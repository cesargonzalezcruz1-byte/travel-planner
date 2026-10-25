// Data layer: Firebase (Auth + Firestore + Storage) or an in-memory demo store for local testing.
// Data model: trips/{tripId} (title, start, end, travellers, extended) with subcollections
//   items (flights/stays/cars), entries (activities/comments), private (editors only), files (editors only).
import { firebaseConfig, FAMILY_EMAIL, EDITORS, FIREBASE_SDK, AI_MODELS, AI_LOCATION } from "./firebase-config.js";

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
const clearTrip = () => Object.assign(store, { trip: null, items: [], entries: [], priv: {}, files: [], journal: [], journalError: "" });

// ---------------- demo store (local testing only)
const demo = { trips: {}, people: {}, vault: {} };   // id -> {trip, items, entries, priv, files}
function demoLoad(id) {
  const t = demo.trips[id]; if (!t) { clearTrip(); return; }
  Object.assign(store, { trip: t.trip, items: t.items, entries: t.entries, priv: store.role === "editor" ? t.priv : {}, files: store.role === "editor" ? t.files : [], journal: (t.journal = t.journal || []) });
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
  for (const name of ["items", "entries", "private", "files", "journal"]) {
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
export async function deleteJournal(id) {
  if (DEMO) { const t = mem(); t.journal = (t.journal || []).filter((x) => x.id !== id && x.replyTo !== id); demoLoad(store.tripId); emit(); return; }
  for (const r of store.journal.filter((x) => x.replyTo === id)) await fb.fsM.deleteDoc(fb.fsM.doc(col("journal"), r.id)).catch(() => {});
  await fb.fsM.deleteDoc(fb.fsM.doc(col("journal"), id));
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
export async function uploadFile(file, { itemId = "", entryId = "", date = "" } = {}) {
  const id = uid("file");
  const meta = { name: file.name, size: file.size, contentType: file.type || "application/octet-stream", itemId, entryId, date, uploadedBy: store.email, uploadedAt: now() };
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
export async function deleteFile(f) {
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
    cancel: S("Cancellation rule in one line, with the deadline date"), phone: S("Phone number of the hotel / airline / rental company itself (not the booking website's customer service line, unless no other number is given)"),
    notes: S("Other useful private details: room type, guests, booking site, taxes, deposit"),
  }),
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

