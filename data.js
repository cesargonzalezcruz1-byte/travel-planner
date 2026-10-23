// Data layer: Firebase (Auth + Firestore + Storage) or an in-memory demo store for local testing.
// Data model: trips/{tripId} (title, start, end, travellers, extended) with subcollections
//   items (flights/stays/cars), entries (activities/comments), private (editors only), files (editors only).
import { firebaseConfig, FAMILY_EMAIL, EDITORS, FIREBASE_SDK, AI_MODELS, AI_LOCATION } from "./firebase-config.js";

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
export const DEMO = isLocal && new URLSearchParams(location.search).has("demo");

let fb = null;
const listeners = new Set();
export const store = { role: null, email: null, trips: [], tripsLoaded: false, tripId: null, trip: null,
                       items: [], entries: [], priv: {}, files: [], ready: false };
const emit = () => listeners.forEach((fn) => fn(store));
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const uid = (p) => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (o) => JSON.parse(JSON.stringify(o));
const now = () => new Date().toISOString();
const clearTrip = () => Object.assign(store, { trip: null, items: [], entries: [], priv: {}, files: [] });

// ---------------- demo store (local testing only)
const demo = { trips: {} };   // id -> {trip, items, entries, priv, files}
function demoLoad(id) {
  const t = demo.trips[id]; if (!t) { clearTrip(); return; }
  Object.assign(store, { trip: t.trip, items: t.items, entries: t.entries, priv: store.role === "editor" ? t.priv : {}, files: store.role === "editor" ? t.files : [] });
}
const demoList = () => { store.trips = Object.entries(demo.trips).map(([id, t]) => ({ id, ...t.trip })); store.tripsLoaded = true; };

// ------------------------------------------------------------------ init / auth
export async function init(onAuth) {
  if (DEMO) {
    const seed = await (await fetch("./seed/trip-seed.json")).json();
    demo.trips[seed.trip.id] = seedToMem(seed);
    const role = new URLSearchParams(location.search).get("demo") === "family" ? "family" : "editor";
    store.role = role; store.email = role === "editor" ? EDITORS[0] : FAMILY_EMAIL;
    demoList(); store.ready = true; onAuth(store.role); emit();
    return;
  }
  const [appM, authM, fsM, stM] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`), import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`), import(`${FIREBASE_SDK}/firebase-storage.js`),
  ]);
  const app = appM.initializeApp(firebaseConfig);
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
export async function signOut() { if (DEMO) { location.href = location.pathname; return; } await fb.authM.signOut(fb.auth); }

// ------------------------------------------------------------------ trips list + open trip
let listUnsub = null, tripUnsubs = [];
function stopList() { if (listUnsub) listUnsub(); listUnsub = null; }
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
  for (const name of ["items", "entries", "private", "files"]) {
    const snap = await fsM.getDocs(fsM.collection(fb.db, "trips", id, name));
    for (const d of snap.docs) {
      if (name === "files" && d.data().path) { try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, d.data().path)); } catch (e) { /* gone */ } }
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
export async function deleteItem(id) {
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
  if (DEMO) { const t = mem(); t.entries = t.entries.filter((x) => x.id !== id); demoLoad(store.tripId); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("entries"), id));
}

// ------------------------------------------------------------------ files (editors)
export async function uploadFile(file, { itemId = "", entryId = "", date = "" } = {}) {
  const id = uid("file");
  const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream", itemId, entryId, date, uploadedBy: store.email, uploadedAt: now() };
  if (DEMO) { mem().files.push({ id, ...meta, path: "", demoUrl: URL.createObjectURL(file) }); demoLoad(store.tripId); emit(); return; }
  const path = `trips/${store.tripId}/files/${id}/${file.name}`;
  await fb.stM.uploadBytes(fb.stM.ref(fb.storage, path), file, { contentType: meta.contentType });
  await fb.fsM.setDoc(fb.fsM.doc(col("files"), id), { ...meta, path });
}
export async function fileUrl(f) { return DEMO ? f.demoUrl || "#" : fb.stM.getDownloadURL(fb.stM.ref(fb.storage, f.path)); }
export async function deleteFile(f) {
  if (DEMO) { const t = mem(); t.files = t.files.filter((x) => x.id !== f.id); demoLoad(store.tripId); emit(); return; }
  try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, f.path)); } catch (e) { /* already gone */ }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("files"), f.id));
}

// ------------------------------------------------------------------ import / export
function seedToMem(seed) {
  return { trip: { ...seed.trip }, items: seed.items.map((x) => ({ ...x })), entries: seed.entries.map((x) => ({ ...x })),
           priv: Object.fromEntries((seed.privateItems || []).map(({ id, ...rest }) => [id, rest])), files: [] };
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
  return { version: 1, exportedAt: now(), trip: { id: store.tripId, ...store.trip }, items: store.items, entries: store.entries,
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
  checkin: S("Hotel check-in time HH:MM (24h), e.g. 15:00"), checkout: S("Hotel check-out time HH:MM (24h), e.g. 11:00"),
  company: S("Car rental company"), vehicle: S("Short vehicle description, e.g. 7-seat SUV"),
  pickup: S("Car pick-up location, short, e.g. MIA airport"), dropoff: S("Car drop-off location, short"),
  pickupTime: S("Car pick-up time HH:MM"), dropoffTime: S("Car drop-off time HH:MM"),
  text: S("Activity: short description, e.g. 'Xcaret full day + evening show'"),
  place: S("Activity: place name for Google Maps"), time: S("Activity start time HH:MM"),
  note: S("One short practical note for the family, e.g. room type, breakfast included, parking, shuttle (no confirmation numbers or prices)"),
  private: req({
    confirmation: S("Booking / confirmation / reservation / itinerary number(s)"), tickets: S("Ticket numbers"), seats: S("Seat numbers"),
    cost: S("Total price with currency, e.g. USD 245.10"), paidWith: S("Payment card or method, e.g. Visa ending 1234, or 'Pay at hotel'"),
    dueAtHotel: S("Amount still to pay at the property, with currency"),
    cancel: S("Cancellation rule in one line, with the deadline date"), phone: S("Phone number of the hotel / company"),
    notes: S("Other useful private details: room type, guests, booking site, taxes, deposit"),
  }),
});
let aiModel = null;
async function getModel(tryIndex = 0) {
  const aiM = await import(`${FIREBASE_SDK}/firebase-ai.js`);
  const Backend = aiM.AgentPlatformBackend || aiM.VertexAIBackend;
  const ai = aiM.getAI(fb.app, { backend: new Backend(AI_LOCATION) });
  return aiM.getGenerativeModel(ai, { model: AI_MODELS[tryIndex],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: EXTRACT_SCHEMA, temperature: 0 } });
}
const dropEmpty = (o) => { for (const k of Object.keys(o)) { const v = o[k];
  if (v && typeof v === "object" && !Array.isArray(v)) dropEmpty(v); else if (v === "" || v === null) delete o[k]; } return o; };
const toBase64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(file); });
export async function extractFromFile(file, hint, ctx) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 600));
    return { type: hint === "activity" ? "activity" : "stay", who: ctx.travellers.map((t) => t.code), start: "2027-01-14", end: "2027-01-15",
             name: "Demo Hotel Orlando", short: "Demo Hotel", address: "1 Demo Way, Orlando, FL", checkin: "15:00", checkout: "11:00",
             text: "Demo activity from " + file.name, place: "Epic Universe", note: "Filled from " + file.name,
             private: { confirmation: "DEMO123", cost: "AU$100.00", cancel: "Free cancellation until 1 day before" } };
  }
  const people = ctx.travellers.map((t) => `${t.code} = ${t.fullName || t.name}`).concat((ctx.extended || []).map((t) => `${t.code} = ${t.name}`)).join("; ");
  const prompt = `Read this travel booking confirmation for a family trip (${ctx.start} to ${ctx.end}) and extract it into the JSON schema.
Traveller codes: ${people}. Put in "who" only the codes of these main travellers who are on the booking: ${ctx.travellers.map((t) => t.code).join(", ")}
(match by name; if the booking only gives a head count such as "2 adults, 1 child", include the travellers that fits).
The user expects a "${hint}" booking but set "type" to what the document really is.
Read the WHOLE document, every page, and fill EVERY field that applies to this type of booking - address, times, confirmation number,
price, payment, cancellation policy and phone are almost always somewhere in a confirmation, often in small print.
For a hotel, "end" is the check-out date (a 1-night stay from 8 Jan has end 9 Jan). Hotel check-in/check-out times are often in the policies section.
Dates as YYYY-MM-DD, times as 24h HH:MM. Use "" only for fields that really are not in the document or don't apply to this type. Keep texts short.`;
  const parts = [{ inlineData: { mimeType: file.type || "application/pdf", data: await toBase64(file) } }, { text: prompt }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try {
      if (!aiModel || aiModel._i !== i) { aiModel = await getModel(i); aiModel._i = i; }
      const res = await aiModel.generateContent(parts);
      return dropEmpty(JSON.parse(res.response.text()));
    } catch (e) {
      lastErr = e; aiModel = null; console.warn("AI model", AI_MODELS[i], "failed:", e.message);
      if (i > 0) e.message = `[tried ${AI_MODELS.slice(0, i + 1).join(", ")}] ` + e.message;
      if (!/not.?found|404|unsupported|model/i.test(String(e.message || e))) break;   // only fall back on a model problem
    }
  }
  throw lastErr;
}

