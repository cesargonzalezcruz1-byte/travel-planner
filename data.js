// Data layer: Firebase (Auth + Firestore + Storage) or an in-memory demo store for local testing.
import { firebaseConfig, FAMILY_EMAIL, EDITORS, TRIP_ID, FIREBASE_SDK, AI_MODELS, AI_LOCATION } from "./firebase-config.js";

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
export const DEMO = isLocal && new URLSearchParams(location.search).has("demo");

let fb = null;          // loaded Firebase modules + instances
const listeners = new Set();
export const store = { role: null, email: null, trip: null, items: [], entries: [], priv: {}, files: [], ready: false };
const emit = () => listeners.forEach((fn) => fn(store));
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const uid = (p) => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ------------------------------------------------------------------ init / auth
export async function init(onAuth) {
  if (DEMO) {
    const seed = await (await fetch("./seed/trip-seed.json")).json();
    loadSeedIntoMemory(seed);
    const role = new URLSearchParams(location.search).get("demo") === "family" ? "family" : "editor";
    store.role = role; store.email = role === "editor" ? EDITORS[0] : FAMILY_EMAIL;
    if (role === "family") { store.priv = {}; store.files = []; }
    store.ready = true; onAuth(store.role); emit();
    return;
  }
  const [appM, authM, fsM, stM] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
    import(`${FIREBASE_SDK}/firebase-storage.js`),
  ]);
  const app = appM.initializeApp(firebaseConfig);
  const auth = authM.getAuth(app);
  let db;
  try {
    db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) });
  } catch (e) { db = fsM.getFirestore(app); }
  fb = { app, authM, fsM, stM, auth, db, storage: stM.getStorage(app) };
  try { await authM.getRedirectResult(auth); } catch (e) { /* ignore */ }
  authM.onAuthStateChanged(auth, (user) => {
    stopSubscriptions();
    if (!user) { Object.assign(store, { role: null, email: null, trip: null, items: [], entries: [], priv: {}, files: [], ready: true }); onAuth(null); emit(); return; }
    const email = (user.email || "").toLowerCase();
    store.email = email;
    store.role = EDITORS.includes(email) ? "editor" : email === FAMILY_EMAIL ? "family" : "none";
    store.ready = true; onAuth(store.role);
    if (store.role === "editor" || store.role === "family") subscribe();
    emit();
  });
}

export async function signInFamily(password) {
  if (DEMO) return;
  await fb.authM.signInWithEmailAndPassword(fb.auth, FAMILY_EMAIL, password);
}
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
export async function signOut() {
  if (DEMO) { location.href = location.pathname; return; }
  await fb.authM.signOut(fb.auth);
}

// ------------------------------------------------------------------ live data
let unsubs = [];
function stopSubscriptions() { unsubs.forEach((u) => u()); unsubs = []; }
function col(name) { return fb.fsM.collection(fb.db, "trips", TRIP_ID, name); }
function subscribe() {
  const { fsM } = fb;
  unsubs.push(fsM.onSnapshot(fsM.doc(fb.db, "trips", TRIP_ID), (s) => { store.trip = s.exists() ? s.data() : null; emit(); }, onErr));
  unsubs.push(fsM.onSnapshot(col("items"), (s) => { store.items = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  unsubs.push(fsM.onSnapshot(col("entries"), (s) => { store.entries = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  if (store.role === "editor") {
    unsubs.push(fsM.onSnapshot(col("private"), (s) => { store.priv = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); emit(); }, onErr));
    unsubs.push(fsM.onSnapshot(col("files"), (s) => { store.files = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }, onErr));
  }
}
function onErr(e) { console.error(e); store.error = e.code === "permission-denied" ? "This login doesn't have access to the trip." : e.message; emit(); }

// ------------------------------------------------------------------ writes (editors)
const clean = (o) => JSON.parse(JSON.stringify(o));
export async function saveItem(item, priv) {
  const id = item.id || uid(item.type[0]);
  const data = clean({ ...item, id: undefined, updatedBy: store.email, updatedAt: new Date().toISOString() });
  if (DEMO) {
    const i = store.items.findIndex((x) => x.id === id);
    const full = { id, ...data };
    if (i >= 0) store.items[i] = full; else store.items.push(full);
    if (priv) store.priv[id] = priv;
    emit(); return id;
  }
  const { fsM } = fb;
  await fsM.setDoc(fsM.doc(col("items"), id), data);
  if (priv) await fsM.setDoc(fsM.doc(col("private"), id), clean(priv));
  return id;
}
export async function deleteItem(id) {
  if (DEMO) { store.items = store.items.filter((x) => x.id !== id); delete store.priv[id]; emit(); return; }
  const { fsM } = fb;
  await fsM.deleteDoc(fsM.doc(col("items"), id));
  await fsM.deleteDoc(fsM.doc(col("private"), id));
}
export async function saveEntry(entry) {
  const id = entry.id || uid("e");
  const data = clean({ ...entry, id: undefined, updatedBy: store.email, updatedAt: new Date().toISOString() });
  if (DEMO) {
    const i = store.entries.findIndex((x) => x.id === id);
    if (i >= 0) store.entries[i] = { id, ...data }; else store.entries.push({ id, ...data });
    emit(); return id;
  }
  await fb.fsM.setDoc(fb.fsM.doc(col("entries"), id), data);
  return id;
}
export async function deleteEntry(id) {
  if (DEMO) { store.entries = store.entries.filter((x) => x.id !== id); emit(); return; }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("entries"), id));
}

// ------------------------------------------------------------------ files (editors)
export async function uploadFile(file, { itemId = "", entryId = "", date = "" } = {}) {
  const id = uid("file");
  const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream", itemId, entryId, date,
                 uploadedBy: store.email, uploadedAt: new Date().toISOString() };
  if (DEMO) { store.files.push({ id, ...meta, path: "", demoUrl: URL.createObjectURL(file) }); emit(); return; }
  const path = `trips/${TRIP_ID}/files/${id}/${file.name}`;
  const ref = fb.stM.ref(fb.storage, path);
  await fb.stM.uploadBytes(ref, file, { contentType: meta.contentType });
  await fb.fsM.setDoc(fb.fsM.doc(col("files"), id), { ...meta, path });
}
export async function fileUrl(f) {
  if (DEMO) return f.demoUrl || "#";
  return fb.stM.getDownloadURL(fb.stM.ref(fb.storage, f.path));
}
export async function updateFile(id, patch) {
  if (DEMO) { Object.assign(store.files.find((f) => f.id === id), patch); emit(); return; }
  await fb.fsM.updateDoc(fb.fsM.doc(col("files"), id), patch);
}
export async function deleteFile(f) {
  if (DEMO) { store.files = store.files.filter((x) => x.id !== f.id); emit(); return; }
  try { await fb.stM.deleteObject(fb.stM.ref(fb.storage, f.path)); } catch (e) { /* already gone */ }
  await fb.fsM.deleteDoc(fb.fsM.doc(col("files"), f.id));
}

// ------------------------------------------------------------------ import / export
function loadSeedIntoMemory(seed) {
  store.trip = seed.trip;
  store.items = seed.items.map((x) => ({ ...x }));
  store.entries = seed.entries.map((x) => ({ ...x }));
  store.priv = Object.fromEntries((seed.privateItems || []).map(({ id, ...rest }) => [id, rest]));
  store.files = [];
}
export async function importSeed(seed) {
  if (!seed || !seed.trip || !Array.isArray(seed.items)) throw new Error("This file isn't a trip data file.");
  if (DEMO) { loadSeedIntoMemory(seed); emit(); return; }
  const { fsM } = fb;
  const writes = [];
  writes.push([fsM.doc(fb.db, "trips", TRIP_ID), clean({ ...seed.trip, id: undefined })]);
  for (const it of seed.items) writes.push([fsM.doc(col("items"), it.id), clean({ ...it, id: undefined })]);
  for (const e of seed.entries || []) writes.push([fsM.doc(col("entries"), e.id), clean({ ...e, id: undefined })]);
  for (const p of seed.privateItems || []) { const { id, ...rest } = p; writes.push([fsM.doc(col("private"), id), clean(rest)]); }
  for (let i = 0; i < writes.length; i += 400) {
    const batch = fsM.writeBatch(fb.db);
    writes.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
  }
}
export function exportAll() {
  return {
    version: 1, exportedAt: new Date().toISOString(), trip: store.trip,
    items: store.items, entries: store.entries,
    privateItems: Object.entries(store.priv).map(([id, v]) => ({ id, ...v })),
    files: store.files.map(({ demoUrl, ...f }) => f),
  };
}

// ------------------------------------------------------------------ AI: read a booking PDF / photo (editors)
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["flight", "stay", "car", "activity"], description: "What the document books" },
    who: { type: "array", items: { type: "string" }, description: "Traveller codes on the booking" },
    start: { type: "string", description: "First date YYYY-MM-DD (flight departure / check-in / pick-up / activity date)" },
    end: { type: "string", description: "Last date YYYY-MM-DD (flight arrival date / check-out / drop-off)" },
    route: { type: "string", description: "Flight: airport codes joined with '-', e.g. LAX-IAH-TQO" },
    airline: { type: "string" }, number: { type: "string", description: "Flight numbers, e.g. UA1306/1600" },
    dep: { type: "string", description: "Departure time HH:MM (24h)" }, arr: { type: "string", description: "Arrival time HH:MM (24h); add (dd-Mon) if next day" },
    name: { type: "string", description: "Hotel / property / activity name" }, short: { type: "string", description: "Short hotel name, max 14 characters" },
    address: { type: "string" }, checkin: { type: "string", description: "HH:MM" }, checkout: { type: "string", description: "HH:MM" },
    company: { type: "string", description: "Car rental company" }, vehicle: { type: "string", description: "Short vehicle description, e.g. 7-seat SUV" },
    pickup: { type: "string", description: "Short pick-up location, e.g. LAX or MIA" }, dropoff: { type: "string" },
    pickupTime: { type: "string" }, dropoffTime: { type: "string" },
    text: { type: "string", description: "Activity: short description, e.g. 'Xcaret full day + evening show'" },
    place: { type: "string", description: "Activity: place name for Google Maps" }, time: { type: "string" },
    note: { type: "string", description: "One short practical note for the family (no confirmation numbers)" },
    private: { type: "object", properties: {
      confirmation: { type: "string" }, tickets: { type: "string" }, seats: { type: "string" }, cost: { type: "string", description: "Total paid with currency" },
      paidWith: { type: "string" }, cancel: { type: "string", description: "Cancellation rule in one line" }, phone: { type: "string" }, notes: { type: "string" } } },
  },
  required: ["type"],
};
let aiModel = null;
async function getModel(tryIndex = 0) {
  const aiM = await import(`${FIREBASE_SDK}/firebase-ai.js`);
  const Backend = aiM.AgentPlatformBackend || aiM.VertexAIBackend;
  const ai = aiM.getAI(fb.app, { backend: new Backend(AI_LOCATION) });
  return aiM.getGenerativeModel(ai, { model: AI_MODELS[tryIndex],
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: EXTRACT_SCHEMA, temperature: 0 } });
}
const toBase64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = bad; r.readAsDataURL(file); });
export async function extractFromFile(file, hint, ctx) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 600));
    return { type: hint === "activity" ? "activity" : "stay", who: ctx.travellers.map((t) => t.code), start: "2027-01-14", end: "2027-01-15",
             name: "Demo Hotel Orlando", short: "Demo Hotel", address: "1 Demo Way, Orlando, FL", checkin: "15:00", checkout: "11:00",
             text: "Demo activity from " + file.name, place: "Epic Universe", note: "Filled from " + file.name,
             private: { confirmation: "DEMO123", cost: "AU$100.00", cancel: "Free cancellation until 1 day before" } };
  }
  const people = ctx.travellers.map((t) => `${t.code} = ${t.name}`).concat((ctx.extended || []).map((t) => `${t.code} = ${t.name}`)).join("; ");
  const prompt = `You read travel booking confirmations for a family trip (${ctx.start} to ${ctx.end}).
Traveller codes: ${people}. Full names: CGC = Cesar Gonzalez Cruz, CGM = Chloe Gonzalez Mondragon, DBMV = Debora Beatriz Mondragon Velazquez,
RGA = Raul Gonzalez Apaolaza, MCN = Margarita Cruz de Gonzalez. Put in "who" only codes of CGC, CGM, DBMV who are on the booking
(if the booking says e.g. "2 adults, 1 child" for Cesar, assume CGC, DBMV, CGM).
The user expects a "${hint}" booking but set "type" to what the document really is.
Dates as YYYY-MM-DD, times as 24h HH:MM. Fill only fields you can read in the document; leave others out. Keep texts short.`;
  const parts = [{ text: prompt }, { inlineData: { mimeType: file.type || "application/pdf", data: await toBase64(file) } }];
  let lastErr;
  for (let i = 0; i < AI_MODELS.length; i++) {
    try {
      if (!aiModel || aiModel._i !== i) { aiModel = await getModel(i); aiModel._i = i; }
      const res = await aiModel.generateContent(parts);
      return JSON.parse(res.response.text());
    } catch (e) {
      lastErr = e; aiModel = null; console.warn("AI model", AI_MODELS[i], "failed:", e.message);
      if (i > 0) e.message = `[tried ${AI_MODELS.slice(0, i + 1).join(", ")}] ` + e.message;
      if (!/not.?found|404|unsupported|model/i.test(String(e.message || e))) break;   // only fall back on a model problem
    }
  }
  throw lastErr;
}

// One-time update: give every activity a "confirmed" flag (only confirmed ones show in the grid)
export async function migrateConfirmed(isConfirmed) {
  if (DEMO) { store.entries.forEach((e) => { if (e.confirmed === undefined) e.confirmed = isConfirmed(e); }); store.trip.schema = 2; emit(); return; }
  const { fsM } = fb; const batch = fsM.writeBatch(fb.db);
  store.entries.filter((e) => e.confirmed === undefined).forEach((e) => batch.update(fsM.doc(col("entries"), e.id), { confirmed: isConfirmed(e) }));
  batch.set(fsM.doc(fb.db, "trips", TRIP_ID), { schema: 2 }, { merge: true });
  await batch.commit();
}
