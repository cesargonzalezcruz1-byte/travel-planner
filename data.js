// Data layer: Firebase (Auth + Firestore + Storage) or an in-memory demo store for local testing.
import { firebaseConfig, FAMILY_EMAIL, EDITORS, TRIP_ID, FIREBASE_SDK } from "./firebase-config.js";

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
  fb = { authM, fsM, stM, auth, db, storage: stM.getStorage(app) };
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
export async function uploadFile(file, { itemId = "", date = "" } = {}) {
  const id = uid("file");
  const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream", itemId, date,
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
