// Data layer: Firebase (Auth + Firestore + Storage) or an in-memory demo store for local testing.
// Data model: trips/{tripId} (title, start, end, travellers, extended) with subcollections
//   items (flights/stays/cars), entries (activities/comments), private (editors only), files (editors only).
import { firebaseConfig, FAMILY_EMAIL, EDITORS, FIREBASE_SDK, AI_MODELS, AI_IMAGE_MODELS, AI_LOCATION, APP_CHECK_SITE_KEY } from "./firebase-config.js";

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
export const DEMO = isLocal && new URLSearchParams(location.search).has("demo");

let fb = null;
const listeners = new Set();
export const store = { role: null, email: null, trips: [], tripsLoaded: false, people: [], peopleError: "", tripId: null, trip: null,
                       items: [], entries: [], priv: {}, files: [], ready: false };
const emit = () => listeners.forEach((fn) => fn(store));
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const uid = (p) => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (o) => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const clearTrip = () => Object.assign(store, { trip: null, items: [], entries: [], priv: {}, files: [], journal: [], journalError: "", votes: {}, votesError: "", packing: [], packingError: "", todos: [], todosError: "" });

// ---------------- demo store (local testing only)
const demo = { trips: {}, people: {}, vault: {} };   // id -> {trip, items, entries, priv, files}
function demoLoad(id) {
  const t = demo.trips[id]; if (!t) { clearTrip(); return; }
  Object.assign(store, { trip: t.trip, items: t.items, entries: t.entries, priv: store.role === "editor" ? t.priv : {}, files: store.role === "editor" ? t.files : [], journal: (t.journal = t.journal || []), votes: (t.votes = t.votes || {}), packing: (t.packing = t.packing || []), todos: (t.todos = t.todos || []) });
}
const demoList = () => { store.trips = Object.entries(demo.trips).map(([id, t]) => ({ id, ...t.trip })); store.tripsLoaded = true; };

// ------------------------------------------------------------------ init / auth
export async function init(onAuth) {
  if (DEMO) {
    const seed = await (await fetch("./seed/trip-seed.json")).json();
    demo.trips[seed.trip.id] = seedToMem(seed);
    const role = new URLSearchParams(location.search).get("demo") === "family" ? "family" : "editor";
    store.role = role; store.email = role === "editor" ? EDITORS[0] : FAMILY_EMAIL;
    demoList(); if (role === "editor") demoPeople(); store.ready = true; onAuth(store.role); emit();
    return;
  }
  const [appM, authM, fsM, stM] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`), import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`), import(`${FIREBASE_SDK}/firebase-storage.js`),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  // App Check: proves requests come from this app (Google requires it for the AI). Must start before the AI, Firestore and Storage are used.
  if (APP_CHECK_SITE_KEY) {
    try { const acM = await import(`${FIREBASE_SDK}/firebase-app-check.js`);
      acM.initializeAppCheck(app, { provider: new acM.ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: true }); }
    catch (e) { console.warn("App Check", e); }
  }
  const auth = authM.getAuth(app);
  let db;
  try { db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) }); }
  catch (e) { db = fsM.getFirestore(app); }
  fb = { app, authM, fsM, stM, auth, db, storage: stM.getStorage(app) };
  try { await authM.getRedirectResult(auth); } catch (e) { /* ignore */ }
  authM.onAuthStateChanged(auth, (user) => {
    stopTrip(); stopList();
    if (!user) { Object.assign(store, { role: null, email: null, trips: [], tripsLoaded: false, tripId: null, ready: true }); clearTrip(); onAuth(null); emit(); return; }
    const email = (user.email || "").toLowerCase();
    store.email = email;
    store.role = EDITORS.includes(email) ? "editor" : email === FAMILY_EMAIL ? "family" : "none";
    store.ready = true; onAuth(store.role);
    if (store.role === "editor" || store.role === "family") { subscribeList(); if (store.tripId) subscribeTrip(store.tripId); }
    if (store.role === "editor") subscribePeople();
    emit();
  });
}
export async function signInFamily(password) { if (!DEMO) await fb.authM.signInWithEmailAndPassword(fb.auth, FAMILY_EMAIL, password); }
export async function signInEditor() {
  if (DEMO) return;
  const provider = new fb.authM.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try { await fb.authM.signInWithPopup(fb.auth, provider); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"].includes(e.code))
      await fb.authM.signInWithRedirect(fb.auth, provider);
    else throw e;
  }
}
// Signing out also wipes this device's offline copy of the data (trips, people) so nothing stays behind.
export async function signOut() {
  if (DEMO) { location.href = location.pathname; return; }
  try { await fb.fsM.terminate(fb.db); await fb.fsM.clearIndexedDbPersistence(fb.db); } catch (e) { console.warn("clear cache", e); }
  await fb.authM.signOut(fb.auth); location.reload();
}

// ---------------- recent sign-in ("confirm it's you") for private details - also enforced by the security rules (15 minutes)
const demoAuth = { at: Date.now() - 3600e3 };
export async function signedInAt() {
  if (DEMO) return demoAuth.at;
  const r = await fb.auth.currentUser.getIdTokenResult();
  return Number(r.claims.auth_time) * 1000;
}
export async function confirmIdentity(maxMin = 14) {
  if (Date.now() - (await signedInAt()) < maxMin * 60e3) return signedInAt();
  if (DEMO) { if (!confirm("Demo: confirm it's you (Google sign-in)")) throw new Error("Not confirmed"); demoAuth.at = Date.now(); return demoAuth.at; }
  const u = fb.auth.currentUser, provider = new fb.authM.GoogleAuthProvider();
  provider.setCustomParameters({ login_hint: u.email || "", prompt: "login" });
  await fb.authM.reauthenticateWithPopup(u, provider);
  await u.getIdToken(true);
  return signedInAt();
}

// ------------------------------------------------------------------ trips list + open trip
let listUnsub = null, tripUnsubs = [];
function stopList() { if (listUnsub) listUnsub(); listUnsub = null; if (peopleUnsub) peopleUnsub(); peopleUnsub = null; store.people = []; }
let peopleUnsub = null;
function subscribePeople() {
  peopleUnsub = fb.fsM.onSnapshot(fb.fsM.collection(fb.db, "people"), (s) => { store.people = s.docs.map((d) => ({ id: d.id, ...d.data() })); store.peopleError = ""; emit(); },
    (e) => { console.warn("people", e); store.peopleError = e.code === "permission-denied" ? "Saved people need the new Firestore rules (people section)." : e.message; emit(); });
}
function stopTrip() { tripUnsubs.forEach((u) => u()); tripUnsubs = []; }
function onErr(e) { console.error(e); store.error = e.code === "permission-denied" ? "This login doesn't have access." : e.message; emit(); }
function subscribeList() {
  const { fsM } = fb;
  listUnsub = fsM.onSnapshot(fsM.collection(fb.db, "trips"), (s) => {
    store.trips = s.docs.map((d) => ({ id: d.id, ...d.data() })); store.tripsLoaded = true; emit();
  }, onErr);
}
function col(name) { return fb.fsM.collection(fb.db, "trips", store.tripId, name); }
function subscribeTrip(id) {
  const { fsM } = fb;
  tripUnsubs.push(fsM.onSnapshot(fsM.doc(fb.db, "trips", id), (s) => { store.trip = s.exists() ? s.data() : null; emit(); }, onErr));
  tripUnsubs.push(fsM.onSnapshot(col("items"), (s) => { store.items = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  tripUnsubs.push(fsM.onSnapshot(col("entries"), (s) => { store.entries = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  // journal: the one place the family can write too (needs the journal rule in firestore.rules)
  tripUnsubs.push(fsM.onSnapshot(col("journal"), (s) => { store.journal = s.docs.map((d) => ({ id: d.id, ...d.data() })); store.journalError = ""; emit(); },
    (e) => { console.warn("journal", e); store.journalError = e.code === "permission-denied" ? "The journal isn't switched on yet (Firestore rules need the journal section)." : e.message; emit(); }));
  // packing lists: everyone can tick and add (needs the packing rule in firestore.rules)
  tripUnsubs.push(fsM.onSnapshot(col("packing"), (s) => { store.packing = s.docs.map((d) => ({ id: d.id, ...d.data() })); store.packingError = ""; emit(); },
    (e) => { console.warn("packing", e); store.packingError = e.code === "permission-denied" ? "Packing lists aren't switched on yet (Firestore rules need the packing section)." : e.message; emit(); }));
  // pre-trip to-dos: everyone can tick and add (needs the todos rule in firestore.rules)
  tripUnsubs.push(fsM.onSnapshot(col("todos"), (s) => { store.todos = s.docs.map((d) => ({ id: d.id, ...d.data() })); store.todosError = ""; emit(); },
    (e) => { console.warn("todos", e); store.todosError = e.code === "permission-denied" ? "To-dos aren't switched on yet (Firestore rules need the todos section)." : e.message; emit(); }));
  // votes on recommended places / ideas: the family can vote too (needs the votes rule in firestore.rules)
  tripUnsubs.push(fsM.onSnapshot(col("votes"), (s) => { store.votes = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); store.votesError = ""; emit(); },
    (e) => { console.warn("votes", e); store.votesError = e.code === "permission-denied" ? "Voting isn't switched on yet (Firestore rules need the votes section)." : e.message; emit(); }));
  if (store.role === "editor") {
    tripUnsubs.push(fsM.onSnapshot(col("private"), (s) => { store.priv = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); emit(); }, onErr));
    tripUnsubs.push(fsM.onSnapshot(col("files"), (s) => { store.files = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  }
}
export function openTrip(id) {
  if (store.tripId === id) return;
  store.tripId = id; clearTrip();
  if (DEMO) { if (id) demoLoad(id); emit(); return; }
  stopTrip(); if (id && fb && (store.role === "editor" || store.role === "family")) subscribeTrip(id);
  emit();
}

// ------------------------------------------------------------------ trip setup (editors)
const slug = (s) => (s || "trip").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "trip";
export async function saveTrip(meta, id = null) {
  const data = clean({ ...meta, id: undefined, updatedBy: store.email, updatedAt: now() });
  if (!id) { id = `${slug(meta.title)}-${Date.now().toString(36).slice(-4)}`; data.createdAt = now(); data.schema = 2; }
  if (DEMO) {
    if (!demo.trips[id]) demo.trips[id] = { trip: {}, items: [], entries: [], priv: {}, files: [] };
    demo.trips[id].trip = { ...demo.trips[id].trip, ...data }; demoList(); if (store.tripId === id) demoLoad(id); emit(); return id;
  }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "trips", id), data, { merge: true });
  return id;
}
export async function deleteTrip(id) {
  if (DEMO) { delete demo.trips[id]; demoList(); if (store.tripId === id) openTrip(null); emit(); return; }
  const { fsM } = fb;
  for (const name of ["items", "entries", "private", "files", "journal", "votes", "packing", "todos"]) {
    const snap = await fsM.getDocs(fsM.collection(fb.db, "trips", id, name));
    for (const d of snap.docs) {
      if (name === "files" && d.data().path) { try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, d.data().path)); } catch (e) { /* gone */ } }
      if (name === "journal" && d.data().photos) await deleteJournalPhotos(d.data().photos);
      await fsM.deleteDoc(d.ref);
    }
  }
  await fsM.deleteDoc(fsM.doc(fb.db, "trips", id));
  if (store.tripId === id) openTrip(null);
}

// ------------------------------------------------------------------ bookings & entries (editors)
const mem = () => demo.trips[store.tripId];
export async function saveItem(item, priv) {
  const id = item.id || uid(item.type[0]);
  const data = clean({ ...item, id: undefined, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { const t = mem(); const i = t.items.findIndex((x) => x.id === id); if (i >= 0) t.items[i] = { id, ...data }; else t.items.push({ id, ...data }); if (priv) t.priv[id] = priv; demoLoad(store.tripId); emit(); return id; }
  await fb.fsM.setDoc(fb.fsM.doc(col("items"), id), data);
  if (priv) await fb.fsM.setDoc(fb.fsM.doc(col("private"), id), clean(priv));
  return id;
}
// ------------------------------------------------------------------ saved people + their travel documents (editors only)
// people/{id}: { code, name, fullName, color, docs: [{ id, type, number, country, expiry, notes, file: { path, name, size, contentType } }] }
const demoPeople = () => { store.people = Object.values(demo.people); };
export async function savePerson(p) {
  const id = p.id || uid("p");
  const data = clean({ ...p, id: undefined, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { demo.people[id] = { id, ...(demo.people[id] || {}), ...data }; demoPeople(); emit(); return id; }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "people", id), data, { merge: true });
  return id;
}
export async function deletePerson(p) {
  const v = await getVault(p.id).catch(() => ({}));
  for (const f of Object.values(v.files || {}).concat((p.docs || []).map((d) => d.file).filter(Boolean))) if (f?.path) await deletePersonFile(f).catch(() => {});
  if (DEMO) { delete demo.people[p.id]; delete demo.vault[p.id]; demoPeople(); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(fb.db, "people", p.id, "vault", "main")).catch(() => {});
  await fb.fsM.deleteDoc(fb.fsM.doc(fb.db, "people", p.id));
}
// people/{id}/vault/main: the private part of a profile (birth date, contacts, medical, document numbers and scans).
// Only readable by an editor who signed in (or confirmed it's them) in the last 15 minutes - see firestore.rules.
export async function getVault(pid) {
  if (DEMO) return JSON.parse(JSON.stringify(demo.vault[pid] || {}));
  const s = await fb.fsM.getDocFromServer(fb.fsM.doc(fb.db, "people", pid, "vault", "main"));
  return s.exists() ? s.data() : {};
}
export async function saveVault(pid, v) {
  const data = clean({ ...v, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { demo.vault[pid] = data; return; }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "people", pid, "vault", "main"), data);
}
export async function uploadPersonFile(pid, file) {
  const fid = uid("pf"), meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" };
  if (DEMO) return { ...meta, path: "", demoUrl: URL.createObjectURL(file) };
  const path = `people/${pid}/${fid}/${file.name}`;
  await fb.stM.uploadBytes(fb.stM.ref(fb.storage, path), file, { contentType: meta.contentType });
  return { ...meta, path };
}
// Scans are fetched through the security rules each time (no shareable link); a link is only the fallback if the browser can't fetch directly.
export async function personFileUrl(f) {
  if (DEMO) return f.demoUrl || "#";
  const r = fb.stM.ref(fb.storage, f.path);
  try { return URL.createObjectURL(await fb.stM.getBlob(r)); }
  catch (e) { if (e.code === "storage/unauthorized") throw e; console.warn("getBlob", e); return fb.stM.getDownloadURL(r); }
}
export async function deletePersonFile(f) { if (DEMO || !f?.path) return; await fb.stM.deleteObject(fb.stM.ref(fb.storage, f.path)); }
const docSchema = () => req({
  type: { type: "string", enum: ["passport", "visa", "esta", "licence", "idp", "insurance", "vaccination", "other"], description: "Kind of travel document" },
  number: { type: "string", description: "Document / passport / visa / policy number" },
  country: { type: "string", description: "Issuing country (or the country the visa/ESTA is for)" },
  fullName: { type: "string", description: "Holder's full name as printed, given names first, e.g. Cesar Gonzalez Cruz" },
  dob: { type: "string", description: "Holder's date of birth YYYY-MM-DD" },
  nationality: { type: "string", description: "Holder's nationality as a country name, e.g. Australia" },
  expiry: { type: "string", description: "Expiry date YYYY-MM-DD" },
  notes: { type: "string", description: "Anything important in a few words (e.g. multiple entry, valid for travel to USA)" },
});
export async function extractDocFromFile(file) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 400)); return { type: "passport", number: "PA1234567", country: "Australia", fullName: "Demo Person", dob: "1990-02-03", nationality: "Australia", expiry: "2027-03-01" }; }
  const parts = [{ inlineData: { mimeType: file.type || "application/pdf", data: await toBase64(file) } },
    { text: "Read this travel document (passport, visa, ESTA/eTA, driver licence, insurance, vaccination record...) and extract it into the JSON schema. Dates as YYYY-MM-DD. Use \"\" for anything not shown." }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, docSchema()); const res = await m.generateContent(parts); return dropEmpty(JSON.parse(res.response.text())); }
    catch (e) { lastErr = e; if (!/not.?found|404|unsupported|model/i.test(String(e.message || e))) break; }
  }
  throw lastErr;
}

// ------------------------------------------------------------------ stay arrival card (Wi-Fi, door code, parking, rules, host) read from a confirmation
export async function arrivalFromFile(file) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 400)); return { wifiName: "Casa-Demo", wifiPass: "playa2026", doorCode: "4821 (lockbox by the gate)", parking: "2 spaces in the driveway",
    checkin: "Self check-in from 3 pm", houseRules: "No parties · Quiet hours 10 pm – 8 am", hostName: "Ana", hostPhone: "+52 984 123 4567" }; }
  const S2 = (d) => ({ type: "string", description: d });
  const schema = { type: "object", properties: {
    wifiName: S2("Wi-Fi network name"), wifiPass: S2("Wi-Fi password"), doorCode: S2("Door, gate, keypad or lockbox code and where it is"),
    checkin: S2("How to check in / get the keys, short"), checkout: S2("Check-out instructions, short"), parking: S2("Parking details"),
    houseRules: S2("House rules, short, separated by ' · '"), hostName: S2("Host or property contact name"), hostPhone: S2("Host or property phone in international format"),
    hostEmail: S2("Host or property email"), address: S2("Full address of the stay"), notes: S2("Anything else useful on arrival (bins, A/C, pool, gate remote), short") },
    required: ["wifiName", "wifiPass", "doorCode", "checkin", "parking", "houseRules", "hostName", "hostPhone"] };
  const parts = [{ inlineData: { mimeType: file.type || "application/pdf", data: await toBase64(file) } },
    { text: "From this accommodation confirmation or host message, extract the arrival details into the JSON schema. Use \"\" for anything not shown - never invent codes or passwords." }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, schema); const res = await m.generateContent(parts); return dropEmpty(JSON.parse(res.response.text())); }
    catch (e) { lastErr = e; if (!/not.?found|404|unsupported|model|429|exhausted|50\d|unavailable|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).slice(0, 300));
}

// ------------------------------------------------------------------ receipt scanning: a photo of a receipt -> an expense
export async function receiptAI(file, ctx) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 400)); return { merchant: "Taquería Honorio", total: "684.00", currency: "MXN", date: ctx.date || "", cat: "food", paidWith: "Visa ending 1234", tip: "60.00", summary: "Tacos, aguas frescas (4 people)", people: "4" }; }
  const schema = { type: "object", properties: {
    merchant: { type: "string", description: "Business name, short (e.g. 'Taquería Honorio', 'Walmart')" },
    total: { type: "string", description: "Final total actually paid including tax and tip, as a plain number like 684.00" },
    currency: { type: "string", description: "ISO currency code of the total (USD, MXN, AUD...). Use the symbol, the country on the receipt and the hint." },
    date: { type: "string", description: "Date on the receipt YYYY-MM-DD, or ''" },
    cat: { type: "string", enum: ["food", "transport", "shopping", "act", "stay", "car", "flight", "other"], description: "food = restaurants, cafes, groceries, drinks; transport = taxi, Uber, fuel, parking, tolls, buses; act = tickets, tours, entry fees; shopping = everything else bought" },
    paidWith: { type: "string", description: "Card or method if shown, e.g. 'Visa ending 1234', 'Mastercard ending 9876', 'Cash'; '' if not shown" },
    tip: { type: "string", description: "Tip / propina / gratuity amount if shown, plain number, or ''" },
    summary: { type: "string", description: "What was bought in a few words" },
    people: { type: "string", description: "Number of people / covers if shown, or ''" } },
    required: ["merchant", "total", "currency", "date", "cat", "paidWith", "tip", "summary", "people"] };
  const parts = [{ inlineData: { mimeType: file.type || "image/jpeg", data: await toBase64(file) } },
    { text: `Read this receipt (it may be a photo, possibly in Spanish) and extract it into the JSON schema. The family is travelling in ${ctx.countries || "the USA and Mexico"}; around this date they were in ${ctx.where || "?"} (local currency hint: ${ctx.cur || "?"}). Use "" for anything not shown.` }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, schema); const res = await m.generateContent(parts); return dropEmpty(JSON.parse(res.response.text())); }
    catch (e) { lastErr = e; if (!/not.?found|404|unsupported|model|429|exhausted|50\d|unavailable|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).slice(0, 300));
}

// ------------------------------------------------------------------ country info (AI-written, kept on the trip)
const L = (d) => ({ type: "array", items: { type: "string" }, description: d });
const countrySchema = () => req({
  country: S("Country name in English"),
  entry: { type: "array", description: "One entry per passport nationality given", items: req({ passport: S("Passport nationality, e.g. Australian"),
    summary: S("One line: what this passport holder needs to enter for a tourist trip of this length, e.g. 'ESTA approval needed (Visa Waiver Program), up to 90 days'"),
    steps: L("Short practical steps or rules: how/where to apply, cost, how far ahead, passport validity, arrival forms, onward ticket, minors travelling, land border notes") }) },
  currency: req({ name: S("Currency name"), code: S("ISO code"), cash: S("Cash vs card in one or two lines: cards widely accepted? need cash for? ATMs/fees tips"), tips: L("2-4 short money tips") }),
  plugs: req({ types: S("Plug types, e.g. Type A and B"), voltage: S("Voltage and frequency, e.g. 120 V, 60 Hz"), adapter: S("Whether an Australian traveller needs an adapter and/or converter, one line") }),
  tipping: req({ restaurants: S("Restaurants"), taxis: S("Taxis / rideshare"), hotels: S("Hotels: housekeeping, porters"), other: S("Tours, guides, bars, other") }),
  emergency: req({ general: S("Main emergency number"), police: S("Police"), ambulance: S("Ambulance"), fire: S("Fire"), other: S("Tourist police, roadside help or other useful numbers") }),
  driving: S("Driving side and key rules for visitors: licence/IDP, insurance, tolls, notable road rules"),
  water: S("Tap water safe to drink?"),
  goodToKnow: L("4-8 short practical tips specific to this trip: safety, health, SIM/eSIM, local customs, sales tax added at checkout, time zones, seasonal weather for these dates"),
  official: { type: "array", description: "Official government sources to check entry rules (e.g. Smartraveller for Australians, the country's immigration site)", items: req({ name: S("Site name"), url: S("https URL") }) },
});
export async function countryInfoAI(code, ctx) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500)); const nm = ctx.name;
    return { country: nm, entry: ctx.passports.map((p) => ({ passport: p.nationality, summary: `Demo: what ${p.nationality} passport holders need for ${nm}`, steps: ["Apply online before you go", "Passport valid for the whole stay"] })),
      currency: { name: "Demo Dollar", code: "DMD", cash: "Cards widely accepted; carry some cash for small shops.", tips: ["Pay in local currency, not AUD"] },
      plugs: { types: "Type A and B", voltage: "120 V, 60 Hz", adapter: "Australian plugs need an adapter" },
      tipping: { restaurants: "15-20%", taxis: "10-15%", hotels: "$2-5 per night housekeeping", other: "Guides 10-20%" },
      emergency: { general: "911", police: "911", ambulance: "911", fire: "911", other: "" }, driving: "Drive on the right.", water: "Safe in most cities.",
      goodToKnow: ["Sales tax is added at the till"], official: [{ name: "Smartraveller", url: "https://www.smartraveller.gov.au/" }] };
  }
  const pp = ctx.passports.map((p) => `${p.nationality} passport (${p.who.join(", ")})`).join("; ") || "Australian passports (assumed - no passports saved in the profiles)";
  const prompt = `Write concise, practical country information for a family visiting ${ctx.name} (${code}) from ${ctx.from} to ${ctx.to}, travelling from ${ctx.origin || "Australia"}.
Travellers' passports: ${pp}. Places on the itinerary: ${ctx.places || "not specified"}.
Give entry requirements for EACH passport nationality listed (tourist visit). Be specific (names of schemes such as ESTA, eTA, FMM; costs; how far ahead to apply).
Keep each text short and scannable - this is shown on a phone. Use the local currency symbol where useful.
If something changes often (fees, visa rules), say so briefly. Only list real, official government URLs in "official".`;
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, countrySchema()); const res = await m.generateContent([{ text: prompt }]); return dropEmpty(JSON.parse(res.response.text())); }
    catch (e) { lastErr = e; console.warn("country AI", AI_MODELS[i], e);
      if (!/not.?found|404|unsupported|model|429|exhausted|quota|50\d|unavailable|overloaded|deadline|timeout|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).replace(/^\[?FirebaseError\]?:?\s*/i, "").slice(0, 300));
}

// ------------------------------------------------------------------ "Ask the trip": answers from the itinerary
export async function askTripAI(question, context, history) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500)); const m = context.match(/\d{4}-\d\d-\d\d/); return { answer: `Demo answer to: **${question}**\nThe AI reads the whole itinerary to answer.`, days: m ? [m[0]] : [] }; }
  const schema = { type: "object", properties: { answer: { type: "string", description: "The answer for the family, short and friendly. Plain text; **bold** allowed; new lines for lists." },
    days: { type: "array", items: { type: "string" }, description: "Trip dates YYYY-MM-DD the answer is about (for 'open this day' links); empty if none" } }, required: ["answer", "days"] };
  const prompt = `You are the family's trip assistant. Answer ONLY from the itinerary below (and general travel knowledge where the itinerary is silent - say so when you do).
If the itinerary doesn't have the answer, say what's missing. Be concise: one to five short lines. Use dd-mmm-yy dates (e.g. 27-Dec-26) and 24h local times with the place's time zone when relevant.
"Leave for the airport" = 3 hours before an international departure, 2 hours before a domestic one (plus travel time to the airport if known).
${history.length ? "Earlier in this chat:\n" + history.map((h) => `Q: ${h.q}\nA: ${h.a}`).join("\n") + "\n" : ""}
ITINERARY
${context}

QUESTION: ${question}`;
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, schema); const res = await m.generateContent([{ text: prompt }]); return JSON.parse(res.response.text()); }
    catch (e) { lastErr = e; console.warn("ask AI", AI_MODELS[i], e);
      if (!/not.?found|404|unsupported|model|429|exhausted|quota|50\d|unavailable|overloaded|deadline|timeout|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).slice(0, 300));
}

// ------------------------------------------------------------------ phone notifications (check-in open), via Firebase Cloud Messaging
// This device registers a push token in push/{hash} with the travellers it wants alerts for; the server function sends them.
export const pushSupported = () => "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
export const pushState = () => { try { return JSON.parse(localStorage.getItem("tp.push") || "null"); } catch (e) { return null; } };
async function tokenId(token) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)); return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40); }
export async function enablePush(people, cats) {
  cats = cats || pushState()?.cats || { important: true, extras: true };
  if (!pushSupported()) throw new Error("unsupported");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "blocked" : "dismissed");
  if (DEMO) { localStorage.setItem("tp.push", JSON.stringify({ people, cats, id: "demo" })); emit(); return; }
  const msgM = await import(`${FIREBASE_SDK}/firebase-messaging.js`);
  const messaging = msgM.getMessaging(fb.app);
  const reg = await navigator.serviceWorker.ready;
  const token = await msgM.getToken(messaging, { serviceWorkerRegistration: reg });
  if (!token) throw new Error("no token");
  const id = await tokenId(token);
  let device = ""; try { device = localStorage.getItem("tp.device") || ""; } catch (e) { /* ignore */ }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "push", id), { token, people, cats, device, role: store.role, email: store.email || "", ua: navigator.userAgent.slice(0, 200), updatedAt: now() });
  localStorage.setItem("tp.push", JSON.stringify({ people, cats, id })); emit();
}
export async function testPush() {
  const st = pushState(); if (!st?.id) throw new Error("Turn notifications on first");
  if (DEMO) { const reg = await navigator.serviceWorker?.getRegistration?.(); if (reg) await reg.showNotification("Test notification ✓", { body: "Demo" }); return; }
  const fM = await import(`${FIREBASE_SDK}/firebase-functions.js`);
  await fM.httpsCallable(fM.getFunctions(fb.app, "us-east1"), "sendTestPush")({ id: st.id });
}
export async function disablePush() {
  const st = pushState(); localStorage.removeItem("tp.push");
  if (st?.id && !DEMO) await fb.fsM.deleteDoc(fb.fsM.doc(fb.db, "push", st.id)).catch(() => {});
  emit();
}

// ------------------------------------------------------------------ recommendations (Google Places, cached on the trip so the family sees them too)
export async function saveRecs(key, rec) {
  if (DEMO) { const t = mem().trip; t.recs = { ...(t.recs || {}), [key]: clean(rec) }; demoLoad(store.tripId); emit(); return; }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "trips", store.tripId), { recs: { [key]: clean(rec) } }, { merge: true });
}
// ------------------------------------------------------------------ journal (editors and family)
export async function saveJournal(post) {
  const id = post.id || uid("j");
  const data = clean({ ...post, id: undefined, by: post.by || (store.role === "editor" ? "editor" : "family"), updatedAt: now(), createdAt: post.createdAt || now() });
  if (DEMO) { const j = mem().journal = mem().journal || []; const i = j.findIndex((x) => x.id === id); if (i >= 0) j[i] = { id, ...data }; else j.push({ id, ...data }); demoLoad(store.tripId); emit(); return id; }
  await fb.fsM.setDoc(fb.fsM.doc(col("journal"), id), data);
  return id;
}
// ---- packing lists: packing/{id} = { text, cat, list: "shared" | traveller code, packer?, done, qty?, order }
export async function savePack(items) {
  const list = Array.isArray(items) ? items : [items];
  if (DEMO) { const pk = (mem().packing ||= []);
    for (const it of list) { const id = it.id || uid("pk"), i = pk.findIndex((x) => x.id === id), v = { ...it, id, updatedAt: now() }; if (i >= 0) pk[i] = v; else pk.push(v); }
    demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb, b = fsM.writeBatch(fb.db);
  for (const it of list) { const id = it.id || uid("pk"); b.set(fsM.doc(col("packing"), id), clean({ ...it, id: undefined, text: String(it.text || "").slice(0, 200), updatedAt: now() })); }
  await b.commit();
}
export async function deletePack(ids) {
  ids = [].concat(ids);
  if (DEMO) { const t = mem(); t.packing = (t.packing || []).filter((x) => !ids.includes(x.id)); demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb, b = fsM.writeBatch(fb.db); ids.forEach((id) => b.delete(fsM.doc(col("packing"), id))); await b.commit();
}
// ---- pre-trip to-dos: todos/{id} = { text, due: YYYY-MM-DD, who: traveller code | "", done, notes?, tz (for the 9 am reminder) }
export async function saveTodo(items) {
  const list = Array.isArray(items) ? items : [items], tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (DEMO) { const td = (mem().todos ||= []);
    for (const it of list) { const id = it.id || uid("td"), i = td.findIndex((x) => x.id === id), v = { tz, ...it, id, updatedAt: now() }; if (i >= 0) td[i] = v; else td.push(v); }
    demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb, b = fsM.writeBatch(fb.db);
  for (const it of list) { const id = it.id || uid("td"); b.set(fsM.doc(col("todos"), id), clean({ tz, ...it, id: undefined, text: String(it.text || "").slice(0, 200), updatedAt: now() })); }
  await b.commit();
}
export async function deleteTodo(ids) {
  ids = [].concat(ids);
  if (DEMO) { const t = mem(); t.todos = (t.todos || []).filter((x) => !ids.includes(x.id)); demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb, b = fsM.writeBatch(fb.db); ids.forEach((id) => b.delete(fsM.doc(col("todos"), id))); await b.commit();
}
export async function todoAI(ctx) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500));
    return { items: [{ text: "Buy eSIMs for the USA and Mexico", daysBefore: 7, who: "", why: "Data on arrival" }, { text: "Book Xcaret Park tickets", daysBefore: 30, who: "", why: "Sells out in January" },
      { text: "Tell the bank about overseas card use", daysBefore: 7, who: "CGC", why: "" }] }; }
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
      text: { type: "string", description: "The to-do, short and actionable, e.g. 'Apply for Chloe's ESTA'" },
      daysBefore: { type: "integer", description: "How many days before the trip starts it should be done (0 = the day before / day of)" },
      who: { type: "string", description: "Traveller code if it's for one person (their document etc.), else ''" },
      why: { type: "string", description: "Very short reason tied to this trip, or ''" } }, required: ["text", "daysBefore", "who", "why"] } } }, required: ["items"] };
  const prompt = `Suggest a practical pre-trip to-do list (10-25 items) for this family trip, ordered by when to do them. Focus on things that must be done BEFORE leaving:
entry documents for each passport (from the country info), renewing documents with problems, bookings still not confirmed, activities that sell out or need booking ahead, travel insurance,
eSIMs/phone plans, notifying the bank, cash, driving permits for hire cars, airline check-in and seats, home tasks (mail, pets, plants) - only what fits this trip. Don't repeat what's already on the list.
${ctx.have.length ? "Already on the list: " + ctx.have.join("; ") + "\n" : ""}
TRIP
${ctx.text}`;
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, schema); const res = await m.generateContent([{ text: prompt }]); return JSON.parse(res.response.text()); }
    catch (e) { lastErr = e; console.warn("todo AI", AI_MODELS[i], e);
      if (!/not.?found|404|unsupported|model|429|exhausted|quota|50\d|unavailable|overloaded|deadline|timeout|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).slice(0, 300));
}
// another trip's packing list (to reuse it as a template)
export async function packingOf(tripId) {
  if (DEMO) return (demo.trips[tripId]?.packing || []).map((x) => ({ ...x }));
  const { fsM } = fb; const s = await fsM.getDocs(fsM.collection(fb.db, "trips", tripId, "packing")); return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
export async function packingAI(ctx) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500));
    return { items: [{ text: "Travel adapters (US Type A/B)", cat: "Electronics", scope: "shared", why: "US & Mexico use Type A/B" }, { text: "Swimsuit", cat: "Beach & Swim", scope: "each", why: "Cenotes and beach" },
      { text: "Reef-safe sunscreen", cat: "Health", scope: "shared", why: "Required in cenotes" }, { text: "Comfortable walking shoes", cat: "Clothes", scope: "each", why: "Theme parks" }, { text: "Passport + ESTA printout", cat: "Documents", scope: "each", why: "" }] }; }
  const schema = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: {
      text: { type: "string", description: "Item, short, with quantity if useful, e.g. '5 T-shirts'" },
      cat: { type: "string", enum: ["Documents", "Clothes", "Toiletries", "Health", "Electronics", "Beach & Swim", "Theme Parks", "Travel Day", "Money", "Other"] },
      scope: { type: "string", enum: ["shared", "each", "person"], description: "shared = one for the family (someone packs it); each = every traveller packs their own; person = only one traveller" },
      person: { type: "string", description: "Traveller code when scope is person" }, why: { type: "string", description: "Very short reason tied to this trip (weather, activity, country); empty if obvious" } },
      required: ["text", "cat", "scope"] } } }, required: ["items"] };
  const prompt = `Make a practical packing list for this family trip. Tailor it to the places, dates/season and weather, the activities, the countries (plugs, documents) and the flights.
Avoid generic filler; 35-60 items. Use "each" for personal items everyone needs (clothes, toiletries), "shared" for family items one person packs (adapters, first aid, chargers hub), "person" only when it clearly applies to one traveller.
${ctx.have.length ? "Already on the lists (don't repeat): " + ctx.have.join("; ") + "\n" : ""}
TRIP
${ctx.text}`;
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try { const m = await getModel(i, schema); const res = await m.generateContent([{ text: prompt }]); return JSON.parse(res.response.text()); }
    catch (e) { lastErr = e; console.warn("packing AI", AI_MODELS[i], e);
      if (!/not.?found|404|unsupported|model|429|exhausted|quota|50\d|unavailable|overloaded|deadline|timeout|fetch/i.test(String(e.message || e) + (e.code || ""))) break; }
  }
  throw new Error(String(lastErr?.message || lastErr).slice(0, 300));
}
// 👍 on a recommended place or idea: votes/{key} = { name, kind, up: [traveller codes] }
export async function setVote(key, info, code, on) {
  if (DEMO) { const v = mem().votes = mem().votes || {}; const cur = v[key] || { ...info, up: [] };
    cur.up = on ? [...new Set(cur.up.concat(code))] : cur.up.filter((c) => c !== code); v[key] = cur; demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb;
  await fsM.setDoc(fsM.doc(col("votes"), key), { name: String(info.name || "").slice(0, 200), kind: info.kind || "", up: on ? fsM.arrayUnion(code) : fsM.arrayRemove(code), updatedAt: now() }, { merge: true });
}
export async function deleteJournal(id) {
  const gone = store.journal.filter((x) => x.id === id || x.replyTo === id);
  if (DEMO) { const t = mem(); t.journal = (t.journal || []).filter((x) => x.id !== id && x.replyTo !== id); demoLoad(store.tripId); emit(); return; }
  for (const r of store.journal.filter((x) => x.replyTo === id)) await fb.fsM.deleteDoc(fb.fsM.doc(col("journal"), r.id)).catch(() => {});
  await fb.fsM.deleteDoc(fb.fsM.doc(col("journal"), id));
  await deleteJournalPhotos(gone.flatMap((x) => x.photos || []));
}
// ---- journal photos: resized in the browser (about 2560 px, plus a small thumbnail) and kept in Storage under the trip
export const newJournalId = () => uid("j");
export async function uploadJournalPhoto(postId, full, thumb, w, h) {
  const id = uid("ph");
  if (DEMO) return { id, path: "", tpath: "", url: URL.createObjectURL(full), turl: URL.createObjectURL(thumb), w, h };
  const base = `trips/${store.tripId}/journal/${postId}/${id}`, put = async (path, blob) => {
    const r = fb.stM.ref(fb.storage, path); await fb.stM.uploadBytes(r, blob, { contentType: "image/jpeg", cacheControl: "private, max-age=31536000" }); return fb.stM.getDownloadURL(r); };
  const [url, turl] = await Promise.all([put(base + ".jpg", full), put(base + "_t.jpg", thumb)]);
  return { id, path: base + ".jpg", tpath: base + "_t.jpg", url, turl, w, h };
}
export async function deleteJournalPhotos(photos) {
  if (DEMO) return;
  for (const ph of photos || []) for (const p of [ph.path, ph.tpath].filter(Boolean)) { try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, p)); } catch (e) { /* already gone */ } }
}
// a photo's bytes for the Word album (through the security rules; falls back to its link)
export async function photoBytes(ph) {
  if (!DEMO && ph.path) { try { return await fb.stM.getBytes(fb.stM.ref(fb.storage, ph.path)); } catch (e) { console.warn("getBytes", e); } }
  const r = await fetch(ph.url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer();
}
// Who travels together on a day: manual overrides on the trip (pair key "A|B", sorted, so it is the same for both people).
// value true/false = override; null = back to automatic (worked out from shared bookings)
export async function setTogether(date, a, b, value) {
  const key = [a, b].sort().join("|");
  if (DEMO) { const t = mem().trip; t.together = t.together || {}; t.together[date] = { ...(t.together[date] || {}) };
    if (value === null) delete t.together[date][key]; else t.together[date][key] = value; demoList(); demoLoad(store.tripId); emit(); return; }
  const { fsM } = fb;
  await fsM.setDoc(fsM.doc(fb.db, "trips", store.tripId), { together: { [date]: { [key]: value === null ? fsM.deleteField() : value } } }, { merge: true });
}
// Editors-only records kept in the "private" collection: activity costs, expenses (id x-...), budget settings (id _budget)
export async function savePrivate(id, obj) {
  id = id || uid("x");
  const data = clean({ ...obj, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { mem().priv[id] = data; demoLoad(store.tripId); emit(); return id; }
  await fb.fsM.setDoc(fb.fsM.doc(col("private"), id), data);
  return id;
}
// home address for the "leave for the airport" timing (editors only; Trip Setup can be opened from the home screen, so the trip id is passed in)
export async function homeAddress(tid) {
  if (store.tripId === tid && store.priv._home) return store.priv._home.address || "";
  if (DEMO) return demo.trips[tid]?.priv?._home?.address || "";
  try { const d = await fb.fsM.getDoc(fb.fsM.doc(fb.db, "trips", tid, "private", "_home")); return d.exists() ? d.data().address || "" : ""; } catch (e) { return ""; }
}
export async function saveHomeAddress(tid, address) {
  const data = clean({ address, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { const t = demo.trips[tid]; if (t) { t.priv = t.priv || {}; t.priv._home = data; if (store.tripId === tid) { demoLoad(tid); emit(); } } return; }
  await fb.fsM.setDoc(fb.fsM.doc(fb.db, "trips", tid, "private", "_home"), data);
}
export async function deletePrivate(id) {
  if (DEMO) { delete mem().priv[id]; demoLoad(store.tripId); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("private"), id));
}
// Re-point files attached to one booking to another (used when a booking replaces an overlapping one)
export async function moveFiles(fromId, toId) {
  const fs = store.files.filter((f) => f.itemId === fromId);
  if (DEMO) { mem().files.forEach((f) => { if (f.itemId === fromId) f.itemId = toId; }); demoLoad(store.tripId); emit(); return; }
  for (const f of fs) await fb.fsM.updateDoc(fb.fsM.doc(col("files"), f.id), { itemId: toId });
}
export async function deleteItem(id) {
  for (const f of store.files.filter((x) => x.itemId === id)) await deleteFile(f);   // its attached documents go with it
  if (DEMO) { const t = mem(); t.items = t.items.filter((x) => x.id !== id); delete t.priv[id]; demoLoad(store.tripId); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("items"), id)); await fb.fsM.deleteDoc(fb.fsM.doc(col("private"), id));
}
export async function saveEntry(entry) {
  const id = entry.id || uid("e");
  const data = clean({ ...entry, id: undefined, updatedBy: store.email, updatedAt: now() });
  if (DEMO) { const t = mem(); const i = t.entries.findIndex((x) => x.id === id); if (i >= 0) t.entries[i] = { id, ...data }; else t.entries.push({ id, ...data }); demoLoad(store.tripId); emit(); return id; }
  await fb.fsM.setDoc(fb.fsM.doc(col("entries"), id), data);
  return id;
}
export async function deleteEntry(id) {
  if (DEMO) { const t = mem(); t.entries = t.entries.filter((x) => x.id !== id); delete t.priv[id]; demoLoad(store.tripId); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("entries"), id));
  if (store.priv[id]) await fb.fsM.deleteDoc(fb.fsM.doc(col("private"), id));
}

// ------------------------------------------------------------------ files (editors)
export async function uploadFile(file, { itemId = "", entryId = "", date = "", expenseId = "" } = {}) {
  const id = uid("file");
  const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream", itemId, entryId, date, ...(expenseId ? { expenseId } : {}), uploadedBy: store.email, uploadedAt: now() };
  if (DEMO) { mem().files.push({ id, ...meta, path: "", demoUrl: URL.createObjectURL(file) }); demoLoad(store.tripId); emit(); return; }
  const path = `trips/${store.tripId}/files/${id}/${file.name}`;
  await fb.stM.uploadBytes(fb.stM.ref(fb.storage, path), file, { contentType: meta.contentType });
  await fb.fsM.setDoc(fb.fsM.doc(col("files"), id), { ...meta, path });
}
export async function fileUrl(f) { return DEMO ? f.demoUrl || "#" : fb.stM.getDownloadURL(fb.stM.ref(fb.storage, f.path)); }
// The file's bytes (for the zip archive): straight through the security rules, or via its download link if the browser can't.
export async function fileBlob(f) {
  if (DEMO) return (await fetch(f.demoUrl)).blob();
  const r = fb.stM.ref(fb.storage, f.path);
  try { return await fb.stM.getBlob(r); }
  catch (e) { if (e.code === "storage/unauthorized" || e.code === "storage/object-not-found") throw e;
    const res = await fetch(await fb.stM.getDownloadURL(r)); if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.blob(); }
}
// ---- documents kept on this device for offline use (Cache Storage; booking files are editor-only, so only editors' phones)
const OFF_CACHE = "tp-docs-v1", offKey = (id) => new URL(`offline-doc/${encodeURIComponent(id)}`, location.href).href;
export const offline = { ids: new Set(), ready: null };
offline.ready = (async () => { try { const c = await caches.open(OFF_CACHE); (await c.keys()).forEach((r) => offline.ids.add(decodeURIComponent(r.url.split("/offline-doc/")[1] || ""))); } catch (e) { /* no cache storage */ } })();
export async function saveOffline(f) {
  const blob = await fileBlob(f), c = await caches.open(OFF_CACHE);
  await c.put(offKey(f.id), new Response(blob, { headers: { "Content-Type": f.contentType || blob.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || "") } }));
  offline.ids.add(f.id);
}
export async function offlineBlob(id) {
  try { const r = await (await caches.open(OFF_CACHE)).match(offKey(id)); return r ? r.blob() : null; } catch (e) { return null; }
}
export async function removeOffline(ids) {
  const c = await caches.open(OFF_CACHE); for (const id of ids) { await c.delete(offKey(id)); offline.ids.delete(id); }
}
export async function deleteFile(f) {
  removeOffline([f.id]).catch(() => {});
  if (DEMO) { const t = mem(); t.files = t.files.filter((x) => x.id !== f.id); demoLoad(store.tripId); emit(); return; }
  try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, f.path)); } catch (e) { /* already gone */ }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("files"), f.id));
}

// ------------------------------------------------------------------ import / export
function seedToMem(seed) {
  return { trip: { ...seed.trip }, items: seed.items.map((x) => ({ ...x })), entries: seed.entries.map((x) => ({ ...x })),
           priv: Object.fromEntries((seed.privateItems || []).map(({ id, ...rest }) => [id, rest])), files: [], journal: (seed.journal || []).map((x) => ({ ...x })) };
}
// Imports a trip file. Into the open trip, or (no trip open) as the trip id in the file.
export async function importSeed(seed) {
  if (!seed || !seed.trip || !Array.isArray(seed.items)) throw new Error("This file isn't a trip data file.");
  const id = store.tripId || seed.trip.id || slug(seed.trip.title);
  if (DEMO) { demo.trips[id] = seedToMem(seed); demoList(); demoLoad(id); emit(); return id; }
  const { fsM } = fb; const c = (n) => fsM.collection(fb.db, "trips", id, n);
  const writes = [[fsM.doc(fb.db, "trips", id), clean({ ...seed.trip, id: undefined })]];
  for (const it of seed.items) writes.push([fsM.doc(c("items"), it.id), clean({ ...it, id: undefined })]);
  for (const e of seed.entries || []) writes.push([fsM.doc(c("entries"), e.id), clean({ ...e, id: undefined })]);
  for (const p of seed.privateItems || []) { const { id: pid, ...rest } = p; writes.push([fsM.doc(c("private"), pid), clean(rest)]); }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = fsM.writeBatch(fb.db); writes.slice(i, i + 400).forEach(([ref, d]) => batch.set(ref, d, { merge: true })); await batch.commit();
  }
  return id;
}
export function exportAll() {
  return { version: 1, exportedAt: now(), trip: { id: store.tripId, ...store.trip }, items: store.items, entries: store.entries, journal: store.journal,
           privateItems: Object.entries(store.priv).map(([id, v]) => ({ id, ...v })), files: store.files.map(({ demoUrl, ...f }) => f) };
}
// One-time update: give every activity a "confirmed" flag (only confirmed ones show in the grid)
export async function migrateConfirmed(isConfirmed) {
  if (DEMO) { store.entries.forEach((e) => { if (e.confirmed === undefined) e.confirmed = isConfirmed(e); }); mem().trip.schema = 2; store.trip.schema = 2; emit(); return; }
  const { fsM } = fb; const batch = fsM.writeBatch(fb.db);
  store.entries.filter((e) => e.confirmed === undefined).forEach((e) => batch.update(fsM.doc(col("entries"), e.id), { confirmed: isConfirmed(e) }));
  batch.set(fsM.doc(fb.db, "trips", store.tripId), { schema: 2 }, { merge: true });
  await batch.commit();
}

// ------------------------------------------------------------------ AI: read a booking PDF / photo (editors)
// Every field is required (empty string when the document doesn't say) - with optional fields Gemini skips most of them.
const S = (description) => ({ type: "string", description });
const req = (properties) => ({ type: "object", properties, required: Object.keys(properties)});
const EXTRACT_SCHEMA = req({
  type: { type: "string", enum: ["flight", "stay", "car", "activity"], description: "What the document books" },
  who: { type: "array", items: { type: "string" }, description: "Traveller codes on the booking" },
  start: S("First date YYYY-MM-DD: flight departure date / hotel check-in date / car pick-up date / activity date"),
  end: S("Last date YYYY-MM-DD: flight arrival date / hotel CHECK-OUT date / car drop-off date / activity end date"),
  route: S("Flight: airport codes joined with '-', e.g. LAX-IAH-TQO"),
  airline: S("Flight: airline name"), number: S("Flight numbers, e.g. UA1306/1600"),
  dep: S("Flight departure time HH:MM (24h)"), arr: S("Flight arrival time HH:MM (24h); add (dd-Mon) if next day"),
  name: S("Hotel / property / activity full name"), short: S("Short hotel name for a small grid cell, max 14 characters"),
  address: S("Full street address of the hotel / property / activity / pick-up desk"),
  area: S("Hotel / property: the town or city it is in, e.g. Queenstown (not the region or country)"),
  checkin: S("Hotel check-in time HH:MM (24h), e.g. 15:00"), checkout: S("Hotel check-out time HH:MM (24h), e.g. 11:00"),
  company: S("Car rental company"), vehicle: S("Short vehicle description, e.g. 7-seat SUV"),
  pickup: S("Car pick-up location, short, e.g. MIA airport"), dropoff: S("Car drop-off location, short"),
  pickupTime: S("Car pick-up time HH:MM"), dropoffTime: S("Car drop-off time HH:MM"),
  text: S("Activity: short description, e.g. 'Xcaret full day + evening show'"),
  flexible: { type: "boolean", description: "true if this is an open-dated voucher, pass or ticket usable on any day within a validity period (no booked visit date)" },
  validFrom: S("Open-dated voucher: first day it can be used YYYY-MM-DD"), validTo: S("Open-dated voucher: last day it can be used YYYY-MM-DD"),
  place: S("Activity: place name for Google Maps"), time: S("Activity start time HH:MM"),
  note: S("One short practical note for the family, e.g. room type, breakfast included, parking, shuttle (no confirmation numbers or prices)"),
  private: req({
    confirmation: S("Booking / confirmation / reservation / itinerary number(s)"), tickets: S("Ticket numbers"), seats: S("Seat numbers"),
    cost: S("Total price with currency, e.g. USD 245.10"), paidWith: S("Payment card or method, e.g. Visa ending 1234, or 'Pay at hotel'"),
    dueAtHotel: S("Amount still to pay at the property, with currency"),
    cancel: S("Cancellation rule in one line, with the deadline date"), phone: S("Phone number of the hotel / airline / rental company itself (not the booking website's customer service line, unless no other number is given)"),
    notes: S("Other useful private details: room type, guests, booking site, taxes, deposit"),
    arrival: req({ wifiName: S("Stays: Wi-Fi network name"), wifiPass: S("Stays: Wi-Fi password"), doorCode: S("Stays: door / gate / keypad / lockbox code and where it is"),
      checkin: S("Stays: how to check in / get the keys, short"), checkout: S("Stays: check-out instructions, short"), parking: S("Stays: parking details"),
      houseRules: S("Stays: house rules, short, separated by ' · '"), hostName: S("Stays: host or property contact name"), hostPhone: S("Stays: host or property phone, international format"),
      hostEmail: S("Stays: host or property email"), notes: S("Stays: anything else useful on arrival, short") }),
  }),
  journeys: { type: "array", description: "Flights only: ONE entry per separate journey on different days, e.g. the outbound AND the return flight of a return ticket. Connections on the way to one destination (e.g. LAX-IAH-TQO the same day) are ONE journey. Empty for other bookings.",
    items: req({ route: S("Airport codes joined with '-', e.g. BNE-AKL"), airline: S("Airline name"), number: S("Flight number(s), e.g. NZ148"),
      start: S("Departure date YYYY-MM-DD"), end: S("Arrival date YYYY-MM-DD"), dep: S("Departure time HH:MM"), arr: S("Arrival time HH:MM; add (dd-Mon) if next day") }) },
  unsure: { type: "array", items: { type: "string" }, description: "Names of fields you guessed or could not read clearly, e.g. ['checkin','phone','who']; empty if all are clearly in the document" },
});
let aiModel = null;
async function getModel(tryIndex = 0, schema = EXTRACT_SCHEMA) {
  const aiM = await import(`${FIREBASE_SDK}/firebase-ai.js`);
  const Backend = aiM.AgentPlatformBackend || aiM.VertexAIBackend;
  const ai = aiM.getAI(fb.app, { backend: new Backend(AI_LOCATION) });
  return aiM.getGenerativeModel(ai, { model: AI_MODELS[tryIndex],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 } });
}
// A portrait avatar drawn by AI from a photo (a data URL in, a data URL out). The picture comes back on plain white; the app then cuts the white away.
export async function avatarAI(photoDataUrl) {
  if (DEMO) { await new Promise((r) => setTimeout(r, 500));   // demo: a simple drawn head on white, so the rest of the flow can be tried
    const cv = document.createElement("canvas"); cv.width = cv.height = 256; const g = cv.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 256, 256); g.fillStyle = "#3A2A22"; g.beginPath(); g.arc(128, 100, 62, 0, 7); g.fill();
    g.fillStyle = "#E8B894"; g.beginPath(); g.arc(128, 112, 52, 0, 7); g.fill(); g.fillStyle = "#2B3A55"; g.beginPath(); g.ellipse(128, 262, 96, 84, 0, 0, 7); g.fill();
    return cv.toDataURL("image/png"); }
  const aiM = await import(`${FIREBASE_SDK}/firebase-ai.js`);
  const Backend = aiM.AgentPlatformBackend || aiM.VertexAIBackend;
  const ai = aiM.getAI(fb.app, { backend: new Backend(AI_LOCATION) });
  const [head, b64] = String(photoDataUrl).split(","), mimeType = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const prompt = "Redraw the person in this photo as a clean, modern portrait avatar for an app profile: head and shoulders, facing the viewer, centred, filling most of the frame. "
    + "Keep a natural likeness - the same hair, skin tone, age, glasses and facial hair if any - with a calm, friendly expression. "
    + "Style: tasteful flat illustration with simple shapes and soft shading, like a professional profile illustration. Not a cartoon, not childish, no emoji look, no exaggerated features. "
    + "No text, no border, no frame, no shadow on the background. The background must be perfectly plain pure white (#FFFFFF) and nothing else. Square image.";
  let lastErr = null;
  for (const model of AI_IMAGE_MODELS) {
    try {
      const m = aiM.getGenerativeModel(ai, { model, generationConfig: { responseModalities: [aiM.ResponseModality?.IMAGE || "IMAGE"] } });
      const res = await m.generateContent([prompt, { inlineData: { mimeType, data: b64 } }]);
      const part = res.response.inlineDataParts?.()?.[0]?.inlineData;
      if (!part?.data) throw new Error("The AI didn't return a picture (it may have declined this photo)");
      return `data:${part.mimeType || "image/png"};base64,${part.data}`;
    } catch (e) { lastErr = e; console.warn("avatar AI", model, e); if (!/not found|404|unsupported|not supported|invalid.*model|permission|unavailable|deprecated/i.test(e.message || "")) break; }
  }
  throw lastErr || new Error("No image model available");
}
const dropEmpty = (o) => { for (const k of Object.keys(o)) { const v = o[k];
  if (v && typeof v === "object" && !Array.isArray(v)) dropEmpty(v); else if (v === "" || v === null) delete o[k]; } return o; };
const toBase64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(file); });
// A return / multi-city ticket: the booking itself is the first journey; the others are in x.journeys (each becomes its own flight)
function splitJourneys(x) {
  const js = (x.journeys || []).filter((j) => j && j.start && j.route);
  if (x.type !== "flight" || js.length < 2) { delete x.journeys; return x; }
  js.sort((a, b) => a.start.localeCompare(b.start));
  Object.assign(x, { route: js[0].route, airline: js[0].airline || x.airline, number: js[0].number, start: js[0].start, end: js[0].end || js[0].start, dep: js[0].dep, arr: js[0].arr });
  x.journeys = js; return dropEmpty(x);
}
export async function extractFromFile(file, hint, ctx) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 600));
    if (/sky|voucher/i.test(file.name)) return { type: "activity", who: ctx.travellers.map((t) => t.code), text: "Sky Tower Single Entry e-voucher", place: "Sky Tower, Auckland", flexible: true, validFrom: "2026-08-15", validTo: "2027-02-15", start: "", end: "", private: { confirmation: "RMKY17M", cost: "NZD 121.14" } };
    if (/return/i.test(file.name)) return splitJourneys({ type: "flight", who: ctx.travellers.map((t) => t.code), airline: "Air New Zealand", private: { confirmation: "5XFRSH" },
      journeys: [{ route: "CHC-BNE", number: "NZ205", start: "2027-01-20", end: "2027-01-20", dep: "06:00", arr: "07:05" }, { route: "BNE-AKL", number: "NZ148", start: "2027-01-10", end: "2027-01-11", dep: "19:35", arr: "00:45 (11-Jan)" }] });
    return { type: hint === "activity" ? "activity" : "stay", who: ctx.travellers.map((t) => t.code), start: "2027-01-14", end: "2027-01-15",
             name: "Demo Hotel Orlando", short: "Demo Hotel", address: "1 Demo Way, Orlando, FL", checkin: "15:00", checkout: "11:00",
             text: "Demo activity from " + file.name, place: "Epic Universe", note: "Filled from " + file.name,
             private: { confirmation: "DEMO123", cost: "AU$100.00", cancel: "Free cancellation until 1 day before", ...(/airbnb|house|casa/i.test(file.name) ? { arrival: { wifiName: "Casa-Demo", wifiPass: "playa2026", doorCode: "4821 lockbox by the gate", hostName: "Ana", hostPhone: "+52 984 123 4567" } } : {}) } };
  }
  const people = ctx.travellers.map((t) => `${t.code} = ${t.fullName || t.name}`).concat((ctx.extended || []).map((t) => `${t.code} = ${t.name}`)).join("; ");
  const prompt = `Read this travel booking confirmation for a family trip (${ctx.start} to ${ctx.end}) and extract it into the JSON schema.
Traveller codes: ${people}. Put in "who" only the codes of these main travellers who are on the booking: ${ctx.travellers.map((t) => t.code).join(", ")}
(match by name; only if the booking names nobody and just gives a head count such as "2 adults, 1 child", include the travellers that fits).
If the booking names passengers / guests and none of them is one of these travellers, leave "who" empty - do not guess.
The user expects a "${hint}" booking but set "type" to what the document really is.
Read the WHOLE document, every page, and fill EVERY field that applies to this type of booking - address, times, confirmation number,
price, payment, cancellation policy and phone are almost always somewhere in a confirmation, often in small print.
For an open-dated voucher or pass (valid for a period, no booked visit date): set "flexible" true, put the validity period in validFrom/validTo, and leave start/end "" unless a visit date is booked. Never use the purchase / order date as the activity date.
The file is called "${file.name}" - its name may contain the intended date.
For a return or multi-city flight booking, list EVERY separate journey in "journeys" (e.g. BNE-AKL on 17 Sep and CHC-BNE on 5 Oct) and fill the top-level flight fields with the FIRST journey only.
For a hotel, "end" is the check-out date (a 1-night stay from 8 Jan has end 9 Jan). Hotel check-in/check-out times are often in the policies section.
Dates as YYYY-MM-DD, times as 24h HH:MM. Use "" only for fields that really are not in the document or don't apply to this type. Keep texts short.`;
  const parts = [{ inlineData: { mimeType: file.type || "application/pdf", data: await toBase64(file) } }, { text: prompt }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try {
      if (!aiModel || aiModel._i !== i) { aiModel = await getModel(i); aiModel._i = i; }
      const res = await aiModel.generateContent(parts);
      return splitJourneys(dropEmpty(JSON.parse(res.response.text())));
    } catch (e) {
      lastErr = e; aiModel = null; console.warn("AI model", AI_MODELS[i], "failed:", e.message);
      if (i > 0) e.message = `[tried ${AI_MODELS.slice(0, i + 1).join(", ")}] ` + e.message;
      if (!/not.?found|404|unsupported|model/i.test(String(e.message || e))) break;   // only fall back on a model problem
    }
  }
  throw lastErr;
}

