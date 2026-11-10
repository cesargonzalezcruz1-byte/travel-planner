import * as data from "./data.js";
import { drawDayMap, drawTripMap, mapsReady, searchPlaces, findPlace, geocodeText, computeRoute, distanceKm, addressSuggest, addressDone, nearbyEssentials, nearestConsulate } from "./map.js";
import { buildAlbum, areaOf } from "./album.js";
import { AIRPORT_TZ, TZ_COUNTRY, checkinUrl, checkinInfo, timeIn, isInternational } from "./checkin-core.js";
// Preview another date: add ?today=2027-01-14 to the address to see the app as it will look on that day
(() => { const m = location.search.match(/[?&]today=(\d{4}-\d{2}-\d{2})/); if (!m) return;
  const R = Date, off = new R(m[1] + "T12:00:00").getTime() - R.now();   // shift the clock, keep it ticking
  window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [R.now() + off])); } static now() { return R.now() + off; } };
  window.__previewDate = m[1];
})();

const { store } = data;

// ================================================================= helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const D = (s) => new Date(s + "T00:00:00");
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
const dayDiff = (a, b) => Math.round((D(b) - D(a)) / 86400000);
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (s) => { const d = D(s); return `${d.getDate()}-${MON[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`; };
const longDate = (s) => { const d = D(s); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const maps = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const isEditor = () => store.role === "editor";
const PEOPLE = () => (store.trip?.travellers || []).map((t) => t.code);
const ALL_CODES = () => (store.trip?.travellers || []).concat(store.trip?.extended || []).map((t) => t.code).filter(Boolean);
const NAME = (code) => (store.trip?.travellers || []).concat(store.trip?.extended || []).find((t) => t.code === code)?.name || code;

let ui = { person: localStorage.getItem("tp.person") || "", day: null, tripId: null, swap: {}, view: "overview" };
try { const v = localStorage.getItem("tp.view"); ui.view = ["now", "overview", "timeline", "journey", "budget", "journal", "more"].includes(v) ? v : "now"; } catch (e) { ui.view = "now"; }
try { ui.swap = JSON.parse(localStorage.getItem("tp.swap") || "{}"); } catch (e) { /* private mode */ }
// routes:  #/  (trips)   #/t/<tripId>   #/t/<tripId>/<YYYY-MM-DD>
function parseRoute() {
  const m = location.hash.match(/^#\/t\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}|before|after))?/);
  ui.tripId = m ? decodeURIComponent(m[1]) : null; ui.day = m && m[2] ? m[2] : null;
}
const routeTo = (tripId, day, replace = false) => {
  const h = tripId ? `#/t/${encodeURIComponent(tripId)}${day ? "/" + day : ""}` : "#/";
  if (replace) history.replaceState(null, "", h); else history.pushState(null, "", h);
  parseRoute(); render();
};
const days = () => {
  if (!store.trip) return [];
  const n = dayDiff(store.trip.start, store.trip.end);
  return Array.from({ length: n + 1 }, (_, i) => addDays(store.trip.start, i));
};
const itemsFor = (p) => store.items.filter((i) => (i.who || []).includes(p));
const entriesFor = (p, date) => store.entries.filter((e) => (e.who || []).includes(p) && e.date <= date && date <= (e.endDate || e.date));

// ---- rich text convention: initials blue, main names dark red, labels bold, TBC orange
function mainNames() {
  const s = new Set();
  for (const i of store.items.filter((x) => x.status !== "tbc")) for (const k of ["name", "short", "company"]) if (i[k] && i[k] !== "TBC" && i[k].length > 2) s.add(i[k]);
  for (const e of store.entries) if (e.place && /[A-Z]/.test(e.place)) { const m = e.text.match(/- ([A-Z][\wéáíóúñ' ]+?)(?: \(|$| -)/); if (m) s.add(m[1].trim()); }
  return [...s].sort((a, b) => b.length - a.length);
}
let tokenRe = null, tokenKey = "";
function fmt(text) {
  const names = mainNames(); const codes = ALL_CODES().concat(ALL_CODES().map((c) => NAME(c)).filter((n) => n && n.length > 1)); const key = names.join("|") + "#" + codes.join("|");
  if (!tokenRe || key !== tokenKey) {
    tokenKey = key;
    const nameAlt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    tokenRe = new RegExp(
      `(?<init>${codes.length ? `\\b(?:${codes.map((c) => c.replace(/[^A-Za-zÀ-ÿ0-9]/g, "")).filter(Boolean).join("|")})\\b|` : ""}^All(?=:))|(?<tbc>\\bTBC\\b)|(?<main>\\b[A-Z]{3}(?:-[A-Z]{3})+\\b${nameAlt ? "|" + nameAlt : ""})` +
      `|(?<label>\\b(?:Check-In|Check-Out|Pick-Up|Drop-Off)\\b|\\b(?:Vehicle|Location|Flight|Driver):|(?<![A-Za-z])[DA]:)`, "gm");
  }
  let out = "", pos = 0;
  for (const m of String(text ?? "").matchAll(tokenRe)) {
    out += esc(text.slice(pos, m.index));
    const g = Object.entries(m.groups).find(([, v]) => v !== undefined)[0];
    out += `<span class="t-${g}">${esc(m[0])}</span>`;
    pos = m.index + m[0].length;
  }
  return out + esc(String(text ?? "").slice(pos));
}
const lines = (...l) => l.filter(Boolean).join("\n");
const whoLabel = (who) => (PEOPLE().every((p) => who.includes(p)) ? "All" : who.map((w) => NAME(w) || w).join(" & "));

// ---- who sleeps where (drives the "together" ticks)
function nightKey(p, date) {
  const its = itemsFor(p);
  const st = its.find((i) => i.type === "stay" && i.start <= date && date < i.end);
  if (st) return st.id;
  const fl = its.find((i) => i.type === "flight" && i.start <= date && date <= i.end && i.start !== i.end);
  if (fl) return fl.id;
  if (store.trip && date === store.trip.end) return "home";
  return null;
}
const autoTogether = (a, b, date) => { const ka = nightKey(a, date); return ka !== null && ka === nightKey(b, date); };
// a manual choice on the day screen (stored on the trip, shared by both people) wins over the automatic answer
const together = (a, b, date) => { const o = store.trip?.together?.[date]?.[[a, b].sort().join("|")]; return typeof o === "boolean" ? o : autoTogether(a, b, date); };

// ---- item texts (as in the spreadsheet)
function texts(i) {
  if (i.type === "flight") return { block: lines(`${whoLabel(i.who)}: ${i.route}`, `Flight: ${i.airline} ${i.number}`, `D: ${i.dep}, A: ${i.arr}`) };
  if (i.type === "stay") {
    if (i.status === "tbc") return { start: "Check-In\nTBC", mid: `${i.name}\nAccommodation TBC`, end: "Check-Out\nTBC" };
    return { start: lines(`Check-In ${i.checkin || ""}`.trim(), i.short || i.name), mid: lines(i.name, i.address), end: lines(`Check-Out ${i.checkout || ""}`.trim(), i.short || "") };
  }
  const tbc = i.status === "tbc" ? " TBC" : "";
  return {
    start: lines(`Pick-Up ${i.pickupTime || ""}`.trim(), `${i.company}${i.pickup ? " (" + i.pickup + ")" : ""}${tbc}`),
    mid: lines(i.company + tbc, i.vehicle ? `Vehicle: ${i.vehicle}` : "", i.pickup && i.dropoff ? `Location: ${i.pickup} to ${i.dropoff}` : ""),
    end: lines(`Drop-Off ${i.dropoffTime || ""}`.trim(), `${i.company}${i.dropoff ? " (" + i.dropoff + ")" : ""}`),
  };
}

// ================================================================= rendering
const appRoot = $("#app");
let root = appRoot;   // where the current screen is drawn (a pane in split view)
function render() {
  const tabs = store.ready && store.role && store.role !== "none" && !!ui.tripId && !splitOn();
  if (!tabs) drawTabs(false);
  if (!store.ready) { root.innerHTML = `<div class="loading"><img class="logo-lg" src="icons/logo.svg" alt=""><br>Loading…</div>`; return; }
  if (!store.role) return renderLogin();
  if (store.role === "none") return renderNoAccess();
  if (!ui.tripId) { data.openTrip(ui.bgTrip || null); applyTheme(); renderHome(); return applyFocus(); }   // bgTrip: a trip's details loaded behind the home screen (Country Info)
  data.openTrip(ui.tripId);
  if (!store.trip && !store.items.length) { drawTabs(false); return renderEmpty(); }
  if (!PEOPLE().includes(ui.person)) ui.person = PEOPLE()[0];
  if (!ui.person) { drawTabs(false); return renderEmpty(); }
  applyTheme();
  if (ui.view === "budget" && !isEditor()) ui.view = "overview";
  if (splitOn() && (ui.view === "journal" || ui.view === "more")) ui.view = "overview";
  // during the trip, the app opens on Now (once per session)
  if (!ui.nowChecked && store.trip?.start) { ui.nowChecked = true; const td = iso(new Date()); if (td >= store.trip.start && td <= store.trip.end && !ui.day) ui.view = "now"; }
  if (splitOn()) { renderSplit(); return afterRender(); }
  root = appRoot; appRoot.classList.remove("is-split");
  renderView(ui.day ? "day" : ui.view); drawTabs(true);
  if (ui.slide) { root.querySelector(".ov,.tl,.journey,.dayview,.bd,.now")?.classList.add(ui.slide); ui.slide = null; }
  afterRender();
}
// ?focus=… from a notification: scroll to that card / section once the screen is drawn (or open a profile)
ui.focus = new URLSearchParams(location.search).get("focus");
function applyFocus() {
  if (!ui.focus || !store.ready || !store.role) return;
  const f = ui.focus;
  if (f === "todos") { if (!store.trip) return; ui.focus = null; clearFocusParam(); return setTimeout(todoSheet, 300); }
  if (f.startsWith("profile-")) { if (!store.people.length) return; ui.focus = null; clearFocusParam(); return personForm(f.slice(8)); }
  const el = document.getElementById(f);
  if (!el) {
    if (!ui.tripId || !store.items.length) return;   // still loading
    // the booking belongs to someone else: show it from their side (preferring a traveller this phone follows)
    const rec = f.startsWith("it-") ? store.items.find((x) => x.id === f.slice(3)) : f.startsWith("en-") ? store.entries.find((x) => x.id === f.slice(3)) : null;
    const who = rec?.who || [], mine = data.pushState()?.people || [];
    const p = who.find((c) => mine.includes(c)) || who[0];
    if (p && p !== ui.person && PEOPLE().includes(p) && !ui.focusSwitched) { ui.focusSwitched = true; ui.person = p; return render(); }
    ui.focus = null; clearFocusParam(); return;
  }
  ui.focus = null; clearFocusParam();
  if (f === "journal") jui.focus = "new";   // keep the cursor in the journal box through redraws
  const go = (flash) => { const t = document.getElementById(f); if (!t) return; t.scrollIntoView({ block: f === "journal" ? "start" : "center" });
    if (flash) { t.classList.add("flash"); setTimeout(() => document.getElementById(f)?.classList.remove("flash"), 2600); }
    if (f === "journal") t.querySelector("textarea")?.focus({ preventScroll: true }); };
  const hold = (ui.focusHold = { go, until: Date.now() + 5000, moved: false }); const stop = () => (hold.moved = true);
  window.addEventListener("touchstart", stop, { once: true }); window.addEventListener("wheel", stop, { once: true });
  setTimeout(() => go(true), 400); setTimeout(() => !hold.moved && go(false), 1500);   // again once the map and lists below have loaded
}
// redraws in the first few seconds (maps, recommendations, journal loading) keep the focused section in view
function holdFocus() { const h = ui.focusHold; if (!h) return; if (h.moved || Date.now() > h.until) { ui.focusHold = null; return; } setTimeout(() => !h.moved && h.go(false), 60); }
function clearFocusParam() { try { const u = new URL(location.href); u.searchParams.delete("focus"); history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (e) { /* ignore */ } }
function afterRender() {
  if (ui.tripId && isEditor()) setTimeout(() => syncOffline(), 1500);
  applyFocus(); holdFocus();
  splitWas = splitOn() + "|" + splitWide();
  if (isEditor() && store.trip) setTimeout(ensureRecs, 0);
}
const renderView = (v) => (v === "day" ? renderDay() : v === "now" ? renderNow() : v === "journey" ? renderJourney() : v === "timeline" ? renderTimeline() : v === "budget" && isEditor() ? renderBudget() : v === "journal" ? renderJournalTab() : v === "more" ? renderMore() : renderOverview());
// ---- split view: on an unfolded foldable, tablet or computer, two views side by side (left / right), each with its own view icons.
// A day opened from either side shows on the right; its home button brings the right side back to its view.
const SPLIT_MIN = 680;
const splitWide = () => window.innerWidth >= SPLIT_MIN || matchMedia("(horizontal-viewport-segments: 2)").matches;
const splitOn = () => !!ui.tripId && splitWide() && (localStorage.getItem("tp.split") ?? "1") === "1";
try { ui.split = JSON.parse(localStorage.getItem("tp.splitViews") || "null"); } catch (e) { /* ignore */ }
if (!Array.isArray(ui.split) || ui.split.length !== 2) ui.split = ["now", "journey"];
try { ui.splitPeople = JSON.parse(localStorage.getItem("tp.splitPeople") || "null"); } catch (e) { /* ignore */ }
if (!Array.isArray(ui.splitPeople) || ui.splitPeople.length !== 2) ui.splitPeople = [null, null];   // null = the main traveller
ui.splitDay = [null, null];   // a day open on that side (split view)
function renderSplit() {
  appRoot.classList.add("is-split");
  const ok = (v) => viewsFor().some((x) => x[0] === v) ? v : "overview";
  ui.split = [ok(ui.split[0]), ok(ui.split[1])];
  const keep = [...appRoot.querySelectorAll(":scope > .split > .pane")].map((p) => p.scrollTop);
  appRoot.innerHTML = `<div class="split"><div class="pane" data-pane="0"></div><div class="pane" data-pane="1"></div></div>`;
  const panes = appRoot.querySelectorAll(".pane"), saved = ui.view, me = ui.person;
  ui.splitPeople = ui.splitPeople.map((x) => (x && PEOPLE().includes(x) ? x : null));
  if (ui.day) { ui.splitDay[1] = ui.day; ui.day = null; }   // a day from the address opens on the right
  [0, 1].forEach((k) => {   // each side: its own view, traveller and open day
    const v = ui.splitDay[k] ? "day" : ui.split[k];
    root = panes[k]; ui.pane = k; ui.person = ui.splitPeople[k] || me; ui.day = ui.splitDay[k]; if (v !== "day") ui.view = v;
    renderView(v); if (keep[k]) panes[k].scrollTop = keep[k]; });
  ui.view = saved; ui.pane = null; ui.person = me; ui.day = null; root = panes[1];
}
const splitToggle = () => (splitWide() && ui.tripId ? `<button class="iconbtn splitbtn" data-split aria-label="${splitOn() ? "One view" : "Two views side by side"}" title="${splitOn() ? "One view" : "Two views side by side"}">${splitOn() ? ICON.single : ICON.split}</button>` : "");
let splitWas = null;
window.addEventListener("resize", () => { const w = splitOn() + "|" + splitWide(); if (splitWas !== null && w !== splitWas && store.ready) render(); splitWas = w; });

function renderLogin(err = "") {
  root.innerHTML = `
  <div class="login">
    <img class="logo-lg" src="icons/logo.svg" alt="Travel Planner logo"><h1 class="title-red">Travel Planner</h1>
    <p class="muted">Family itinerary</p>
    <form id="famForm" class="card">
      <label>Family Password</label>
      <input id="famPw" type="password" autocomplete="current-password" required placeholder="Enter the family password">
      <button class="btn primary" type="submit">Open Itinerary</button>
    </form>
    <div class="or">or</div>
    <button id="gBtn" class="btn">Sign In with Google (Editors)</button>
    <p class="err">${esc(err)}</p>
  </div>`;
  $("#famForm").onsubmit = async (e) => {
    e.preventDefault();
    try { await data.signInFamily($("#famPw").value); }
    catch (x) { renderLogin(x.code === "auth/invalid-credential" || x.code === "auth/wrong-password" ? "That password isn't right." : x.code === "auth/network-request-failed" ? "No connection - try again when you're online." : "Couldn't sign in (" + (x.code || x.message) + ")."); }
  };
  $("#gBtn").onclick = async () => { try { await data.signInEditor(); } catch (x) {
    renderLogin(x.code === "auth/admin-restricted-operation"
      ? "First-time Google sign-in is blocked because sign-ups are switched off in Firebase (Authentication > Settings > User actions). Switch it on, sign in once, then switch it off again."
      : x.code === "auth/unauthorized-domain" ? "This web address isn't allowed yet - add it under Firebase Authentication > Settings > Authorized domains."
      : x.code === "auth/popup-closed-by-user" ? "" : "Google sign-in failed (" + (x.code || x.message) + ")."); } };
}
function renderNoAccess() {
  root.innerHTML = `<div class="login"><img class="logo-lg" src="icons/logo.svg" alt="Travel Planner logo"><h1 class="title-red">Travel Planner</h1>
    <p>${esc(store.email)} isn't set up as an editor.</p><button class="btn" id="out">Sign Out</button></div>`;
  $("#out").onclick = data.signOut;
}
function renderEmpty() {
  const known = store.trips.find((t) => t.id === ui.tripId);
  root.innerHTML = `${header()}<div class="empty card">
    ${!store.tripsLoaded || known ? `<h2>Loading Trip…</h2>` : store.trip && !PEOPLE().length ? `<h2>No Travellers Yet</h2>
      ${isEditor() ? `<p>Add the travellers in the trip setup.</p><button class="btn primary" data-act="settings">Trip Setup</button>` : ""}`
      : `<h2>Trip Not Found</h2><p>It may have been deleted.</p>`}
    <p><button class="btn" data-home>← All Trips</button></p></div>`;
  wireHeader();
}

// ---------------------------------------------------------------- home (trip list)
function renderHome() {
  const today = iso(new Date());
  const trips = [...store.trips].sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const upcoming = trips.filter((t) => (t.end || "") >= today), past = trips.filter((t) => (t.end || "") < today);
  const card = (t) => {
    const days = t.start && t.end ? dayDiff(t.start, t.end) + 1 : 0;
    const status = t.start <= today && today <= t.end ? `<span class="tstat now">On now</span>` : t.start > today ? `<span class="tstat">in ${dayDiff(today, t.start)} days</span>` : `<span class="tstat past">Past</span>`;
    return `<article class="tripcard" data-open="${esc(t.id)}" role="button" tabindex="0">
      <div class="tc-top"><h3>${esc(t.title || "Untitled Trip")}</h3>${status}</div>${(() => { const iss = tripDocIssues(t); if (!iss.length) return "";
        const lvl = iss[0].st.level, who = [...new Set(iss.map((x) => x.per.code))];
        return `<button type="button" class="tc-warn ${lvl}" data-docwarn="${esc(t.id)}" title="${esc(iss.map((x) => (x.per.name || x.per.code) + ": " + x.st.text).join("\n"))}"><i class="ic16">${I.warn}</i>${lvl === "bad" ? "Document problem" : "Check documents"} · ${who.map(esc).join(", ")}</button>`; })()}
      <div class="tc-dates">${t.start ? `${longDate(t.start)} – ${longDate(t.end)} · ${days} days` : "Dates not set"}</div>
      <div class="tc-people">${(t.travellers || []).map((p, k) => avObj(p, upc(p.color) || TDEFAULT[k % TDEFAULT.length], (t.travellers || []).concat(t.extended || []))).join("")}</div>
      <div class="tc-ctry"><button type="button" class="cchip ask" data-task="${esc(t.id)}"><i>${I.chat}</i>Ask</button><button type="button" class="cchip map" data-tmap="${esc(t.id)}"><i>${ICON.map}</i>Trip Map</button><button type="button" class="cchip stat" data-trecap="${esc(t.id)}"><i>${I.stats}</i>Recap</button>${t.start <= today ? `<button type="button" class="cchip reelc" data-treel="${esc(t.id)}"><i>${I.camera}</i>Reel</button>` : ""}<button type="button" class="cchip sos" data-tsos="${esc(t.id)}"><i>${I.warn}</i>Emergency</button>${t.countryInfo?.codes?.length ? t.countryInfo.codes.map((c) => `<button type="button" class="cchip" data-cinfo="${esc(t.id)}" data-c="${c}"><i>${I.globe}</i>${esc(countryName(c))}</button>`).join("")
        : isEditor() && t.end >= today ? `<button type="button" class="cchip add" data-cnew="${esc(t.id)}"><i>${I.globe}</i>+ Country Info</button>` : ""}</div>
      ${isEditor() ? `<div class="tc-acts"><button class="btn tiny" data-settings="${esc(t.id)}">Setup</button></div>` : ""}
    </article>`;
  };
  root.innerHTML = `<header class="top"><div class="brand"><img class="logo-sm" src="icons/logo.svg" alt=""><span class="title-red">Travel Planner</span>
      <span class="role ${store.role}">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span></div>
    <div class="menu">${isEditor() ? `<button class="btn small primary" data-act="newtrip">+ New Trip</button>` : ""}
      <details class="more"><summary class="btn small">⋯</summary><div class="pop">
        ${isEditor() ? `${mi("people", I.users, "Traveller Profiles")}${mi("import", I.upload, "Restore a Trip from Backup…")}<hr>` : ""}${mi("signout", I.logout, "Sign Out")}</div></details></div></header>
  <div class="home">
    ${!store.tripsLoaded ? `<p class="muted">Loading trips…</p>` : !trips.length ? `<div class="empty card"><h2>No Trips Yet</h2>
       ${isEditor() ? `<p>Create your first trip: name, dates and who's travelling.</p><button class="btn primary" data-act="newtrip">+ New Trip</button>` : `<p>Nothing has been planned yet.</p>`}</div>` : ""}
    ${upcoming.length ? `<h2 class="hsec">Upcoming</h2><div class="trips">${upcoming.map(card).join("")}</div>` : ""}
    ${past.length ? `<h2 class="hsec">Past Trips</h2><div class="trips">${past.map(card).join("")}</div>` : ""}
  <p class="appver">Travel Planner ${APP_VERSION}</p></div>`;
  wireHeader();
  root.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = (e) => { const w = e.target.closest("[data-docwarn]"); if (w) return showTripDocIssues(store.trips.find((t) => t.id === w.dataset.docwarn));
      const ci = e.target.closest("[data-cinfo]"); if (ci) return showCountryInfo(store.trips.find((t) => t.id === ci.dataset.cinfo), ci.dataset.c);
      const cn = e.target.closest("[data-cnew]"); if (cn) return countryInfoFlow(cn.dataset.cnew);
      const tm = e.target.closest("[data-tmap]"); if (tm) return openTripMap(tm.dataset.tmap);
      const ta = e.target.closest("[data-task]"); if (ta) return askTrip(ta.dataset.task);
      const tr = e.target.closest("[data-trecap]"); if (tr) return showRecap(tr.dataset.trecap);
      const ts = e.target.closest("[data-tsos]"); if (ts) return emergencySheet(ts.dataset.tsos);
      const tl = e.target.closest("[data-treel]"); if (tl) return travelReel(tl.dataset.treel);
      if (e.target.closest("[data-settings]")) return; localStorage.setItem("tp.trip", el.dataset.open); routeTo(el.dataset.open); };
    el.onkeydown = (e) => { if (e.key === "Enter") el.click(); };
  });
  root.querySelectorAll("[data-settings]").forEach((b) => (b.onclick = () => tripForm(store.trips.find((t) => t.id === b.dataset.settings))));
}

// ---------------------------------------------------------------- "Ask the trip": a chat answered by the AI from the itinerary
// The itinerary as plain text for the AI (private details - confirmation numbers, costs - only for editors)
function tripContext() {
  const t = store.trip, ed = isEditor(), who = (a) => (a || []).join(",") || "everyone";
  const tz = (c) => AIRPORT_TZ[c] || "", L = [];
  const now = new Date();
  L.push(`TRIP: ${t.title} from ${t.start} to ${t.end}. Today is ${iso(now)} ${now.toTimeString().slice(0, 5)} (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Asked by: ${NAME(ui.person)} (${ui.person}).`);
  L.push("TRAVELLERS: " + (t.travellers || []).map((x) => `${x.code}=${x.name}`).join("; ") + ((t.extended || []).length ? " | OTHERS JOINING SOMETIMES: " + t.extended.map((x) => `${x.code}=${x.name}`).join("; ") : ""));
  L.push("BOOKINGS:");
  for (const i of store.items.slice().sort((a, b) => a.start.localeCompare(b.start) || (a.dep || "").localeCompare(b.dep || ""))) {
    const pv = ed ? store.priv[i.id] || {} : {}, priv = ed ? ["confirmation", "seats", "tickets", "phone", "cancel", "cost", "dueAtHotel"].filter((k) => pv[k]).map((k) => `${k}: ${pv[k]}`).join("; ") : "";
    const side = i.end < t.start ? " [before the trip]" : i.start > t.end ? " [after the trip]" : "";
    if (i.type === "flight") { const c = codesOf(i.route);
      L.push(`- FLIGHT ${i.start}${i.end !== i.start ? "→" + i.end : ""} ${c.join("-")} ${[i.airline, i.number].filter(Boolean).join(" ")} departs ${i.dep || "?"} (${tz(c[0])}) arrives ${i.arr || "?"} (${tz(c.at(-1))}), ${isInternational(i) ? "international" : "domestic"}; who: ${who(i.who)}${i.note ? "; note: " + i.note : ""}${priv ? "; " + priv : ""}${side}`); }
    else if (i.type === "stay") L.push(`- STAY ${i.start} to ${i.end} (check-out day) ${i.name || ""}${i.area ? " in " + i.area : ""}; address: ${i.address || "?"}; check-in ${i.checkin || "?"}, check-out ${i.checkout || "?"}; who: ${who(i.who)}${i.status === "tbc" ? "; NOT BOOKED YET" : ""}${i.note ? "; note: " + i.note : ""}${priv ? "; " + priv : ""}${side}`);
    else L.push(`- CAR ${i.start} to ${i.end} ${[i.company, i.vehicle].filter(Boolean).join(" ")}; pick-up ${i.pickup || "?"} ${i.pickupTime || ""}; drop-off ${i.dropoff || "?"} ${i.dropoffTime || ""}; who: ${who(i.who)}${i.note ? "; note: " + i.note : ""}${priv ? "; " + priv : ""}${side}`);
  }
  const acts = store.entries.filter((e) => e.kind === "activity").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  if (acts.length) { L.push("ACTIVITIES (confirmed = booked/in the itinerary, planned = maybe, idea = recommended only):");
    acts.forEach((e) => { const pv = ed ? store.priv[e.id] || {} : {};
      L.push(`- ${e.date}${e.endDate && e.endDate !== e.date ? "→" + e.endDate : ""} [${e.status === "recommended" ? "idea" : e.confirmed ? "confirmed" : "planned"}] ${String(e.text || "").replace(/\s+/g, " ")}${e.place ? " @ " + e.place : ""}; who: ${who(e.who)}${votesFor("e_" + e.id).length ? `; votes: ${votesFor("e_" + e.id).join(",")}` : ""}${ed && pv.cost ? "; cost: " + pv.cost : ""}`); }); }
  const coms = store.entries.filter((e) => e.kind === "comment");
  if (coms.length) { L.push("NOTES:"); coms.forEach((e) => L.push(`- ${e.date}: ${String(e.text || "").replace(/\s+/g, " ")} (${who(e.who)})`)); }
  const ci = t.countryInfo;
  if (ci?.codes?.length) { L.push("COUNTRY INFO:"); ci.codes.forEach((c) => { const x = ci.data[c] || {};
    L.push(`- ${x.country || c}: currency ${x.currency?.name || "?"}; plugs ${x.plugs?.types || "?"} ${x.plugs?.voltage || ""}; emergency ${x.emergency?.general || "?"}; tipping restaurants ${x.tipping?.restaurants || "?"}; entry: ${(x.entry || []).map((e) => e.passport + ": " + e.summary).join(" / ")}`); }); }
  return L.join("\n");
}
const chats = {};   // this session's conversation per trip
const fmtAnswer = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
async function askTrip(tid = ui.tripId) {
  try { await loadTripData(tid); } catch (e) { return toast(e.message); }
  const log = (chats[tid] ||= []);
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="sheet askbox"><div class="ask-head"><h3>${I.chat}Ask the Trip</h3><button type="button" class="btn tiny" data-askx aria-label="Close">✕</button></div>
    <div class="ask-log" aria-live="polite"></div>
    <div class="ask-sugg"></div>
    <form class="ask-form"><input name="q" autocomplete="off" placeholder="e.g. When do we leave for the airport on 27 Dec?" aria-label="Your question"><button class="btn primary">Ask</button></form>
    <p class="muted small">Answered by AI from this trip's itinerary - double-check anything important.${isEditor() ? "" : " Private details like confirmation numbers aren't included."}</p></div>`;
  document.body.appendChild(m);
  const logEl = m.querySelector(".ask-log"), form = m.querySelector("form"), inp = form.q;
  const close = () => m.remove();
  m.querySelector("[data-askx]").onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
  const next = store.items.filter((i) => i.type === "flight" && i.start >= iso(new Date())).sort((a, b) => a.start.localeCompare(b.start))[0];
  const sugg = [next && `When do we leave for the airport for the ${fmtDate(next.start)} flight?`, `Where are we staying on ${fmtDate(iso(new Date()) >= store.trip.start && iso(new Date()) <= store.trip.end ? iso(new Date()) : store.trip.start)}?`,
    "What's planned for tomorrow?", "Which activities still need booking?"].filter(Boolean);
  const draw = () => {
    logEl.innerHTML = log.map((x) => `<div class="ask-q">${esc(x.q)}</div><div class="ask-a${x.err ? " err" : ""}">${x.a == null ? `<span class="ask-dots"><i></i><i></i><i></i></span>` : fmtAnswer(x.a)}
      ${(x.days || []).filter((d) => d >= store.trip.start && d <= store.trip.end).slice(0, 4).map((d) => `<button type="button" class="lnk" data-askday="${d}">Open ${fmtDate(d)} →</button>`).join(" ")}</div>`).join("")
      || `<p class="muted small">Ask anything about the trip: times, places, who's where, what's booked.</p>`;
    m.querySelector(".ask-sugg").innerHTML = log.length ? "" : sugg.map((q) => `<button type="button" class="cchip" data-askq="${esc(q)}">${esc(q)}</button>`).join("");
    logEl.scrollTop = logEl.scrollHeight;
    logEl.querySelectorAll("[data-askday]").forEach((b) => (b.onclick = () => { close(); routeTo(tid, b.dataset.askday); }));
    m.querySelectorAll("[data-askq]").forEach((b) => (b.onclick = () => ask(b.dataset.askq)));
  };
  const ask = async (q) => {
    q = q.trim(); if (!q) return; inp.value = "";
    const turn = { q, a: null }; log.push(turn); draw();
    try { const r = await data.askTripAI(q, tripContext(), log.filter((x) => x !== turn && x.a && !x.err).slice(-4)); turn.a = r.answer || "…"; turn.days = r.days || []; }
    catch (e) { turn.a = "Couldn't get an answer: " + (e.message || e); turn.err = true; }
    if (m.isConnected) draw();
  };
  form.onsubmit = (e) => { e.preventDefault(); ask(inp.value); };
  draw(); setTimeout(() => inp.focus(), 50);
}

// ---------------------------------------------------------------- country info (AI-written per country, kept on the trip)
const REGION = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch (e) { return null; } })();
const countryName = (c) => { try { return REGION?.of(c) || c; } catch (e) { return c; } };
const COUNTRY_CODES = (() => { const out = {}; const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) for (const b of A) { const c = a + b; const n = countryName(c); if (n && n !== c && !/Unknown/i.test(n)) out[n.toLowerCase()] = c; }
  Object.assign(out, { usa: "US", "u.s.a.": "US", "united states of america": "US", us: "US", méxico: "MX", uk: "GB", england: "GB", scotland: "GB", "new zealand": "NZ", nz: "NZ", aotearoa: "NZ" });
  return out; })();
// the countries a trip visits: where flights land and where the stays are (not the country you fly out from)
function tripCountries() {
  const t = store.trip, inTrip = (i) => !(i.end < t.start || i.start > t.end), seen = new Map(), add = (c, d) => { if (c && !seen.has(c)) seen.set(c, d); };
  const fl = store.items.filter((i) => i.type === "flight" && inTrip(i)).sort((a, b) => a.start.localeCompare(b.start));
  const ctry = (a) => TZ_COUNTRY[AIRPORT_TZ[a]];
  const home = fl.length ? ctry(codesOf(fl[0].route)[0]) : null;
  fl.forEach((f) => codesOf(f.route).slice(1).forEach((a) => add(ctry(a), f.start)));
  store.items.filter((i) => i.type === "stay" && inTrip(i)).forEach((i) => { const last = String(i.address || "").split(",").map((x) => x.replace(/\d+/g, "").trim()).filter(Boolean).at(-1) || "";
    add(COUNTRY_CODES[last.toLowerCase()], i.start); });
  if (home) seen.delete(home);
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([c]) => c);
}
// passports from the travellers' profiles (passport documents), grouped by nationality
function tripPassports() {
  const by = {};
  for (const x of (store.trip?.travellers || []).concat(store.trip?.extended || [])) {
    const per = personFor(x), pp = (per?.docs || []).filter((d) => d.type === "passport" && d.country);
    for (const d of pp) { const n = titleCase(d.country); (by[n] ||= new Set()).add(x.code); }
  }
  return Object.entries(by).map(([nationality, who]) => ({ nationality, who: [...who] }));
}
// make a trip's bookings available (also from the home screen, without opening the trip)
async function loadTripData(tid) {
  if (ui.tripId === tid && store.trip) return;
  if (!ui.tripId) { ui.bgTrip = tid; data.openTrip(tid); }
  for (let k = 0; k < 40 && !(store.tripId === tid && store.trip); k++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 500));   // let the bookings arrive too
  if (!store.trip) throw new Error("Couldn't load the trip");
}
async function countryInfoFlow(tid = ui.tripId) {
  if (!isEditor()) return;
  try { await loadTripData(tid); } catch (e) { return toast(e.message); }
  const found = tripCountries(), have = store.trip.countryInfo?.codes || [];
  const list = [...new Set(have.concat(found))];
  const opts = Object.entries(COUNTRY_CODES).filter(([n, c]) => n === countryName(c).toLowerCase()).sort((a, b) => a[0].localeCompare(b[0]));
  modal(`<h3>Country Info</h3><p class="muted small">Written by AI for this trip: entry requirements for your passports, money, plugs, tipping, emergency numbers and tips. Kept with the trip so everyone can read it, also offline.</p>
    <fieldset class="pbox"><legend>Countries</legend><div id="ccl">${list.map((c) => `<label class="pcand"><input type="checkbox" name="c" value="${c}" checked><span><b>${esc(countryName(c))}</b>${have.includes(c) ? `<small class="muted">has info - tick to update it</small>` : ""}</span></label>`).join("") || `<p class="muted small">No countries found from the bookings yet.</p>`}</div>
      <select data-cadd aria-label="Add a country"><option value="">+ Add a country…</option>${opts.map(([, c]) => `<option value="${c}">${esc(countryName(c))}</option>`).join("")}</select></fieldset>
    <p class="muted small">Passports used: ${tripPassports().map((p) => `${esc(p.nationality)} (${p.who.map(esc).join(", ")})`).join("; ") || "none saved in the profiles - Australian assumed"}</p>`,
    async (fd) => {
      const pick = fd.getAll("c"); if (!pick.length) throw new Error("Tick at least one country");
      const info = { ...(store.trip.countryInfo || {}) }, dataBy = { ...(info.data || {}) };
      const places = [...new Set(store.items.filter((i) => i.type === "stay").map((i) => stayArea(i)).filter(Boolean))].join(", ");
      const fl = store.items.filter((i) => i.type === "flight").sort((a, b) => a.start.localeCompare(b.start));
      const origin = fl.length ? countryName(TZ_COUNTRY[AIRPORT_TZ[codesOf(fl[0].route)[0]]] || "AU") : "Australia";
      for (const [k, c] of pick.entries()) {
        toast(`Writing ${countryName(c)} (${k + 1} of ${pick.length})…`);
        let x; try { x = await data.countryInfoAI(c, { name: countryName(c), from: store.trip.start, to: store.trip.end, origin, places, passports: tripPassports() }); }
        catch (e) { infoBox(`<h2>Couldn't Write ${esc(countryName(c))}</h2><p class="small">The AI service said:</p><pre class="errbox">${esc(e.message || String(e))}</pre><p class="muted small">Send Claude a screenshot of this.</p>`); throw Object.assign(new Error(""), { back: true }); }
        dataBy[c] = { ...x, at: new Date().toISOString() };
      }
      const codes = list.filter((c) => pick.includes(c) || (have.includes(c) && dataBy[c]));
      await data.saveTrip({ countryInfo: { codes: codes.filter((c) => dataBy[c]), data: Object.fromEntries(codes.filter((c) => dataBy[c]).map((c) => [c, dataBy[c]])) } }, tid);
      toast("Country info ready"); setTimeout(() => showCountryInfo({ id: tid, ...store.trip }, pick[0]), 400);
    });
  const m = [...document.querySelectorAll(".modal")].pop(); m.querySelector("button.primary").textContent = "Write with AI";
  m.querySelector("[data-cadd]").onchange = (e) => { const c = e.target.value; e.target.value = ""; if (!c || m.querySelector(`input[value="${c}"]`)) return;
    m.querySelector("#ccl").insertAdjacentHTML("beforeend", `<label class="pcand"><input type="checkbox" name="c" value="${c}" checked><span><b>${esc(countryName(c))}</b></span></label>`); };
}
function showCountryInfo(t, code) {
  const ci = t.countryInfo; if (!ci?.codes?.length) return;
  code = ci.codes.includes(code) ? code : ci.codes[0];
  const x = ci.data[code] || {}, li = (a) => (a || []).filter(Boolean).map((v) => `<li>${esc(v)}</li>`).join("");
  const tel = (v) => esc(v).replace(/(\+?\d[\d\s-]{1,14}\d|\b\d{3}\b)/g, (n) => `<a href="tel:${n.replace(/[\s-]/g, "")}">${n}</a>`);
  const row = (k, v, f = esc) => (v ? `<dt>${k}</dt><dd>${f(v)}</dd>` : "");
  infoBox(`<div class="cinfo"><h2>${esc(x.country || countryName(code))}</h2>
    ${ci.codes.length > 1 ? `<div class="seg-mini ctabs">${ci.codes.map((c) => `<button type="button" class="${c === code ? "on" : ""}" data-ctab="${c}">${esc(countryName(c))}</button>`).join("")}</div>` : ""}
    ${x.entry?.length ? `<section><h3>${I.file}Entry Requirements</h3>${x.entry.map((e) => `<div class="centry"><b>${esc(e.passport)} passport</b><p>${esc(e.summary)}</p><ul>${li(e.steps)}</ul></div>`).join("")}</section>` : ""}
    ${x.currency ? `<section><h3>${I.wallet || ""}Money</h3><p><b>${esc(x.currency.name)}</b>${x.currency.code ? ` (${esc(x.currency.code)})` : ""}</p>${x.currency.cash ? `<p>${esc(x.currency.cash)}</p>` : ""}<ul>${li(x.currency.tips)}</ul></section>` : ""}
    ${x.plugs ? `<section><h3>Plugs &amp; Power</h3><dl>${row("Plugs", x.plugs.types)}${row("Power", x.plugs.voltage)}${row("Adapter", x.plugs.adapter)}</dl></section>` : ""}
    ${x.tipping ? `<section><h3>Tipping</h3><dl>${row("Restaurants", x.tipping.restaurants)}${row("Taxis", x.tipping.taxis)}${row("Hotels", x.tipping.hotels)}${row("Other", x.tipping.other)}</dl></section>` : ""}
    ${x.emergency ? `<section class="cemerg"><h3>${I.warn}Emergency Numbers</h3><dl>${row("Emergency", x.emergency.general, tel)}${row("Police", x.emergency.police, tel)}${row("Ambulance", x.emergency.ambulance, tel)}${row("Fire", x.emergency.fire, tel)}${row("Other", x.emergency.other, tel)}</dl></section>` : ""}
    ${x.driving || x.water ? `<section><h3>Getting Around &amp; Water</h3><dl>${row("Driving", x.driving)}${row("Tap water", x.water)}</dl></section>` : ""}
    ${x.goodToKnow?.length ? `<section><h3>Good to Know</h3><ul>${li(x.goodToKnow)}</ul></section>` : ""}
    ${x.official?.length ? `<section><h3>Check the Official Sources</h3><ul>${x.official.filter((o) => /^https:\/\//.test(o.url || "")).map((o) => `<li><a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.name || o.url)}</a></li>`).join("")}</ul></section>` : ""}
    <p class="muted small">Written by AI on ${x.at ? fmtDate(x.at.slice(0, 10)) : "?"}. Entry rules and fees change - check the official sites before you travel.</p>
    ${isEditor() ? `<button type="button" class="btn small" data-cupdate>Update with AI…</button>` : ""}</div>`);
  const m = [...document.querySelectorAll(".modal")].pop();
  m.querySelectorAll("[data-ctab]").forEach((b) => (b.onclick = () => { m.remove(); showCountryInfo(t, b.dataset.ctab); }));
  m.querySelector("[data-cupdate]")?.addEventListener("click", () => { m.remove(); countryInfoFlow(t.id); });
}

// ---------------------------------------------------------------- Emergency card: numbers, consulates, health details and what's near each stay
const DEMONYM = { Australia: "Australian", Mexico: "Mexican", "New Zealand": "New Zealand", "United States": "US", Canada: "Canadian", "United Kingdom": "British", Spain: "Spanish", Ireland: "Irish", Colombia: "Colombian", Brazil: "Brazilian", Argentina: "Argentine", Chile: "Chilean", Peru: "Peruvian", France: "French", Germany: "German", Italy: "Italian", Japan: "Japanese", China: "Chinese", India: "Indian" };
const AU_CONSULAR = { name: "Australian Government 24/7 Consular Emergency Centre", phone: "+61 2 6261 3305", local: "1300 555 135 (from within Australia)" };
const sosLocal = (tid) => { try { return JSON.parse(localStorage.getItem("tp.sos." + tid) || "null"); } catch (e) { return null; } };
const sosKeep = (tid, v) => { try { v ? localStorage.setItem("tp.sos." + tid, JSON.stringify(v)) : localStorage.removeItem("tp.sos." + tid); } catch (e) { /* private mode */ } };
const ctryOfAddr = (a) => { const last = String(a || "").split(",").map((x) => x.replace(/\d+/g, "").trim()).filter(Boolean).at(-1) || ""; return COUNTRY_CODES[last.toLowerCase()] || ""; };
function sosStays() {
  const t = store.trip, inT = (i) => !(i.end < t.start || i.start > t.end), seen = new Set();
  return store.items.filter((i) => i.type === "stay" && i.status !== "tbc" && inT(i) && (i.address || i.name)).sort((a, b) => a.start.localeCompare(b.start))
    .filter((i) => { const k = (i.address || i.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
const sosQ = (i) => i.address || [i.name, i.area].filter(Boolean).join(", ");
const sosNeeds = (i) => { const e = store.trip?.essentials?.[i.id]; return !e || e.q !== sosQ(i) || !!e.err; };   // not looked up, address changed, or failed last time
// look up what's missing (editors): nearest hospital, pharmacy, supermarket and consulates for each stay, saved with the trip
async function sosFind(tid, stays, note) {
  const ess = { ...(store.trip.essentials || {}) };
  let nats = tripPassports().map((p) => ({ country: p.nationality, code: COUNTRY_CODES[p.nationality.toLowerCase()] || "", who: p.who }));
  if (!nats.length) nats = [{ country: "Australia", code: "AU", who: [] }];
  for (const [k, i] of stays.entries()) {
    note(`Looking around ${i.short || i.name} (${k + 1} of ${stays.length})…`);
    try {
      const r = await nearbyEssentials(sosQ(i)), here = ctryOfAddr(i.address) || ctryOfAddr(r.addr), cons = [];
      for (const n of nats) { if (n.code && n.code === here) continue;
        const c = await nearestConsulate(n.country, r).catch(() => null); cons.push({ country: n.country, who: n.who, place: c }); }
      ess[i.id] = { q: sosQ(i), at: new Date().toISOString(), ctry: here, hospital: r.hospital, pharmacy: r.pharmacy, supermarket: r.supermarket, cons, err: null };   // err: null clears an earlier failure (the trip doc is merged)
    } catch (e) { console.warn("sos", i.id, e); if (/load Google Maps|rejected the key/i.test(e.message || "")) throw e;   // offline or no Maps: save nothing
      ess[i.id] = { q: sosQ(i), at: new Date().toISOString(), err: String(e.message || e).slice(0, 200) }; }
  }
  await data.saveTrip({ essentials: JSON.parse(JSON.stringify(ess)) }, tid);
  store.trip.essentials = ess;
}
async function emergencySheet(tid = ui.tripId) {
  try { await loadTripData(tid); } catch (e) { return toast(e.message); }
  const m = document.createElement("div"); m.className = "modal"; document.body.appendChild(m);
  let health = sosLocal(tid), busy = "";
  const tel = (n) => `<a class="btn tiny" href="tel:${esc(String(n).replace(/[^\d+]/g, ""))}"><i class="ic16">${I.phone}</i>${esc(n)}</a>`;
  const telText = (v) => esc(v).replace(/(\+?\d[\d\s()-]{5,}\d|\b\d{3}\b)/g, (n) => `<a href="tel:${n.replace(/[^\d+]/g, "")}">${n}</a>`);
  const dir = (p) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([p.name, p.address].filter(Boolean).join(", "))}`;
  const place = (lbl, icon, p, extra = "") => p ? `<div class="sosp"><span class="sosi">${icon}</span><div class="sosm"><small>${lbl}${p.h24 ? ` · <b class="h24">Open 24 h</b>` : ""}${extra}</small><b>${esc(p.name)}</b>
      <small>${p.km != null ? `${p.km < 1 ? Math.round(p.km * 1000) + " m" : p.km + " km"} away · ` : ""}${esc(p.address)}</small>
      <span class="sosacts">${p.phone ? tel(p.phone) : ""}<a class="btn tiny" target="_blank" rel="noopener" href="${dir(p)}"><i class="ic16">${ICON.map}</i>Directions</a></span></div></div>`
    : `<div class="sosp none"><span class="sosi">${icon}</span><div class="sosm"><small>${lbl}</small><span class="muted small">None found nearby</span></div></div>`;
  const draw = () => {
    const t = store.trip, ess = t.essentials || {}, stays = sosStays(), today = iso(new Date());
    const now = stays.find((i) => i.start <= today && today < i.end);
    const order = now ? [now, ...stays.filter((i) => i !== now)] : stays;
    const missing = stays.filter(sosNeeds);
    const ci = t.countryInfo || {}, codes = (ci.codes || []).filter((c) => ci.data?.[c]?.emergency);
    const nats = tripPassports(), aus = !nats.length || nats.some((p) => /austral/i.test(p.nationality));
    m.innerHTML = `<div class="sheet sossheet"><div class="sos-h"><span class="sos-badge">${I.warn}</span><div><h3>Emergency</h3><small class="muted">${esc(t.title || "")}</small></div><button type="button" class="btn tiny" data-x aria-label="Close">✕</button></div>
      <section><h4>Emergency Numbers</h4>${codes.length ? codes.map((c) => { const e = ci.data[c].emergency;
        return `<div class="sosnum"><b>${esc(countryName(c))}</b><span class="sosacts">${e.general ? tel(e.general) : ""}${e.ambulance && e.ambulance !== e.general ? `<span class="small muted">Ambulance</span>${tel(e.ambulance)}` : ""}${e.police && e.police !== e.general ? `<span class="small muted">Police</span>${tel(e.police)}` : ""}</span>${e.other ? `<small class="muted">${telText(e.other)}</small>` : ""}</div>`; }).join("")
        : `<p class="muted small">Add Country Info for this trip to see each country's emergency numbers here.${isEditor() ? ` <button type="button" class="btn tiny" data-sos-ci>+ Country Info</button>` : ""}</p>`}
        ${aus ? `<div class="sosnum"><b>${AU_CONSULAR.name}</b><span class="sosacts">${tel(AU_CONSULAR.phone)}</span><small class="muted">Lost passport, arrest, serious illness or injury, a missing family member. Also ${esc(AU_CONSULAR.local)}.</small></div>` : ""}</section>
      ${isEditor() || health ? `<section><h4>Health &amp; Insurance</h4>${health ? (health.people.length ? "" : `<p class="muted small">No profiles on this trip yet.</p>`) + health.people.map((h) => `<div class="soshl"><b>${esc(h.name)}</b><dl>
          ${[["Blood type", h.blood], ["Allergies", h.allergies], ["Conditions", h.conditions], ["Medications", h.medications]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") || `<dt>Health</dt><dd class="muted">Nothing noted in the profile</dd>`}
          ${h.em ? `<dt>Emergency contact</dt><dd>${telText(h.em)}</dd>` : ""}
          ${h.ins.map((x) => `<dt>Insurance</dt><dd>${telText(x)}</dd>`).join("")}</dl></div>`).join("")
          + `<label class="pswitch"><span><b>Keep on this phone</b><small>So it's here without signal or signing in. Only on this phone.</small></span><input type="checkbox" data-sos-keep ${sosLocal(tid) ? "checked" : ""}><i></i></label>`
        : `<p class="muted small">Blood type, allergies, medications, emergency contacts and travel insurance from the profiles.</p><button type="button" class="btn small" data-sos-health>Show (confirm it's you)</button>`}</section>` : ""}
      <section><h4>Near Each Stay</h4>${busy ? `<p class="small sosbusy">${esc(busy)}</p>` : ""}
        ${!stays.length ? `<p class="muted small">No stays with an address yet.</p>` : order.map((i) => { const e = ess[i.id];
          return `<div class="sosstay${i === now ? " now" : ""}"><div class="soss-h"><b>${esc(i.short || i.name)}</b><small class="muted">${i === now ? "Staying now · " : ""}${shortDate(i.start)} – ${shortDate(i.end)}</small></div>
            ${!e || e.q !== sosQ(i) ? `<p class="muted small">${isEditor() ? "Not looked up yet." : "Not looked up yet - Cesar or Debora can do it from this screen."}</p>` : e.err ? `<p class="muted small">Couldn't look this one up (${esc(e.err)}).</p>`
            : place("Hospital", "🏥", e.hospital) + place("Pharmacy", "💊", e.pharmacy) + place("Supermarket", "🛒", e.supermarket)
              + (e.cons || []).map((c) => place(`${DEMONYM[c.country] || c.country} embassy / consulate${c.who?.length ? " · for " + c.who.map((w) => NAME(w) || w).join(", ") : ""}`, "🏛️", c.place)).join("")}</div>`; }).join("")}
        ${isEditor() && stays.length ? `<div class="row wrap">${missing.length ? `<button type="button" class="btn small primary" data-sos-find ${busy ? "disabled" : ""}>Find Nearby Places (${missing.length} stay${missing.length > 1 ? "s" : ""})</button>` : `<button type="button" class="btn small" data-sos-refresh ${busy ? "disabled" : ""}>↻ Look Again</button>`}</div>` : ""}
        <p class="muted small">From Google Maps, saved with the trip so it's on everyone's phone, also offline once the app has opened the trip. Check opening hours before you go.</p></section></div>`;
  };
  const run = async (list) => { busy = "Starting…"; draw();
    try { await sosFind(tid, list, (n) => { busy = n; draw(); }); toast("Nearby places saved"); } catch (e) { toast("Couldn't look up: " + (e.message || e)); }
    busy = ""; draw(); };
  m.addEventListener("click", async (e) => {
    if (e.target === m || e.target.closest("[data-x]")) return m.remove();
    if (e.target.closest("[data-sos-ci]")) { m.remove(); return countryInfoFlow(tid); }
    if (e.target.closest("[data-sos-find]")) return run(sosStays().filter(sosNeeds));
    if (e.target.closest("[data-sos-refresh]")) return run(sosStays());
    if (e.target.closest("[data-sos-health]")) {
      try { if (!unlocked()) await unlock(); } catch (err) { return toast("Not unlocked"); }
      const people = [];
      for (const x of (store.trip.travellers || []).concat(store.trip.extended || [])) { const per = personFor(x); if (!per?.id) continue;
        let v = {}; try { v = secure.vault[per.id] || await data.getVault(per.id); secure.vault[per.id] = v; } catch (err) { console.warn("vault", err); }
        const ins = (per.docs || []).filter((d) => d.type === "insurance" && !(d.expiry && d.expiry < store.trip.start)).map((d) => [d.country, (v.docNumbers || {})[d.id] ? "Policy " + v.docNumbers[d.id] : "", d.notes, d.expiry ? "until " + fmtDate(d.expiry) : ""].filter(Boolean).join(" · "));
        people.push({ name: per.name || x.code, blood: v.blood || "", allergies: v.allergies || "", conditions: v.conditions || "", medications: v.medications || "",
          em: [v.emName, v.emRelation ? `(${v.emRelation})` : "", v.emPhone].filter(Boolean).join(" "), ins }); }
      health = { people }; return draw();
    }
  });
  m.addEventListener("change", (e) => { const k = e.target.closest("[data-sos-keep]"); if (k) { sosKeep(tid, k.checked ? health : null); toast(k.checked ? "Saved on this phone" : "Removed from this phone"); } });
  draw();
  if (isEditor() && navigator.onLine !== false && sosStays().some(sosNeeds) && mapsReady()) run(sosStays().filter(sosNeeds));
}

// Google Maps suggestions under a text field while typing (addresses, or any place with opts.any, biased near opts.near = an address)
function acAttach(input, opts = {}) {
  if (!input || !mapsReady() || input.dataset.ac) return; input.dataset.ac = "1"; input.autocomplete = "off";
  const wrap = document.createElement("div"); wrap.className = "acwrap"; input.replaceWith(wrap); wrap.appendChild(input);
  const list = document.createElement("div"); list.className = "aclist"; list.hidden = true; wrap.appendChild(list);
  let tmr = 0, seq = 0, near = null, nearDone = !opts.near;
  input.addEventListener("input", () => { clearTimeout(tmr); const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    tmr = setTimeout(async () => { const my = ++seq; let r = [];
      if (!nearDone) { nearDone = true; try { const g = await geocodeText(opts.near); if (g) near = { lat: g.lat, lng: g.lng }; } catch (e) { /* no bias */ } }
      try { r = await addressSuggest(q, { any: opts.any, near }); } catch (e) { console.warn("suggest", e); }
      if (my !== seq) return;
      list.innerHTML = r.slice(0, 5).map((x, k) => `<button type="button" data-ac="${k}"><b>${esc(x.main)}</b><small>${esc(x.sub)}</small></button>`).join("");
      list.hidden = !r.length; list._r = r; }, 300); });
  list.addEventListener("pointerdown", (e) => { const b = e.target.closest("[data-ac]"); if (!b) return; e.preventDefault();
    input.value = list._r[+b.dataset.ac].text; list.hidden = true; addressDone(); input.dispatchEvent(new Event("change", { bubbles: true })); });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
}
// ---------------------------------------------------------------- Travel reel: the journal photos as a full-screen slideshow, day by day
const reelUI = { speed: 5, music: "gentle", captions: true };
try { Object.assign(reelUI, JSON.parse(localStorage.getItem("tp.reel") || "{}")); } catch (e) { /* defaults */ }
// gentle generated background music (soft chords and a slow arpeggio - no copyright, no download)
function reelMusic() {
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
  const ac = new AC(), out = ac.createGain(), lp = ac.createBiquadFilter(), dly = ac.createDelay(), fb2 = ac.createGain();
  lp.type = "lowpass"; lp.frequency.value = 1800; dly.delayTime.value = 0.38; fb2.gain.value = 0.28; out.gain.value = 0;
  lp.connect(out); lp.connect(dly); dly.connect(fb2); fb2.connect(dly); dly.connect(out); out.connect(ac.destination);
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const prog = [[48, 55, 60, 64, 67], [43, 55, 59, 62, 67], [45, 57, 60, 64, 69], [41, 53, 57, 60, 65]];   // C  G  Am  F
  const bar = 3.2; let next = ac.currentTime + 0.1, k = 0, timer = 0;
  const note = (m, t, len, vol, type) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.value = hz(m);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + Math.min(0.6, len / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g); g.connect(lp); o.start(t); o.stop(t + len + 0.1); };
  const sched = () => { while (next < ac.currentTime + 1.5) { const ch = prog[k % prog.length];
      ch.slice(0, 4).forEach((m) => note(m, next, bar + 0.6, 0.05, "sine"));
      [0, 1, 2, 3, 4, 3, 2, 1].forEach((x, j) => note(ch[x] + 12, next + j * (bar / 8), bar / 3, 0.035, "triangle"));
      next += bar; k++; } };
  return { start() { ac.resume(); sched(); timer = setInterval(sched, 400); out.gain.cancelScheduledValues(ac.currentTime); out.gain.linearRampToValueAtTime(0.9, ac.currentTime + 2); },
    pause() { out.gain.cancelScheduledValues(ac.currentTime); out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.4); },
    resume() { ac.resume(); out.gain.cancelScheduledValues(ac.currentTime); out.gain.linearRampToValueAtTime(0.9, ac.currentTime + 0.8); },
    stop() { clearInterval(timer); try { out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.3); setTimeout(() => ac.close(), 500); } catch (e) { /* closed */ } } };
}
function reelSlides() {
  const t = store.trip, posts = (store.journal || []).filter((j) => !j.replyTo && j.photos?.length && j.date)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const out = [], ds = days(); let last = "";
  for (const j of posts) {
    if (j.date !== last) { last = j.date;
      const stay = store.items.find((i) => i.type === "stay" && i.start <= j.date && j.date < i.end);
      out.push({ kind: "day", date: j.date, n: ds.indexOf(j.date) + 1, where: stay ? stayArea(stay) : "" }); }
    const cap = String(j.text || "").split("\n")[0].trim();
    j.photos.forEach((ph, k) => out.push({ kind: "photo", ph, cap: k === 0 && cap ? (cap.length > 110 ? cap.slice(0, 107) + "…" : cap) : "", by: j.author || "", date: j.date }));
  }
  return out;
}
async function travelReel(tid = ui.tripId) {
  try { await loadTripData(tid); } catch (e) { return toast(e.message); }
  const slides = reelSlides(), t = store.trip;
  if (!slides.length) return toast("No journal photos yet - add some to the journal and they'll play here");
  const nPh = slides.filter((s) => s.kind === "photo").length, nDays = slides.filter((s) => s.kind === "day").length;
  const box = document.createElement("div"); box.className = "reel"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Travel reel");
  document.body.appendChild(box); document.body.classList.add("noscroll");
  let k = -1, playing = false, timer = 0, music = null, song = null, songUrl = "", lock = null, hideT = 0;
  const save = () => { try { localStorage.setItem("tp.reel", JSON.stringify(reelUI)); } catch (e) { /* ignore */ } };
  const preload = (i) => slides.slice(i, i + 3).forEach((s) => { if (s.kind === "photo" && !s.img) { s.img = new Image(); s.img.decoding = "async"; s.img.src = s.ph.url; } });
  const close = () => { clearTimeout(timer); music?.stop(); song?.pause(); if (songUrl) URL.revokeObjectURL(songUrl); lock?.release?.().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); document.removeEventListener("keydown", key); document.body.classList.remove("noscroll"); box.remove(); };
  const startScreen = () => { box.innerHTML = `<div class="reel-start"><button class="lb-btn reel-x" data-rx aria-label="Close">✕</button>
      <div class="reel-cover">${slides.find((s) => s.kind === "photo") ? `<img src="${esc(slides.find((s) => s.kind === "photo").ph.turl || slides.find((s) => s.kind === "photo").ph.url)}" alt="">` : ""}</div>
      <h2>${esc(t.title || "Our Trip")}</h2><p>${fmtDate(t.start)} – ${fmtDate(t.end)} · ${nPh} photo${nPh === 1 ? "" : "s"} over ${nDays} day${nDays === 1 ? "" : "s"}</p>
      <div class="reel-opts"><span>Music</span><div class="seg-mini">${[["gentle", "Gentle"], ["song", "Song from Phone…"], ["off", "Off"]].map(([v, l]) => `<button type="button" data-rmus="${v}" class="${reelUI.music === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <span>Speed</span><div class="seg-mini">${[[7, "Slow"], [5, "Normal"], [3, "Fast"]].map(([v, l]) => `<button type="button" data-rspd="${v}" class="${reelUI.speed === v ? "on" : ""}">${l}</button>`).join("")}</div>
        <span>Captions</span><div class="seg-mini">${[[true, "On"], [false, "Off"]].map(([v, l]) => `<button type="button" data-rcap="${v}" class="${reelUI.captions === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
      ${song ? `<p class="small reel-song">♪ ${esc(song.dataset.name || "Your song")}</p>` : ""}
      <button class="btn primary reel-play" data-rplay>▶ Play</button><p class="small reel-tip">Tip: mirror your phone to the TV (Screen Mirroring / Cast) to show everyone.</p>
      <input type="file" accept="audio/*" hidden data-rsong></div>`; };
  const frame = () => { const s = slides[k];
    if (!s) return `<div class="reel-card end"><h2>${esc(t.title || "The End")}</h2><p>${nPh} photos · ${nDays} days</p><button class="btn reel-again" data-ragain>↺ Watch Again</button></div>`;
    if (s.kind === "day") return `<div class="reel-card day"><small>Day ${s.n > 0 ? s.n : ""}</small><h2>${esc(longDate(s.date))}</h2>${s.where ? `<p>${esc(s.where)}</p>` : ""}</div>`;
    const ph = s.ph, tall = ph.h && ph.w && ph.h > ph.w, kb = ["kb1", "kb2", "kb3", "kb4"][k % 4];
    return `<div class="reel-ph ${tall ? "tall" : ""}"><img class="reel-bg" src="${esc(ph.turl || ph.url)}" alt=""><img class="reel-img ${kb}" style="--dur:${reelUI.speed + 1.5}s" src="${esc(ph.url)}" alt="">
      ${reelUI.captions && (s.cap || s.by) ? `<div class="reel-cap">${s.cap ? `<b>${esc(s.cap)}</b>` : ""}${s.by ? `<small>${esc(s.by)} · ${esc(fmtDate(s.date))}</small>` : ""}</div>` : ""}</div>`; };
  const bar = () => `<div class="reel-ui"><div class="reel-prog"><i style="width:${Math.max(0, Math.min(100, ((k + 1) / slides.length) * 100))}%"></i></div>
      <div class="reel-btns"><button class="lb-btn" data-rprev aria-label="Previous">‹</button><button class="lb-btn" data-rpause aria-label="${playing ? "Pause" : "Play"}">${playing ? "❚❚" : "▶"}</button><button class="lb-btn" data-rnext aria-label="Next">›</button>
        <span class="grow"></span>${reelUI.music !== "off" ? `<button class="lb-btn" data-rmute aria-label="Music on or off">${box.dataset.muted ? "🔇" : "♪"}</button>` : ""}<button class="lb-btn" data-rx aria-label="Close">✕</button></div></div>`;
  const show = () => { const old = box.querySelector(".reel-stage .reel-frame");
    const st = box.querySelector(".reel-stage") || (box.innerHTML = `<div class="reel-stage"></div>`, box.querySelector(".reel-stage"));
    const f = document.createElement("div"); f.className = "reel-frame"; f.innerHTML = frame(); st.appendChild(f);
    requestAnimationFrame(() => f.classList.add("in")); if (old) { old.classList.remove("in"); setTimeout(() => old.remove(), 900); }
    box.querySelector(".reel-ui")?.remove(); box.insertAdjacentHTML("beforeend", bar()); preload(k + 1); };
  const schedule = () => { clearTimeout(timer); if (!playing || k >= slides.length) return;
    const s = slides[k], ms = (s?.kind === "day" ? 2.6 : reelUI.speed) * 1000;
    timer = setTimeout(() => { go(1); }, ms); };
  const go = (d) => { k = Math.max(0, Math.min(slides.length, k + d)); show();
    if (k >= slides.length) { playing = false; music?.pause(); if (song) { const fade = setInterval(() => { song.volume = Math.max(0, song.volume - 0.1); if (song.volume <= 0.05) { song.pause(); clearInterval(fade); } }, 150); } show(); return; }
    schedule(); };
  const setPlay = (on) => { playing = on; if (on) { if (box.dataset.muted !== "1") { music?.resume(); song?.play().catch(() => {}); } schedule(); } else { clearTimeout(timer); music?.pause(); song?.pause(); } show(); };
  const wake = () => { box.classList.remove("idle"); clearTimeout(hideT); hideT = setTimeout(() => playing && box.classList.add("idle"), 2500); };
  const start = async () => {
    try { await box.requestFullscreen?.(); } catch (e) { /* not allowed - fine */ }
    try { lock = await navigator.wakeLock?.request("screen"); } catch (e) { /* screen may sleep */ }
    if (reelUI.music === "gentle") { music = reelMusic(); music?.start(); }
    if (reelUI.music === "song" && song) { song.currentTime = 0; song.volume = 0.9; song.loop = true; song.play().catch(() => {}); }
    playing = true; k = -1; box.innerHTML = ""; go(1); wake();
  };
  const key = (e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowRight") go(1); else if (e.key === "ArrowLeft") go(-1); else if (e.key === " " && k >= 0) { e.preventDefault(); setPlay(!playing); } };
  box.addEventListener("click", (e) => {
    const b = (s) => e.target.closest(s); wake();
    if (b("[data-rx]")) return close();
    if (b("[data-rmus]")) { reelUI.music = b("[data-rmus]").dataset.rmus; save(); if (reelUI.music === "song" && !song) return box.querySelector("[data-rsong]").click(); return startScreen(); }
    if (b("[data-rspd]")) { reelUI.speed = +b("[data-rspd]").dataset.rspd; save(); return startScreen(); }
    if (b("[data-rcap]")) { reelUI.captions = b("[data-rcap]").dataset.rcap === "true"; save(); return startScreen(); }
    if (b("[data-rplay]")) return start();
    if (b("[data-ragain]")) { song && (song.volume = 0.9); return start(); }
    if (b("[data-rprev]")) return go(-1);
    if (b("[data-rnext]")) return go(1);
    if (b("[data-rpause]")) return setPlay(!playing);
    if (b("[data-rmute]")) { if (box.dataset.muted === "1") { delete box.dataset.muted; if (playing) { music?.resume(); song?.play().catch(() => {}); } } else { box.dataset.muted = "1"; music?.pause(); song?.pause(); } return show(); }
    if (b(".reel-stage")) setPlay(!playing);   // tap the picture to pause / play
  });
  box.addEventListener("change", (e) => { const f = e.target.closest("[data-rsong]")?.files?.[0]; if (!f) { reelUI.music = song ? "song" : "gentle"; return startScreen(); }
    if (songUrl) URL.revokeObjectURL(songUrl); songUrl = URL.createObjectURL(f); song = new Audio(songUrl); song.dataset.name = f.name.replace(/\.[^.]+$/, ""); reelUI.music = "song"; startScreen(); });
  let x0 = null; box.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  box.addEventListener("touchend", (e) => { if (x0 == null || k < 0) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) { e.preventDefault(); go(dx < 0 ? 1 : -1); } });
  box.addEventListener("pointermove", wake);
  document.addEventListener("keydown", key);
  if (reelUI.music === "song") reelUI.music = "gentle";   // a song has to be picked again each time
  startScreen(); preload(0);
}

// ---------------------------------------------------------------- trip setup window
function tripForm(t) {
  const isNew = !t; t = t || { title: "", start: "", end: "", travellers: [], extended: [] };
  const used = (t.travellers || []).map((x) => upc(x.color)).filter(Boolean);
  const nextColor = () => { const all = [...document.querySelectorAll('.prow[data-kind="t"]')].map((r) => r.dataset.color); return TDEFAULT.find((h) => !all.includes(h) && !used.includes(h)) || TDEFAULT[all.length % TDEFAULT.length]; };
  // every person on a trip has a profile; the row shows it (details and colour are changed in the profile)
  const row = (p, kind) => { const per = personFor(p), st = per ? personStatus(per) : null;
    const v = { code: per?.code || p.code || "", name: per?.name || p.name || "", full: per?.fullName || p.fullName || "", color: (per && upc(per.color)) || upc(p.color) || "" };
    return `<div class="prow pcard" data-kind="${kind}" data-pid="${esc(per?.id || p.pid || "")}" data-code="${esc(v.code)}" data-name="${esc(v.name)}" data-full="${esc(v.full)}" data-color="${kind === "t" ? v.color : ""}" style="--pc:${kind === "t" && v.color ? v.color : "var(--muted)"}">
      ${avObj({ ...p, name: v.name, code: v.code }, kind === "t" && v.color ? v.color : EXTRA_C[0], (t?.travellers || []).concat(t?.extended || []))}<span class="pn2"><b>${esc(v.name)}</b>${v.full ? `<small>${esc(v.full)}</small>` : ""}</span>
      <button type="button" class="btn tiny pdocs${st ? " " + st.level : ""}" data-docs title="${esc(st?.text || "Profile, passport, visas and other documents")}"><i class="ic16">${I.file}</i>Profile${per?.docs?.length ? ` · ${per.docs.length} doc${per.docs.length > 1 ? "s" : ""}` : ""}${st && st.level !== "ok" ? ` <span class="dwarn">!</span>` : ""}</button>
      <button type="button" class="btn tiny danger" data-rm title="Remove from this trip" aria-label="Remove ${esc(v.name)} from this trip">✕</button></div>`; };
  const savedPick = (kind) => `<select class="savedpick" data-pick="${kind}" aria-label="Add someone who has a profile"><option value="">${kind === "t" ? "+ Add Traveller" : "+ Add Person"}</option>${[...store.people].sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.code)} (${esc(x.code)})</option>`).join("")}</select>`;
  modal(`<h3>${isNew ? "New Trip" : "Trip Setup"}</h3>
    <label>Trip Name<input name="title" value="${esc(t.title)}" placeholder="e.g. Japan 2027" required></label>
    <div class="row"><label>Start<input type="date" name="start" value="${t.start || ""}" required></label><label>End<input type="date" name="end" value="${t.end || ""}" required></label></div>
    <fieldset class="pbox"><legend>Travellers (Each Gets Their Own Itinerary)</legend>
      <div id="trav">${(t.travellers || []).map((p, k) => row(p, "t", k)).join("")}</div>
      <div class="addrow">${savedPick("t")}<button type="button" class="btn tiny" data-addp="t">New Traveller (Create Profile)</button></div></fieldset>
    <fieldset class="pbox"><legend>Others Joining Sometimes (Optional)</legend>
      <div id="ext">${(t.extended || []).map((p) => row(p, "e")).join("")}</div>
      <div class="addrow">${savedPick("e")}<button type="button" class="btn tiny" data-addp="e">New Person (Create Profile)</button></div></fieldset>
    ${isEditor() ? `<fieldset class="pbox" id="famsbox"><legend>Families for Settling Up (Optional)</legend><div id="fams"></div>
      <button type="button" class="btn tiny" data-addfam>+ Add Family</button>
      <p class="muted small">Group the people joining into families - each family gets its own balance in Budget (Settle Up). Then mark costs as shared with, or paid by, a family.</p></fieldset>` : ""}
    <p class="muted small">Everyone on a trip has a profile: initials (how they appear in the itinerary), full name (helps the AI match names on bookings), their colour and documents. Tap Profile to change them.</p>
    ${isEditor() && !isNew ? `<fieldset class="pbox"><legend>Home Address (Editors Only)</legend><input name="homeaddr" data-was="" value="" autocomplete="off" placeholder="Start typing, e.g. 12 Smith St, Paddington">
      <p class="muted small">Used for the "Leave now for the airport" alert on the first flight, worked out with live traffic. Later flights leave from where you're staying.</p></fieldset>` : ""}
    ${isNew ? "" : `<fieldset class="pbox"><legend>Notifications (This Phone)</legend><div class="pushset">${pushSetupHtml(t)}</div></fieldset>`}
    <fieldset class="pbox"><legend>Colour Theme</legend><div class="themes">
      ${THEMES.map(([k, n, cs]) => `<label class="themecard"><input type="radio" name="theme" value="${k}" ${(t.theme || "ink") === k ? "checked" : ""}><span class="tsw">${cs.map((c) => `<i style="background:${c}"></i>`).join("")}</span><b>${n}</b></label>`).join("")}</div></fieldset>`,
    async (fd, form) => {
      const read = (kind) => [...form.querySelectorAll(`.prow[data-kind="${kind}"]`)].map((r) => ({
        code: r.dataset.code, name: r.dataset.name, fullName: r.dataset.full, color: r.dataset.color || "", pid: r.dataset.pid || "" }))
        .filter((p) => p.code).map(({ fullName, color, pid, ...p }) => ({ ...p, ...(fullName ? { fullName } : {}), ...(color ? { color } : {}), ...(pid ? { pid } : {}) }));
      const travellers = read("t"), extended = read("e");
      if (!travellers.length) throw new Error("Add at least one traveller");
      const codes = travellers.concat(extended).map((p) => p.code);
      if (new Set(codes).size !== codes.length) throw new Error("Each person needs different initials");
      if (codes.some((c) => !/^[A-Z0-9]{2,6}$/.test(c))) throw new Error("Initials: 2-6 letters, no spaces");
      if (fd.get("end") < fd.get("start")) throw new Error("End is before start");
      if (!isNew) {
        const removed = (t.travellers || []).map((p) => p.code).filter((c) => !travellers.some((p) => p.code === c));
        if (removed.length && !confirm(`Remove ${removed.join(", ")} from the travellers? Their bookings stay but won't show in an itinerary.`)) throw new Error("Cancelled");
      }
      // remember everyone for next time (saved people), and link each row to its saved person
      const dup = travellers.find((p, k) => p.color && travellers.findIndex((q) => q.color === p.color) !== k);
      if (dup && !confirm(`${dup.name} has the same colour as another traveller on this trip. Save anyway?`)) throw Object.assign(new Error(""), { back: true });
      for (const p of travellers.concat(extended)) { try { const before = personFor(p); p.pid = await rememberPerson(p);
        if (p.color && before && upc(before.color) !== upc(p.color)) syncPersonColor({ ...before, id: p.pid, color: p.color }); } catch (e) { console.warn("people", e); } }
      const extCodes = extended.map((p) => p.code);
      const famList = fams.map((f) => ({ ...f, members: f.members.filter((c) => extCodes.includes(c)) })).filter((f) => f.members.length)
        .map((f) => ({ id: f.id, name: f.name.trim() || joinNames(f.members.map((c) => extended.find((p) => p.code === c)?.name || c)), members: f.members }));
      const home = form.querySelector("[name=homeaddr]");
      if (home && home.value.trim() !== home.dataset.was) await data.saveHomeAddress(t.id, home.value.trim());
      const id = await data.saveTrip({ title: fd.get("title").trim(), start: fd.get("start"), end: fd.get("end"), travellers, extended, families: famList, theme: fd.get("theme") || "ink" }, isNew ? null : t.id);
      if (isNew) { ui.person = travellers[0].code; localStorage.setItem("tp.person", ui.person); routeTo(id); }
    }, isNew ? null : async () => {
      const typed = prompt(`This deletes "${t.title}" with all its bookings, activities and documents for everyone. Type DELETE to confirm.`);
      if (typed !== "DELETE") throw new Error("Not deleted");
      await data.deleteTrip(t.id); routeTo(null);
    });
  const form = [...document.querySelectorAll(".sheet")].pop();
  wirePushSetup(form, t);
  const homeIn = form.querySelector("[name=homeaddr]");
  if (homeIn) data.homeAddress(t.id).then((v) => { homeIn.dataset.was = v; if (!homeIn.value) homeIn.value = v; });
  if (homeIn) acAttach(homeIn);
  // families for settling up: groups of the people joining (a person is in at most one)
  const fams = (t.families || []).map((f) => ({ ...f, members: [...(f.members || [])] }));
  const drawFams = () => { const box = form.querySelector("#fams"); if (!box) return;
    const ext = [...form.querySelectorAll('.prow[data-kind="e"]')].map((r) => ({ code: r.dataset.code, name: r.dataset.name }));
    box.innerHTML = !ext.length ? `<p class="muted small">Add the people joining above first.</p>` : fams.map((f, k) => `<div class="famrow">
      <input class="famname" data-famname="${k}" value="${esc(f.name || "")}" placeholder="${esc(joinNames(f.members.map((c) => ext.find((p) => p.code === c)?.name || c)) || "Family name")}" aria-label="Family name">
      <span class="ddots">${ext.map((p) => { const other = fams.some((g, j) => j !== k && g.members.includes(p.code)), on = f.members.includes(p.code);
        return `<button type="button" class="dd${on ? " on" : ""}" data-fammem="${k}" data-c="${esc(p.code)}" ${other ? "disabled" : ""} style="--pc:${pcolor(p.code)}" aria-pressed="${on}" title="${esc(p.name)}${other ? " (in another family)" : ""}">${ddIn(p.code)}</button>`; }).join("")}</span>
      <button type="button" class="btn tiny danger" data-famrm="${k}" aria-label="Remove family">✕</button></div>`).join(""); };
  form.querySelector("[data-addfam]")?.addEventListener("click", () => { fams.push({ id: "f" + Date.now().toString(36), name: "", members: [] }); drawFams(); });
  form.querySelector("#fams")?.addEventListener("click", (e) => { const m = e.target.closest("[data-fammem]"), x = e.target.closest("[data-famrm]");
    if (m) { const f = fams[+m.dataset.fammem], c = m.dataset.c; f.members = f.members.includes(c) ? f.members.filter((y) => y !== c) : f.members.concat(c); drawFams(); }
    if (x) { fams.splice(+x.dataset.famrm, 1); drawFams(); } });
  form.querySelector("#fams")?.addEventListener("input", (e) => { const n = e.target.closest("[data-famname]"); if (n) fams[+n.dataset.famname].name = n.value; });
  const extBox = form.querySelector("#ext"); if (extBox) new MutationObserver(drawFams).observe(extBox, { childList: true, subtree: true });
  drawFams();
  const addRow = (per, kind) => {
    if ([...form.querySelectorAll(".prow")].some((r) => r.dataset.pid === per.id || r.dataset.code === per.code)) return toast(`${per.name} is already on this trip`);
    const color = kind === "t" ? upc(per.color) || nextColor() : "";
    if (kind === "t" && [...form.querySelectorAll('.prow[data-kind="t"]')].some((r) => r.dataset.color === color)) toast(`${per.name}'s colour is already used on this trip - change it in their profile`);
    form.querySelector(kind === "t" ? "#trav" : "#ext").insertAdjacentHTML("beforeend", row({ code: per.code, name: per.name, fullName: per.fullName, color, pid: per.id }, kind));
  };
  form.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-pick]"); if (!sel || !sel.value) return;
    const per = store.people.find((x) => x.id === sel.value), kind = sel.dataset.pick; sel.value = "";
    if (per) addRow(per, kind);
  });
  // after a profile is created or edited, redraw its row with the new name, initials and colour
  const refreshRow = (pid, rec) => { const r = form.querySelector(`.prow[data-pid="${CSS.escape(pid)}"]`), per = { ...rec, ...store.people.find((x) => x.id === pid) };
    if (r) r.outerHTML = row({ ...per, pid }, r.dataset.kind); };
  form.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]"); if (rm) rm.closest(".prow").remove();
    const add = e.target.closest("[data-addp]");
    if (add) { const kind = add.dataset.addp; personForm(null, { color: kind === "t" ? nextColor() : "", title: kind === "t" ? "New Traveller" : "New Person",
      onSaved: (pid, rec) => addRow(store.people.find((x) => x.id === pid) || rec, kind) }); }
    const dbtn = e.target.closest("[data-docs]");
    if (dbtn) (async () => { const r = dbtn.closest(".prow");
      try { if (!r.dataset.pid) r.dataset.pid = await rememberPerson({ code: r.dataset.code, name: r.dataset.name, fullName: r.dataset.full, color: r.dataset.color });
        const pid = r.dataset.pid; personForm(pid, { onSaved: (id, rec) => refreshRow(pid, rec) }); } catch (x) { toast("Couldn't open the profile: " + (x.code || x.message)); } })();
  });
}

// ---------------------------------------------------------------- icons + type colours (same everywhere)
const SV = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
const I = {
  pin: SV('<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
  chat: SV('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>'),
  bag: SV('<rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M4 12h16M10 12v2M14 12v2"/>'),
  receipt: SV('<path d="M5 3v18l2-1.5L9 21l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5V3l-2 1.5L15 3l-2 1.5L11 3 9 4.5 7 3z"/><path d="M8 9h8M8 13h6"/>'),
  wifi: SV('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>'),
  house: SV('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>'),
  copy: SV('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>'),
  stats: SV('<path d="M3 3v18h18"/><path d="M7 15v3M11 10v8M15 12v6M19 6v12"/>'),
  globe: SV('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  walk: SV('<circle cx="13" cy="4" r="2"/><path d="m9 20 3-6 3 2v6M6 12l3-4 4 1 3 4 3 1"/><path d="M9 8 7 14"/>'),
  route: SV('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>'),
  camera: SV('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  clip: SV('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  trash: SV('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  file: SV('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h4"/>'),
  map: SV('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>'),
  star: SV('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>'),
  eat: SV('<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2 1-3.5 3.5-3.5 7 0 2 1.5 3 3.5 3"/>'),
  lock: SV('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  gear: SV('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  users: SV('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  upload: SV('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  download: SV('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  archive: SV('<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>'),
  book: SV('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
  logout: SV('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  plusc: SV('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  bell: SV('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  check: SV('<path d="M20 6 9 17l-5-5"/>'),
  phone: SV('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  wsun: SV('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>'),
  wpart: SV('<path d="M12 2v2M4.9 4.9l1.4 1.4M20 12h2M19.1 4.9l-1.4 1.4M15.9 12.7a4 4 0 0 0-5.9-4.1"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>'),
  wcloud: SV('<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>'),
  wfog: SV('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 17H7M17 21H9"/>'),
  wdrizzle: SV('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1"/>'),
  wrain: SV('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M16 14v6M8 14v6M12 16v6"/>'),
  wsnow: SV('<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2"/><path d="M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>'),
  wstorm: SV('<path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9"/><path d="m13 12-3 5h4l-3 5"/>'),
  thumb: SV('<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>'),
  warn: SV('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  drop: SV('<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5S5 13 5 15a7 7 0 0 0 7 7z"/>'),
  scan: SV('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8"/>'),
};
const APP_VERSION = "v2.3";   // shown in the ⋯ menu - matches the service worker cache name
const mi = (act, icon, label) => `<button data-act="${act}"><i class="ic16">${icon}</i><span>${label}</span></button>`;   // menu item
const ICON = {
  map: SV('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>'),
  flight: SV('<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>'),
  stay: SV('<path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9"/>'),
  car: SV('<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2M9 17h6"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>'),
  act: SV('<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
  home: SV('<path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  menu: SV('<path d="M4 6h16M4 12h16M4 18h16"/>'),
  plus: SV('<path d="M12 5v14M5 12h14"/>'),
  dots: SV('<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>'),
  chat: SV('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
  chev: SV('<path d="M9 6l6 6-6 6"/>'),
  wallet: SV('<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3v3a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/><path d="M17 14h.01"/>'),
  food: SV('<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>'),
  bus: SV('<path d="M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>'),
  bag: SV('<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>'),
  grid: SV('<path d="M3 4h18v16H3zM3 10h18M3 15h18M9 4v16"/>'),
  list: SV('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  split: SV('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>'),
  single: SV('<rect x="3" y="4" width="18" height="16" rx="2"/>'),
  clock: SV('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  route: SV('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>'),
};
const KIND = { flight: "flight", stay: "stay", car: "car", activity: "act", act: "act" };
const shortDate = (s) => { const d = D(s); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const WD3 = (s) => WD[D(s).getDay()].slice(0, 3).toUpperCase();
const minus1 = (t) => { const [h, m] = t.split(":").map(Number); const x = Math.max(0, h * 60 + (m || 0) - 1); return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
const cleanTime = (t) => String(t || "").replace(/\s*\(.*\)\s*$/, "").trim();
const codesOf = (route) => String(route || "").split(/[-–>]+/).map((c) => c.trim()).filter(Boolean);
// the same filled initials pills as on the day screen, for whoever is travelling with p
const pillsFor = (codes) => codes.length ? `<span class="tpills" role="img" aria-label="With ${esc(codes.map(NAME).join(", "))}">${codes.map((o) => avHtml(o)).join("")}</span>` : "";
const withPills = (p, date) => pillsFor(PEOPLE().filter((o) => o !== p && together(p, o, date)));
const withText = (p, date) => { const w = PEOPLE().filter((o) => o !== p && together(p, o, date)).map(NAME); return w.length ? "With " + w.join(" & ") : ""; };

// ---------------------------------------------------------------- traveller colours (picked in Trip Setup; none of them is used by a theme)
// Traveller colours: a rainbow, every one dark enough for white initials (contrast 5:1 or more) and clearly different from its neighbours
const TCOLORS = [["Red", "#C62828"], ["Orange", "#B35300"], ["Gold", "#856A00"], ["Green", "#2E7D32"], ["Teal", "#00796B"], ["Blue", "#1565C0"], ["Violet", "#6A35C9"], ["Magenta", "#B0186E"]];
// new travellers get colours far apart from each other first
const EXTRA_C = ["#5D6573", "#7B5B3A", "#3F6A7A", "#6E4F72", "#5F6B3A"];   // muted tones for "others joining sometimes"
const TDEFAULT = ["#1565C0", "#B35300", "#2E7D32", "#B0186E", "#00796B", "#C62828", "#6A35C9", "#856A00"];
// earlier palettes -> nearest rainbow colour (so trips set up before keep a similar choice)
const OLDC = { "#14B8A6": "#00796B", "#0F7C72": "#00796B", "#FF7A59": "#C62828", "#D2442C": "#C62828", "#F2A93B": "#856A00", "#A15F08": "#856A00",
  "#22A06B": "#2E7D32", "#17B2D9": "#1565C0", "#0B76A0": "#1565C0", "#8BBF2B": "#2E7D32", "#5B7A14": "#2E7D32", "#C8553D": "#B35300", "#9A3F24": "#B35300", "#C9A66B": "#B0186E", "#7A5C3E": "#B0186E" };
const upc = (h) => (h && OLDC[h.toUpperCase()]) || h;
const THEMES = [["ink", "Ink & Violet", ["#16141F", "#2F6FED", "#7A4BD6", "#5D6573", "#E0457B"]],
  ["lavender", "Lavender & Pink", ["#4B2A8C", "#3D6BE0", "#C2367A", "#5D6573", "#7C4DDB"]],
  ["midnight", "Midnight (dark)", ["#000000", "#6E9BFF", "#A47BFF", "#9AA3B2", "#FF5FA2"]]];
function pcolor(code) {
  const tr = store.trip?.travellers || []; const k = tr.findIndex((t) => t.code === code);
  const per = k >= 0 && tr[k].pid && store.people.find((x) => x.id === tr[k].pid);   // the traveller's profile colour wins (editors)
  if (k < 0) { const ex = store.trip?.extended || [], j = ex.findIndex((t) => t.code === code);   // others joining: their profile colour, or a muted tone
    const pe = j >= 0 && (store.people.find((x) => x.id === ex[j].pid) || null);
    if (j >= 0) return (pe && upc(pe.color)) || EXTRA_C[j % EXTRA_C.length]; }
  return (per && upc(per.color)) || (k >= 0 && upc(tr[k].color)) || TDEFAULT[Math.max(0, k) % TDEFAULT.length];
}
const inkOn = (hex) => { const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#16141F" : "#FFFFFF"; };
function applyTheme() {
  const th = (ui.tripId && store.trip?.theme) || "ink";
  if (th === "ink") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = THEMES.find((t) => t[0] === th)?.[2][0] || "#16141F";
}

// ---------------------------------------------------------------- header: trip title, initials (traveller menu), view icons, + and ⋯
const VIEWS = [["now", "Now", "clock"], ["overview", "Overview", "grid"], ["timeline", "Timeline", "list"], ["journey", "Journey", "route"], ["budget", "Budget", "wallet"]];
const viewsFor = () => VIEWS.filter((v) => v[0] !== "budget" || isEditor());
function header(opts = {}) {
  const t = store.trip || {}; const today = iso(new Date());
  const when = !t.start ? "" : t.start > today ? `In ${dayDiff(today, t.start)} days` : today <= t.end ? "On now" : "";
  const sub = [window.__previewDate ? "Preview" : "", t.start ? `${shortDate(t.start)} – ${shortDate(t.end)}` : "", when].filter(Boolean).join(" · ");
  const me = ui.person, mc = pcolor(me), tabs = !splitOn();
  const TABNAME = { now: "Today", journal: "Journal", budget: "Budget", more: "More" };
  return `<header class="hero">
    <div class="hero-top">
      <button class="iconbtn" data-home aria-label="All trips" title="All trips">${ICON.menu}</button>
      <div class="hero-title"><span class="hero-sub">${esc(sub)}</span><span class="hero-name">${esc(t.title || "Travel Planner")}</span></div>
      <details class="more who">${tabs ? `<summary class="pbtn2" aria-label="Traveller: ${esc(NAME(me))} - change" title="Change traveller">${avHtml(me)}<span>${esc(NAME(me))}</span></summary>`
        : `<summary class="pbtn" style="--pc:${mc};--pi:${inkOn(mc)}" aria-label="Traveller: ${esc(NAME(me))} - change" title="Change traveller">${esc(me)}</summary>`}
        <div class="pop"><span class="pop-role">Show itinerary for</span>
        ${PEOPLE().map((p) => `<button data-person="${p}" class="${p === me ? "on" : ""}">${avHtml(p)}<span class="grow">${esc(NAME(p))}</span>${p === me ? "✓" : ""}</button>`).join("")}</div></details>
    </div>
    <div class="hero-bar">
      ${!opts.views && ui.day ? `<button class="iconbtn" data-itinerary data-back aria-label="Back to ${VIEWS.find((v) => v[0] === ui.view)?.[1] || "Overview"}" title="Back to ${VIEWS.find((v) => v[0] === ui.view)?.[1] || "Overview"}">${ICON.home}</button>` : ""}
      ${opts.views && tabs ? (PLAN.includes(ui.view) ? `<nav class="vseg lab" aria-label="How to show the plan">${VIEWS.filter((v) => PLAN.includes(v[0])).map(([k, l]) => `<button class="${ui.view === k ? "on" : ""}" data-view="${k}" aria-pressed="${ui.view === k}">${l}</button>`).join("")}</nav>` : `<span class="hero-hint big">${TABNAME[ui.view] || ""}</span>`)
      : opts.views ? `<nav class="vseg${viewsFor().length > 3 ? " icons" : ""}" aria-label="View">${viewsFor().map(([k, l, ic]) => `<button class="${ui.view === k ? "on" : ""}" data-view="${k}" aria-label="${l}" title="${l}">${ICON[ic]}${ui.view === k && viewsFor().length <= 3 ? `<span>${l}</span>` : ""}</button>`).join("")}</nav>` : `<span class="hero-hint">${esc(NAME(me))}'s day</span>`}
      <span class="grow"></span>
      ${ui.pane !== 1 ? splitToggle() : ""}
      ${isEditor() ? `<button class="iconbtn" data-act="add" aria-label="Add booking" title="Add booking">${ICON.plus}</button>` : ""}
      ${tabs ? "" : `<details class="more"><summary class="iconbtn" aria-label="More">${ICON.dots}</summary><div class="pop">
        <span class="pop-role">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""} · ${APP_VERSION}</span>
        ${isEditor() ? `${mi("settings", I.gear, "Trip Setup")}${mi("people", I.users, "Traveller Profiles")}<hr>
        ${mi("bulk", I.clip, "Attach Documents…")}${mi("offline", I.download || I.archive, "Offline Documents…")}${mi("archive", I.archive, "Archive Documents (Zip)…")}<hr>` : ""}
        ${mi("todo", I.check, "To-dos")}${mi("pack", I.bag, "Packing Lists")}${mi("ask", I.chat, "Ask the Trip")}${mi("tripmap", ICON.map, "Trip Map")}${mi("recap", I.stats, "Trip Recap")}${mi("reel", I.camera, "Travel Reel (Slideshow)")}${mi("country", I.globe, "Country Info")}${mi("sos", I.warn, "Emergency &amp; Nearby")}${mi("album", I.book, "Export Album (Word)")}
        ${isEditor() ? `<hr>${mi("export", I.download, "Download Backup")}${mi("import", I.upload, "Restore from Backup…")}` : ""}<hr>
        ${mi("signout", I.logout, "Sign Out")}</div></details>`}
    </div>
  </header>
  ${store.error ? `<div class="banner err">${esc(store.error)}</div>` : ""}`;
}
function wireHeader() {
  root.querySelectorAll("[data-person]").forEach((b) => (b.onclick = () => {
    const pane = b.closest(".pane");
    if (pane) { ui.splitPeople[+pane.dataset.pane] = b.dataset.person; try { localStorage.setItem("tp.splitPeople", JSON.stringify(ui.splitPeople)); } catch (e) { /* ignore */ } render(); return; }
    ui.person = b.dataset.person; ui.voter = null; localStorage.setItem("tp.person", ui.person); render(); }));
  root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => {
    const pane = b.closest(".pane");
    if (pane) { const k = +pane.dataset.pane; ui.split[k] = b.dataset.view; ui.splitDay[k] = null; try { localStorage.setItem("tp.splitViews", JSON.stringify(ui.split)); } catch (e) { /* ignore */ }
      render(); return; }
    ui.view = b.dataset.view; try { localStorage.setItem("tp.view", ui.view); if (PLAN.includes(ui.view)) localStorage.setItem("tp.plan", ui.view); } catch (e) { /* ignore */ } sessionStorage.removeItem("tp.wscroll"); render(); }));
  root.querySelectorAll("[data-split]").forEach((b) => (b.onclick = () => { try { localStorage.setItem("tp.split", splitOn() ? "0" : "1"); } catch (e) { /* ignore */ } render(); }));
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.(b)));
  root.querySelectorAll("[data-home]").forEach((b) => (b.onclick = () => routeTo(null)));
  root.querySelectorAll("[data-itinerary]").forEach((b) => (b.onclick = () => routeTo(ui.tripId, null)));
  // close an open menu when tapping elsewhere
  document.onclick = (e) => document.querySelectorAll("details.more[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
}

// ---------------------------------------------------------------- v2 navigation: labelled tabs along the bottom (one view); the split view keeps its icon bars
const PLAN = ["overview", "timeline", "journey"];
const planMode = () => { const v = localStorage.getItem("tp.plan"); return PLAN.includes(v) ? v : "overview"; };
const tabOf = () => (ui.day ? "plan" : ui.view === "now" ? "today" : PLAN.includes(ui.view) ? "plan" : ui.view);
const TAB_IC = { today: () => ICON.clock, plan: () => SV('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>'), journal: () => I.camera, budget: () => ICON.wallet, map: () => ICON.map,
  more: () => SV('<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>') };
const tabList = () => [["today", "Today"], ["plan", "Plan"], ["journal", "Journal"], isEditor() ? ["budget", "Budget"] : ["map", "Map"], ["more", "More"]];
function goTab(k) {
  if (k === "map") return openTripMap(ui.tripId);
  ui.view = k === "today" ? "now" : k === "plan" ? planMode() : k;
  try { localStorage.setItem("tp.view", ui.view); } catch (e) { /* ignore */ }
  sessionStorage.removeItem("tp.wscroll"); window.scrollTo(0, 0);
  if (ui.day) routeTo(ui.tripId, null); else render();
}
function drawTabs(show) {
  let n = document.getElementById("tabbar");
  if (!show) { n?.remove(); document.body.classList.remove("has-tabs"); return; }
  if (!n) { n = document.createElement("nav"); n.id = "tabbar"; n.className = "tabbar"; n.setAttribute("aria-label", "Main"); document.body.appendChild(n);
    n.addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) goTab(b.dataset.tab); }); }
  document.body.classList.add("has-tabs");
  const cur = tabOf(), open = (store.todos || []).filter((x) => !x.done), today = iso(new Date()), late = open.some((x) => x.due && x.due < today);
  n.innerHTML = tabList().map(([k, l]) => `<button type="button" data-tab="${k}" class="${k === cur ? "on" : ""}" ${k === cur ? 'aria-current="page"' : ""}><span class="tb-ic">${TAB_IC[k]()}${k === "more" && late ? `<i class="tb-dot"></i>` : ""}</span>${l}</button>`).join("");
}

// ---- avatars: a photo or a picture chosen in the Traveller Profile, framed in the person's colour (initials when none is set)
const allPeople = () => (store.trip?.travellers || []).concat(store.trip?.extended || []);
function avatarOf(code) {
  const x = allPeople().find((t) => t.code === code), per = x && personFor(x);
  return (per && per.avatar) || x?.avatar || "";
}
function shortInit(code) {   // "C", or "Ch" when two travellers share a first letter
  const nm = NAME(code) || code, first = nm.slice(0, 1).toUpperCase();
  const clash = allPeople().some((t) => t.code !== code && (t.name || t.code).slice(0, 1).toUpperCase() === first);
  return clash ? first + nm.slice(1, 2).toLowerCase() : first;
}
function avInner(a, label, c) {
  return a && a.startsWith("data:") ? `<img src="${esc(a)}" alt="">` : a && a.startsWith("e:") ? `<span class="av-e">${esc(a.slice(2))}</span>` : `<span class="av-i" style="color:${inkOn(c)}">${esc(label)}</span>`;
}
const ddIn = (code) => avInner(avatarOf(code), shortInit(code), pcolor(code));   // what a traveller toggle shows
// a traveller row that isn't the open trip's (home cards, Trip Setup rows, profiles): x = { code, name, color, avatar, pid }
const initIn = (x, list) => { const nm = x.name || x.code || "?", f = nm.slice(0, 1).toUpperCase();   // "C", or "Ce" when someone else in the list starts with the same letter
  return (list || []).some((t) => t !== x && t.code !== x.code && (t.name || t.code || "").slice(0, 1).toUpperCase() === f) ? f + nm.slice(1, 2).toLowerCase() : f; };
const avObj = (x, c, list) => { const a = (personFor(x) || {}).avatar || x.avatar || ""; return `<span class="av${a ? " has" : ""}" style="--pc:${c}" title="${esc(x.name || x.code || "")}">${avInner(a, initIn(x, list), c)}</span>`; };
const dotsFor = (codes) => (codes.length ? `<span class="idots" role="img" aria-label="${esc(codes.map(NAME).join(", "))}">${codes.map((o) => `<i class="tdot" style="--pc:${pcolor(o)}"></i>`).join("")}</span>` : "");
// who is who: each traveller's colour dot with their preferred name (shown at the top of the plan views)
const whoKey = () => (ALL_CODES().length > 1 ? `<div class="whokey" role="img" aria-label="Who is who: ${esc(ALL_CODES().map(NAME).join(", "))}">${ALL_CODES().map((c) => avHtml(c)).join("")}</div>` : "");
const avHtml = (code, cls = "") => { const c = pcolor(code), a = avatarOf(code); return `<span class="av ${cls}${a ? " has" : ""}" style="--pc:${c}" title="${esc(NAME(code))}">${avInner(a, shortInit(code), c)}</span>`; };
// a small square photo for the avatar (kept with the profile and copied to the trips, so the family login sees it too)
function avatarFromFile(file, S = 128) {
  return new Promise((res, rej) => { const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const cv = document.createElement("canvas"); cv.width = cv.height = S; const s = Math.min(img.width, img.height);
      cv.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S); URL.revokeObjectURL(url); res(cv.toDataURL("image/jpeg", 0.8)); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Couldn't read that photo")); }; img.src = url; });
}
// the AI portrait comes on plain white: make the white around the person see-through (from the top and sides inwards), so the person's colour shows behind
function cutWhite(dataUrl, S = 144) {
  return new Promise((res, rej) => { const img = new Image();
    img.onload = () => { const cv = document.createElement("canvas"); cv.width = cv.height = S; const g = cv.getContext("2d"), s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, S, S);
      const im = g.getImageData(0, 0, S, S), d = im.data, seen = new Uint8Array(S * S), q = [];
      const white = (k) => { const r = d[k * 4], gg = d[k * 4 + 1], b = d[k * 4 + 2]; return Math.min(r, gg, b) > 232 && Math.max(r, gg, b) - Math.min(r, gg, b) < 16; };
      const push = (x, y) => { if (x < 0 || y < 0 || x >= S || y >= S) return; const k = y * S + x; if (seen[k]) return; seen[k] = 1; if (white(k)) q.push(k); };
      for (let i = 0; i < S; i++) { push(i, 0); push(0, i); push(S - 1, i); }
      let n = 0; while (q.length) { const k = q.pop(), x = k % S, y = (k - x) / S; d[k * 4 + 3] = 0; n++; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); }
      if (n < S * S * 0.04) return res(cv.toDataURL("image/jpeg", 0.85));   // no white background came back: keep the picture as it is
      for (let k = 0; k < S * S; k++) if (d[k * 4 + 3] && seen[k] === 0) { const x = k % S, y = (k - x) / S;   // soften the edge a little
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => { const X = x + a, Y = y + b; return X >= 0 && Y >= 0 && X < S && Y < S && d[(Y * S + X) * 4 + 3] === 0; }).length;
        if (nb) d[k * 4 + 3] = nb > 1 ? 120 : 190; }
      g.putImageData(im, 0, 0); res(cv.toDataURL("image/png")); };
    img.onerror = () => rej(new Error("Couldn't read the portrait")); img.src = dataUrl; });
}
async function syncPersonAvatar(per) {
  const a = per.avatar || null;
  for (const t of store.trips) {
    let changed = false;
    const fix = (list) => (list || []).map((x) => ((x.pid === per.id || (!x.pid && x.code === per.code && (x.name || "") === (per.name || ""))) && (x.avatar || null) !== a ? (changed = true, { ...x, avatar: a, pid: per.id }) : x));
    const travellers = fix(t.travellers), extended = fix(t.extended);
    if (changed) await data.saveTrip({ travellers, extended }, t.id).catch((e) => console.warn("avatar sync", t.id, e));
  }
}

// ---------------------------------------------------------------- More tab: everything that isn't a tab, grouped by when you need it
function renderMore() {
  const td = store.todos || [], open = td.filter((x) => !x.done).length, pk = store.packing || [], ed = isEditor();
  const tile = (act, icon, label, badge = "", cls = "") => `<button type="button" class="mtile ${cls}" data-act="${act}">${badge ? `<b class="mbadge">${badge}</b>` : ""}<i>${icon}</i><span>${label}</span></button>`;
  const row = (act, label, sub = "", attr = "") => `<button type="button" class="mrow" ${attr || `data-act="${act}"`}><span class="grow">${label}</span>${sub ? `<small>${sub}</small>` : ""}<i class="mgo">›</i></button>`;
  root.innerHTML = `${header({ views: true })}<div class="morev">
    <section><h3>Before You Go</h3><div class="mgrid">${tile("todo", I.check, "To-dos", open || "")}${tile("pack", I.bag, "Packing", pk.length ? `${pk.filter((x) => x.done).length}/${pk.length}` : "", "soft")}${ed ? tile("bulk", I.clip, "Add Documents") : ""}${tile("country", I.globe, "Country Info")}</div></section>
    <section><h3>On the Trip</h3><div class="mgrid">${tile("ask", I.chat, "Ask the Trip")}${tile("tripmap", ICON.map, "Trip Map")}${tile("sos", I.warn, "Emergency", "", "sos")}${ed ? tile("offline", I.download || I.archive, "Offline Docs") : ""}</div></section>
    <section><h3>Memories</h3><div class="mgrid">${tile("reel", I.camera, "Trip Reel")}${tile("recap", I.stats, "Recap")}${tile("album", I.book, "Photo Album")}${ed ? tile("archive", I.archive, "Archive Docs") : ""}</div></section>
    <section class="mlist">${ed ? row("settings", "Trip Setup", "Travellers, dates, families, notifications") + row("people", "Traveller Profiles", "Photos, colours, documents") + row("export", "Download Backup") + row("import", "Restore from Backup…") : ""}
      ${row("", "All Trips", "", "data-home")}${row("signout", "Sign Out")}</section>
    <p class="muted small mver">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""} · Travel Planner ${APP_VERSION}</p></div>`;
  wireHeader();
}

// ---------------------------------------------------------------- Journal tab: the same journal as on each day, one day at a time
function renderJournalTab() {
  const ds = days(), today = iso(new Date()), posts = (store.journal || []).filter((j) => !j.replyTo && j.date);
  const withPosts = [...new Set(posts.map((j) => j.date))].sort();
  let d = ui.jdate; if (!d || !ds.includes(d)) d = ds.includes(today) ? today : withPosts.filter((x) => ds.includes(x)).at(-1) || ds[0];
  ui.jdate = d;
  const chips = [...new Set([...withPosts.filter((x) => ds.includes(x)), ...(ds.includes(today) ? [today] : []), d])].sort();
  const n = (x) => posts.filter((j) => j.date === x).length;
  root.innerHTML = `${header({ views: true })}<div class="jtab">
    <div class="jtdays">${chips.map((x) => `<button type="button" class="jdchip${x === d ? " on" : ""}" data-jd="${x}">${x === today ? "Today" : `${WD[D(x).getDay()].slice(0, 3)} ${shortDate(x)}`}${n(x) ? `<b>${n(x)}</b>` : ""}</button>`).join("")}
      <select data-jsel aria-label="Another day"><option value="">Another day…</option>${ds.map((x) => `<option value="${x}">${WD[D(x).getDay()].slice(0, 3)} ${shortDate(x)}</option>`).join("")}</select></div>
    <p class="jd-title"><b>${esc(WD[D(d).getDay()])} ${esc(longDate(d))}</b><button type="button" class="lnk" data-day="${d}">Open This Day ›</button></p>
    ${journalHtml(d)}</div>`;
  wireHeader(); wireDays(); wireJournal(d);
  root.querySelectorAll("[data-jd]").forEach((b) => (b.onclick = () => { ui.jdate = b.dataset.jd; render(); }));
  root.querySelector("[data-jsel]").onchange = (e) => { if (e.target.value) { ui.jdate = e.target.value; render(); } };
}

// ---- Today, before the trip: what's left to get ready (to-dos, packing, documents)
function readyHtml() {
  const t = store.trip, today = iso(new Date()), td = store.todos || [], open = td.filter((x) => !x.done).sort((a, b) => (a.due || "9").localeCompare(b.due || "9"));
  const pk = store.packing || [], pdone = pk.filter((x) => x.done).length, issues = tripDocIssues({ id: ui.tripId, ...t });
  const dueTxt = (x) => { if (!x.due) return ""; const n = dayDiff(today, x.due);
    return `<span class="rdue${n < 0 ? " late" : n <= 7 ? " soon" : ""}">${n < 0 ? `${-n} day${n === -1 ? "" : "s"} late` : n === 0 ? "due today" : n <= 7 ? `in ${n} day${n === 1 ? "" : "s"}` : "due " + shortDate(x.due)}</span>`; };
  const total = td.length + pk.length, done = td.length - open.length + pdone;
  return `<section class="ncard ready">
      <div class="rd-head"><h3>Get Ready</h3>${total ? `<span class="muted small">${done} of ${total} done</span>` : ""}</div>
      ${total ? `<div class="rbar"><i style="width:${Math.round(done / total * 100)}%"></i></div>` : ""}
      ${open.slice(0, 3).map((x) => `<div class="rtodo"><button type="button" class="rtick" data-rtick="${esc(x.id)}" aria-label="Mark ${esc(x.text)} as done"></button><div class="grow"><b>${esc(x.text)}</b>${dueTxt(x)}</div>${x.who && allPeople().some((a) => a.code === x.who) ? avHtml(x.who, "sm") : ""}</div>`).join("")}
      ${!td.length ? `<p class="muted small">No to-dos yet. Add things like “Renew ESTA” or “Buy eSIMs”, or let the app suggest some.</p>` : !open.length ? `<p class="rok small">${I.check} All to-dos done</p>` : ""}
      <div class="gtiles"><button type="button" class="gtile" data-act="todo"><i>${I.check}</i><span><b>To-dos</b><small>${td.length ? `${open.length} left` : "Start a list"}</small></span></button>
        <button type="button" class="gtile" data-act="pack"><i>${I.bag}</i><span><b>Packing</b><small>${pk.length ? `${pdone} of ${pk.length} packed` : "Start a list"}</small></span></button>
        ${isEditor() ? `<button type="button" class="gtile${issues.length ? " warn" : ""}" data-act="${issues.length ? "docwarn" : "offline"}"><i>${issues.length ? I.warn : I.file || I.clip}</i><span><b>Documents</b><small>${issues.length ? `${issues.length} to check` : offOn(ui.tripId) ? "Saved on this phone" : "Save for offline"}</small></span></button>` : ""}</div>
    </section>`;
}

// ---------------------------------------------------------------- budget & spending (editors only - costs live in the private collection)
const BCATS = [["flight", "Flights", "flight"], ["stay", "Stays", "stay"], ["car", "Cars", "car"], ["act", "Activities", "act"],
  ["food", "Food & Drink", "food"], ["transport", "Transport", "bus"], ["shopping", "Shopping", "bag"], ["other", "Other", "dots"]];
const CURRENCIES = ["AUD", "USD", "MXN", "CAD", "NZD", "EUR", "GBP"];
const SHARE = { ours: "Us", split: "Shared with a family", theirs: "A family's cost (not ours)" };
// ---- settling up with other families (grouped in Trip Setup from "Others joining sometimes")
const joinNames = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " & " + a.at(-1));
const families = () => (store.trip?.families || []).filter((f) => f.id && (f.members || []).length);
const famName = (id) => families().find((f) => f.id === id)?.name || "Family";
const pctOf = (r) => { const v = parseFloat(r.theirPct); return v >= 0 && v <= 100 ? v : 50; };
// which family a cost is settled with: the one it's shared with / belongs to, or the one that paid for something of ours
function famOf(r) {
  const fams = families(), ok = (id) => fams.some((f) => f.id === id);
  if ((r.share || "ours") === "ours") return r.paidBy && r.paidBy !== "us" && ok(r.paidBy) ? r.paidBy : null;
  if (ok(r.fam)) return r.fam;
  if (r.paidBy && r.paidBy !== "us" && ok(r.paidBy)) return r.paidBy;
  return fams.length === 1 ? fams[0].id : null;
}
// our part of a cost (in home currency): all of it, our share of a shared cost, or nothing for a family's own cost
const ourPart = (r) => (r.home == null ? 0 : r.share === "theirs" ? 0 : r.share === "split" ? (famOf(r) ? r.home * (1 - pctOf(r) / 100) : 0) : r.home);
function shareFields(pv, n = (k) => "priv." + k) {
  const fams = families(), sh = pv.share || "ours";
  return `<div class="sharebox" data-sharebox>
    <label>Whose Cost<select name="${n("share")}" data-sh>${Object.entries(SHARE).map(([k, l]) => `<option value="${k}" ${sh === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    ${fams.length ? `<div class="row"><label data-shf>Family<select name="${n("fam")}">${fams.map((f) => `<option value="${esc(f.id)}" ${(pv.fam || fams[0].id) === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>
      <label data-shp>Their Share<span class="pctin"><input name="${n("theirPct")}" type="number" min="0" max="100" step="1" inputmode="numeric" value="${esc(pv.theirPct ?? 50)}">%</span></label></div>
      <label>Paid By<select name="${n("paidBy")}" data-pb><option value="us">Us</option>${fams.map((f) => `<option value="${esc(f.id)}" ${pv.paidBy === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></label>`
      : sh !== "ours" ? `<p class="muted small">To track who owes what, group the people joining into families in Trip Setup.</p>` : ""}</div>`;
}
function wireShare(form) {
  const box = form?.querySelector("[data-sharebox]"); if (!box) return;
  const sync = () => { const v = box.querySelector("[data-sh]").value;
    box.querySelector("[data-shf]")?.toggleAttribute("hidden", v === "ours"); box.querySelector("[data-shp]")?.toggleAttribute("hidden", v !== "split"); };
  box.addEventListener("change", sync); sync();
}
const settlements = () => Object.entries(store.priv).filter(([, v]) => v && v.kind === "settle").map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
// running balance per family: + they owe us, - we owe them
function settleData(B) {
  const S = B.S, out = families().map((f) => ({ f, bal: 0, lines: [], noRate: 0 }));
  for (const r of B.rows) {
    const fid = famOf(r); if (!fid || !r.m) continue; const o = out.find((x) => x.f.id === fid); if (!o) continue;
    if (r.home == null) { o.noRate++; continue; }
    const our = ourPart(r), their = r.home - our, paidUs = (r.paidBy || "us") === "us";
    const amt = paidUs ? their : -our; if (Math.abs(amt) < 0.005) continue;
    o.bal += amt;
    o.lines.push({ r, amt, what: paidUs ? (r.share === "theirs" ? "their cost - you paid" : `their ${pctOf(r)}% - you paid`) : (r.share === "ours" ? "yours - they paid" : `your ${100 - pctOf(r)}% - they paid`) });
  }
  for (const p of settlements()) { const o = out.find((x) => x.f.id === p.fam); if (!o) continue;
    const v = toHome({ amt: +p.amount || 0, cur: p.currency || S.home }, S); if (v == null) { o.noRate++; continue; }
    const amt = p.dir === "in" ? -v : v; o.bal += amt; o.lines.push({ pay: p, amt, what: p.dir === "in" ? "they paid you" : "you paid them" }); }
  return out;
}
function settleHtml(B) {
  const cur = B.S.home, fams = families();
  if (!fams.length) return (store.trip?.extended || []).length ? `<section class="settle"><h3>Settle Up</h3><p class="muted small">Group the people joining into families in Trip Setup, then mark costs as shared or theirs. Each family gets a running balance here.</p></section>` : "";
  const unlinked = B.rows.filter((r) => r.share === "split" && !famOf(r) && r.m).length;
  return `<section class="settle"><h3>Settle Up</h3>
    ${settleData(B).map(({ f, bal, lines, noRate }) => { const st = Math.abs(bal) < 0.5 ? "even" : bal > 0 ? "in" : "out";
      return `<div class="scard ${st}">
        <div class="s-top"><span class="s-who">${(f.members || []).map((c) => avHtml(c)).join("")}</span>
          <span class="s-bal">${st === "even" ? `<b>${esc(f.name)}</b> - all settled` : st === "in" ? `<b>${esc(f.name)}</b> owe${f.members.length === 1 ? "s" : ""} you <b class="amt">${money(bal, cur, 2)}</b>` : `You owe <b>${esc(f.name)}</b> <b class="amt">${money(-bal, cur, 2)}</b>`}</span></div>
        ${lines.length ? `<details class="s-lines"><summary>${lines.filter((l) => l.r).length} cost${lines.filter((l) => l.r).length === 1 ? "" : "s"}${lines.some((l) => l.pay) ? ` · ${lines.filter((l) => l.pay).length} payment${lines.filter((l) => l.pay).length === 1 ? "" : "s"}` : ""}</summary>
          <ul>${lines.map((l) => l.r ? `<li><button class="lnk" data-${l.r.src === "item" ? "bk" : l.r.src === "entry" ? "bact" : "exp"}="${esc(l.r.id)}">${esc(firstText(l.r.name))}</button><small class="muted">${l.r.date ? shortDate(l.r.date) + " · " : ""}${esc(l.what)}</small><span class="${l.amt > 0 ? "pos" : "neg"}">${l.amt > 0 ? "+" : "−"}${money(Math.abs(l.amt), cur, 2)}</span></li>`
            : `<li class="pay"><button class="lnk" data-settle-edit="${esc(l.pay.id)}">${esc(l.pay.note || "Payment")}</button><small class="muted">${l.pay.date ? shortDate(l.pay.date) + " · " : ""}${esc(l.what)}</small><span class="${l.amt > 0 ? "pos" : "neg"}">${l.amt > 0 ? "+" : "−"}${money(Math.abs(l.amt), cur, 2)}</span></li>`).join("")}</ul>
          <p class="muted small">+ they owe you · − you owe them</p></details>` : `<p class="muted small">No shared costs yet - mark a booking or expense as shared with ${esc(f.name)}.</p>`}
        ${noRate ? `<p class="jwarn small">${noRate} amount${noRate > 1 ? "s" : ""} left out - add the exchange rate in Budget Settings</p>` : ""}
        <button class="btn small" data-settle-pay="${esc(f.id)}">Record a Payment</button></div>`; }).join("")}
    ${unlinked ? `<p class="jwarn small">${unlinked} shared cost${unlinked > 1 ? "s aren't" : " isn't"} linked to a family yet - open ${unlinked > 1 ? "them" : "it"} below and choose the family.</p>` : ""}
  </section>`;
}
function settleForm(fid, p) {
  const S = budgetSettings(), B = budgetData(), d = settleData(B).find((x) => x.f.id === (p?.fam || fid)), bal = d ? d.bal : 0, isNew = !p;
  const curs = [...new Set([S.home, ...Object.keys(S.rates), ...CURRENCIES])];
  p = p || { fam: fid, dir: bal < 0 ? "out" : "in", amount: Math.abs(Math.round(bal * 100) / 100) || "", currency: S.home, date: iso(new Date()) };
  modal(`<h3>${isNew ? "Record a Payment" : "Edit Payment"}</h3><p class="muted small">${esc(famName(p.fam))} · balance now ${Math.abs(bal) < 0.5 ? "settled" : bal > 0 ? `they owe you ${money(bal, S.home, 2)}` : `you owe them ${money(-bal, S.home, 2)}`}</p>
    <label class="pcand"><input type="radio" name="dir" value="in" ${p.dir === "in" ? "checked" : ""}><span><b>${esc(famName(p.fam))} paid us</b></span></label>
    <label class="pcand"><input type="radio" name="dir" value="out" ${p.dir === "out" ? "checked" : ""}><span><b>We paid ${esc(famName(p.fam))}</b></span></label>
    <div class="row"><label>Amount<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(p.amount)}" required></label>
      <label>Currency<select name="currency">${curs.map((c) => `<option ${c === (p.currency || S.home) ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
    <div class="row"><label>Date<input type="date" name="date" value="${esc(p.date || iso(new Date()))}"></label><label>Note<input name="note" value="${esc(p.note || "")}" placeholder="e.g. Bank transfer"></label></div>`,
    async (fd) => { const amount = parseFloat(fd.get("amount")); if (!(amount > 0)) throw new Error("Enter an amount");
      await data.savePrivate(p.id || null, { kind: "settle", fam: p.fam, dir: fd.get("dir"), amount, currency: fd.get("currency"), date: fd.get("date"), note: fd.get("note").trim() }); },
    isNew ? null : () => data.deletePrivate(p.id));
}
const usedMethods = () => [...new Set(Object.values(store.priv).map((v) => (v && v.paidWith || "").trim()).filter((m) => m && !/^paid$/i.test(m)))].sort();
const payMethods = () => { const s = store.priv._budget; return s && Array.isArray(s.methods) ? s.methods : usedMethods(); };
const budgetSettings = () => { const s = store.priv._budget || {}; return { home: s.home || "AUD", rates: s.rates || { USD: 1.5 }, total: +s.total || 0, cats: s.cats || {} }; };
function parseMoney(str, home) {
  const s = String(str ?? "").trim(); if (!s) return null;
  const tags = [[/AU\$|A\$|\bAUD\b/i, "AUD"], [/US\$|\bUSD\b/i, "USD"], [/MX\$|\bMXN\b/i, "MXN"], [/CA\$|C\$|\bCAD\b/i, "CAD"], [/NZ\$|\bNZD\b/i, "NZD"], [/€|\bEUR\b/i, "EUR"], [/£|\bGBP\b/i, "GBP"]];
  const cur = (tags.find(([re]) => re.test(s)) || [null, home])[1];
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/); if (!m) return null;
  return { amt: parseFloat(m[0]), cur };
}
const toHome = (m, S) => (!m ? null : m.cur === S.home ? m.amt : S.rates[m.cur] ? m.amt * S.rates[m.cur] : null);
const money = (n, cur, dp = 0) => { try { return new Intl.NumberFormat("en-AU", { style: "currency", currency: cur, minimumFractionDigits: dp, maximumFractionDigits: dp }).format(n || 0); } catch (e) { return `${cur} ${(n || 0).toFixed(dp)}`; } };
const expenses = () => Object.entries(store.priv).filter(([, v]) => v && v.kind === "expense").map(([id, v]) => ({ id, ...v })).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
function budgetData() {
  const S = budgetSettings(), rows = [];
  for (const i of store.items) {
    const pv = store.priv[i.id] || {}, m = parseMoney(pv.cost, S.home), due = parseMoney(pv.dueAtHotel, S.home);
    rows.push({ src: "item", id: i.id, cat: KIND[i.type], date: i.start, end: i.end, who: i.who || [], tbc: i.status === "tbc",
      name: i.type === "flight" ? `${codesOf(i.route).join(" → ")} ${i.number || ""}`.trim() : i.type === "stay" ? i.name : `${i.company || "Car"}${i.vehicle ? " · " + i.vehicle.replace(/\s*\(.*\)$/, "") : ""}`,
      m, home: toHome(m, S), due: toHome(due, S), share: pv.share || "ours", fam: pv.fam, paidBy: pv.paidBy, theirPct: pv.theirPct, paidWith: pv.paidWith || "" });
  }
  for (const e of store.entries.filter((x) => x.kind === "activity" && x.status !== "recommended")) {
    const pv = store.priv[e.id] || {}; const m = parseMoney(pv.cost, S.home); if (!m) continue;
    rows.push({ src: "entry", id: e.id, cat: "act", date: e.date, name: e.text, who: e.who || [], m, home: toHome(m, S), share: pv.share || "ours", fam: pv.fam, paidBy: pv.paidBy, theirPct: pv.theirPct, planned: !e.confirmed });
  }
  for (const x of expenses()) {
    const m = { amt: +x.amount || 0, cur: x.currency || S.home };
    rows.push({ src: "expense", id: x.id, cat: x.cat || "other", date: x.date, name: x.text || "Expense", who: x.who || [], m, home: toHome(m, S), share: x.share || "ours", fam: x.fam, paidBy: x.paidBy, theirPct: x.theirPct, paidWith: x.paidWith || "" });
  }
  const cats = Object.fromEntries(BCATS.map(([k]) => [k, { booked: 0, spent: 0, shared: 0, due: 0 }]));
  let noCost = 0, unknownRate = new Set();
  for (const r of rows) {
    if (r.src === "item" && !r.m && !r.tbc) noCost++;
    if (r.m && r.home === null) unknownRate.add(r.m.cur);
    const c = cats[r.cat] || cats.other, v = r.home || 0;
    if (r.share === "theirs") continue;
    if (r.share === "split" && !famOf(r)) { c.shared += v; continue; }   // shared, but with no family chosen yet
    const ov = ourPart(r);
    if (r.src === "expense") c.spent += ov; else c.booked += ov;
    if (r.due) c.due += r.due;
  }
  const sum = (k) => Object.values(cats).reduce((a, c) => a + c[k], 0);
  return { S, rows, cats, booked: sum("booked"), spent: sum("spent"), shared: sum("shared"), due: sum("due"), noCost, unknownRate: [...unknownRate],
    toBook: store.items.filter((i) => i.status === "tbc").length };
}
function renderBudget() {
  const B = budgetData(), S = B.S, total = B.booked + B.spent, cur = S.home;
  const pct = S.total ? Math.min(100, Math.round(total / S.total * 100)) : 0;
  const maxCat = Math.max(1, ...BCATS.map(([k]) => Math.max(B.cats[k].booked + B.cats[k].spent, +S.cats[k] || 0)));
  const catRows = BCATS.map(([k, l, ic]) => {
    const c = B.cats[k], t = c.booked + c.spent, tgt = +S.cats[k] || 0; if (!t && !tgt && !c.shared) return "";
    const w = (x) => Math.max(0, Math.min(100, x / (tgt || maxCat) * 100));
    return `<li class="bc-row c-${k}"><span class="ic sm">${ICON[ic]}</span>
      <div class="bc-main"><div class="bc-top"><b>${l}</b><span>${money(t, cur)}${tgt ? `<small> / ${money(tgt, cur)}</small>` : ""}</span></div>
        <div class="bar${tgt && t > tgt ? " over" : ""}"><i style="width:${w(c.booked)}%"></i><i class="sp" style="width:${w(c.spent)}%"></i></div>
        <small class="muted">${[c.booked && `Booked ${money(c.booked, cur)}`, c.spent && `Spent ${money(c.spent, cur)}`, c.shared && `Shared TBC ${money(c.shared, cur)}`, c.due && `Due at property ${money(c.due, cur)}`].filter(Boolean).join(" · ")}</small></div></li>`;
  }).join("");
  const exp = B.rows.filter((r) => r.src === "expense");
  const byDay = {}; exp.forEach((r) => (byDay[r.date] = byDay[r.date] || []).push(r));
  const expHtml = Object.keys(byDay).sort().reverse().map((d) => `<h4 class="bd-date">${d ? `${WD[D(d).getDay()]} ${longDate(d)}` : "No date"}<span>${money(byDay[d].reduce((a, r) => a + (r.home || 0), 0), cur, 2)}</span></h4>
      ${byDay[d].map((r) => `<button class="bl-row c-${r.cat}" data-exp="${r.id}"><span class="dot"></span><span class="bl-name">${store.files.some((f) => f.expenseId === r.id) ? `<i class="rcpt" title="Receipt saved">${I.receipt}</i>` : ""}${esc(r.name)}${r.paidWith || famOf(r) ? `<small>${[r.paidWith, famOf(r) && (r.share === "split" ? `shared with ${famName(famOf(r))}` : r.share === "theirs" ? `${famName(famOf(r))}'s` : `paid by ${famName(famOf(r))}`)].filter(Boolean).map(esc).join(" · ")}</small>` : ""}</span><span class="bl-amt">${money(r.m.amt, r.m.cur, 2)}${r.m.cur !== cur && r.home !== null ? `<small>${money(r.home, cur, 2)}</small>` : ""}</span></button>`).join("")}`).join("");
  const bk = B.rows.filter((r) => r.src !== "expense").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const sideOf = (r) => { const t = store.trip; if (!r.date || !t?.start) return ""; const last = r.end && r.end > r.date && r.src === "item" ? addDays(r.end, -1) : (r.end || r.date);
    return last < t.start ? "before" : r.date > t.end ? "after" : ""; };
  const bkHtml = bk.map((r) => `<button class="bl-row c-${r.cat}${!r.m ? " missing" : ""}${sideOf(r) ? " out " + sideOf(r) : ""}" data-${r.src === "item" ? "bk" : "bact"}="${r.id}"><span class="dot"></span>
      <span class="bl-name">${esc(r.name)}<small>${r.date ? shortDate(r.date) + (r.end && r.end !== r.date ? " – " + shortDate(r.end) : "") : ""}${r.share !== "ours" ? " · " + (famOf(r) ? (r.share === "split" ? `shared with ${famName(famOf(r))} (${pctOf(r)}% theirs)` : `${famName(famOf(r))}'s`) : SHARE[r.share]) : r.paidBy && r.paidBy !== "us" && famOf(r) ? ` · paid by ${famName(famOf(r))}` : ""}${r.planned ? " · not confirmed" : ""}${r.tbc ? " · to book" : ""}${sideOf(r) ? ` · <span class="otag">${sideOf(r) === "before" ? "Before Trip" : "After Trip"}</span>` : ""}</small></span>
      <span class="bl-amt">${r.m ? money(r.m.amt, r.m.cur, 2) : (r.tbc ? "To book" : "Add cost")}${r.m && r.m.cur !== cur && r.home !== null ? `<small>${money(r.home, cur, 2)}</small>` : ""}${r.due ? `<small>+ ${money(r.due, cur, 2)} due</small>` : ""}</span></button>`).join("");
  root.innerHTML = `${header({ views: true })}
    <div class="bd">
      <section class="bd-sum">
        <div class="bd-total"><small>Trip cost so far</small><b>${money(total, cur)}</b>
          <span>${money(B.booked, cur)} booked · ${money(B.spent, cur)} spent</span>
          ${(() => { const dc = dailyCosts(B, false); return dc.preT || dc.postT ? `<span class="bd-out">Includes ${[dc.preT && `${money(dc.preT, cur)} before`, dc.postT && `${money(dc.postT, cur)} after`].filter(Boolean).join(" and ")} the trip dates</span>` : ""; })()}</div>
        ${S.total ? `<div class="bar big${total > S.total ? " over" : ""}"><i style="width:${pct}%"></i></div><p class="bd-target">${pct}% of ${money(S.total, cur)} budget · ${total > S.total ? `${money(total - S.total, cur)} over` : `${money(S.total - total, cur)} left`}</p>` : `<p class="bd-target">No total budget set yet - add one in Budget Settings.</p>`}
        <div class="bd-chips">
          ${B.due ? `<span>Still to pay at properties <b>${money(B.due, cur)}</b></span>` : ""}
          ${B.shared ? `<span>Shared, no family chosen <b>${money(B.shared, cur)}</b></span>` : ""}
          ${B.noCost ? `<span class="warn">${B.noCost} booking${B.noCost > 1 ? "s" : ""} without a cost</span>` : ""}
          ${B.toBook ? `<span>${B.toBook} still to book</span>` : ""}
          ${B.unknownRate.length ? `<span class="warn">Add an exchange rate for ${B.unknownRate.join(", ")}</span>` : ""}
        </div>
        <div class="bd-acts"><button class="btn primary" data-add-exp>+ Add Expense</button><label class="btn" data-scan-wrap>${I.receipt}Scan Receipt<input type="file" accept="image/*,application/pdf" hidden data-scan-exp=""></label><button class="btn" data-bsettings>Budget Settings</button></div>
      </section>
      ${settleHtml(B)}
      <section class="charts"><h3>Charts</h3>${donutChart(B)}${dailyChart(B)}${cumulativeChart(B)}</section>
      <section><h3>By Category</h3><ul class="bc">${catRows || `<li class="muted">No costs yet.</li>`}</ul>
        <div class="bd-rates"><p class="muted small">All amounts in ${cur}${Object.keys(S.rates).length ? ` · ${Object.entries(S.rates).map(([c, r]) => `1 ${c} = ${r} ${cur}`).join(" · ")}` : ""}${store.priv._budget?.ratesDate ? ` · rates of ${longDate(store.priv._budget.ratesDate)}` : " · rates entered by hand"}</p>
          <button class="btn small" data-rates>↻ Latest Rates</button></div></section>
      <section><h3>Spending</h3>${expHtml || `<p class="muted">Nothing logged yet. Use <b>+ Add Expense</b> for meals, tickets, fuel, shopping…</p>`}</section>
      <section><h3>Bookings</h3>${bkHtml || `<p class="muted">No bookings yet.</p>`}</section>
    </div>`;
  wireHeader(); wireBudget(); wireCharts();
}
function wireBudget() {
  root.querySelectorAll("[data-add-exp]").forEach((b) => (b.onclick = () => expenseForm({ date: b.dataset.addExp || (ui.day || defaultExpenseDate()) })));
  root.querySelectorAll("[data-exp]").forEach((b) => (b.onclick = () => expenseForm({ id: b.dataset.exp, ...store.priv[b.dataset.exp] })));
  root.querySelectorAll("[data-scan-exp]").forEach((inp) => (inp.onchange = () => { const f = inp.files[0]; inp.value = ""; if (f) scanReceipt(f, inp.dataset.scanExp || ui.day || defaultExpenseDate()); }));
  root.querySelectorAll("[data-bk]").forEach((b) => (b.onclick = () => itemForm(store.items.find((i) => i.id === b.dataset.bk))));
  root.querySelectorAll("[data-bact]").forEach((b) => (b.onclick = () => entryForm(store.entries.find((e) => e.id === b.dataset.bact))));
  root.querySelectorAll("[data-bsettings]").forEach((b) => (b.onclick = budgetForm));
  root.querySelectorAll("[data-rates]").forEach((b) => (b.onclick = refreshRates));
  root.querySelectorAll("[data-settle-pay]").forEach((b) => (b.onclick = () => settleForm(b.dataset.settlePay)));
  root.querySelectorAll("[data-settle-edit]").forEach((b) => (b.onclick = () => settleForm(null, { id: b.dataset.settleEdit, ...store.priv[b.dataset.settleEdit] })));
}
// latest rates (European Central Bank daily reference rates via Frankfurter - free, no key); returns { USD: 1.52, ... } in home currency
async function fetchRates(home, curs) {
  const want = curs.filter((c) => c !== home); if (!want.length) return { rates: {}, date: "" };
  const urls = [`https://api.frankfurter.dev/v1/latest?base=${home}&symbols=${want.join(",")}`, `https://api.frankfurter.app/latest?from=${home}&to=${want.join(",")}`];
  let lastErr;
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(), rates = {};
      for (const c of want) if (j.rates?.[c]) rates[c] = +(1 / j.rates[c]).toFixed(c === "MXN" ? 5 : 4);
      return { rates, date: j.date || "" };
    } catch (e) { lastErr = e; }
  }
  throw new Error("Couldn't get rates (" + (lastErr?.message || "offline?") + ")");
}
async function refreshRates() {
  const S = budgetSettings(); toast("Getting latest rates…");
  try {
    const { rates, date } = await fetchRates(S.home, CURRENCIES);
    await data.savePrivate("_budget", { ...(store.priv._budget || {}), home: S.home, rates: { ...S.rates, ...rates }, ratesDate: date });
    toast(`Rates updated (${date || "today"})`);
  } catch (e) { toast(e.message); }
}
// ---------------------------------------------------------------- budget charts (SVG, hover/tap tooltips)
// Fixed category order for charts (chosen so neighbouring colours stay distinct, incl. colour-blind checks)
const CHART_ORDER = ["flight", "food", "stay", "transport", "act", "shopping", "car", "other"];
const catLabel = (k) => (k === "before" ? "Before Trip" : k === "after" ? "After Trip" : (BCATS.find((c) => c[0] === k) || [k, k])[1]);
const catVar = (k) => (k === "before" ? "url(#oh-pre)" : k === "after" ? "url(#oh-post)" : `var(--${k})`);
const swatch = (k) => (k === "before" || k === "after" ? `repeating-linear-gradient(45deg,var(--out-${k === "before" ? "pre" : "post"}) 0 2px,var(--out-bg) 2px 4px)` : catVar(k));
const HATCH = `<defs>${[["pre", "out-pre"], ["post", "out-post"]].map(([id, v]) => `<pattern id="oh-${id}" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" style="fill:var(--out-bg)"></rect><rect width="2.2" height="5" style="fill:var(--${v})"></rect></pattern>`).join("")}</defs>`;
const outTip = (o, cur) => CHART_ORDER.filter((k) => o[k] > 0).map((k) => `${catLabel(k)} ${money(o[k], cur)}`).join(" · ");
// spread each cost over the trip days it covers: stays per night, cars per rental day, everything else on its date
function dailyCosts(B, spentOnly) {
  const ds = days(), idx = Object.fromEntries(ds.map((d, i) => [d, i])), blank = () => Object.fromEntries(CHART_ORDER.map((k) => [k, 0]));
  const out = ds.map(blank), pre = blank(), post = blank();   // costs on days before / after the trip get their own grey bucket
  const put = (d, k, v) => { if (d in idx) out[idx[d]][k] += v; else if (ds.length) (d < ds[0] ? pre : post)[k] += v; };
  for (const r of B.rows) {
    const amt = ourPart(r);
    if (!amt || (spentOnly && r.src !== "expense")) continue;
    const k = CHART_ORDER.includes(r.cat) ? r.cat : "other";
    if (r.src === "item" && (r.cat === "stay" || r.cat === "car") && r.end && r.end > r.date) {
      const n = dayDiff(r.date, r.end); for (let j = 0; j < n; j++) put(addDays(r.date, j), k, amt / n);
    } else put(r.date, k, amt);
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return { ds, out, pre, post, preT: sum(pre), postT: sum(post) };
}
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
const kfmt = (v, cur) => (v >= 1000 ? `${money(v / 1000, cur, Number.isInteger(Math.round(v / 100) / 10) ? 0 : 1)}k` : money(v, cur));
const pctTxt = (v, t) => { const p = v / t * 100; return p > 0 && p < 1 ? "<1%" : Math.round(p) + "%"; };
function donutChart(B) {
  const cur = B.S.home, dc = dailyCosts(B, false);
  const parts = CHART_ORDER.map((k) => ({ k, v: dc.out.reduce((a, o) => a + o[k], 0) })).concat([{ k: "before", v: dc.preT }, { k: "after", v: dc.postT }]).filter((p) => p.v > 0);
  const total = parts.reduce((a, p) => a + p.v, 0); if (!total) return "";
  const R = 64, r = 42, cx = 80, cy = 80; let a0 = -Math.PI / 2;
  const arc = (a1, a2) => { const big = a2 - a1 > Math.PI ? 1 : 0, p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(a1, R)}A${R} ${R} 0 ${big} 1 ${p(a2, R)}L${p(a2, r)}A${r} ${r} 0 ${big} 0 ${p(a1, r)}Z`; };
  const segs = parts.map((p) => { const a1 = a0, a2 = a0 + p.v / total * Math.PI * 2 - (parts.length > 1 ? 0.0001 : 0.0002); a0 = a1 + p.v / total * Math.PI * 2;
    const tip = `${catLabel(p.k)}: ${money(p.v, cur)} (${pctTxt(p.v, total)})`;
    return parts.length === 1 ? `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${catVar(p.k)}" stroke-width="${R - r}" data-tip="${esc(tip)}"></circle>`
      : `<path d="${arc(a1, a2)}" style="fill:${catVar(p.k)};stroke:var(--card);stroke-width:2" data-tip="${esc(tip)}"></path>`; }).join("");
  return `<figure class="chart"><figcaption>Where the money goes</figcaption>
    <div class="donut-wrap"><svg viewBox="0 0 160 160" class="donut" role="img" aria-label="Costs by type">${HATCH}${segs}
      <text x="80" y="76" text-anchor="middle" class="d-lab">Total</text><text x="80" y="94" text-anchor="middle" class="d-val">${esc(kfmt(total, cur))}</text></svg>
    <ul class="legend">${parts.map((p) => `<li><i style="background:${swatch(p.k)}"></i><span>${catLabel(p.k)}</span><b>${money(p.v, cur)}</b><small>${pctTxt(p.v, total)}</small></li>`).join("")}</ul></div></figure>`;
}
function dailyChart(B) {
  const cur = B.S.home, spentOnly = ui.chartMode === "spent", { ds, out, pre, post, preT, postT } = dailyCosts(B, spentOnly);
  const tot = out.map((o) => Object.values(o).reduce((a, b) => a + b, 0)), max = niceMax(Math.max(0, preT, postT, ...tot));
  const nPre = preT ? 1 : 0, nPost = postT ? 1 : 0, slots = ds.length + nPre + nPost;
  const W = 340, H = 170, L = 38, T = 8, Bm = 22, cw = (W - L - 4) / Math.max(1, slots), bw = Math.max(3, Math.min(18, cw - 2)), ph = H - T - Bm;
  const outBar = (side, i, v, o) => { const x = L + 2 + i * cw + (cw - bw) / 2, r = Math.min(3, bw / 2);
    return `<g class="obar"><path d="M${x} ${y(0)}V${y(v) + r}Q${x} ${y(v)} ${x + r} ${y(v)}H${x + bw - r}Q${x + bw} ${y(v)} ${x + bw} ${y(v) + r}V${y(0)}Z" style="fill:${catVar(side)}"></path>
      <rect x="${L + 2 + i * cw}" y="${T}" width="${cw}" height="${ph}" fill="transparent" data-tip="${esc(`${catLabel(side)}: ${money(v, cur)} · ${outTip(o, cur)}`)}" data-day="${side}"></rect>
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${side === "before" ? "Pre" : "Post"}</text></g>`; };
  const y = (v) => T + ph - v / max * ph;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="g"></line><text x="${L - 5}" y="${y(max * f) + 3.5}" text-anchor="end" class="ax">${esc(kfmt(max * f, cur))}</text>`).join("");
  const bars = ds.map((d, i) => {
    i += nPre; const x = L + 2 + i * cw + (cw - bw) / 2; let acc = 0, segs = ""; const di = i - nPre;
    const ks = CHART_ORDER.filter((k) => out[di][k] > 0);
    ks.forEach((k, j) => { const v = out[di][k], y0 = y(acc), y1 = y(acc + v), h = Math.max(0, y0 - y1 - (j < ks.length - 1 ? 1.5 : 0)); acc += v;
      segs += j === ks.length - 1 ? `<path d="M${x} ${y0}V${y1 + Math.min(3, h / 2)}Q${x} ${y1} ${x + Math.min(3, bw / 2)} ${y1}H${x + bw - Math.min(3, bw / 2)}Q${x + bw} ${y1} ${x + bw} ${y1 + Math.min(3, h / 2)}V${y0}Z" style="fill:${catVar(k)}"></path>`
        : `<rect x="${x}" y="${y0 - h}" width="${bw}" height="${h}" style="fill:${catVar(k)}"></rect>`; });
    const tip = `${WD[D(d).getDay()].slice(0, 3)} ${shortDate(d)}: ${money(tot[di], cur)}${ks.length ? " · " + ks.map((k) => `${catLabel(k)} ${money(out[di][k], cur)}`).join(" · ") : ""}`;
    const lab = (di === 0 && !nPre) || D(d).getDate() === 1 || D(d).getDay() === 1 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${D(d).getDate()}${di === 0 || D(d).getDate() === 1 ? " " + MON[D(d).getMonth()] : ""}</text>` : "";
    return `<g>${d === iso(new Date()) ? `<rect x="${L + 2 + i * cw}" y="${T}" width="${cw}" height="${ph}" rx="3" class="today-col"></rect>` : ""}${segs}<rect x="${L + 2 + i * cw}" y="${T}" width="${cw}" height="${ph}" fill="transparent" data-tip="${esc((d === iso(new Date()) ? "Today · " : "") + tip)}" data-day="${d}"></rect>${lab}</g>`;
  }).join("") + (nPre ? outBar("before", 0, preT, pre) : "") + (nPost ? outBar("after", slots - 1, postT, post) : "");
  const used = CHART_ORDER.filter((k) => out.some((o) => o[k] > 0)).concat(nPre ? ["before"] : [], nPost ? ["after"] : []);
  return `<figure class="chart"><figcaption>${spentOnly ? "Spending by day" : "Cost by day"}
      <span class="seg-mini"><button class="${spentOnly ? "" : "on"}" data-chart-mode="all">All costs</button><button class="${spentOnly ? "on" : ""}" data-chart-mode="spent">Spending only</button></span></figcaption>
    ${tot.some((v) => v) || preT || postT ? `<svg viewBox="0 0 ${W} ${H}" class="bars" role="img" aria-label="${spentOnly ? "Spending" : "Costs"} per trip day">${HATCH}${grid}${bars}</svg>
    <ul class="legend inline">${used.map((k) => `<li><i style="background:${swatch(k)}"></i><span>${catLabel(k)}</span></li>`).join("")}</ul>
    <p class="muted small">${spentOnly ? "Expenses you logged, by the day you spent them." : "Hotels and cars are spread across the nights / days they cover; flights and activities sit on their date."} Tap a bar to open that day.</p>`
    : `<p class="muted">${spentOnly ? "No expenses logged yet." : "No costs yet."}</p>`}</figure>`;
}
function cumulativeChart(B) {
  const cur = B.S.home, { ds, out, preT, postT } = dailyCosts(B, false); if (!ds.length) return "";
  let run = preT; const cum = out.map((o) => (run += Object.values(o).reduce((a, b) => a + b, 0)));
  const inTrip = run; run += postT;
  if (!run) return "";
  const target = B.S.total, max = niceMax(Math.max(run, target || 0));
  const nPre = preT ? 1 : 0, nPost = postT ? 1 : 0;
  const W = 340, H = 150, L = 38, T = 10, Bm = 20, ph = H - T - Bm, step = (W - L - 8) / Math.max(1, ds.length - 1 + nPre + nPost);
  const x = (i) => L + 4 + (i + nPre) * step, y = (v) => T + ph - v / max * ph;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="g"></line><text x="${L - 5}" y="${y(max * f) + 3.5}" text-anchor="end" class="ax">${esc(kfmt(max * f, cur))}</text>`).join("");
  const pts = cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const today = iso(new Date()), ti = ds.indexOf(today);
  const hits = ds.map((d, i) => `<rect x="${x(i) - step / 2}" y="${T}" width="${step}" height="${ph}" fill="transparent" data-tip="${esc(`${WD[D(d).getDay()].slice(0, 3)} ${shortDate(d)}: ${money(cum[i], cur)} so far${target ? ` · ${Math.round(cum[i] / target * 100)}% of budget` : ""}`)}" data-x="${x(i)}" data-y="${y(cum[i])}"></rect>`).join("");
  return `<figure class="chart"><figcaption>Running total${target ? " vs budget" : ""}</figcaption>${nPre || nPost ? `<ul class="legend inline"><li><i style="background:var(--run, var(--accent))"></i><span>During the trip</span></li>${nPre ? `<li><i style="background:${swatch("before")}"></i><span>Before Trip</span></li>` : ""}${nPost ? `<li><i style="background:${swatch("after")}"></i><span>After Trip</span></li>` : ""}</ul>` : ""}
    <svg viewBox="0 0 ${W} ${H}" class="line" role="img" aria-label="Cumulative trip cost${target ? " against the budget" : ""}">${grid}
      ${target ? `<line x1="${L}" x2="${W}" y1="${y(target)}" y2="${y(target)}" class="budget"></line><text x="${W - 2}" y="${y(target) - 4}" text-anchor="end" class="ax strong">Budget ${esc(kfmt(target, cur))}</text>` : ""}
      ${ti >= 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${T + ph}" class="today"></line>` : ""}
      ${nPre ? `<polyline points="${x(-1)},${y(0)} ${x(-1)},${y(preT)} ${x(0)},${y(cum[0])}" class="run-out pre"></polyline><circle cx="${x(-1)}" cy="${y(preT)}" r="3.5" class="out-dot pre"></circle>
        <rect x="${x(-1) - step / 2}" y="${T}" width="${step}" height="${ph}" fill="transparent" data-tip="${esc(`Before Trip: ${money(preT, cur)}`)}" data-x="${x(-1)}" data-y="${y(preT)}"></rect>` : ""}
      <polyline points="${pts}" class="run"></polyline>
      ${nPost ? `<polyline points="${x(ds.length - 1)},${y(inTrip)} ${x(ds.length)},${y(run)}" class="run-out post"></polyline>
        <rect x="${x(ds.length) - step / 2}" y="${T}" width="${step}" height="${ph}" fill="transparent" data-tip="${esc(`After Trip: + ${money(postT, cur)} · ${money(run, cur)} in all`)}" data-x="${x(ds.length)}" data-y="${y(run)}"></rect>` : ""}
      <circle cx="${x(ds.length - 1 + nPost)}" cy="${y(run)}" r="4" class="run-end${nPost ? " post" : ""}"></circle>
      <text x="${x(ds.length - 1 + nPost) - 6}" y="${y(run) + (y(run) < T + 14 ? 14 : -8)}" text-anchor="end" class="ax strong">${esc(kfmt(run, cur))}</text>
      <text x="${L + 4}" y="${H - 5}" class="ax">${nPre ? "Pre · " : ""}${shortDate(ds[0])}</text><text x="${W}" y="${H - 5}" text-anchor="end" class="ax">${shortDate(ds.at(-1))}${nPost ? " · Post" : ""}</text>
      <circle r="4.5" class="cross-dot" cx="-20" cy="-20"></circle>${hits}</svg></figure>`;
}
function wireCharts() {
  let tip = document.querySelector(".ch-tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "ch-tip"; tip.setAttribute("role", "status"); document.body.appendChild(tip); }
  const show = (el, ev) => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = tip.getBoundingClientRect(), px = (ev.clientX ?? 0), py = (ev.clientY ?? 0);
    tip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, px - r.width / 2)) + "px"; tip.style.top = Math.max(8, py - r.height - 14) + "px";
    const dot = el.closest("svg")?.querySelector(".cross-dot"); if (dot && el.dataset.x) { dot.setAttribute("cx", el.dataset.x); dot.setAttribute("cy", el.dataset.y); }
  };
  const hide = () => { tip.hidden = true; root.querySelectorAll(".cross-dot").forEach((d) => { d.setAttribute("cx", -20); d.setAttribute("cy", -20); }); };
  root.querySelectorAll(".chart [data-tip]").forEach((el) => { el.onpointermove = el.onpointerenter = (ev) => show(el, ev); el.onpointerleave = hide; });
  const cpane = ui.pane;
  root.querySelectorAll(".chart [data-day]").forEach((el) => (el.onclick = () => { hide(); openDay(el.dataset.day, cpane); }));
  root.querySelectorAll("[data-chart-mode]").forEach((b) => (b.onclick = () => { ui.chartMode = b.dataset.chartMode; const y = scrollY; render(); scrollTo(0, y); }));
  hide();
}

const defaultExpenseDate = () => { const t = iso(new Date()), tr = store.trip; return tr && t >= tr.start && t <= tr.end ? t : tr?.start || t; };
// "Paid With": a list of the payment methods from Budget Settings, plus "Other…" for a one-off
function payField(cur, name = "paidWith") {
  const ms = payMethods(), v = (cur || "").trim(), other = v && !ms.includes(v);
  return `<label>Paid With<select name="${name}" data-pay>${ms.length ? "" : `<option value="">-</option>`}${ms.map((m) => `<option ${m === v ? "selected" : ""}>${esc(m)}</option>`).join("")}<option value="__other" ${other || !ms.length ? "selected" : ""}>Other…</option></select></label>
    <label class="payother" ${other || !ms.length ? "" : "hidden"}>Other Payment Method<input name="${name}Other" value="${other ? esc(v) : ""}" placeholder="e.g. Cash, Visa 0385"></label>`;
}
const readPay = (fd, name = "paidWith") => (fd.get(name) === "__other" ? (fd.get(name + "Other") || "") : (fd.get(name) || "")).trim();
function setPay(form, name, v) {
  const sel = form.querySelector(`[name="${name}"]`); if (!sel) return;
  const opt = [...sel.options].find((o) => o.value.toLowerCase() === String(v).trim().toLowerCase());
  sel.value = opt ? opt.value : "__other"; const o = sel.closest("label").nextElementSibling; o.hidden = !!opt;
  if (!opt) o.querySelector("input").value = v;
}
function wirePay(form) {
  form.querySelectorAll("[data-pay]").forEach((sel) => (sel.onchange = () => { const o = sel.closest("label").nextElementSibling; o.hidden = sel.value !== "__other"; if (!o.hidden) o.querySelector("input").focus(); }));
}
let lastShare = null;   // the sharing choice of the last expense, used for the next new one
function expenseForm(x) {
  const S = budgetSettings(), isNew = !x.id;
  if (isNew && lastShare && !x.share) x = { ...lastShare, ...x };
  const rfile = x.receiptFile, saved = x.id ? store.files.filter((f) => f.expenseId === x.id) : [];
  const curs = [...new Set([S.home, ...Object.keys(S.rates), ...CURRENCIES])];
  modal(`<h3>${isNew ? "Add Expense" : "Edit Expense"}</h3>
    <label>What For<input name="text" value="${esc(x.text || "")}" placeholder="e.g. Dinner at Hartwood" required></label>
    <div class="row"><label>Amount<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${x.amount ?? ""}" required></label>
      <label>Currency<select name="currency">${curs.map((c) => `<option ${c === (x.currency || S.home) ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
    <div class="row"><label>Category<select name="cat">${BCATS.map(([k, l]) => `<option value="${k}" ${k === (x.cat || "food") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Date<input type="date" name="date" value="${x.date || defaultExpenseDate()}"></label></div>
    ${payField(x.paidWith)}
    ${shareFields(x, (k) => "s_" + k)}
    ${whoBoxes(x.who || PEOPLE())}
    ${rfile ? `<p class="rcpt-note">${I.receipt}<span>Receipt photo will be saved with this expense${x.scanNote ? ` · <span class="muted">${esc(x.scanNote)}</span>` : ""}</span></p>` : ""}
    ${saved.length ? `<p class="rcpt-note">${I.receipt}<span>${saved.map((f) => `<button type="button" class="lnk" data-rview="${esc(f.id)}">View receipt</button>`).join(" · ")}</span></p>` : ""}`,
    async (fd) => {
      const amount = parseFloat(fd.get("amount")); if (!(amount >= 0)) throw new Error("Enter an amount");
      const sh = { share: fd.get("s_share") || "ours", fam: fd.get("s_fam") || "", paidBy: fd.get("s_paidBy") || "us", theirPct: fd.get("s_theirPct") || "" };
      const eid = await data.savePrivate(x.id || null, { kind: "expense", text: fd.get("text").trim(), amount, currency: fd.get("currency"), cat: fd.get("cat"), date: fd.get("date"), paidWith: readPay(fd), who: fd.getAll("who"), ...sh });
      if (isNew) lastShare = sh;
      if (rfile) { try { await data.uploadFile(rfile, { expenseId: eid }); } catch (e) { toast("The expense is saved, but the receipt photo couldn't be: " + (e.code || e.message)); } }
    }, isNew ? null : async () => { await data.deletePrivate(x.id); for (const f of saved) await data.deleteFile(f).catch(() => {}); });
  const form = [...document.querySelectorAll(".sheet")].pop();
  wirePay(form); wireShare(form);
  form.querySelectorAll("[data-rview]").forEach((b) => (b.onclick = () => openFile(store.files.find((f) => f.id === b.dataset.rview))));
}
// photograph a receipt -> the AI fills in the expense form (you check it, then save)
async function scanReceipt(file, date) {
  toast("Reading the receipt…");
  const t = store.trip, stay = store.items.find((i) => i.type === "stay" && i.start <= date && date < i.end);
  const ci = t.countryInfo, curs = ci?.codes?.map((c) => ci.data[c]?.currency?.code).filter(Boolean).join(", ");
  let r; try { r = await data.receiptAI(file, { date, countries: tripCountries().map(countryName).join(", "), where: stay ? stayArea(stay) || stay.name : "", cur: curs || "" }); }
  catch (e) { toast("Couldn't read the receipt: " + (e.message || e)); return expenseForm({ date, receiptFile: file }); }
  const amount = parseFloat(String(r.total || "").replace(/[^\d.]/g, ""));
  const cur = /^[A-Z]{3}$/.test(r.currency || "") ? r.currency : undefined;
  const pay = (() => { const m = String(r.paidWith || "").match(/(\d{4})\s*$/); const known = payMethods();
    return (m && known.find((k) => k.endsWith(m[1]))) || r.paidWith || ""; })();
  const note = [r.summary, r.tip && `tip ${r.tip}`, r.people && !/people|persons|pax/i.test(r.summary || "") && `${r.people} people`].filter(Boolean).join(" · ");
  expenseForm({ date: r.date && r.date >= addDays(t.start, -30) && r.date <= addDays(t.end, 30) ? r.date : date, text: r.merchant || "Receipt", amount: amount >= 0 ? amount : "", currency: cur,
    cat: BCATS.some(([k]) => k === r.cat) ? r.cat : "other", paidWith: pay, receiptFile: file, scanNote: note });
  toast("Check the details, then save");
}
function budgetForm() {
  const S = budgetSettings();
  const rateRows = CURRENCIES.filter((c) => c !== S.home).map((c) => `<label>1 ${c} =<input name="rate.${c}" type="number" step="any" min="0" value="${S.rates[c] ?? ""}" placeholder="rate"></label>`).join("");
  modal(`<h3>Budget Settings</h3>
    <label>Home Currency<select name="home">${CURRENCIES.map((c) => `<option ${c === S.home ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <fieldset class="pbox"><legend>Exchange Rates (in home currency)</legend><div class="rates">${rateRows}</div>
      <div class="row wrap"><button type="button" class="btn small" data-fetch-rates>↻ Get Latest Rates</button><span class="muted small" data-rates-note>${store.priv._budget?.ratesDate ? `Last updated: ${longDate(store.priv._budget.ratesDate)}` : "Daily European Central Bank rates"}</span></div>
      <p class="muted small">Costs in other currencies are converted with these. Banks and cards add their own fees.</p></fieldset>
    <fieldset class="pbox"><legend>Payment Methods</legend>
      <div id="pmlist">${payMethods().map((m) => `<div class="pmrow"><input name="pm" value="${esc(m)}" placeholder="e.g. Amex 2008"><button type="button" class="btn tiny danger" data-rm-pm aria-label="Remove">✕</button></div>`).join("")}</div>
      <button type="button" class="btn tiny" data-add-pm>+ Add Method</button>
      <p class="muted small">These appear in the Paid With list when you add an expense or a booking.</p></fieldset>
    <label>Total Budget<input name="total" type="number" step="any" min="0" value="${S.total || ""}" placeholder="optional"></label>
    <fieldset class="pbox"><legend>Budget per Category (Optional)</legend><div class="rates">
      ${BCATS.map(([k, l]) => `<label>${l}<input name="cat.${k}" type="number" step="any" min="0" value="${S.cats[k] || ""}"></label>`).join("")}</div></fieldset>`,
    async (fd) => {
      const rates = {}, cats = {};
      for (const [k, v] of fd.entries()) { if (k.startsWith("rate.") && v) rates[k.slice(5)] = +v; if (k.startsWith("cat.") && v) cats[k.slice(4)] = +v; }
      const form = document.querySelector(".sheet");
      const methods = [...new Set(fd.getAll("pm").map((m) => m.trim()).filter(Boolean))];
      await data.savePrivate("_budget", { home: fd.get("home"), rates, total: +fd.get("total") || 0, cats, methods, ratesDate: form?.dataset.ratesDate || store.priv._budget?.ratesDate || "" });
    });
  const form = [...document.querySelectorAll(".sheet")].pop();
  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-rm-pm]")) e.target.closest(".pmrow").remove();
    if (e.target.closest("[data-add-pm]")) { form.querySelector("#pmlist").insertAdjacentHTML("beforeend", `<div class="pmrow"><input name="pm" placeholder="e.g. Cash"><button type="button" class="btn tiny danger" data-rm-pm aria-label="Remove">✕</button></div>`); form.querySelector("#pmlist .pmrow:last-child input").focus(); }
  });
  form.querySelector("[data-fetch-rates]").onclick = async (ev) => {
    const btn = ev.currentTarget, note = form.querySelector("[data-rates-note]"), home = form.querySelector("[name=home]").value;
    btn.disabled = true; note.textContent = "Getting rates…";
    try {
      const { rates, date } = await fetchRates(home, CURRENCIES);
      CURRENCIES.forEach((c) => { const inp = form.querySelector(`[name="rate.${c}"]`); if (inp) inp.value = c === home ? "" : (rates[c] ?? inp.value); });
      form.dataset.ratesDate = date; note.textContent = `Rates of ${date ? longDate(date) : "today"} - press Save to keep them`;
    } catch (e) { note.textContent = e.message; } finally { btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- Overview (the spreadsheet, phone-sized)
// Stays and cars use two half-columns: a booking starts in the right half of its first day, fills both halves in between
// and ends in the left half of its last day, so hand-overs read like the spreadsheet. Each booking is one SVG shape.
const placeCode = (x) => { const m = String(x || "").trim().match(/^([A-Z]{3})\b/); return m ? m[1] : String(x || "").replace(/\s*airport$/i, "").trim(); };
const ROW_H = 34;
function renderOverview() {
  const p = ui.person, ds = days(), N = ds.length, today = iso(new Date());
  const ix = (d) => dayDiff(store.trip.start, d);
  const others = PEOPLE().filter((o) => o !== p);
  const cells = [];
  ds.forEach((d, k) => {
    const wd = D(d).getDay(), wk = wd === 0 || wd === 6, first = k === 0 || D(d).getDate() === 1;
    const dots = others.filter((o) => together(p, o, d)).map((o) => `<i style="background:${pcolor(o)}" title="With ${esc(NAME(o))}"></i>`).join("");
    if (d === today) cells.push(`<div class="ov-today" style="grid-row:${k + 1}" aria-hidden="true"></div>`);
    cells.push(`<div class="ov-bg${wk ? " wk" : k % 2 ? "" : " alt"}" style="grid-row:${k + 1}"></div>
      <button class="ov-day${d === today ? " today" : ""}" data-day="${d}" style="grid-row:${k + 1}" aria-label="${WD[wd]} ${longDate(d)}${d === today ? " (today)" : ""}"><span class="ov-dn"><b>${D(d).getDate()}</b><small class="${first ? "mon" : wk ? "wk" : ""}">${first ? MON[D(d).getMonth()].toUpperCase() : WD3(d)}</small></span><span class="ov-dots">${dots}</span></button>`);
  });
  const its = itemsFor(p).filter((i) => i.end >= store.trip.start && i.start <= store.trip.end).sort((a, b) => a.start.localeCompare(b.start));
  // Bookings of the same type that would cover the same space are a "clash": only one is drawn at a time, in a clash colour,
  // with a swap button to switch which one fills the space. Occupancy is counted in half-days (stays/cars hand over mid-row).
  const occ = (i) => { const a = ix(i.start), b = ix(i.end); return i.type === "flight" || a === b ? [2 * a, 2 * b + 1] : [2 * a + 1, 2 * b]; };
  const collide = (a, b) => { const x = occ(a), y = occ(b); return x[0] <= y[1] && y[0] <= x[1]; };
  const clusters = (list) => { const gs = []; for (const i of list) { const hit = gs.filter((g) => g.some((j) => collide(i, j))); const m = [i, ...hit.flat()]; hit.forEach((g) => gs.splice(gs.indexOf(g), 1)); gs.push(m); }
    return gs.map((g) => g.sort((a, b) => a.start.localeCompare(b.start) || (a.updatedAt || "").localeCompare(b.updatedAt || ""))).sort((a, b) => a[0].start.localeCompare(b[0].start)); };
  // For each clash group, the selected booking is drawn and every other one that doesn't clash with what's drawn is drawn too;
  // the swap button steps through the distinct arrangements.
  const layout = (list) => clusters(list).flatMap((g) => {
    if (g.length < 2) return [{ i: g[0], clash: 0 }];
    const sets = [];
    g.forEach((first) => { const drawn = [first]; g.forEach((x) => { if (!drawn.includes(x) && !drawn.some((d) => collide(d, x))) drawn.push(x); });
      const sig = drawn.map((x) => x.id).sort().join("|"); if (!sets.some((t) => t.sig === sig)) sets.push({ sig, first, drawn }); });
    if (sets.length < 2 && sets[0].drawn.length === g.length) return g.map((i) => ({ i, clash: 0 }));
    const key = g.map((x) => x.id).sort().join("|"), k = (ui.swap[key] || 0) % sets.length, set = sets[k], clash = (k % 2) + 1;
    return set.drawn.sort((a, b) => a.start.localeCompare(b.start)).map((i) => ({ i, clash, key, k, n: sets.length, btn: i === set.first, hidden: g.length - set.drawn.length }));
  });
  const swapBtn = (pk, col, row) => pk.btn ? cells.push(`<button class="ov-swap c${pk.clash}" data-swap="${esc(pk.key)}" style="grid-column:${col};grid-row:${row}" title="Overlapping bookings - ${pk.hidden} hidden here (view ${pk.k + 1} of ${pk.n}). Tap to switch." aria-label="Switch overlapping bookings (view ${pk.k + 1} of ${pk.n})"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5h9M9.5 3 12 5.5 9.5 8M13 10.5H4M6.5 8 4 10.5 6.5 13"/></svg></button>`) : 0;
  // flights: one rounded block per flight in the Flight column
  layout(its.filter((i) => i.type === "flight")).forEach((pk) => {
    const i = pk.i;
    const s = Math.max(0, ix(i.start)), e = Math.min(N - 1, ix(i.end)); const c = codesOf(i.route);
    const lab = c.length ? `${c[0]}-${c.at(-1)}` : (i.number || "Flight");
    cells.push(`<button class="ov-fl${i.status === "tbc" ? " tbc" : ""}${pk.clash ? " clash c" + pk.clash : ""}" data-day="${i.start}" style="grid-row:${s + 1} / ${e + 2}" title="${esc(c.join(" → "))}"><b>${esc(lab)}</b></button>`);
    swapBtn(pk, 2, s + 1);
  });
  // stays and cars: one shape per booking (clashing ones: one at a time, see above)
  const shapes = [];
  let clashNow = 0;
  const lab = (col, r1, r2, cls, d, title, sub) => cells.push(`<button class="ov-lab ${cls}${clashNow ? " clash c" + clashNow : ""}" data-day="${d}" style="grid-column:${col};grid-row:${r1} / ${r2}">${title ? `<b>${esc(title)}</b>` : ""}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`);
  [["stay", 3], ["car", 5]].forEach(([type, col]) => {
    layout(its.filter((i) => i.type === type)).forEach((pk, n) => {
      const i = pk.i; clashNow = pk.clash;
      const s0 = ix(i.start), e0 = ix(i.end), cutTop = s0 < 0, cutBot = e0 > N - 1;
      const s = Math.max(0, s0), e = Math.min(N - 1, e0);
      shapes.push({ type, half: col === 3 ? 0 : 1, s, e, cutTop, cutBot, shade: n % 2, tbc: i.status === "tbc", day: i.start, clash: pk.clash });
      swapBtn(pk, col + 1, s + 1);
      const name = type === "stay" ? (i.short || i.name) : (i.company || "Car");
      const sub = type === "stay" ? areaOf(i) : (i.vehicle || "").replace(/\s*\(.*\)$/, "");
      const inLab = type === "car" ? placeCode(i.pickup) : "", outLab = type === "car" ? placeCode(i.dropoff) : "";
      const mid0 = cutTop ? s : s + 1, mid1 = cutBot ? e : e - 1, hasMid = mid1 >= mid0 && e > s;
      const tbc = i.status === "tbc" ? " (TBC)" : "";
      if (e === s) { lab(`${col} / span 2`, s + 1, s + 2, "", i.start, name + tbc, ""); return; }
      if (!cutTop) lab(`${col + 1} / span 1`, s + 1, s + 2, hasMid ? "half loc" : "half", i.start, hasMid ? inLab : name + tbc, "");
      if (hasMid) lab(`${col} / span 2`, mid0 + 1, mid1 + 2, "", addDays(i.start, cutTop ? 0 : 1), name + tbc, sub);
      if (!cutBot) lab(`${col} / span 1`, e + 1, e + 2, "half loc", i.end, hasMid ? outLab : (type === "stay" ? sub : outLab), "");
    });
  });
  clashNow = 0;
  const legend = others.length ? `<div class="ov-legend"><span class="muted">Traveling together with:</span>${others.map((o) => `<span><i style="background:${pcolor(o)}"></i>${esc(NAME(o))}</span>`).join("")}</div>` : "";
  root.innerHTML = `${header({ views: true })}
    <div class="ov">${whoKey()}${outsideBlock(p, "before")}<div class="ov-card">
      <div class="ov-head"><span class="l">DAY</span><span class="k-flight">FLIGHT</span><span class="k-stay" style="grid-column:3 / span 2">STAY</span><span class="k-car" style="grid-column:5 / span 2">CAR</span></div>
      <div class="ov-grid" style="--n:${N}">${cells.join("")}<svg class="ov-svg" aria-hidden="true"></svg></div>
      </div>${outsideBlock(p, "after")}</div>`;
  const svgEl = root.querySelector(".ov-svg"); if (svgEl) { svgEl._shapes = shapes; svgEl._pane = ui.pane; } drawOverviewShapes(svgEl);
  wireHeader(); wireDays();
  root.querySelectorAll("[data-swap]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); const k = b.dataset.swap; ui.swap[k] = (ui.swap[k] || 0) + 1;
    try { localStorage.setItem("tp.swap", JSON.stringify(ui.swap)); } catch (e) { /* ignore */ } const y = scrollY; render(); scrollTo(0, y); }));
  const back = sessionStorage.getItem("tp.wscroll");
  if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (ds.includes(today) && !ui.ovScrolled) { ui.ovScrolled = true; const el = root.querySelector(".ov-day.today"); if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 200)); }
}
function drawOverviewShapes(svg) {
  if (!svg || !svg._shapes) return; const shapes = svg._shapes;
  const W = svg.getBoundingClientRect().width, H = ROW_H, GAP = 3, PAIR = (W - GAP) / 2, INSET = 2, R = 12, NECK = 10;
  if (!W) return;
  const rows = days().length; svg.setAttribute("viewBox", `0 0 ${W} ${rows * H}`);
  const outline = (x0, s, e, cutTop, cutBot) => {
    const xL = x0, xR = x0 + PAIR, xm = x0 + PAIR / 2, ys = s * H, ye = e * H;
    if (e === s || (cutTop && cutBot)) return [[xL, ys], [xR, ys], [xR, ye + H], [xL, ye + H]];
    if (e - s === 1 && !cutTop && !cutBot) { const yb = ys + H, n = NECK;
      return [[xm, ys], [xR, ys], [xR, yb], [xm + n, yb], [xm, yb + n], [xm, yb + H], [xL, yb + H], [xL, yb], [xm - n, yb], [xm, yb - n]]; }
    const pts = cutTop ? [[xL, ys], [xR, ys]] : [[xm, ys], [xR, ys]];
    if (cutBot) pts.push([xR, ye + H], [xL, ye + H]); else pts.push([xR, ye], [xm, ye], [xm, ye + H], [xL, ye + H]);
    if (!cutTop) pts.push([xL, ys + H], [xm, ys + H]);
    return pts;
  };
  const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const pathOf = (pts, inset = INSET) => {   // shrink by INSET (even gap between neighbours), then round every corner
    const M = pts.length, INS = inset, RR = Math.max(4, R - (inset - INSET));
    const ins = pts.map((v, i) => {
      const a = unit(pts[(i - 1 + M) % M], v), b = unit(v, pts[(i + 1) % M]);
      const na = [-a[1], a[0]], nb = [-b[1], b[0]], k = 1 + na[0] * nb[0] + na[1] * nb[1];
      return [v[0] + INS * (na[0] + nb[0]) / k, v[1] + INS * (na[1] + nb[1]) / k];
    });
    return ins.map((v, i) => {
      const p0 = ins[(i - 1 + M) % M], q = ins[(i + 1) % M];
      const t = Math.min(RR, Math.hypot(v[0] - p0[0], v[1] - p0[1]) / 2, Math.hypot(q[0] - v[0], q[1] - v[1]) / 2);
      const a = unit(p0, v), b = unit(v, q);
      return `${i ? "L" : "M"}${(v[0] - a[0] * t).toFixed(1)} ${(v[1] - a[1] * t).toFixed(1)}Q${v[0].toFixed(1)} ${v[1].toFixed(1)} ${(v[0] + b[0] * t).toFixed(1)} ${(v[1] + b[1] * t).toFixed(1)}`;
    }).join("") + "Z";
  };
  svg.innerHTML = shapes.map((x) => {
    const fill = x.tbc ? "var(--card)" : x.clash ? `var(--clash${x.clash}-t)` : `var(--${x.type}-t${x.shade ? "2" : ""})`;
    const stroke = x.tbc ? `stroke:var(--${x.clash ? "clash" + x.clash : x.type});stroke-width:1.5;stroke-dasharray:4 3;` : "";
    return `<path data-day="${x.day}" d="${pathOf(outline(x.half * (PAIR + GAP), x.s, x.e, x.cutTop, x.cutBot), x.tbc ? INSET + 0.75 : INSET)}" style="fill:${fill};${stroke}"></path>`;
  }).join("");
  svg.querySelectorAll("[data-day]").forEach((el) => (el.onclick = () => openDay(el.dataset.day, svg._pane)));
}
window.addEventListener("resize", () => document.querySelectorAll(".ov-svg").forEach((svg) => drawOverviewShapes(svg)));
// swipe left / right on the itinerary to move between Overview, Timeline and Journey (phones)
(() => {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    ok = e.touches.length === 1 && !!ui.tripId && !splitOn() && !document.querySelector(".modal") && !e.target.closest(".seg,.vseg,.daymap,.pop,input,textarea,select");
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - t0 > 700) return;
    if (ui.day) {   // day screen: swipe left = next day, right = previous day
      const ds = days(), j = ds.indexOf(ui.day) + (dx < 0 ? 1 : -1);
      if (j < 0 || j >= ds.length) return;
      ui.slide = dx < 0 ? "from-right" : "from-left"; window.scrollTo(0, 0); routeTo(ui.tripId, ds[j], true); return;
    }
    const V = viewsFor(), k = V.findIndex((v) => v[0] === ui.view), n = k + (dx < 0 ? 1 : -1);
    if (n < 0 || n >= V.length) return;
    ui.view = V[n][0]; ui.slide = dx < 0 ? "from-right" : "from-left";
    try { localStorage.setItem("tp.view", ui.view); } catch (err) { /* ignore */ }
    sessionStorage.removeItem("tp.wscroll"); window.scrollTo(0, 0); render();
  }, { passive: true });
})();

const pillHtml = (s) => `<span class="pill k-${s.k}${s.tbc ? " tbc" : ""}"><span class="ic">${ICON[s.k]}</span><span class="pt"><b>${s.rich ? fmt(s.title) : esc(s.title)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</span>${s.tbc ? `<span class="tbctag">TBC</span>` : ""}</span>`;

// ---------------------------------------------------------------- what happens on a day (for one traveller)
function dayInfo(p, date) {
  const allDay = [], steps = [];
  const its = itemsFor(p).filter((i) => i.start <= date && date <= i.end);
  const firstDep = its.filter((i) => i.type === "flight" && i.start === date && i.dep).map((i) => cleanTime(i.dep)).sort()[0];
  for (const i of its) {
    const tbc = i.status === "tbc", N = dayDiff(i.start, i.end), n = dayDiff(i.start, date) + 1;
    if (i.type === "flight") {
      const c = codesOf(i.route); const fl = [i.airline, i.number].filter(Boolean).join(" ");
      if (date === i.start) steps.push({ k: "flight", time: cleanTime(i.dep), title: c.join(" → ") || "Flight", sub: [fl, i.arr && "lands " + i.arr + landTz(i)].filter(Boolean).join(" · "), id: i.id });
      else if (date === i.end) steps.push({ k: "flight", time: cleanTime(i.arr), title: "Land in " + (c.at(-1) || ""), sub: fl, id: i.id });
      else allDay.push({ k: "flight", title: "In flight", sub: fl });
    } else if (i.type === "stay") {
      const nm = i.short || i.name;
      if (date === i.start) steps.push({ k: "stay", time: cleanTime(i.checkin), key: i.checkin ? null : "23:58", title: "Check in", sub: i.name, tbc, id: i.id });
      if (date === i.end) steps.push({ k: "stay", time: cleanTime(i.checkout), key: i.checkout ? null : "00:01", title: "Check out", sub: i.name, tbc, id: i.id });
      if (i.start < date && date < i.end) allDay.push({ k: "stay", title: nm, sub: `Night ${n} of ${N}`, tbc });
    } else if (i.type === "car") {
      const veh = i.vehicle ? i.vehicle.replace(/\s*\(.*\)$/, "") : "";
      if (date === i.start) steps.push({ k: "car", time: cleanTime(i.pickupTime), key: i.pickupTime ? null : "23:50", title: "Pick up " + (i.company || "car"), sub: [i.pickup, veh].filter(Boolean).join(" · "), tbc, id: i.id });
      if (date === i.end) steps.push({ k: "car", time: cleanTime(i.dropoffTime), key: i.dropoffTime ? null : firstDep ? minus1(firstDep) : "23:55", title: "Return " + (i.company || "car"), sub: i.dropoff || "", tbc, id: i.id });
      if (i.start < date && date < i.end) allDay.push({ k: "car", title: [i.company, veh].filter(Boolean).join(" · "), sub: `Day ${n} of ${N + 1}`, tbc });
    }
  }
  const ents = entriesFor(p, date);
  ents.filter((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed)
    .forEach((e) => steps.push({ k: "act", time: "", key: "12:00", title: e.text, rich: true, sub: e.place && !e.text.includes(e.place) ? e.place : "" }));
  const sortKey = (s) => s.time || s.key || "12:00";
  steps.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  // travel order across time zones (see nowSteps): check-outs / car returns at the origin before a flight, check-ins / car pick-ups at the destination after it
  const byId = (id) => store.items.find((x) => x.id === id);
  steps.filter((s) => s.k === "flight" && byId(s.id)?.start === date).forEach((f) => {
    const c = codesOf(byId(f.id).route), from = c[0], to = c.at(-1);
    const it = (s) => (s.id ? byId(s.id) : null);
    const after = (s) => { const i = it(s); return i && ((s.k === "stay" && i.start === date) || (s.k === "car" && i.start === date && placeCode(i.pickup) === to)); };
    const before = (s) => { const i = it(s); return i && ((s.k === "stay" && i.end === date && i.start !== date) || (s.k === "car" && i.end === date && placeCode(i.dropoff) === from)); };
    for (const s of steps.filter(after)) { const k = steps.indexOf(s); if (k < steps.indexOf(f)) { steps.splice(k, 1); steps.splice(steps.indexOf(f) + 1, 0, s); } }
    for (const s of steps.filter(before)) { const k = steps.indexOf(s); if (k > steps.indexOf(f)) { steps.splice(k, 1); steps.splice(steps.indexOf(f), 0, s); } }
  });
  const comments = ents.filter((e) => e.kind === "comment");
  return { allDay, steps, comments, travel: steps.some((s) => s.k !== "act") };
}

// ---------------------------------------------------------------- time zones on flight days
// Clock times are local. On a day with a flight between time zones, each time gets its zone (e.g. AEST, PST) underneath.
// " PST" after a landing time when the flight arrives in another time zone
function landTz(f) {
  const c = codesOf(f.route), a = tzLabel(AIRPORT_TZ[c.at(-1)], f.end || f.start), d = tzLabel(AIRPORT_TZ[c[0]], f.start);
  return a && d && a !== d ? " " + a : "";
}
function tzLabel(tz, date) {
  if (!tz) return "";
  const at = new Date(`${date}T12:00:00Z`);
  const name = (loc) => { try { return new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((x) => x.type === "timeZoneName")?.value || ""; } catch (e) { return ""; } };
  const au = name("en-AU"); if (au && !/^(GMT|UTC)/.test(au)) return au;
  const us = name("en-US"); return us && !/^(GMT|UTC)/.test(us) ? us : (au || us).replace("GMT", "UTC");
}
// steps: in travel order; flightOf(step) -> the flight item if the step is that flight; returns a zone label per step, or null when the day has one zone
function stepZones(steps, date, flightOf) {
  const fl = steps.map(flightOf).filter((f) => f && codesOf(f.route).length);
  if (!fl.length) return null;
  const tzOf = (code) => AIRPORT_TZ[String(code || "").toUpperCase()] || "";
  let cur = fl[0].start === date ? tzOf(codesOf(fl[0].route)[0]) : tzOf(codesOf(fl[0].route).at(-1));
  const out = steps.map((st) => { const f = flightOf(st); if (!f) return cur;
    const c = codesOf(f.route);
    if (f.start === date) { const z = tzOf(c[0]); cur = tzOf(c.at(-1)) || cur; return z; }
    cur = tzOf(c.at(-1)) || cur; return cur; });
  const labels = out.map((z) => tzLabel(z, date));
  return new Set(labels.filter(Boolean)).size > 1 ? labels : null;
}
// ---------------------------------------------------------------- Now: what's next today, with directions, check-in and status links

// ---- online check-in: when it opens (per airline, in the departure airport's time zone), a link, and a calendar reminder
const checkinFor = (f) => checkinInfo(f, Date.now());
const localWhen = (d) => d.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
// Trip Setup: choose whose check-ins notify this phone (applied straight away), and send a test
function pushSetupHtml(t) {
  if (!data.pushSupported()) return `<p class="muted small">${/iPhone|iPad/.test(navigator.userAgent) ? "On iPhone, add the app to your Home Screen (Share → Add to Home Screen) and open it from there to get notifications." : "This browser can't show notifications - use the installed app or Chrome."}</p>`;
  const st = data.pushState(), on = st?.people || [], cats = st?.cats || { important: true, extras: true };
  const sw = (k, title, sub) => `<label class="pswitch"><span><b>${title}</b><small>${sub}</small></span><input type="checkbox" data-pcat="${k}" ${cats[k] !== false ? "checked" : ""} ${on.length ? "" : "disabled"}><i></i></label>`;
  return `<p class="muted small">Notifications on this phone for these travellers:</p>
    <div class="pushpeople">${(t.travellers || []).map((x) => `<label class="pp${on.includes(x.code) ? " on" : ""}" style="--pc:${pcolor(x.code)}"><input type="checkbox" data-pp="${esc(x.code)}" ${on.includes(x.code) ? "checked" : ""}>${esc(x.code)}</label>`).join("")}</div>
    ${sw("important", "Important", "Check-in opens · time to leave for the airport (live traffic) · hotel check-out · car return · passport &amp; visa problems")}
    ${sw("extras", "Extras", "New journal posts &amp; replies · itinerary changes · activities booked")}
    ${on.length ? `<button type="button" class="btn small" data-push-test><i class="ic16">${I.bell}</i>Send Test Notification</button>` : ""}`;
}
function wirePushSetup(form, t) {
  const box = form.querySelector(".pushset"); if (!box) return;
  const redraw = () => { box.innerHTML = pushSetupHtml(t); wire(); };
  const wire = () => {
    box.querySelectorAll("[data-pp]").forEach((cb) => (cb.onchange = async () => {
      const want = [...box.querySelectorAll("[data-pp]:checked")].map((x) => x.dataset.pp);
      const keep = (data.pushState()?.people || []).filter((c) => !(t.travellers || []).some((x) => x.code === c));   // travellers of other trips stay
      box.querySelectorAll("[data-pp]").forEach((x) => (x.disabled = true));
      try { const all = [...new Set([...keep, ...want])]; if (all.length) await data.enablePush(all); else await data.disablePush(); toast(want.length ? "Notifications on for " + want.map(NAME).join(", ") : "Notifications off on this phone"); }
      catch (e) { toast(e.message === "blocked" ? "Notifications are blocked for this app - allow them in your phone's settings" : e.message === "dismissed" ? "Notifications not turned on" : "Couldn't change notifications: " + (e.code || e.message)); }
      redraw();
    }));
    box.querySelectorAll("[data-pcat]").forEach((cb) => (cb.onchange = async () => {
      const cats = Object.fromEntries([...box.querySelectorAll("[data-pcat]")].map((x) => [x.dataset.pcat, x.checked]));
      try { await data.enablePush(data.pushState()?.people || [], cats); toast(`${cb.closest("label").querySelector("b").textContent} notifications ${cb.checked ? "on" : "off"}`); }
      catch (e) { toast("Couldn't change notifications: " + (e.code || e.message)); }
      redraw();
    }));
    box.querySelector("[data-push-test]")?.addEventListener("click", sendTest);
  };
  wire();
}
async function sendTest(ev) {
  const b = ev.currentTarget; b.disabled = true; toast("Sending a test notification…");
  try { await data.testPush(); toast("Sent - it should arrive in a few seconds"); } catch (e) { toast("Couldn't send: " + (e.message || e.code)); } finally { b.disabled = false; }
}
// phone notification switch for the traveller being viewed (this device)
const pushOnFor = (p) => !!data.pushState()?.people?.includes(p);
function notifyBtn() {
  return pushOnFor(ui.person) ? `<span class="ci-on" role="img" aria-label="You'll get a notification" title="You'll get a notification"><i class="ic16">${I.bell}</i></span>` : "";
}
function pushCard() {   // shown on Now only while notifications are off for this traveller
  if (pushOnFor(ui.person)) return "";
  if (!data.pushSupported()) return `<p class="muted small">${/iPhone|iPad/.test(navigator.userAgent) ? "To get check-in notifications on iPhone, add the app to your Home Screen (Share → Add to Home Screen) and open it from there." : "This browser can't show notifications - add the app to your Home Screen or use Chrome."}</p>`;
  return `<div class="pushrow"><span><i class="ic16">${I.bell}</i><b>Notifications on this phone are off</b><small>Get a notification when check-in opens for ${esc(NAME(ui.person))}'s flights</small></span>
    <span class="pushbtns"><button type="button" class="btn small primary" data-push-on>Turn On</button></span></div>`;
}
const untilWords = (d) => inWords(Math.round((d - Date.now()) / 60000));
function checkinHtml(f, compact = false) {
  const c = checkinFor(f); if (!c || c.status === "closed") return "";
  const flight = `${codesOf(f.route).join(" → ")}${f.number ? " · " + f.number : ""}`;
  const btn = `<a class="btn small primary" target="_blank" rel="noopener" href="${c.url}"><i class="ic16">${I.check}</i>Check In Online</a>`;
  const remind = notifyBtn();
  return `<div class="cin ${c.status}"><div class="cin-t"><div class="cin-h"><b>${c.status === "open" ? "Online check-in is open" : `Online check-in opens ${untilWords(c.opens)}`}</b>${c.status === "open" ? "" : remind}</div>
      ${compact ? `<small class="one">${esc(flight)}</small><small class="one">${c.status === "open" ? "until 1 h before departure" : esc(localWhen(c.opens))}</small>`
        : `<small>${c.status === "open" ? `until about 1 hour before departure` : `${esc(localWhen(c.opens))} your time · usually ${c.hours} h before departure`}</small>`}</div>
    ${c.status === "open" ? `<div class="nacts">${btn}</div>` : ""}</div>${goHtml(f)}`;
}
// "Go now": leave time worked out with live traffic (the server refreshes it through the morning of the flight)
function goHtml(f) {
  const g = f.go; if (!g || g.connection || !g.leave || g.dep !== +checkinFor(f).dep || Date.now() > g.dep) return "";
  let t = ""; try { t = new Date(g.leave).toLocaleTimeString("en-AU", { timeZone: g.tz || undefined, hour: "numeric", minute: "2-digit" }); } catch (e) { t = new Date(g.leave).toLocaleTimeString(); }
  const ago = Math.max(0, Math.round((Date.now() - g.checked) / 60000));
  return `<div class="gonow"><i class="ic16">${ICON.car}</i><span><b>Leave by ${esc(t)}</b><small>${g.mins} min drive from ${esc(g.from)} with traffic · updated ${ago < 2 ? "just now" : ago < 60 ? ago + " min ago" : Math.round(ago / 60) + " h ago"}</small></span></div>`;
}
// calendar reminders (.ics) - one per flight, an alert when check-in opens
function icsFor(flights) {
  const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc2 = (t) => String(t).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const ev = flights.map((f) => { const c = checkinFor(f); if (!c) return "";
    const conf = isEditor() ? store.priv[f.id]?.confirmation : "";
    return ["BEGIN:VEVENT", `UID:checkin-${f.id}@travel-planner`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(c.opens)}`, `DTEND:${z(new Date(+c.opens + 30 * 60e3))}`,
      `SUMMARY:${esc2(`Check in: ${f.number || ""} ${codesOf(f.route).join("-")}`.replace(/\s+/g, " ").trim())}`,
      `DESCRIPTION:${esc2(`Online check-in opens for ${[f.airline, f.number].filter(Boolean).join(" ")} ${codesOf(f.route).join(" → ")} (departs ${f.start} ${timeIn(f.dep)} local).${conf ? "\nConfirmation: " + conf : ""}\n${c.url}`)}`,
      `URL:${c.url}`, "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:PT0M", `DESCRIPTION:${esc2("Check in now: " + (f.number || "flight"))}`, "END:VALARM", "END:VEVENT"].join("\r\n"); }).filter(Boolean);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Travel Planner//Check-in//EN", "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR"].join("\r\n");
}
function downloadIcs(flights, name) {
  const blob = new Blob([icsFor(flights)], { type: "text/calendar" }), a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast("Calendar reminder downloaded - open it to add it to your calendar");
}
const upcomingFlights = (p) => itemsFor(p).filter((i) => i.type === "flight" && checkinFor(i) && checkinFor(i).status !== "closed").sort((a, b) => checkinFor(a).dep - checkinFor(b).dep);
function wireCheckins() {
  root.querySelectorAll("[data-push-on]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const cur = data.pushState()?.people || []; await data.enablePush([...new Set([...cur, ui.person])]); toast(`Notifications on - you'll be told when check-in opens for ${NAME(ui.person)}`); }
    catch (e) { b.disabled = false; toast(e.message === "blocked" ? "Notifications are blocked for this app - allow them in your phone's settings" : e.message === "dismissed" ? "Notifications not turned on" : e.message === "unsupported" ? "This browser can't show notifications" : "Couldn't turn on notifications: " + (e.code || e.message)); }
  }));
  root.querySelectorAll("[data-push-off]").forEach((b) => (b.onclick = async () => {
    const rest = (data.pushState()?.people || []).filter((x) => x !== ui.person);
    try { if (rest.length) await data.enablePush(rest); else await data.disablePush(); toast("Notifications off for " + NAME(ui.person)); } catch (e) { toast(e.message); }
  }));
  root.querySelectorAll("[data-ci-remind]").forEach((b) => (b.onclick = () => { const f = store.items.find((x) => x.id === b.dataset.ciRemind); if (f) downloadIcs([f], `Check-in ${f.number || "flight"}.ics`); }));
  root.querySelector("[data-ci-all]")?.addEventListener("click", () => downloadIcs(upcomingFlights(ui.person), `Check-in reminders ${(store.trip?.title || "trip").replace(/[^\w ]+/g, "")}.ics`));
}
const dirUrl = (q) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
const minsUntil = (date, hm) => Math.round((new Date(`${date}T${hm}:00`) - new Date()) / 60000);
const inWords = (m) => (m < 1 ? "now" : m < 60 ? `in ${m} min` : m < 24 * 60 ? `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `in ${Math.round(m / 1440)} day${Math.round(m / 1440) > 1 ? "s" : ""}`);
// Everything happening on a day for one traveller, with where to go and what you might need
function nowSteps(p, date) {
  const out = [];
  const apt = (c) => (/^[A-Z]{3}$/.test(c) ? c + " airport" : c);
  for (const i of itemsFor(p).filter((x) => x.start <= date && date <= x.end)) {
    const base = { item: i, k: i.type, tbc: i.status === "tbc" };
    if (i.type === "flight") {
      const c = codesOf(i.route), fl = [i.airline, i.number].filter(Boolean).join(" ");
      if (date === i.start) out.push({ ...base, time: cleanTime(i.dep), title: `Fly ${c[0] || ""} → ${c.at(-1) || ""}`, sub: [fl, i.arr && "lands " + i.arr + landTz(i)].filter(Boolean).join(" · "), where: apt(c[0] || ""), flight: true });
      if (date === i.end && i.end !== i.start) out.push({ ...base, time: cleanTime(i.arr), title: `Land in ${c.at(-1) || ""}`, sub: fl, where: apt(c.at(-1) || "") });
    } else if (i.type === "stay") {
      if (date === i.end) out.push({ ...base, time: cleanTime(i.checkout), key: "10:00", title: `Check out of ${i.short || i.name}`, sub: i.checkout ? `by ${cleanTime(i.checkout)}` : "", where: i.address || i.name });
      if (date === i.start) out.push({ ...base, time: cleanTime(i.checkin), key: "15:00", title: `Check in at ${i.short || i.name}`, sub: [i.checkin ? "from " + cleanTime(i.checkin) : "", areaOf(i)].filter(Boolean).join(" · "), where: i.address || i.name });
    } else if (i.type === "car") {
      if (date === i.start) out.push({ ...base, time: cleanTime(i.pickupTime), key: "09:00", title: `Pick up the ${i.company || ""} car`, sub: [i.pickup, i.vehicle && i.vehicle.replace(/\s*\(.*\)$/, "")].filter(Boolean).join(" · "), where: [i.company, apt(placeCode(i.pickup) || i.pickup || "")].filter(Boolean).join(" ") });
      if (date === i.end) out.push({ ...base, time: cleanTime(i.dropoffTime), key: "17:00", title: `Return the ${i.company || ""} car`, sub: i.dropoff || "", where: [i.company, apt(placeCode(i.dropoff) || i.dropoff || "")].filter(Boolean).join(" ") });
    }
  }
  entriesFor(p, date).filter((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed).forEach((e) =>
    out.push({ entry: e, k: "act", time: timeIn(e.text), key: "12:00", title: firstText(e.text), sub: e.place && !e.text.includes(e.place) ? e.place : "", where: e.place || "" }));
  const sk = (s) => s.time || s.key || "12:00";
  out.sort((a, b) => sk(a).localeCompare(sk(b)));
  // Clock times are local, so a flight across time zones can "land before it leaves". Keep things in travel order:
  // check-outs and returning a car at the departure airport come before the flight; check-ins and picking up a car at the arrival airport after it.
  out.filter((s) => s.flight).forEach((f) => {
    const c = codesOf(f.item.route), from = c[0], to = c.at(-1);
    const before = (s) => (s.k === "stay" && s.item.end === date && s.item.start !== date) || (s.k === "car" && s.item.end === date && placeCode(s.item.dropoff) === from);
    const after = (s) => (s.k === "stay" && s.item.start === date) || (s.k === "car" && s.item.start === date && placeCode(s.item.pickup) === to);
    for (const s of out.filter(after)) { const i = out.indexOf(s), fi = out.indexOf(f); if (i < fi) { out.splice(i, 1); out.splice(out.indexOf(f) + 1, 0, s); } }
    for (const s of out.filter(before)) { const i = out.indexOf(s), fi = out.indexOf(f); if (i > fi) { out.splice(i, 1); out.splice(out.indexOf(f), 0, s); } }
  });
  return out;
}
const tonightStay = (p, date) => itemsFor(p).find((i) => i.type === "stay" && i.start <= date && date < i.end);
function stepActions(s, date) {
  const a = [], i = s.item, pv = i ? store.priv[i.id] || {} : s.entry ? store.priv[s.entry.id] || {} : {};
  if (s.where) a.push(`<a class="btn small" target="_blank" rel="noopener" href="${dirUrl(s.where)}"><i class="ic16">${I.pin}</i>Directions</a>`);
  if (s.flight) {
    const num = String(i.number || "").split(/[/,]/)[0].replace(/\s+/g, "");
    if (num) a.push(`<a class="btn small" target="_blank" rel="noopener" href="https://www.flightaware.com/live/flight/${encodeURIComponent(num)}"><i class="ic16">${ICON.flight}</i>Flight Status</a>`);
  }
  if (isEditor() && pv.phone) a.push(`<a class="btn small" href="tel:${esc(String(pv.phone).replace(/[^\d+]/g, ""))}"><i class="ic16">${I.phone}</i>Call</a>`);
  const files = isEditor() ? store.files.filter((f) => (i && f.itemId === i.id) || (s.entry && f.entryId === s.entry.id)) : [];
  files.forEach((f) => a.push(fileLink(f)));
  return `${isEditor() && pv.confirmation ? `<div class="nconf">Confirmation <b>${esc(pv.confirmation)}</b></div>` : ""}${a.length ? `<div class="nacts">${a.join("")}</div>` : ""}`;
}
function renderNow() {
  const p = ui.person, t = store.trip, today = iso(new Date()), hm = nowHM();
  const phase = today < t.start ? "before" : today > t.end ? "after" : "during";
  const date = phase === "before" ? t.start : today, day = dayDiff(t.start, date) + 1, N = dayDiff(t.start, t.end) + 1;
  const steps = phase === "after" ? [] : nowSteps(p, date);
  const sk = (s) => s.time || s.key || "12:00";
  // done: its time is more than 30 min ago - or, with no time, something after it is already done
  const doneSet = new Set(); if (phase === "during") { let later = false; for (let k = steps.length - 1; k >= 0; k--) { const s = steps[k];
    if (s.time ? minsUntil(date, s.time) < -30 : later) { doneSet.add(s); later = true; } } }
  const done = (s) => doneSet.has(s);
  let next = steps.find((s) => !done(s)), nextDate = date;
  const tomorrow = addDays(date, 1), tmSteps = phase === "after" || tomorrow > t.end ? [] : nowSteps(p, tomorrow);
  if (!next && tmSteps.length) { next = tmSteps[0]; nextDate = tomorrow; }
  const stay = phase === "after" ? null : tonightStay(p, date);
  const w = withText(p, date);
  const zf = (st) => (st.flight || (st.k === "flight" && st.item) ? st.item : null);
  const zToday = stepZones(steps, date, zf), zTom = stepZones(tmSteps, tomorrow, zf);
  const zoneOf = (s, d) => { const list = d === date ? steps : tmSteps, z = d === date ? zToday : zTom, k = list.indexOf(s); return z && k >= 0 && s.time ? z[k] : ""; };
  const line = (s, d) => `<li class="nstep k-${s.k}${done(s) && d === date ? " done" : ""}${s === next ? " is-next" : ""}"><span class="ntime">${esc(s.time || "")}${zoneOf(s, d) ? `<small class="tz">${esc(zoneOf(s, d))}</small>` : ""}</span><span class="nic">${ICON[KIND[s.k] || s.k] || ""}</span><span class="nt"><b>${esc(s.title)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</span></li>`;
  const countdown = next ? (next.time ? inWords(minsUntil(nextDate, next.time)) : nextDate === today ? "today" : nextDate === tomorrow ? "tomorrow" : inWords(dayDiff(today, nextDate) * 1440)) : "";
  const stats = phase !== "after" ? {} : { places: new Set(itemsFor(p).filter((i) => i.type === "stay" && i.status !== "tbc").map((i) => areaOf(i) || i.short || i.name)).size, flights: itemsFor(p).filter((i) => i.type === "flight").length };
  const status = phase === "before" ? `Trip starts ${inWords(dayDiff(today, t.start) * 1440)} · ${fmtDate(t.start)}` : phase === "after" ? `Trip finished ${fmtDate(t.end)}` : `Day ${day} of ${N}${stay ? " · " + (areaOf(stay) || stay.short || stay.name) : ""}`;
  root.innerHTML = `${header({ views: true })}
  <div class="now">${isEditor() && !offOn(ui.tripId) && phase !== "after" && dayDiff(today, store.trip.start) <= 21 && store.files.length ? `<button class="offhint" data-act="offline"><i>${I.download || I.archive}</i><span><b>Save the trip documents on this phone</b><small>Boarding passes, tickets and vouchers that open with no signal</small></span></button>` : ""}${phase === "before" ? outsideBlock(p, "before") : ""}
    <p class="nstatus">${esc(status)}${w ? ` · ${withPills(p, date)}` : ""}</p>
    ${phase === "before" ? readyHtml() : ""}
    ${phase === "after" ? `<section class="ncard home"><h3>Welcome Home</h3><p class="muted">${N} days${stats.places ? ` · ${stats.places} places` : ""}${stats.flights ? ` · ${stats.flights} flights` : ""}</p>
        <button type="button" class="reelcta" data-act="reel"><i>${SV('<path d="M8 5v14l11-7z"/>')}</i><span><b>Watch the Trip Reel</b><small>Your journal photos, day by day, with music</small></span></button>
        <div class="wrap-list"><button type="button" class="mrow" data-act="album"><span class="grow">Make the Photo Album</span><small>A Word file ready to print</small><i class="mgo">›</i></button>
          <button type="button" class="mrow" data-act="recap"><span class="grow">See the Trip Recap</span><small>Where the nights went</small><i class="mgo">›</i></button>
          ${isEditor() ? `<button type="button" class="mrow" data-tabgo="budget"><span class="grow">Settle Up &amp; Budget</span><small>Who owes what</small><i class="mgo">›</i></button>
          <button type="button" class="mrow" data-act="archive"><span class="grow">Archive the Documents</span><small>One zip with everything</small><i class="mgo">›</i></button>` : ""}</div></section>`
    : next ? `<section class="ncard next k-${next.k}${next.tbc ? " tbc" : ""}">
        <div class="nhead"><span class="nlabel">${phase === "before" ? "First up" : "Next up"}${nextDate !== today && phase !== "before" ? " · tomorrow" : ""}</span><span class="ncount">${esc(countdown)}</span></div>
        <div class="nmain"><span class="nbig">${ICON[KIND[next.k] || next.k] || ""}</span><div><div class="ntitle">${esc(next.title)}</div>
          <div class="nsub">${[next.time && `${phase === "before" ? fmtDate(nextDate) + " · " : ""}${next.time}${zoneOf(next, nextDate) ? " " + zoneOf(next, nextDate) : ""}`, next.sub].filter(Boolean).map(esc).join(" · ")}</div></div></div>
        ${next.flight ? checkinHtml(next.item) : ""}
        ${stepActions(next, nextDate)}</section>`
    : `<section class="ncard"><h3>Nothing else planned today</h3><p class="muted">Free time! Check the Recommended places on the day screen.</p></section>`}
    ${steps.length > 1 || (steps.length && next && nextDate !== date) ? `<section class="ncard"><h3>${phase === "before" ? "Day 1 · " + fmtDate(date) : "Today"}</h3><ul class="nlist">${steps.map((s) => line(s, date)).join("")}</ul></section>` : ""}
    ${stay ? `<section class="ncard k-stay tonight"><h3>Tonight</h3><div class="nmain"><span class="nbig">${ICON.stay}</span><div><div class="ntitle">${esc(stay.name || stay.short)}</div>
        <div class="nsub">${esc(stay.address || areaOf(stay) || "")}</div></div></div>${stepActions({ item: stay, k: "stay", where: stay.address || stay.name }, date)}${isEditor() ? `<button class="arrbtn${store.priv[stay.id]?.arrival ? " has" : ""}" data-arrival="${stay.id}"><i class="ic16">${I.house}</i>Arrival${store.priv[stay.id]?.arrival ? " · Wi-Fi, door code, host" : " +"}</button>` : stay.wifi ? `<button class="arrbtn has" data-wifi="${stay.id}"><i class="ic16">${I.wifi}</i>Wi-Fi</button>` : ""}</section>` : ""}
    ${tmSteps.length ? `<section class="ncard"><h3>Tomorrow · ${esc(WD[D(tomorrow).getDay()])} ${fmtDate(tomorrow)}</h3><ul class="nlist">${tmSteps.map((s) => line(s, tomorrow)).join("")}</ul></section>` : ""}
    ${(() => { const fl = upcomingFlights(p).filter((f) => f !== next?.item).slice(0, 6); return fl.length ? `<section class="ncard"><h3>Upcoming Check-ins</h3>${pushCard()}
        ${fl.map((f) => checkinHtml(f, true)).join("")}</section>` : ""; })()}
    ${phase !== "after" ? `<button class="btn small nday" data-day="${date}">Open ${date === today ? "Today's" : "Day 1"} Full Day →</button>` : ""}
    ${phase === "during" ? `<div class="nquick"><button type="button" data-tabgo="journal"><i>${I.camera}</i>Add Photo</button>${isEditor() ? `<button type="button" data-qexp><i>${ICON.wallet}</i>Add Expense</button>` : ""}<button type="button" data-act="ask"><i>${I.chat}</i>Ask the Trip</button></div>` : ""}
    ${phase !== "before" ? outsideBlock(p, "before") : ""}${outsideBlock(p, "after")}
  </div>`;
  wireHeader(); wireDays(); wireCheckins();
  root.querySelectorAll("[data-arrival]").forEach((b) => (b.onclick = () => arrivalSheet(b.dataset.arrival)));
  root.querySelectorAll("[data-wifi]").forEach((b) => (b.onclick = () => wifiSheet(b.dataset.wifi)));
  root.querySelectorAll(".now [data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.()));
  root.querySelectorAll(".now [data-tabgo]").forEach((b) => (b.onclick = () => { if (b.dataset.tabgo === "journal") ui.jdate = today; goTab(b.dataset.tabgo); }));
  root.querySelectorAll(".now [data-qexp]").forEach((b) => (b.onclick = () => expenseForm({ date: defaultExpenseDate() })));
  root.querySelectorAll(".now [data-rtick]").forEach((b) => (b.onclick = async () => { const x = (store.todos || []).find((y) => y.id === b.dataset.rtick); if (!x) return;
    b.classList.add("on"); try { await data.saveTodo({ ...x, done: true }); toast("Done: " + x.text); } catch (e) { toast(e.message); } }));
  root.querySelectorAll(".now [data-file]").forEach((b) => (b.onclick = () => openFile(store.files.find((x) => x.id === b.dataset.file))));
}
// keep the countdown fresh while the Now screen is open
setInterval(() => { if (ui.view === "now" && !ui.day && store.trip && !document.querySelector(".modal") && document.visibilityState === "visible" && !document.activeElement?.matches?.("input,textarea,select")) { const y = scrollY; render(); scrollTo(0, y); } }, 60000);

// ---------------------------------------------------------------- Before Trip / After Trip (bookings outside the trip dates)
// Shown as grey, information-only blocks at the top and bottom of every view, and as their own screen - only to the people on them.
function outside(p, side) {
  const t = store.trip; if (!t?.start) return { items: [], ents: [] };
  const out = side === "before" ? (a, b) => b < t.start : (a) => a > t.end;
  const items = itemsFor(p).filter((i) => out(i.start, i.end || i.start)).sort((a, b) => a.start.localeCompare(b.start) || (a.dep || "").localeCompare(b.dep || ""));
  const ents = store.entries.filter((e) => (e.who || []).includes(p) && e.kind === "activity" && e.status !== "recommended" && e.date && out(e.date, e.endDate || e.date)).sort((a, b) => a.date.localeCompare(b.date));
  return { items, ents };
}
const outTitle = (i) => i.type === "flight" ? `${codesOf(i.route).join(" → ")}${i.number ? " · " + i.number : ""}` : i.type === "stay" ? (i.name || i.short || "Stay") : `${i.company || "Car"}${i.pickup ? " · " + i.pickup : ""}`;
function packBtn() {
  const pk = (store.packing || []), done = pk.filter((x) => x.done).length;
  return `<button type="button" class="obpack" data-pack aria-label="Packing lists: ${done} of ${pk.length} packed">${I.bag}<span>Packing</span>${pk.length ? `<b>${done}/${pk.length}</b>` : ""}</button>`;
}
function outsideBlock(p, side) {
  const { items, ents } = outside(p, side), live = store.trip && store.trip.end >= iso(new Date());
  if (!items.length && !ents.length) return side === "before" && live && splitOn() ? `<div class="oblock before slim"><span class="ob-head"><b>Before Trip</b><span class="muted small">Get ready</span>${todoBtn()}${packBtn()}</span></div>` : "";
  const rows = items.map((i) => ({ d: i.start, k: KIND[i.type], t: outTitle(i) })).concat(ents.map((e) => ({ d: e.date, k: "act", t: firstText(e.text) })))
    .sort((a, b) => a.d.localeCompare(b.d));
  const span = rows[0].d === rows.at(-1).d ? fmtDate(rows[0].d) : `${fmtDate(rows[0].d)} – ${fmtDate(rows.at(-1).d)}`;
  return `<div class="oblock ${side}" role="button" tabindex="0" data-day="${side}" aria-label="${side === "before" ? "Before" : "After"} Trip: ${rows.length} booking${rows.length > 1 ? "s" : ""}">
    <span class="ob-head"><b>${side === "before" ? "Before Trip" : "After Trip"}</b><span class="muted small">${span} · not part of this trip's days</span>${side === "before" && live ? todoBtn() + packBtn() : ""}<span class="ob-go">›</span></span>
    <span class="ob-list">${rows.slice(0, 4).map((r) => `<span class="ob-row"><span class="ob-d">${esc(WD[D(r.d).getDay()].slice(0, 3))} ${esc(fmtDate(r.d))}</span><span class="ob-ic">${ICON[r.k] || ""}</span><span class="ob-t">${esc(r.t)}</span></span>`).join("")}
    ${rows.length > 4 ? `<span class="ob-more muted small">+ ${rows.length - 4} more</span>` : ""}</span></div>`;
}
function renderOutside(side) {
  const p = ui.person, t = store.trip, { items, ents } = outside(p, side), pane = ui.pane;
  const dates = [...new Set(items.map((i) => i.start).concat(ents.map((e) => e.date)))].sort();
  root.innerHTML = `${header()}
  <div class="dayview outside">
    <div class="dayhead out">
      <button class="nav" data-ogo="before" ${side === "before" ? "disabled" : ""} aria-label="Last day of the trip">‹</button>
      <div><div class="wd">${esc(NAME(p))}</div><div class="dt">${side === "before" ? "Before Trip" : "After Trip"}</div>
        <div class="muted small">${side === "before" ? "Before the trip starts on " + fmtDate(t.start) : "After the trip ends on " + fmtDate(t.end)}</div></div>
      <button class="nav" data-ogo="after" ${side === "after" ? "disabled" : ""} aria-label="First day of the trip">›</button>
    </div>
    ${dates.length ? dates.map((d) => { const its = items.filter((i) => i.start === d), es = ents.filter((e) => e.date === d);
      return `<section><h3>${esc(WD[D(d).getDay()])} ${esc(fmtDate(d))}</h3>${its.map((i) => itemCard(i, d)).join("")}
        ${es.length ? `<ul class="entries">${es.map(entryLi).join("")}</ul>` : ""}</section>`; }).join("")
      : `<section><p class="muted">Nothing ${side === "before" ? "before" : "after"} the trip for ${esc(NAME(p))}.</p></section>`}
    <p class="muted small">These bookings are outside the trip dates, so they aren't in the day-by-day plan. To make them part of it, change the trip's dates in Trip Setup.</p>
  </div>`;
  wireHeader(); wireCards(); wireCheckins();
  root.querySelector("[data-back]").onclick = () => (pane !== null && pane !== undefined ? (ui.splitDay[pane] = null, render()) : routeTo(ui.tripId, null));
  root.querySelectorAll("[data-ogo]").forEach((b) => (b.onclick = () => { const d2 = side === "before" ? t.start : t.end;
    if (pane !== null && pane !== undefined) { ui.splitDay[pane] = d2; return render(); }
    ui.slide = side === "before" ? "from-right" : "from-left"; routeTo(ui.tripId, d2, true); }));
}

// ---------------------------------------------------------------- stay arrival card: Wi-Fi, door code, parking, check-in, rules, host (private, offline)
const ARR_FIELDS = [["wifiName", "Wi-Fi network"], ["wifiPass", "Wi-Fi password", 1], ["doorCode", "Door / lockbox code", 1], ["checkin", "Check-in"], ["checkout", "Check-out"],
  ["parking", "Parking"], ["houseRules", "House rules"], ["hostName", "Host"], ["hostPhone", "Host phone"], ["hostEmail", "Host email"], ["notes", "Good to know"]];
function arrivalSheet(id) {
  const it = store.items.find((x) => x.id === id); if (!it) return;
  const a = store.priv[id]?.arrival;
  if (!a) return arrivalForm(id);
  const digits = (p) => String(p || "").replace(/[^\d+]/g, "");
  const val = (k, v) => k === "hostPhone" ? `<a href="tel:${esc(digits(v))}">${esc(v)}</a> · <a href="https://wa.me/${esc(digits(v).replace("+", ""))}" target="_blank" rel="noopener">WhatsApp</a>`
    : k === "hostEmail" ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v).replace(/ · /g, "<br>");
  infoBox(`<div class="arrival"><h2>${I.house}${esc(it.short || it.name || "Stay")}</h2><p class="muted small">${fmtDate(it.start)} – ${fmtDate(it.end)}${it.checkin ? ` · check-in ${esc(it.checkin)}` : ""}</p>
    <dl>${ARR_FIELDS.filter(([k]) => a[k]).map(([k, l, copy]) => `<dt>${l}</dt><dd><span class="${copy ? "acode" : ""}">${val(k, a[k])}</span>${copy ? `<button type="button" class="lb-copy" data-acopy="${esc(a[k])}" aria-label="Copy ${l}">${I.copy}</button>` : ""}</dd>`).join("")}</dl>
    <p class="muted small">Private - only Cesar and Debora see this${it.wifi ? " (the Wi-Fi is shared with the family)" : ""}. Kept on the phone, so it opens offline once the app has loaded the trip.</p>
    <button type="button" class="btn small" data-aedit>Edit</button></div>`);
  const m = [...document.querySelectorAll(".modal")].pop();
  m.querySelectorAll("[data-acopy]").forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.acopy); toast("Copied"); } catch (e) { toast("Couldn't copy"); } }));
  m.querySelector("[data-aedit]").onclick = () => { m.remove(); arrivalForm(id); };
}
function wifiSheet(id) {
  const it = store.items.find((x) => x.id === id), w = it?.wifi; if (!w) return;
  infoBox(`<div class="arrival"><h2>${I.wifi}Wi-Fi · ${esc(it.short || it.name || "Stay")}</h2>
    <dl>${w.name ? `<dt>Network</dt><dd><span class="acode">${esc(w.name)}</span><button type="button" class="lb-copy" data-acopy="${esc(w.name)}" aria-label="Copy network">${I.copy}</button></dd>` : ""}
      ${w.pass ? `<dt>Password</dt><dd><span class="acode">${esc(w.pass)}</span><button type="button" class="lb-copy" data-acopy="${esc(w.pass)}" aria-label="Copy password">${I.copy}</button></dd>` : ""}</dl></div>`);
  [...document.querySelectorAll(".modal")].pop().querySelectorAll("[data-acopy]").forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.acopy); toast("Copied"); } catch (e) { toast("Couldn't copy"); } }));
}
function arrivalForm(id) {
  const it = store.items.find((x) => x.id === id), had = store.priv[id] || {}, a = { ...(had.arrival || {}) };
  const files = store.files.filter((f) => f.itemId === id);
  const long = ["checkin", "checkout", "houseRules", "notes"];
  modal(`<h3>${I.house}Arrival · ${esc(it.short || it.name || "Stay")}</h3>
    <p class="muted small">Everything you need on arrival in one place. Let the AI read the confirmation or the host's message, then check it.</p>
    <div class="afill">${files.map((f) => `<button type="button" class="btn tiny" data-aread="${esc(f.id)}">✨ Read ${esc(f.name.length > 28 ? f.name.slice(0, 26) + "…" : f.name)}</button>`).join("")}
      <label class="btn tiny">✨ Read a file or screenshot…<input type="file" hidden accept="application/pdf,image/*" data-afile></label></div>
    ${ARR_FIELDS.map(([k, l]) => long.includes(k) ? `<label>${l}<textarea name="${k}" rows="2">${esc(a[k] || "")}</textarea></label>` : `<label>${l}<input name="${k}" value="${esc(a[k] || "")}" ${k === "hostPhone" ? 'inputmode="tel"' : ""}></label>`).join("")}
    <label class="pswitch"><input type="checkbox" name="shareWifi" ${it.wifi ? "checked" : ""}><span>Share the Wi-Fi with the family (only the network and password - codes and host details stay private)</span></label>`,
    async (fd) => {
      const out = {}; ARR_FIELDS.forEach(([k]) => { const v = String(fd.get(k) || "").trim(); if (v) out[k] = v; });
      await data.savePrivate(id, { ...had, arrival: Object.keys(out).length ? out : null });
      const cur = store.items.find((x) => x.id === id) || it, { wifi, ...rest } = cur;
      if (fd.get("shareWifi") && (out.wifiName || out.wifiPass)) { const w = { name: out.wifiName || "", pass: out.wifiPass || "" };
        if (JSON.stringify(w) !== JSON.stringify(wifi || {})) await data.saveItem({ ...rest, wifi: w }); }
      else if (wifi) await data.saveItem(rest);
    }, had.arrival ? () => data.savePrivate(id, { ...had, arrival: null }) : null);
  const form = [...document.querySelectorAll(".sheet")].pop();
  const fill = async (blob, name) => {
    toast(`Reading ${name}…`);
    try { const x = await data.arrivalFromFile(blob); let n = 0;
      ARR_FIELDS.forEach(([k]) => { const el = form.querySelector(`[name="${k}"]`); if (x[k] && el && !el.value.trim()) { el.value = x[k]; el.classList.add("filled"); n++; } });
      toast(n ? `Filled ${n} field${n > 1 ? "s" : ""} - check them` : "Nothing new found in that file"); }
    catch (e) { toast("Couldn't read it: " + (e.message || e)); }
  };
  form.querySelectorAll("[data-aread]").forEach((b) => (b.onclick = async () => { const f = store.files.find((x) => x.id === b.dataset.aread);
    try { const blob = (await data.offlineBlob(f.id)) || (await data.fileBlob(f)); await fill(new File([blob], f.name, { type: f.contentType || blob.type }), f.name); } catch (e) { toast("Couldn't open the file"); } }));
  form.querySelector("[data-afile]").onchange = (e) => { const f = e.target.files[0]; if (f) fill(f, f.name); };
}

// ---------------------------------------------------------------- pre-trip to-dos: due dates, who, reminders at 9 am on the due date
const todoUI = { hide: true };
function todoBtn() {
  const td = store.todos || [], open = td.filter((x) => !x.done), today = iso(new Date()), late = open.filter((x) => x.due && x.due < today).length;
  return `<button type="button" class="obpack${late ? " late" : ""}" data-todo aria-label="To-dos: ${open.length} left">${I.check}<span>To-dos</span>${td.length ? `<b>${td.length - open.length}/${td.length}</b>` : ""}</button>`;
}
function todoContext() {
  const t = store.trip, lines = [packContext()];
  const pp = tripPassports(); lines.push("Passports: " + (pp.map((p) => `${p.nationality} (${p.who.join(", ")})`).join("; ") || "Australian (assumed)"));
  const issues = tripDocIssues(t); if (issues.length) lines.push("Document problems: " + issues.map((x) => `${x.per.name || x.per.code}: ${x.st.text}`).join("; "));
  const ci = t.countryInfo; if (ci?.codes?.length) lines.push("Entry rules: " + ci.codes.map((c) => `${ci.data[c]?.country || c}: ${(ci.data[c]?.entry || []).map((e) => e.passport + " - " + e.summary).join(" / ")}`).join(" | "));
  const tbc = store.items.filter((i) => i.status === "tbc"); if (tbc.length) lines.push("Not booked yet: " + tbc.map((i) => `${i.type} ${i.start} ${i.name || i.route || ""}`).join("; "));
  const planned = store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && !e.confirmed); if (planned.length) lines.push("Activities planned but not booked: " + planned.map((e) => `${e.date} ${firstText(e.text)}`).join("; "));
  const cars = store.items.filter((i) => i.type === "car"); if (cars.length) lines.push("Hire cars in: " + [...new Set(cars.map((c) => c.pickup || c.company))].join(", "));
  lines.push(`Today is ${iso(new Date())}; the trip starts ${t.start}.`);
  return lines.join("\n");
}
function todoSheet() {
  if (!store.trip) return;
  document.querySelector(".todosheet")?.remove();
  const box = document.createElement("div"); box.className = "modal todosheet"; document.body.appendChild(box);
  const close = () => { box.remove(); clearInterval(iv); const y = scrollY; render(); scrollTo(0, y); };
  const fail = (e) => toast(e.code === "permission-denied" ? "To-dos need the new Firestore rules (todos section)" : "Couldn't save: " + (e.code || e.message));
  const draw = () => {
    const td = store.todos || [], today = iso(new Date()), soon = addDays(today, 7);
    const list = td.filter((x) => !(todoUI.hide && x.done)).sort((a, b) => a.done - b.done || (a.due || "9999").localeCompare(b.due || "9999") || (a.order || 0) - (b.order || 0));
    const left = td.filter((x) => !x.done).length;
    box.innerHTML = `<div class="sheet packbox">
      <div class="ask-head"><h3>${I.check}To-dos</h3><span class="muted small">${left} left · trip in ${Math.max(0, dayDiff(today, store.trip.start))} days</span><button type="button" class="btn tiny" data-tx aria-label="Close">✕</button></div>
      ${td.length ? `<div class="pbar"><i style="width:${Math.round((td.length - left) / td.length * 100)}%"></i></div>` : ""}
      ${store.todosError ? `<p class="jwarn small">${esc(store.todosError)}</p>` : ""}
      <div class="plist">${list.map((x) => { const st = x.done ? "" : x.due && x.due < today ? "late" : x.due && x.due <= soon ? "soon" : "";
        return `<div class="pitem tdo ${x.done ? "done" : ""} ${st}">
          <label><input type="checkbox" data-tdone="${esc(x.id)}" ${x.done ? "checked" : ""}><span>${esc(x.text)}${x.why ? `<small class="muted">${esc(x.why)}</small>` : ""}</span></label>
          <input type="date" class="tdue" data-tdue="${esc(x.id)}" value="${esc(x.due || "")}" aria-label="Due date">
          <button type="button" class="dd${x.who ? " on" : ""}" data-twho="${esc(x.id)}" style="--pc:${x.who ? pcolor(x.who) : "var(--line2)"}" title="Who does it">${x.who ? ddIn(x.who) : "?"}</button>
          <button type="button" class="pdel" data-tdel="${esc(x.id)}" aria-label="Remove">✕</button></div>`; }).join("")
        || `<p class="muted">${td.length ? "All done!" : "Nothing yet. Add things to do before you go, or let the app suggest them from your documents, Country Info and bookings."}</p>`}</div>
      <form class="padd"><input name="t" placeholder="Add a to-do…" autocomplete="off" aria-label="New to-do"><input type="date" name="d" value="${esc(addDays(store.trip.start, -7) > today ? addDays(store.trip.start, -7) : today)}" aria-label="Due date"><button class="btn small primary">Add</button></form>
      <div class="ptools"><button type="button" class="btn small" data-tai>✨ Suggest</button>
        <label class="pswitch small"><input type="checkbox" data-thide ${todoUI.hide ? "checked" : ""}><span>Hide done</span></label></div>
      <p class="muted small">Reminder at 9 am on the due date, to the phones of the person it's for (or everyone's, if no one is chosen), with Important notifications on.</p></div>`;
    box.querySelector("[data-tx]").onclick = close;
    box.querySelectorAll("[data-tdone]").forEach((c) => (c.onchange = () => { const x = td.find((y) => y.id === c.dataset.tdone); data.saveTodo({ ...x, done: c.checked }).catch(fail); }));
    box.querySelectorAll("[data-tdue]").forEach((c) => (c.onchange = () => { const x = td.find((y) => y.id === c.dataset.tdue); data.saveTodo({ ...x, due: c.value }).catch(fail); }));
    box.querySelectorAll("[data-tdel]").forEach((b) => (b.onclick = () => data.deleteTodo(b.dataset.tdel).catch(fail)));
    box.querySelectorAll("[data-twho]").forEach((b) => (b.onclick = () => { const x = td.find((y) => y.id === b.dataset.twho), o = ["", ...ALL_CODES()], k = o.indexOf(x.who || "");
      data.saveTodo({ ...x, who: o[(k + 1) % o.length] }).catch(fail); }));
    box.querySelector("[data-thide]").onchange = (e) => { todoUI.hide = e.target.checked; draw(); };
    box.querySelector(".padd").onsubmit = (e) => { e.preventDefault(); const f = e.target, t = f.t.value.trim(); if (!t) return;
      data.saveTodo({ text: t, due: f.d.value, who: "", done: false, order: Date.now() }).catch(fail); f.t.value = ""; };
    box.querySelector("[data-tai]").onclick = () => todoSuggest();
  };
  let last = ""; const tick = () => { if (!box.isConnected) return; const sig = JSON.stringify(store.todos || []) + store.todosError;
    if (sig !== last) { last = sig; const typed = box.querySelector(".padd input")?.value || "", focused = document.activeElement?.name === "t"; draw();
      const inp = box.querySelector(".padd input"); if (inp) { inp.value = typed; if (focused) inp.focus(); } } };
  const iv = setInterval(tick, 400);
  box.onclick = (e) => { if (e.target === box) close(); };
  tick();
}
async function todoSuggest() {
  const t = store.trip, today = iso(new Date()), have = (store.todos || []).map((x) => x.text);
  const dueFor = (n) => { const d = addDays(t.start, -Math.max(0, n || 0)); return d < today ? today : d; };
  // straight from the travel-document warnings
  const local = tripDocIssues(t).map((x) => ({ text: `${x.st.level === "bad" ? "Renew" : "Check"} ${x.per.name || x.per.code}'s ${docName(x.d.type)}`, due: dueFor(42), who: x.per.code || "", why: x.st.text }))
    .filter((x) => !have.some((h) => h.toLowerCase() === x.text.toLowerCase()));
  toast("Looking at your documents, bookings and Country Info…");
  let ai = []; try { ai = ((await data.todoAI({ text: todoContext(), have: have.concat(local.map((x) => x.text)) })).items || []).filter((x) => x.text); }
  catch (e) { toast("The AI couldn't suggest more: " + (e.message || e)); }
  const all = local.concat(ai.map((x) => ({ text: x.text, due: dueFor(x.daysBefore), who: ALL_CODES().includes(x.who) ? x.who : "", why: x.why || "" })));
  if (!all.length) return toast("Nothing new to suggest");
  modal(`<h3>Suggested To-dos</h3><p class="muted small">Untick anything you don't need. You can change dates and who later.</p>
    <div class="psugg">${all.map((x, k) => `<label class="pcand"><input type="checkbox" name="i" value="${k}" checked><span><b>${esc(x.text)}</b><small class="muted">by ${fmtDate(x.due)}${x.who ? " · " + esc(NAME(x.who) || x.who) : ""}${x.why ? " · " + esc(x.why) : ""}</small></span></label>`).join("")}</div>`,
    async (fd) => { let o = Date.now(); const pick = fd.getAll("i").map((k) => ({ ...all[+k], done: false, order: o++ })); await data.saveTodo(pick); toast(`${pick.length} to-dos added`); });
  [...document.querySelectorAll(".modal")].pop().querySelector("button.primary").textContent = "Add to the List";
}

// ---------------------------------------------------------------- packing lists: one shared family list + one per traveller
const PACK_CATS = ["Documents", "Clothes", "Toiletries", "Health", "Electronics", "Beach & Swim", "Theme Parks", "Travel Day", "Money", "Other"];
const packUI = { tab: "shared", hide: false };
function packContext() {
  const t = store.trip, ppl = PEOPLE(), lines = [];
  lines.push(`${t.title}: ${t.start} to ${t.end} (${days().length} days). Travellers: ${ppl.map((c) => `${c} (${NAME(c)})`).join(", ")}${(t.extended || []).length ? "; others joining at times: " + t.extended.map((x) => x.name).join(", ") : ""}.`);
  const stays = store.items.filter((i) => i.type === "stay" && !(i.end < t.start || i.start > t.end)).sort((a, b) => a.start.localeCompare(b.start));
  lines.push("Places: " + stays.map((s) => `${stayArea(s) || s.name} ${s.start}→${s.end}${/house|villa|airbnb|vrbo/i.test(s.name || "") ? " (house)" : ""}`).join("; "));
  const fl = store.items.filter((i) => i.type === "flight" && !(i.end < t.start || i.start > t.end));
  lines.push("Flights: " + fl.map((f) => `${codesOf(f.route).join("-")} ${f.start}${isInternational(f) ? " international" : ""}`).join("; "));
  if (store.items.some((i) => i.type === "car")) lines.push("Hire cars: yes (driving).");
  const acts = store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && e.date >= t.start && e.date <= t.end).map((e) => firstText(e.text));
  if (acts.length) lines.push("Activities: " + [...new Set(acts)].slice(0, 40).join("; "));
  const ci = t.countryInfo; if (ci?.codes?.length) lines.push("Countries: " + ci.codes.map((c) => `${ci.data[c]?.country || c} (plugs ${ci.data[c]?.plugs?.types || "?"}, ${ci.data[c]?.plugs?.voltage || ""}; currency ${ci.data[c]?.currency?.code || ""})`).join("; "));
  else lines.push("Countries: " + tripCountries().map(countryName).join(", "));
  const wxl = []; for (const [k, f] of Object.entries(wx.fc || {})) { const ds = Object.entries(f.days || {}).filter(([d]) => d >= t.start && d <= t.end); if (ds.length) wxl.push(`${k}: ` + ds.slice(0, 6).map(([d, v]) => `${d} ${Math.round(v[2])}-${Math.round(v[1])}°C${v[3] != null ? " rain " + v[3] + "%" : ""}`).join(", ")); }
  lines.push(wxl.length ? "Forecast: " + wxl.join(" | ") : "No forecast yet - use the typical weather for these places and dates.");
  lines.push("Travelling from: Australia (Brisbane).");
  return lines.join("\n");
}
function packingSheet() {
  if (!store.trip) return;
  document.querySelector(".packsheet")?.remove();
  const box = document.createElement("div"); box.className = "modal packsheet"; document.body.appendChild(box);
  const close = () => { box.remove(); unsub(); const y = scrollY; render(); scrollTo(0, y); };
  const tabs = () => ["shared", ...PEOPLE()];
  const draw = () => {
    const pk = store.packing || [], tab = tabs().includes(packUI.tab) ? packUI.tab : "shared", mine = pk.filter((x) => x.list === tab);
    const cnt = (l) => { const a = pk.filter((x) => x.list === l); return `${a.filter((x) => x.done).length}/${a.length}`; };
    const shown = packUI.hide ? mine.filter((x) => !x.done) : mine;
    const groups = PACK_CATS.concat([...new Set(shown.map((x) => x.cat))].filter((c) => !PACK_CATS.includes(c))).map((c) => [c, shown.filter((x) => (x.cat || "Other") === c).sort((a, b) => a.done - b.done || (a.order || 0) - (b.order || 0))]).filter(([, a]) => a.length);
    const all = pk.length, done = pk.filter((x) => x.done).length;
    box.innerHTML = `<div class="sheet packbox">
      <div class="ask-head"><h3>${I.bag}Packing</h3><span class="muted small">${done} of ${all} packed</span><button type="button" class="btn tiny" data-px aria-label="Close">✕</button></div>
      ${all ? `<div class="pbar"><i style="width:${Math.round(done / all * 100)}%"></i></div>` : ""}
      ${store.packingError ? `<p class="jwarn small">${esc(store.packingError)}</p>` : ""}
      <div class="ptabs" role="tablist">${tabs().map((l) => `<button type="button" role="tab" class="ptab${l === tab ? " on" : ""}" data-ptab="${esc(l)}" ${l !== "shared" ? `style="--pc:${pcolor(l)}"` : ""}>${l === "shared" ? "Shared" : avHtml(l) + esc(NAME(l))} <small>${cnt(l)}</small></button>`).join("")}</div>
      <p class="muted small">${tab === "shared" ? "Family items - one person packs each (tap the circle to choose who)." : `${esc(NAME(tab))}'s own things.`}</p>
      <div class="plist">${groups.map(([c, a]) => `<div class="pgroup"><h4>${esc(c)}</h4>${a.map((x) => `<div class="pitem${x.done ? " done" : ""}">
          <label><input type="checkbox" data-pdone="${esc(x.id)}" ${x.done ? "checked" : ""}><span>${esc(x.text)}${x.why ? `<small class="muted">${esc(x.why)}</small>` : ""}</span></label>
          ${tab === "shared" ? `<button type="button" class="dd${x.packer ? " on" : ""}" data-ppacker="${esc(x.id)}" style="--pc:${x.packer ? pcolor(x.packer) : "var(--line2)"}" title="Who packs it">${x.packer ? ddIn(x.packer) : "?"}</button>` : ""}
          <button type="button" class="pdel" data-pdel="${esc(x.id)}" aria-label="Remove">✕</button></div>`).join("")}</div>`).join("")
        || `<p class="muted">Nothing on this list yet. Add items below, let the AI suggest a list for this trip, or copy one from another trip.</p>`}</div>
      <form class="padd"><input name="t" placeholder="Add an item…" autocomplete="off" aria-label="New item"><select name="c" aria-label="Category">${PACK_CATS.map((c) => `<option>${c}</option>`).join("")}</select><button class="btn small primary">Add</button></form>
      <div class="ptools"><button type="button" class="btn small" data-pai>✨ Suggest with AI</button><button type="button" class="btn small" data-pcopy>Copy from a trip…</button>
        <label class="pswitch small"><input type="checkbox" data-phide ${packUI.hide ? "checked" : ""}><span>Hide packed</span></label>
        ${mine.some((x) => x.done) ? `<button type="button" class="lnk" data-preset>Untick all</button>` : ""}</div></div>`;
    box.querySelector("[data-px]").onclick = close;
    box.querySelectorAll("[data-ptab]").forEach((b) => (b.onclick = () => { packUI.tab = b.dataset.ptab; draw(); }));
    box.querySelectorAll("[data-pdone]").forEach((c) => (c.onchange = () => { const x = pk.find((y) => y.id === c.dataset.pdone); data.savePack({ ...x, done: c.checked }).catch(fail); }));
    box.querySelectorAll("[data-pdel]").forEach((b) => (b.onclick = () => data.deletePack(b.dataset.pdel).catch(fail)));
    box.querySelectorAll("[data-ppacker]").forEach((b) => (b.onclick = () => { const x = pk.find((y) => y.id === b.dataset.ppacker), o = ["", ...PEOPLE()], k = o.indexOf(x.packer || "");
      data.savePack({ ...x, packer: o[(k + 1) % o.length] }).catch(fail); }));
    box.querySelector("[data-phide]").onchange = (e) => { packUI.hide = e.target.checked; draw(); };
    box.querySelector("[data-preset]")?.addEventListener("click", () => data.savePack(mine.filter((x) => x.done).map((x) => ({ ...x, done: false }))).catch(fail));
    box.querySelector(".padd").onsubmit = (e) => { e.preventDefault(); const f = e.target, t = f.t.value.trim(); if (!t) return;
      data.savePack({ text: t, cat: f.c.value, list: tab, done: false, order: Date.now() }).catch(fail); f.t.value = ""; packUI.lastCat = f.c.value; };
    if (packUI.lastCat) box.querySelector(".padd select").value = packUI.lastCat;
    box.querySelector("[data-pai]").onclick = () => packAI();
    box.querySelector("[data-pcopy]").onclick = () => packCopy();
  };
  const fail = (e) => toast(e.code === "permission-denied" ? "Packing lists need the new Firestore rules (packing section)" : "Couldn't save: " + (e.code || e.message));
  let last = ""; const tick = () => { if (!box.isConnected) return; const sig = JSON.stringify(store.packing || []) + store.packingError; if (sig !== last) { last = sig; const y = box.querySelector(".plist")?.scrollTop || 0, typed = box.querySelector(".padd input")?.value || "", focused = document.activeElement?.name === "t";
    draw(); const pl = box.querySelector(".plist"); if (pl) pl.scrollTop = y; const inp = box.querySelector(".padd input"); if (inp) { inp.value = typed; if (focused) inp.focus(); } } };
  const iv = setInterval(tick, 400); const unsub = () => clearInterval(iv);
  box.onclick = (e) => { if (e.target === box) close(); };
  tick();
}
async function packAI() {
  toast("Writing a packing list for this trip…");
  let r; try { r = await data.packingAI({ text: packContext(), have: (store.packing || []).map((x) => `${x.text} (${x.list})`) }); }
  catch (e) { return infoBox(`<h2>Couldn't Suggest a List</h2><pre class="errbox">${esc(e.message || String(e))}</pre>`); }
  const its = (r.items || []).filter((x) => x.text);
  if (!its.length) return toast("Nothing new to suggest");
  const label = (x) => (x.scope === "each" ? "everyone" : x.scope === "person" && PEOPLE().includes(x.person) ? x.person : "shared");
  modal(`<h3>Suggested for This Trip</h3><p class="muted small">Untick anything you don't want, then add. "Everyone" items go on each traveller's list.</p>
    <div class="psugg">${PACK_CATS.map((c) => [c, its.map((x, k) => [x, k]).filter(([x]) => (PACK_CATS.includes(x.cat) ? x.cat : "Other") === c)]).filter(([, a]) => a.length).map(([c, a]) => `<h4>${esc(c)}</h4>${a.map(([x, k]) => `<label class="pcand"><input type="checkbox" name="i" value="${k}" checked><span><b>${esc(x.text)}</b><small class="muted">${esc(label(x))}${x.why ? " · " + esc(x.why) : ""}</small></span></label>`).join("")}`).join("")}</div>`,
    async (fd) => {
      const pick = fd.getAll("i").map((k) => its[+k]), out = []; let o = Date.now();
      for (const x of pick) { const cat = PACK_CATS.includes(x.cat) ? x.cat : "Other";
        const lists = x.scope === "each" ? PEOPLE() : x.scope === "person" && PEOPLE().includes(x.person) ? [x.person] : ["shared"];
        lists.forEach((l) => out.push({ text: x.text, cat, list: l, done: false, why: x.why || "", order: o++ })); }
      await data.savePack(out); toast(`${out.length} items added`);
    });
  [...document.querySelectorAll(".modal")].pop().querySelector("button.primary").textContent = "Add to the Lists";
}
async function packCopy() {
  const others = store.trips.filter((t) => t.id !== ui.tripId && t.id !== store.tripId).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  if (!others.length) return toast("No other trips to copy from yet");
  const tid = store.tripId;
  modal(`<h3>Copy a Packing List</h3><p class="muted small">Copies another trip's lists here, all unticked. Items already on this trip's lists are skipped. Travellers' lists go to the same people if they're on this trip.</p>
    <label>From<select name="t">${others.map((t) => `<option value="${esc(t.id)}">${esc(t.title || "Trip")} (${fmtDate(t.start)})</option>`).join("")}</select></label>`,
    async (fd) => {
      const src = await data.packingOf(fd.get("t")); if (!src.length) throw new Error("That trip has no packing list");
      const have = new Set((store.packing || []).map((x) => x.list + "|" + x.text.toLowerCase())); let o = Date.now();
      const out = src.map((x) => ({ text: x.text, cat: x.cat || "Other", list: x.list === "shared" || PEOPLE().includes(x.list) ? x.list : "shared", packer: PEOPLE().includes(x.packer) ? x.packer : "", done: false, order: o++ }))
        .filter((x) => !have.has(x.list + "|" + x.text.toLowerCase()));
      if (store.tripId !== tid) throw new Error("Trip changed");
      await data.savePack(out); toast(`${out.length} items copied`);
    });
}

// ---------------------------------------------------------------- trip recap: the trip in numbers (also a page in the Word album)
async function tripRecap(tid) {
  await loadTripData(tid);
  const t = store.trip, inTrip = (a, b) => !(b < t.start || a > t.end), ppl = PEOPLE(), today = iso(new Date());
  const its = store.items.filter((i) => inTrip(i.start, i.end || i.start));
  const pos = async (q) => { if (!q || !mapsReady()) return null; try { return await geocodeText(q); } catch (e) { return null; } };
  const fl = its.filter((i) => i.type === "flight"), legs = [];
  for (const f of fl) { const c = codesOf(f.route);
    for (let k = 0; k + 1 < c.length; k++) { const a = await pos(c[k] + " airport"), b = await pos(c[k + 1] + " airport");
      legs.push({ f, from: c[k], to: c[k + 1], km: a && b ? distanceKm(a, b) : null }); } }
  const sumKm = (ls) => ls.reduce((x, l) => x + (l.km || 0), 0);
  const longest = legs.filter((l) => l.km).sort((a, b) => b.km - a.km)[0];
  const stays = its.filter((i) => i.type === "stay");
  const nightsBy = {}; const nightSet = new Set();
  for (const s of stays) for (let d = s.start; d < s.end; d = addDays(d, 1)) { if (!inTrip(d, d)) continue; const k = s.status === "tbc" ? "Not booked yet" : stayArea(s) || s.short || s.name;
    (nightsBy[k] ||= new Set()).add(d); nightSet.add(d); }
  const places = Object.entries(nightsBy).map(([name, ds]) => ({ name, nights: ds.size, tbc: name === "Not booked yet" })).sort((a, b) => a.tbc - b.tbc || b.nights - a.nights);
  // by road: Plan Route drives, plus moves between stays on days without a flight (straight line x 1.25 - an estimate)
  let roadKm = 0; const byDate = {};
  for (const [k, r] of Object.entries(t.routes || {})) { const d = k.split("_")[0]; const m = (r.legs || []).filter((l) => l.mode === "drive").reduce((a, l) => a + l.m, 0) / 1000; byDate[d] = Math.max(byDate[d] || 0, m); }
  roadKm += Object.values(byDate).reduce((a, b) => a + b, 0);
  const ordered = stays.slice().sort((a, b) => a.start.localeCompare(b.start)), moves = new Set();
  for (const p of ppl) { const mine = ordered.filter((s) => (s.who || []).includes(p));
    for (let k = 0; k + 1 < mine.length; k++) { const a = mine[k], b = mine[k + 1], key = a.id + ">" + b.id;
      if (moves.has(key) || fl.some((f) => (f.who || []).includes(p) && f.start <= b.start && b.start <= (f.end || f.start))) continue; moves.add(key);
      const x = await pos(a.address || a.name), y = await pos(b.address || b.name); if (x && y) roadKm += distanceKm(x, y) * 1.25; } }
  const acts = store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed && e.date && inTrip(e.date, e.endDate || e.date));
  const posts = (store.journal || []).filter((j) => !j.replyTo);
  const rated = acts.map((e) => { const rs = posts.filter((j) => j.activityId === e.id && j.rating > 0).map((j) => j.rating);
    return { name: firstText(e.text), avg: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0, n: rs.length }; }).filter((x) => x.n).sort((a, b) => b.avg - a.avg || b.n - a.n);
  const voted = Object.values(store.votes || {}).filter((v) => (v.up || []).length).map((v) => ({ name: v.name, n: v.up.length, who: v.up })).sort((a, b) => b.n - a.n);
  const countries = tripCountries().map(countryName);
  const people = ppl.map((c) => { const ls = legs.filter((l) => (l.f.who || []).includes(c)), ns = new Set();
    stays.filter((s) => (s.who || []).includes(c)).forEach((s) => { for (let d = s.start; d < s.end; d = addDays(d, 1)) if (inTrip(d, d)) ns.add(d); });
    return { code: c, name: NAME(c), flights: new Set(ls.map((l) => l.f.id)).size, km: Math.round(sumKm(ls)), nights: ns.size }; });
  return {
    stage: today < t.start ? "planned" : today > t.end ? "done" : "so far",
    days: days().length, nights: nightSet.size, countries, places,
    flights: fl.length, flownKm: Math.round(sumKm(legs)), noKm: legs.some((l) => l.km == null),
    longest: longest && { route: `${longest.from} → ${longest.to}`, km: Math.round(longest.km) },
    roadKm: Math.round(roadKm), stays: stays.length,
    activities: acts.length, rated: rated.slice(0, 5), voted: voted.slice(0, 5),
    journal: { posts: posts.length, photos: posts.reduce((a, j) => a + (j.photos || []).length, 0), replies: (store.journal || []).filter((j) => j.replyTo).length, authors: new Set(posts.map((j) => j.author)).size },
    people,
  };
}
const nfmt = (n) => Number(n || 0).toLocaleString("en-AU");
async function showRecap(tid) {
  toast("Adding it all up…");
  let R; try { R = await tripRecap(tid); } catch (e) { return toast("Couldn't build the recap: " + (e.message || e)); }
  const t = store.trip, tile = (v, l) => `<div class="rtile"><b>${v}</b><span>${l}</span></div>`;
  const stars = (a) => "★".repeat(Math.round(a)) + "☆".repeat(5 - Math.round(a));
  infoBox(`<div class="recap"><h2>${I.stats}Trip Recap</h2><p class="muted small">${esc(t.title)} · ${fmtDate(t.start)} – ${fmtDate(t.end)}${R.stage === "planned" ? " · as planned" : R.stage === "so far" ? " · so far" : ""}</p>
    <div class="rtiles">${tile(R.days, "days")}${tile(R.nights, "nights away")}${tile(R.countries.length, R.countries.length === 1 ? "country" : "countries")}${tile(R.places.filter((x) => !x.tbc).length, R.places.filter((x) => !x.tbc).length === 1 ? "place" : "places")}
      ${tile(R.flights, R.flights === 1 ? "flight" : "flights")}${tile(nfmt(R.flownKm) + (R.noKm ? "+" : ""), "km flown")}${tile("~" + nfmt(R.roadKm), "km by road")}${tile(R.activities, "activities")}</div>
    ${R.countries.length ? `<p class="small"><b>Countries:</b> ${R.countries.map(esc).join(", ")}</p>` : ""}
    ${R.longest ? `<p class="small"><b>Longest flight:</b> ${esc(R.longest.route)} · ${nfmt(R.longest.km)} km</p>` : ""}
    ${R.places.length ? `<section><h3>Nights by Place</h3><ul class="rbars">${R.places.map((x) => `<li${x.tbc ? ' class="muted"' : ""}><span>${esc(x.name)}</span><i style="--w:${Math.round(x.nights / R.places[0].nights * 100)}%"></i><b>${x.nights}</b></li>`).join("")}</ul></section>` : ""}
    ${R.rated.length ? `<section><h3>Top-Rated Activities</h3><ol>${R.rated.map((x) => `<li>${esc(x.name)} <span class="rstars">${stars(x.avg)}</span> <small class="muted">${x.n} rating${x.n > 1 ? "s" : ""}</small></li>`).join("")}</ol></section>` : ""}
    ${R.voted.length ? `<section><h3>Family Favourites (Most Votes)</h3><ol>${R.voted.map((x) => `<li>${esc(x.name)} <small class="muted">${x.n} vote${x.n > 1 ? "s" : ""} · ${x.who.map(esc).join(", ")}</small></li>`).join("")}</ol></section>` : ""}
    <section><h3>Journal</h3><p class="small">${R.journal.posts} post${R.journal.posts === 1 ? "" : "s"} · ${R.journal.photos} photo${R.journal.photos === 1 ? "" : "s"} · ${R.journal.replies} repl${R.journal.replies === 1 ? "y" : "ies"} · ${R.journal.authors} writer${R.journal.authors === 1 ? "" : "s"}</p></section>
    <section><h3>Each Traveller</h3><table class="rpeople"><tr><th></th><th>Flights</th><th>km flown</th><th>Nights</th></tr>${R.people.map((x) => `<tr><td><span class="rp-who">${avHtml(x.code)}${esc(NAME(x.code))}</span></td><td>${x.flights}</td><td>${nfmt(x.km)}</td><td>${x.nights}</td></tr>`).join("")}</table></section>
    <p class="muted small">Kilometres flown are straight lines between airports; road kilometres are an estimate (Plan Route results plus the moves between stays).</p></div>`);
}

// ---------------------------------------------------------------- whole-trip map: every stay, flight path and activity, and where we were each day
let tripMapCtl = null, tripMapPlay = null;
function tripMapModel(ps) {
  const mine = (x) => (x.who || []).some((c) => ps.includes(c));
  const t = store.trip, inTrip = (a, b) => !(b < t.start || a > t.end), cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const C = { flight: cssv("--flight"), stay: cssv("--stay"), car: cssv("--car"), act: cssv("--act") };
  const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const points = [], flights = [], ground = [], pt = {};
  const add = (x) => { if (pt[x.key]) { pt[x.key].days = [...new Set(pt[x.key].days.concat(x.days))]; return; } pt[x.key] = x; points.push(x); };
  const its = store.items.filter((i) => mine(i) && inTrip(i.start, i.end || i.start));
  const stays = its.filter((i) => i.type === "stay" && (i.address || i.name)).sort((a, b) => a.start.localeCompare(b.start));
  stays.forEach((i) => add({ key: "s:" + i.id, q: i.address || i.name, name: i.short || i.name, kind: "Stay", sub: `${fmtDate(i.start)} – ${fmtDate(i.end)}`, glyph: ICON.stay, color: C.stay, days: span(i.start, i.end) }));
  const fl = its.filter((i) => i.type === "flight");
  fl.forEach((f) => { const c = codesOf(f.route), ds = span(f.start, f.end || f.start);
    c.forEach((a) => add({ key: "a:" + a, q: /^[A-Z]{3}$/.test(a) ? a + " airport" : a, name: a, kind: "Airport", glyph: ICON.flight, color: C.flight, days: ds, small: true }));
    for (let k = 0; k + 1 < c.length; k++) flights.push({ from: "a:" + c[k], to: "a:" + c[k + 1], days: ds, label: `${c[k]} → ${c[k + 1]}`, color: C.flight }); });
  for (let k = 0; k + 1 < stays.length; k++) { const a = stays[k], b = stays[k + 1], d = b.start;   // moving between stays by road (no flight that day)
    if (!fl.some((f) => f.start <= d && d <= (f.end || f.start))) ground.push({ from: "s:" + a.id, to: "s:" + b.id, days: [d], color: C.car }); }
  store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed && mine(e) && e.date && inTrip(e.date, e.endDate || e.date) && (e.geo || e.place))
    .forEach((e) => add({ key: "e:" + e.id, pos: e.geo ? { lat: e.geo.lat, lng: e.geo.lng } : null, q: e.geo ? "" : e.place, name: firstText(e.text), kind: "Activity", sub: fmtDate(e.date), glyph: ICON.act, color: C.act, days: span(e.date, e.endDate || e.date), small: true }));
  return { points, flights, ground };
}
function tripMapDay(ps, d, tid) {
  if (!d) return `<b>Whole trip</b> · ${days().length} days`;
  const mine = (x) => (x.who || []).some((c) => ps.includes(c));
  const its = store.items.filter((i) => mine(i) && i.start <= d && d <= (i.end || i.start)), n = days().indexOf(d) + 1;
  const fl = [...new Set(its.filter((i) => i.type === "flight").map((f) => codesOf(f.route).join(" → ")))], nights = its.filter((i) => i.type === "stay" && i.start <= d && d < i.end);
  const acts = store.entries.filter((e) => mine(e) && e.date <= d && d <= (e.endDate || e.date) && e.kind === "activity" && e.status !== "recommended" && e.confirmed).map((e) => firstText(e.text));
  return `<b>Day ${n} · ${esc(WD[D(d).getDay()].slice(0, 3))} ${esc(fmtDate(d))}</b>${fl.length ? ` · ${ICON.flight}${esc(fl.join(", "))}` : ""}${nights.length ? ` · ${ICON.stay}${nights.map((n) => esc(n.short || n.name) + (nights.length > 1 ? ` <small class="muted">(${(n.who || []).filter((c) => ps.includes(c)).map(esc).join(", ")})</small>` : "")).join(", ")}` : ""}${acts.length ? ` · ${ICON.act}${esc(acts.slice(0, 3).join(", "))}${acts.length > 3 ? ` +${acts.length - 3}` : ""}` : ""}
    <button class="lnk" data-mopen="${d}">Open day →</button>`;
}
async function openTripMap(tid) {
  try { await loadTripData(tid); } catch (e) { return toast(e.message); }
  const t = store.trip, ds = days(), everyone = PEOPLE();
  let ps = everyone.slice(), k0 = 0;
  clearInterval(tripMapPlay); tripMapPlay = null; tripMapCtl = null;
  const box = document.createElement("div"); box.className = "tmapsheet"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Trip map");
  box.innerHTML = `<div class="tms-bar"><b>${esc(t.title || "Trip")} · Map</b>
      <span class="ddots">${everyone.map((c) => `<button type="button" class="dd on" data-mp="${esc(c)}" style="--pc:${pcolor(c)}" aria-pressed="true" title="${esc(NAME(c))}">${ddIn(c)}</button>`).join("")}</span>
      <button class="lb-btn" data-mclose aria-label="Close">✕</button></div>
    <div class="tmap">
      <div class="tmap-canvas">${mapsReady() ? "" : `<p class="muted">The trip map needs the Google Maps key.</p>`}</div>
      <p class="muted small tmap-msg"></p>
      <div class="tmap-days card">
        <div class="tmap-ctl"><button class="iconbtn sm" data-mstep="-1" aria-label="Previous day">‹</button>
          <input type="range" min="0" max="${ds.length}" value="0" data-mrange aria-label="Day of the trip (0 = whole trip)">
          <button class="iconbtn sm" data-mstep="1" aria-label="Next day">›</button><button class="btn tiny" data-mplay>▶ Play</button></div>
        <div class="tmap-info"></div>
        <div class="tmap-legend muted small"><span><i style="background:var(--stay)"></i>Stays</span><span><i class="dash" style="border-color:var(--flight)"></i>Flights</span><span><i style="background:var(--car)"></i>By road</span><span><i style="background:var(--act)"></i>Activities</span></div>
      </div></div>`;
  document.body.appendChild(box); document.body.classList.add("noscroll");
  const range = box.querySelector("[data-mrange]"), info = box.querySelector(".tmap-info"), holder = box.querySelector(".tmap-canvas");
  const close = () => { clearInterval(tripMapPlay); tripMapPlay = null; box.remove(); document.body.classList.remove("noscroll"); document.removeEventListener("keydown", esc2); };
  const esc2 = (e) => { if (e.key === "Escape") close(); }; document.addEventListener("keydown", esc2);
  box.querySelector("[data-mclose]").onclick = close;
  const wireInfo = () => info.querySelectorAll("[data-mopen]").forEach((b) => (b.onclick = () => { close(); if (ps.length === 1) { ui.person = ps[0]; localStorage.setItem("tp.person", ui.person); } routeTo(tid, b.dataset.mopen); }));
  const set = (k) => { k = Math.max(0, Math.min(ds.length, k)); k0 = k; range.value = k; const d = ds[k - 1] || null; info.innerHTML = tripMapDay(ps, d, tid); wireInfo(); tripMapCtl?.focus(d); };
  range.oninput = () => set(+range.value);
  box.querySelectorAll("[data-mstep]").forEach((b) => (b.onclick = () => set(+range.value + +b.dataset.mstep)));
  box.querySelector("[data-mplay]").onclick = (ev) => {
    if (tripMapPlay) { clearInterval(tripMapPlay); tripMapPlay = null; ev.target.textContent = "▶ Play"; return; }
    ev.target.textContent = "❚❚ Pause"; if (+range.value >= ds.length) set(0);
    tripMapPlay = setInterval(() => { if (!box.isConnected || +range.value >= ds.length) { clearInterval(tripMapPlay); tripMapPlay = null; if (box.isConnected) ev.target.textContent = "▶ Play"; return; } set(+range.value + 1); }, 1600);
  };
  const draw = () => { if (!mapsReady()) return;
    drawTripMap(holder, tripMapModel(ps), box.querySelector(".tmap-msg")).then((ctl) => { if (!box.isConnected) return; tripMapCtl = ctl; set(k0); })
      .catch((e) => { holder.innerHTML = `<p class="muted">${esc(e.message || "Couldn't load the map")}</p>`; }); };
  box.querySelectorAll("[data-mp]").forEach((b) => (b.onclick = () => { const c = b.dataset.mp;
    if (ps.includes(c) && ps.length === 1) return toast("Show at least one person");
    ps = ps.includes(c) ? ps.filter((x) => x !== c) : ps.concat(c); b.classList.toggle("on", ps.includes(c)); b.setAttribute("aria-pressed", ps.includes(c)); draw(); }));
  set(0); draw();
}

// ---------------------------------------------------------------- Timeline view (one card per day)
function renderTimeline() {
  const p = ui.person, ds = days(), today = iso(new Date());
  const cards = ds.map((date) => {
    const { allDay, steps, comments, travel } = dayInfo(p, date);
    const zones = stepZones(steps, date, (st) => (st.k === "flight" && st.id ? store.items.find((x) => x.id === st.id) : null));
    const w = withText(p, date);
    return `<section class="dcard${travel ? " travel" : ""}${date === today ? " today" : ""}" id="d-${date}" data-day="${date}" role="button" tabindex="0" aria-label="${WD[D(date).getDay()]} ${longDate(date)}">
      <div class="dc-head">
        <span class="dnum"><small>${WD3(date)}</small><b>${D(date).getDate()}</b></span>
        <span class="dc-title"><b>${WD[D(date).getDay()]} ${shortDate(date)}</b>${w ? withPills(p, date) : ""}</span>
        ${date === today ? `<span class="tbadge now">Today</span>` : travel ? `<span class="tbadge">Travel Day</span>` : ""}
        ${isEditor() ? `<button class="iconbtn sm" data-add-on="${date}" aria-label="Add booking on ${shortDate(date)}" title="Add booking">${ICON.plus}</button>` : ""}
      </div>
      ${allDay.length ? `<div class="allday">${allDay.map((s) => `<span class="chip k-${s.k}${s.tbc ? " tbc" : ""}"><span class="ic">${ICON[s.k]}</span>${esc(s.title)}${s.sub ? ` <span class="cs">· ${esc(s.sub)}</span>` : ""}</span>`).join("")}</div>` : ""}
      ${steps.length ? `<ol class="steps">${steps.map((s, k) => `<li><span class="st-time">${esc(s.time) || "–"}${zones && zones[k] && s.time ? `<small class="tz">${esc(zones[k])}</small>` : ""}</span><span class="st-dot k-${s.k}"></span>${pillHtml(s)}</li>`).join("")}</ol>` : ""}
      ${!allDay.length && !steps.length ? `<p class="dc-empty">Nothing booked yet</p>` : ""}
      ${comments.map((c) => `<p class="dcom">${ICON.chat}<span>${fmt(c.text)}</span></p>`).join("")}
    </section>`;
  }).join("");
  root.innerHTML = `${header({ views: true })}<div class="tl">${whoKey()}${outsideBlock(p, "before")}${cards}${outsideBlock(p, "after")}</div>`;
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll");
  if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (ds.includes(today) && !ui.scrolled) { ui.scrolled = true; document.getElementById("d-" + today)?.scrollIntoView({ block: "start" }); }
}

// ---------------------------------------------------------------- Journey view (stays as stations, flights / cars as connectors)
function renderJourney() {
  const today = iso(new Date());
  const p = ui.person, ord = { flight: 0, car: 1, stay: 2 };
  const its = itemsFor(p).filter((i) => !(i.end < store.trip.start || i.start > store.trip.end)).sort((a, b) => a.start.localeCompare(b.start) || ord[a.type] - ord[b.type]);
  // every confirmed activity of a day (multi-day ones included)
  const actsOn = (date) => entriesFor(p, date).filter((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed).map((e) => e.text);
  const dayChip = (d) => { const a = actsOn(d);
    return `<button class="jday${d === today ? " today" : ""}${a.length ? "" : " noact"}" data-day="${d}"><span class="jd">${WD3(d).slice(0, 3)} ${D(d).getDate()}</span>${a.length ? `<span class="jn-acts">${a.map((t) => `<span class="ja"><span class="jdot"></span>${fmt(t)}</span>`).join("")}</span>` : ""}</button>`; };
  const chips = (ds) => { let out = "", run = [];
    const flush = () => { if (run.length) out += `<div class="jempties">${run.map(dayChip).join("")}</div>`; run = []; };
    ds.forEach((d) => { if (actsOn(d).length) { flush(); out += dayChip(d); } else run.push(d); }); flush(); return out; };
  // nights belong to their stay; days with no stay (flight days, the last day) go under the flight/car before them
  const covered = new Set(), extra = {};
  its.filter((i) => i.type === "stay").forEach((i) => { for (let d = i.start; d < i.end; d = addDays(d, 1)) covered.add(d); });
  const legs = its.filter((i) => i.type !== "stay");
  for (const d of days()) if (!covered.has(d)) { const l = legs.filter((i) => i.start <= d).at(-1); if (l) (extra[l.id] = extra[l.id] || []).push(d); }
  const stops = its.map((i) => {
    if (i.type === "stay") {
      const N = dayDiff(i.start, i.end); const inner = [];
      for (let d = i.start; d < i.end; d = addDays(d, 1)) if (d >= store.trip.start && d <= store.trip.end) inner.push(d);
      return `<li class="jrow station${i.status === "tbc" ? " tbc" : ""}">
        <span class="jnode k-stay">${ICON.stay}</span>
        <div class="jn-body">
          <button class="jcard${i.start <= today && today < i.end ? " today" : ""}" data-day="${i.start}"><span class="jl-top"><b>${esc(i.name)}${i.status === "tbc" ? ` <span class="tbctag">TBC</span>` : ""}</b>${dotsFor((i.who || []).filter((o) => o !== p && PEOPLE().includes(o)))}</span>
            <small>${shortDate(i.start)} – ${shortDate(i.end)} · ${N} night${N === 1 ? "" : "s"}${i.address ? " · " + esc(i.address) : ""}</small></button>
          ${inner.length ? `<div class="jdays">${chips(inner)}</div>` : ""}
        </div></li>`;
    }
    const isF = i.type === "flight", k = isF ? "flight" : "car";
    const title = isF ? `${codesOf(i.route).join(" → ")}` : `${i.company || "Car"}${i.pickup ? " · " + i.pickup : ""}`;
    const sub = isF ? [[i.airline, i.number].filter(Boolean).join(" "), [cleanTime(i.dep), i.arr].filter(Boolean).join(" – ")].filter(Boolean).join(" · ")
      : [i.vehicle && i.vehicle.replace(/\s*\(.*\)$/, ""), `until ${shortDate(i.end)}`, i.dropoff && i.dropoff !== i.pickup ? "return " + i.dropoff : ""].filter(Boolean).join(" · ");
    return `<li class="jrow leg">
      <span class="jnode k-${k}">${ICON[k]}</span>
      <div class="jn-body"><button class="jleg k-${k}${i.status === "tbc" ? " tbc" : ""}${i.start === today ? " today" : ""}" data-day="${i.start}">
        <span class="jl-top"><b>${esc(title)}</b>${dotsFor((i.who || []).filter((o) => o !== p && PEOPLE().includes(o)))}<span class="jl-date">${WD3(i.start)} ${D(i.start).getDate()}</span></span>
        <small>${esc(sub)}</small></button>${extra[i.id] ? `<div class="jdays">${chips(extra[i.id])}</div>` : ""}</div></li>`;
  }).join("");
  const t = store.trip;
  root.innerHTML = `${header({ views: true })}<div class="jwrap">${whoKey()}${outsideBlock(p, "before")}
    <ol class="journey">${stops || `<li class="jempty">No bookings yet${isEditor() ? " - add one with +" : ""}.</li>`}
      ${t ? `<li class="jrow station end"><span class="jnode k-home">${ICON.home}</span><div class="jn-body"><div class="jcard plain"><b>End of Trip</b><small>${WD[D(t.end).getDay()]} ${longDate(t.end)}</small></div></div></li>` : ""}</ol>${outsideBlock(p, "after")}</div>`;
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll"); if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (!ui.jScrolled) { const el = root.querySelector(".jday.today, .jleg.today, .jcard.today"); if (el) { ui.jScrolled = true; window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 200)); } }
}
function wireDays() {
  root.querySelectorAll("[data-add-on]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation(); const date = b.dataset.addOn; const others = PEOPLE().filter((o) => o !== ui.person);
    itemForm({ type: "stay", who: [ui.person, ...others.filter((o) => together(ui.person, o, date))], start: date, end: addDays(date, 1), status: "booked" });
  }));
  root.querySelectorAll("[data-pack]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); packingSheet(); }));
  root.querySelectorAll("[data-todo]").forEach((b) => (b.onclick = (ev) => { ev.stopPropagation(); todoSheet(); }));
  const pane = ui.pane;
  root.querySelectorAll("[data-day]").forEach((el) => {
    el.onclick = (ev) => { if (ev.target.closest("[data-add-on]")) return; ev.stopPropagation();
      if (ev.target.closest("[data-pack]")) return packingSheet();
      if (ev.target.closest("[data-todo]")) return todoSheet();
      openDay(el.dataset.day, pane); };
    if (el.tagName !== "BUTTON") el.onkeydown = (e) => { if (e.key === "Enter") openDay(el.dataset.day, pane); };
  });
}

function openDay(date, pane = null) {
  if (pane !== null && pane !== undefined && splitOn()) { ui.splitDay[pane] = date; return render(); }   // split view: the day opens on the side it was picked
  sessionStorage.setItem("tp.wscroll", window.scrollY);
  routeTo(ui.tripId, date); window.scrollTo(0, 0);
}
window.onpopstate = () => { parseRoute(); render(); };

// ---------------------------------------------------------------- day view
function roleOn(i, date) {
  if (i.type === "flight") return "Flight";
  if (i.type === "stay") return date === i.start ? "Check-in" : date === i.end ? "Check-out" : "Staying";
  return date === i.start ? "Pick-up" : date === i.end ? "Drop-off" : "Car";
}
function entryLi(e) {
    const isAct = e.kind === "activity" && e.status !== "recommended";
    const mark = e.status === "recommended" ? "☆ " : !isAct ? "" : isEditor()
      ? `<label class="conf" title="Confirmed activities show in the itinerary"><input type="checkbox" data-confirm="${e.id}" ${e.confirmed ? "checked" : ""}></label>`
      : (e.confirmed ? "✓ " : "○ ");
    const efiles = isEditor() ? store.files.filter((f) => f.entryId === e.id) : [];
    return `<li id="en-${esc(e.id)}" class="entry st-${e.status} ${isAct ? (e.confirmed ? "is-conf" : "is-plan") : ""}">
      <div class="etext">${mark}${fmt(e.text)}${isAct && !e.confirmed ? ` <span class="planned">planned</span>` : ""}${ratingBadge(e.id)}
        ${(e.endDate && e.endDate !== e.date) ? `<span class="muted small"> (${fmtDate(e.date)} – ${fmtDate(e.endDate)})</span>` : ""}
        ${e.who.length < PEOPLE().length ? `<span class="who idots whos" role="img" aria-label="${esc(e.who.map(NAME).join(", "))}">${ALL_CODES().filter((c) => e.who.includes(c)).map((w) => `<i class="tdot" style="--pc:${pcolor(w)}" title="${esc(NAME(w))}"></i>`).join("")}</span>` : ""}</div>
      <div class="eacts">${e.status === "recommended" ? voteBtn("e_" + e.id, firstText(e.text), "idea") : ""}${e.place ? `<a class="ibtn pin" target="_blank" rel="noopener" href="${maps(e.place)}" title="Open in Google Maps" aria-label="Open in Google Maps">${I.pin}</a>` : ""}
        ${isEditor() ? `${e.status === "recommended" ? `<button class="btn tiny" data-plan="${e.id}">Add to Plan</button>` : ""}
        ${isAct ? `<label class="ibtn" title="Attach a booking / ticket - marks it confirmed" aria-label="Attach a booking or ticket">${I.clip}<input type="file" hidden data-attach-entry="${e.id}"></label>` : ""}
        <button class="btn tiny" data-edit-entry="${e.id}">Edit</button>
        <button class="ibtn danger" data-del-entry="${e.id}" title="Delete" aria-label="Delete">${I.trash}</button>` : ""}</div>
      ${efiles.length ? `<div class="efiles">${efiles.map(fileLink).join("")}</div>` : ""}</li>`; }
// buttons on booking cards and activity rows (day view and the Before / After Trip screens)
function wireCards() {
  root.querySelectorAll("[data-arrival]").forEach((b) => (b.onclick = () => arrivalSheet(b.dataset.arrival)));
  root.querySelectorAll("[data-wifi]").forEach((b) => (b.onclick = () => wifiSheet(b.dataset.wifi)));
  root.querySelectorAll("[data-edit-item]").forEach((b) => (b.onclick = () => itemForm(store.items.find((i) => i.id === b.dataset.editItem))));
  root.querySelectorAll("[data-edit-entry]").forEach((b) => (b.onclick = () => entryForm(store.entries.find((e) => e.id === b.dataset.editEntry))));
  root.querySelectorAll("[data-confirm]").forEach((cb) => (cb.onchange = () => { const e = store.entries.find((x) => x.id === cb.dataset.confirm); data.saveEntry({ ...e, confirmed: cb.checked }); }));
  root.querySelectorAll("[data-del-entry]").forEach((b) => (b.onclick = () => { const e = store.entries.find((x) => x.id === b.dataset.delEntry);
    if (confirm(`Delete "${e.text}"${e.endDate && e.endDate !== e.date ? " (all its days)" : ""} for everyone?`)) data.deleteEntry(e.id); }));
  root.querySelectorAll("[data-del-item]").forEach((b) => (b.onclick = () => { const i = store.items.find((x) => x.id === b.dataset.delItem);
    const nm = i.type === "flight" ? `${i.route} ${i.number}` : i.type === "stay" ? i.name : `${i.company} car`;
    if (confirm(`Delete ${nm} (${fmtDate(i.start)} – ${fmtDate(i.end)}) and its attached documents for everyone?`)) data.deleteItem(i.id); }));
  root.querySelectorAll("[data-attach-entry]").forEach((inp) => (inp.onchange = async () => {
    const e = store.entries.find((x) => x.id === inp.dataset.attachEntry);
    await upload(inp.files, { entryId: e.id, date: e.date }); await data.saveEntry({ ...e, confirmed: true }); }));
  root.querySelectorAll("[data-file]").forEach((b) => (b.onclick = () => openFile(store.files.find((x) => x.id === b.dataset.file))));
  root.querySelectorAll("[data-del-file]").forEach((b) => (b.onclick = () => { const f = store.files.find((x) => x.id === b.dataset.delFile); if (confirm(`Remove ${f.name}?`)) data.deleteFile(f); }));
  root.querySelectorAll("[data-attach-item]").forEach((inp) => (inp.onchange = () => upload(inp.files, { itemId: inp.dataset.attachItem })));
}
function itemCard(i, date) {
  const t = texts(i); const role = roleOn(i, date);
  const body = i.type === "flight" ? t.block : role === "Check-in" || role === "Pick-up" ? lines(t.start, i.type === "stay" ? i.address : "") :
               role === "Check-out" || role === "Drop-off" ? t.end : t.mid;
  const addr = i.type === "stay" ? i.address : i.type === "car" ? (role === "Drop-off" ? i.dropoff : i.pickup) : "";
  const mapQ = i.type === "stay" ? (i.address || i.name) : i.type === "car" ? `${i.company} ${addr}` : i.route.split("-").map((a) => a + " airport");
  const mapLinks = Array.isArray(mapQ) ? mapQ.map((q) => `<a class="maplink" target="_blank" rel="noopener" href="${maps(q)}"><i class="ic16">${I.pin}</i>${esc(q.replace(" airport", ""))}</a>`).join("")
                                       : (i.status !== "tbc" && mapQ ? `<a class="maplink" target="_blank" rel="noopener" href="${maps(mapQ)}"><i class="ic16">${I.pin}</i>Open in Google Maps</a>` : "");
  const pv = isEditor() ? store.priv[i.id] : null;
  const pvHtml = pv && Object.keys(pv).length ? `<dl class="priv">${Object.entries(pv).filter(([k, v]) => v && !["updatedBy", "updatedAt", "kind"].includes(k) && !(k === "share" && v === "ours")).map(([k, v]) => `<dt>${esc(label(k))}</dt><dd>${esc(k === "share" ? SHARE[v] || v : v)}</dd>`).join("")}</dl>` : "";
  const files = isEditor() ? store.files.filter((f) => f.itemId === i.id) : [];
  const k = KIND[i.type];
  return `<article class="icard k-${k}" id="it-${esc(i.id)}">
    <div class="ihead"><span class="ic">${ICON[k]}</span><span class="tag">${role}</span>${i.status === "tbc" ? `<span class="tbctag">TBC</span>` : ""}
      <span class="who idots" role="img" aria-label="${esc(i.who.map(NAME).join(", "))}">${ALL_CODES().filter((c) => i.who.includes(c)).concat(i.who.filter((c) => !ALL_CODES().includes(c))).map((w) => `<i class="tdot" style="--pc:${pcolor(w)}" title="${esc(NAME(w))}"></i>`).join("")}</span></div>
    <div class="ibody">${fmt(body)}</div>
    ${i.note ? `<div class="inote">${fmt(i.note)}</div>` : ""}
    ${pvHtml}
    ${i.type === "flight" && i.start === date ? checkinHtml(i) : ""}
    <div class="ilinks">${mapLinks}${files.map(fileLink).join("")}${i.type === "stay" && isEditor() ? `<button class="arrbtn${store.priv[i.id]?.arrival ? " has" : ""}" data-arrival="${i.id}"><i class="ic16">${I.house}</i>Arrival${store.priv[i.id]?.arrival ? "" : " +"}</button>` : i.type === "stay" && i.wifi ? `<button class="arrbtn has" data-wifi="${i.id}"><i class="ic16">${I.wifi}</i>Wi-Fi</button>` : ""}</div>
    ${isEditor() ? `<div class="iacts"><button class="btn small" data-edit-item="${i.id}">Edit</button>
       <button class="btn small danger" data-del-item="${i.id}"><i class="ic16">${I.trash}</i>Delete</button>
       <label class="btn small"><i class="ic16">${I.clip}</i>Attach File<input type="file" hidden data-attach-item="${i.id}" multiple></label></div>` : ""}
  </article>`;
}
const LABELS = { confirmation: "Confirmation", tickets: "Tickets", seats: "Seats", cost: "Cost", paidWith: "Paid With", dueAtHotel: "Due at Hotel",
  cancel: "Cancellation", phone: "Phone", share: "Who Pays", host: "Host", checkIn: "Check-In", bags: "Bags", extras: "Extras", notes: "Notes" };
const cap = (w) => String(w || "").replace(/^./, (c) => c.toUpperCase());
const label = (k) => LABELS[k] || k;
const fileLink = (f) => `<button class="filelink${data.offline.ids.has(f.id) ? " off" : ""}" data-file="${f.id}" ${data.offline.ids.has(f.id) ? `title="Saved on this phone - opens without signal"` : ""}><i class="ic16">${I.file}</i>${esc(f.name)}${data.offline.ids.has(f.id) ? `<i class="offmark" aria-label="saved offline">${I.check}</i>` : ""}</button>`;
// ---------------------------------------------------------------- offline travel documents (this phone)
const offGet = (tid) => { try { return JSON.parse(localStorage.getItem("tp.offline") || "{}")[tid] || null; } catch (e) { return null; } };
const offOn = (tid) => !!offGet(tid);
const offWho = (tid) => { const v = offGet(tid); return v && Array.isArray(v.who) ? v.who : PEOPLE(); };
const setOff = (tid, v) => { try { const o = JSON.parse(localStorage.getItem("tp.offline") || "{}"); if (v) o[tid] = v; else delete o[tid]; localStorage.setItem("tp.offline", JSON.stringify(o)); } catch (e) { /* ignore */ } };
// whose a document is: the people on the booking or activity it's attached to (unattached ones count for everyone)
const fileWho = (f) => { const it = f.itemId && store.items.find((i) => i.id === f.itemId), en = f.entryId && store.entries.find((e) => e.id === f.entryId); return (it || en)?.who || []; };
const offWanted = (tid) => { const who = offWho(tid); return store.files.filter((f) => (f.path || f.demoUrl) && (!fileWho(f).length || fileWho(f).some((c) => who.includes(c)))); };
const offList = (tid) => { try { return JSON.parse(localStorage.getItem("tp.offline.files") || "{}")[tid] || []; } catch (e) { return []; } };
const setOffList = (tid, ids) => { try { const o = JSON.parse(localStorage.getItem("tp.offline.files") || "{}"); o[tid] = ids; localStorage.setItem("tp.offline.files", JSON.stringify(o)); } catch (e) { /* ignore */ } };
const offState = { busy: false, done: 0, total: 0, sig: "", err: "" };
// open a document: the copy on this phone if there is one (works with no signal), otherwise from the cloud
async function openFile(f) {
  if (!f) return;
  const phone = matchMedia("(pointer: coarse)").matches;
  const b = await data.offlineBlob(f.id);
  if (b && phone) return docViewer(f, b);   // phones: show the saved copy inside the app (nothing lands in Downloads)
  const w = window.open("", "_blank");
  const show = (u) => { if (w) w.location = u; else location.href = u; };
  if (b) { const u = URL.createObjectURL(new Blob([b], { type: f.contentType || b.type })); show(u); setTimeout(() => URL.revokeObjectURL(u), 60000); return; }
  if (!navigator.onLine) { w?.close(); return toast("No signal, and this document isn't saved on this phone"); }
  try { show(await data.fileUrl(f)); } catch (e) { w?.close(); toast("Couldn't open: " + (e.code || e.message)); }
}
// in-app viewer: images as they are, PDFs drawn page by page with PDF.js (cached for offline by the service worker)
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/";
const loadPdfJs = () => import(PDFJS + "pdf.min.mjs").then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs"; return m; });
async function docViewer(f, blob) {
  const box = document.createElement("div"); box.className = "docview"; box.setAttribute("role", "dialog");
  box.innerHTML = `<div class="dv-bar"><b>${esc(f.name)}</b><button class="lb-btn" data-dvz="-1" aria-label="Zoom out">−</button><button class="lb-btn" data-dvz="1" aria-label="Zoom in">+</button><button class="lb-btn" data-dvx aria-label="Close">✕</button></div><div class="dv-body"><p class="muted">Opening…</p></div>`;
  document.body.appendChild(box); const body = box.querySelector(".dv-body"); let zoom = 1;
  const close = () => box.remove();
  box.querySelector("[data-dvx]").onclick = close;
  box.querySelectorAll("[data-dvz]").forEach((b) => (b.onclick = () => { zoom = Math.max(0.6, Math.min(3, zoom + +b.dataset.dvz * 0.4)); body.style.setProperty("--z", zoom); }));
  const type = f.contentType || blob.type || "";
  if (/^image\//.test(type)) { const u = URL.createObjectURL(blob); body.innerHTML = `<img src="${u}" alt="">`; return; }
  if (!/pdf/.test(type) && !/\.pdf$/i.test(f.name || "")) { body.innerHTML = `<p class="muted">This type of file can't be shown here.</p>`; return; }
  try {
    const pdfjs = await loadPdfJs(), doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    body.innerHTML = "";
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n), vp = page.getViewport({ scale: 2 }), c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height; body.appendChild(c); await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    }
  } catch (e) { console.warn("pdf view", e); body.innerHTML = `<p class="muted">Couldn't show this PDF here.</p><button class="btn" data-dvdl>Open in the phone's PDF viewer</button>`;
    body.querySelector("[data-dvdl]").onclick = () => { const u = URL.createObjectURL(blob), a = document.createElement("a"); a.href = u; a.download = f.name || "document.pdf"; a.click(); }; }
}
// keep every document of this trip on the phone (new ones are added, deleted ones removed)
async function syncOffline(force) {
  const tid = ui.tripId; if (!tid || !isEditor() || !offOn(tid) || offState.busy || !navigator.onLine) return;
  await data.offline.ready;
  if (!offState.warm) { offState.warm = true; loadPdfJs().catch(() => {}); fetch(PDFJS + "pdf.worker.min.mjs").catch(() => {}); }   // the in-app PDF viewer, cached for offline
  const files = offWanted(tid), sig = files.map((f) => f.id).sort().join() + "|" + offWho(tid).join();
  if (!force && sig === offState.sig) return;
  const gone = [...new Set(offList(tid).concat(store.files.map((f) => f.id)))].filter((id) => data.offline.ids.has(id) && !files.some((f) => f.id === id));
  const want = files.filter((f) => !data.offline.ids.has(f.id));
  if (gone.length) await data.removeOffline(gone).catch(() => {});
  if (!want.length) { offState.sig = sig; setOffList(tid, files.map((f) => f.id)); return; }
  Object.assign(offState, { busy: true, done: 0, total: want.length, err: "" });
  try { await navigator.storage?.persist?.(); } catch (e) { /* not supported */ }
  for (const f of want) { if (ui.tripId !== tid) break;
    try { await data.saveOffline(f); } catch (e) { offState.err = e.code || e.message; console.warn("offline", f.name, e); }
    offState.done++; document.querySelectorAll("[data-offprog]").forEach((x) => (x.textContent = `${offState.done} of ${offState.total}`)); }
  offState.busy = false; offState.sig = offState.err ? "" : sig;
  setOffList(tid, files.filter((f) => data.offline.ids.has(f.id)).map((f) => f.id));
  const y = scrollY; render(); scrollTo(0, y);
}
function offlineForm() {
  const tid = ui.tripId, on = offOn(tid), all = store.files.filter((f) => f.path || f.demoUrl);
  const mb = (n) => (n / 1048576).toFixed(n > 1048576 * 10 ? 0 : 1) + " MB";
  let who = offWho(tid).slice();
  const sum = () => { const fs = all.filter((f) => !fileWho(f).length || fileWho(f).some((c) => who.includes(c))), have = fs.filter((f) => data.offline.ids.has(f.id));
    return `${fs.length} document${fs.length === 1 ? "" : "s"} · about ${mb(fs.reduce((a, f) => a + (f.size || 0), 0))} · <b>${have.length} saved on this phone</b>`; };
  modal(`<h3>Offline Documents</h3>
    <p class="muted small">Keep booking documents - boarding passes, tickets, vouchers, hotel confirmations - on <b>this phone</b>, so they open with no signal (airports, border crossings, theme park gates). New ones are added automatically while the phone is online.</p>
    <label class="pswitch"><input type="checkbox" name="on" ${on ? "checked" : ""}><span>Keep documents on this phone</span></label>
    <div class="offwho"><span class="muted small">Whose documents:</span><span class="ddots">${PEOPLE().map((c) => `<button type="button" class="dd${who.includes(c) ? " on" : ""}" data-offp="${esc(c)}" style="--pc:${pcolor(c)}" aria-pressed="${who.includes(c)}" title="${esc(NAME(c))}">${ddIn(c)}</button>`).join("")}</span></div>
    <p class="small" data-offsum>${sum()}${offState.busy ? ` · saving <span data-offprog>${offState.done} of ${offState.total}</span>…` : ""}</p>
    ${offState.err ? `<p class="jwarn small">Some couldn't be saved: ${esc(offState.err)}</p>` : ""}
    <p class="muted small">They're kept inside the app (not in your Files, Downloads or Gallery). Unticking a person removes their documents from this phone; switching off removes them all. Uninstalling the app also deletes them. Documents marked ✓ are saved.</p>`,
    async (fd) => {
      const v = fd.get("on") === "on";
      if (v && !who.length) throw new Error("Pick at least one person");
      if (v) { setOff(tid, { who }); offState.sig = ""; toast("Updating the documents on this phone…"); setTimeout(() => syncOffline(true), 100); }
      else { setOff(tid, null); const have = all.filter((f) => data.offline.ids.has(f.id));
        if (have.length && confirm(`Remove the ${have.length} saved document${have.length > 1 ? "s" : ""} from this phone?`)) { await data.removeOffline(have.map((f) => f.id)); setOffList(tid, []); toast("Removed from this phone"); } }
    });
  const m = [...document.querySelectorAll(".modal")].pop();
  m.querySelectorAll("[data-offp]").forEach((b) => (b.onclick = () => { const c = b.dataset.offp; who = who.includes(c) ? who.filter((x) => x !== c) : who.concat(c);
    b.classList.toggle("on", who.includes(c)); b.setAttribute("aria-pressed", who.includes(c)); m.querySelector("[data-offsum]").innerHTML = sum(); }));
}


function renderDay() {
  if (ui.day === "before" || ui.day === "after") return renderOutside(ui.day);
  const p = ui.person, date = ui.day, ds = days();
  const idx = ds.indexOf(date);
  if (idx < 0) { ui.day = null; return render(); }
  const others = PEOPLE().filter((x) => x !== p);
  const ob = outside(p, "before"), oa = outside(p, "after"), hasBefore = ob.items.length + ob.ents.length > 0, hasAfter = oa.items.length + oa.ents.length > 0;
  const its = itemsFor(p).filter((i) => i.start <= date && date <= i.end).sort((a, b) => ({ flight: 0, car: 2, stay: 1 }[a.type] - { flight: 0, car: 2, stay: 1 }[b.type]));
  const ents = entriesFor(p, date);
  const acts = ents.filter((e) => e.kind === "activity" && e.status !== "recommended");
  const recs = ents.filter((e) => e.kind === "activity" && e.status === "recommended");
  const coms = ents.filter((e) => e.kind === "comment");
  // map pins: one colour per type (as everywhere in the app); recommended / not-yet-confirmed activities are outlined
  const cssv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const COLOR = { flight: cssv("--flight"), stay: cssv("--stay"), car: cssv("--car"), act: cssv("--act") };
  const pins = [];
  const apt = (c) => (/^[A-Z]{3}$/.test(c.trim()) ? c.trim() + " airport" : c.trim());
  its.forEach((i) => {
    if (i.type === "flight") {
      const codes = codesOf(i.route);
      const todays = i.start === i.end ? codes : date === i.start ? codes.slice(0, -1) : date === i.end ? codes.slice(-1) : [];
      todays.forEach((c) => pins.push({ q: apt(c), name: c, kind: "Airport" + (i.number ? " · " + i.number : ""), glyph: ICON.flight, color: COLOR.flight }));
    } else if (i.type === "stay") {
      if (i.address || i.name) pins.push({ q: i.address || i.name, name: i.short || i.name, kind: i.status === "tbc" ? "Hotel (TBC)" : "Hotel", glyph: ICON.stay, color: COLOR.stay, hollow: i.status === "tbc" });
    } else if (i.type === "car") {
      const at = (loc, what) => loc && pins.push({ q: [i.company, apt(loc)].filter(Boolean).join(" "), name: `${i.company || "Car"} ${loc}`, kind: what, glyph: ICON.car, color: COLOR.car });
      if (date === i.start) at(i.pickup, "Car Pick-Up" + (i.pickupTime ? " " + i.pickupTime : ""));
      if (date === i.end) at(i.dropoff, "Car Drop-Off" + (i.dropoffTime ? " " + i.dropoffTime : ""));
    }
  });
  ents.filter((e) => e.kind === "activity" && e.place).forEach((e) => {
    const ok = e.confirmed && e.status !== "recommended";
    pins.push({ q: e.place, name: e.place, kind: ok ? "Confirmed Activity" : e.status === "recommended" ? "Recommended" : "Planned - Not Confirmed", glyph: I.star, color: COLOR.act, hollow: !ok });
  });
  // Google recommendations near today's stay: top 5 to do + top 5 to eat (all of the open tab when expanded), skipping ones already planned
  const rlocs = dayLocations(p, date), rkey = rlocs.some((l) => l.key === ui.recLoc) ? ui.recLoc : rlocs[0]?.key, rrec = rkey && (store.trip.recs || {})[rkey];
  const inPlan = (x) => ents.some((e) => e.kind === "activity" && (e.text === x.name || String(e.place || "").startsWith(x.name)));
  const recPins = [];
  if (rrec) [["do", COLOR.act, I.star, "Recommended"], ["eat", cssv("--food"), I.eat, "Place to Eat"]].forEach(([tab, color, glyph, kind]) =>
    (rrec[tab] || []).slice(0, ui.recMore && (ui.recTab || "do") === tab ? 20 : 5).filter((x) => !inPlan(x)).forEach((x) =>
      recPins.push({ q: [x.name, x.address].filter(Boolean).join(", "), name: x.name, kind: `${kind} · ★ ${x.rating.toFixed(1)}`, glyph, color, hollow: true, rec: true,
        url: x.url, pos: x.lat != null ? { lat: x.lat, lng: x.lng, addr: x.address } : null })));
  const places = pins.filter((x) => !x.hollow).map((x) => [x.name, x.q]);
  const mapPins = pins.concat(recPins);
  const dayFiles = isEditor() ? store.files.filter((f) => f.date === date || (f.itemId && its.some((i) => i.id === f.itemId)) || (f.entryId && ents.some((e) => e.id === f.entryId))) : [];
  const route = places.length >= 2 ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(places[0][1])}&destination=${encodeURIComponent(places.at(-1)[1])}${places.length > 2 ? "&waypoints=" + encodeURIComponent(places.slice(1, -1).map((x) => x[1]).join("|")) : ""}` : "";
  root.innerHTML = `${header()}
  <div class="dayview">
    <div class="dayhead${date === iso(new Date()) ? " today" : ""}">
      <button class="nav" data-go="-1" ${idx === 0 && !hasBefore ? "disabled" : ""}>‹</button>
      <div><div class="wd">${date === iso(new Date()) ? "Today · " : ""}${WD[D(date).getDay()]}</div><div class="dt">${longDate(date)}</div>${others.length ? `<div class="ddots" role="group" aria-label="Travelling with">${others.map((o) => { const on = together(p, o, date);
        return `<button class="dd${on ? " on" : ""}" ${isEditor() ? `data-with="${o}"` : "disabled"} aria-pressed="${on}" aria-label="${esc(NAME(o))}: ${on ? "travelling with " + esc(NAME(p)) : "not with " + esc(NAME(p))}" title="${esc(NAME(o))}${on ? " - together" : " - apart"}${isEditor() ? " (tap to change)" : ""}" style="--pc:${pcolor(o)};--pi:${inkOn(pcolor(o))}">${ddIn(o)}</button>`; }).join("")}</div>` : ""}</div>
      <button class="nav" data-go="1" ${idx === ds.length - 1 && !hasAfter ? "disabled" : ""}>›</button>
    </div>
    ${wxStrip(p, date)}

    <section><h3>Travel & Stays</h3>${its.length ? its.map((i) => itemCard(i, date)).join("") : `<p class="muted">No flights, hotels or cars today.</p>`}</section>

    <section><h3>Activities</h3>${isEditor() ? `<p class="muted small">Tick ☑ to confirm - only confirmed activities show in the itinerary. Attaching a booking confirms it.</p>` : ""}<ul class="entries">${sortActs(acts, date).map(entryLi).join("") || `<li class="muted">Nothing planned yet.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="activity">+ Add Activity</button>` : ""}${routePanel(p, date, acts)}</section>

    ${recsHtml(p, date, recs.slice().sort((a, b) => votesFor("e_" + b.id).length - votesFor("e_" + a.id).length).map(entryLi).join(""))}

    <section><h3>Comments</h3><ul class="entries">${coms.map(entryLi).join("") || `<li class="muted">No comments.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="comment">+ Add Comment</button>` : ""}</section>

    <section><h3>Map</h3>
      ${mapPins.length ? `${mapsReady() ? `<div class="daymap" id="daymap"></div><p class="daymap-msg muted small"></p>` : isEditor() ? `<p class="muted small">The embedded map isn't set up yet (needs a Google Maps key).</p>` : ""}
      <div class="maplegend"><span><i style="background:${COLOR.flight}"></i>Flight</span><span><i style="background:${COLOR.stay}"></i>Stay</span><span><i style="background:${COLOR.car}"></i>Car</span><span><i style="background:${COLOR.act}"></i>Activity</span><span><i class="hollow" style="border-color:${COLOR.act}"></i>Recommended / Not Confirmed</span>${recPins.some((x) => x.glyph === I.eat) ? `<span><i class="hollow" style="border-color:${cssv("--food")}"></i>Place to Eat</span>` : ""}</div>
      <ul class="places">${pins.map((x) => `<li><a class="maplink" target="_blank" rel="noopener" href="${maps(x.q)}"><i class="pdot${x.hollow ? " hollow" : ""}" style="--pin:${x.color}">${x.glyph}</i> ${esc(x.name)} <span class="muted small">${esc(x.kind)}</span></a></li>`).join("")}</ul>` : `<p class="muted">No places for this day.</p>`}
      ${route ? `<a class="btn small" target="_blank" rel="noopener" href="${route}"><i class="ic16">${I.map}</i>Day Route in Google Maps</a>` : ""}</section>

    ${isEditor() ? (() => { const S = budgetSettings(), ex = expenses().filter((x) => x.date === date);
      return `<section class="bd-day"><h3>Spending</h3>${ex.length ? ex.map((x) => { const m = { amt: +x.amount || 0, cur: x.currency || S.home }, h = toHome(m, S);
        return `<button class="bl-row c-${x.cat || "other"}" data-exp="${x.id}"><span class="dot"></span><span class="bl-name">${esc(x.text || "Expense")}${x.paidWith ? `<small>${esc(x.paidWith)}</small>` : ""}</span><span class="bl-amt">${money(m.amt, m.cur, 2)}${m.cur !== S.home && h !== null ? `<small>${money(h, S.home, 2)}</small>` : ""}</span></button>`; }).join("")
        + `<p class="bd-daytot">Day total <b>${money(ex.reduce((a, x) => a + (toHome({ amt: +x.amount || 0, cur: x.currency || S.home }, S) || 0), 0), S.home, 2)}</b></p>` : `<p class="muted">Nothing spent yet.</p>`}
        <button class="btn small" data-add-exp="${date}">+ Add Expense</button><label class="btn small" data-scan-wrap>${I.receipt}Scan Receipt<input type="file" accept="image/*,application/pdf" hidden data-scan-exp="${date}"></label></section>`; })() : ""}
    ${isEditor() ? `<section><h3>Documents</h3>
      ${dayFiles.length ? `<div class="files">${dayFiles.map((f) => `<div class="frow">${fileLink(f)}<button class="btn tiny" data-del-file="${f.id}">Remove</button></div>`).join("")}</div>` : `<p class="muted">No documents for this day.</p>`}
      <label class="btn small">Upload for This Day<input type="file" hidden data-attach-day="${date}" multiple></label></section>` : ""}
    ${journalHtml(date)}
  </div>`;
  wireHeader();
  const dpane = ui.pane;
  root.querySelector("[data-back]").onclick = () => (dpane !== null && dpane !== undefined ? (ui.splitDay[dpane] = null, render()) : routeTo(ui.tripId, null));
  if (isEditor()) wireBudget();
  wireJournal(date); wireRecs(p, date, others); wireCheckins(); wireVotes(); wireRoute(p, date, acts);
  root.querySelectorAll("[data-with]").forEach((b) => (b.onclick = async () => {
    const o = b.dataset.with, next = !together(p, o, date), auto = autoTogether(p, o, date);
    try { await data.setTogether(date, p, o, next === auto ? null : next); toast(`${NAME(o)} ${next ? "with" : "not with"} ${NAME(p)} on ${shortDate(date)}`); }
    catch (x) { toast("Couldn't save: " + (x.code || x.message)); }
  }));
  const mapBox = root.querySelector("#daymap");
  if (mapBox) drawDayMap(mapBox, mapPins, root.querySelector(".daymap-msg")).catch((x) => { mapBox.hidden = true; const m = root.querySelector(".daymap-msg"); if (m) m.textContent = "Map unavailable: " + x.message; });
  root.querySelectorAll("[data-wxunit]").forEach((b) => (b.onclick = () => { wxUnit = wxUnit === "C" ? "F" : "C"; try { localStorage.setItem("tp.wxUnit", wxUnit); } catch (e) { /* ignore */ } const y = scrollY; render(); scrollTo(0, y); }));
  root.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { const d2 = ds[idx + +b.dataset.go] || (+b.dataset.go < 0 ? "before" : "after");
    if (dpane !== null && dpane !== undefined) { ui.splitDay[dpane] = d2; return render(); }
    ui.slide = +b.dataset.go > 0 ? "from-right" : "from-left"; routeTo(ui.tripId, d2, true); }));
  root.querySelectorAll("[data-new-entry]").forEach((b) => (b.onclick = () => entryForm({ kind: b.dataset.newEntry, date, endDate: date, who: [p, ...others.filter((o) => together(p, o, date))], status: "planned", confirmed: false, text: "", place: "" })));
  root.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => { const e = store.entries.find((x) => x.id === b.dataset.plan); data.saveEntry({ ...e, status: "planned", confirmed: false, date, endDate: date }); }));
  wireCards();
  root.querySelectorAll("[data-attach-day]").forEach((inp) => (inp.onchange = () => upload(inp.files, { date: inp.dataset.attachDay })));
}
// ------------------------------------------------------------------ date fields shown as dd-mmm-yy everywhere
// The browser's own date box follows the computer's region (e.g. mm/dd/yyyy); each one is covered by a label in our format,
// while the real (invisible) date input underneath still opens the calendar and holds the value.
const dmy = (v) => { if (!/^\d{4}-\d\d-\d\d$/.test(v || "")) return ""; const [y, m, d] = v.split("-"); return `${d}-${MON[+m - 1]}-${y.slice(2)}`; };
function enhanceDate(inp) {
  if (inp.dataset.dmy) return; inp.dataset.dmy = "1";
  const wrap = document.createElement("span"); wrap.className = "dmy";
  inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
  const face = document.createElement("span"); face.className = "dmy-face"; face.setAttribute("aria-hidden", "true"); wrap.appendChild(face);
  const show = () => { const t = dmy(inp.value); face.textContent = t || "dd-mmm-yy"; face.classList.toggle("empty", !t); };
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(inp, "value", { get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); show(); }, configurable: true });
  inp.addEventListener("input", show); inp.addEventListener("change", show);
  inp.addEventListener("click", () => { try { inp.showPicker(); } catch (e) { /* older browsers open it themselves */ } });
  show();
}
new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType !== 1) return;
  if (n.matches?.('input[type="date"]')) enhanceDate(n); n.querySelectorAll?.('input[type="date"]').forEach(enhanceDate); })))
  .observe(document.documentElement, { childList: true, subtree: true });

// ------------------------------------------------------------------ saved people + travel documents (editors)
const DOC_TYPES = [["passport", "Passport"], ["visa", "Visa"], ["esta", "ESTA / eTA"], ["licence", "Driver Licence"], ["idp", "International Driving Permit"], ["insurance", "Travel Insurance"], ["vaccination", "Vaccination"], ["other", "Other"]];
const docName = (t) => (DOC_TYPES.find((x) => x[0] === t) || [, "Document"])[1];
const addMonths = (s, n) => { const d = D(s); d.setMonth(d.getMonth() + n); return iso(d); };
function personFor(p) {   // the saved person behind a trip row
  if (!p) return null;
  return store.people.find((x) => x.id === p.pid) || store.people.find((x) => x.code === p.code && (x.name || "").toLowerCase() === (p.name || "").toLowerCase()) || null;
}
async function rememberPerson(p) {
  const ex = personFor(p) || store.people.find((x) => x.code === p.code && !p.name);
  const rec = { code: p.code, name: p.name, ...(p.fullName ? { fullName: p.fullName } : {}), ...(p.color ? { color: p.color } : {}) };
  if (ex) { if (ex.code !== rec.code || ex.name !== rec.name || (rec.fullName && ex.fullName !== rec.fullName) || (rec.color && ex.color !== rec.color)) await data.savePerson({ id: ex.id, ...rec }); return ex.id; }
  return data.savePerson(rec);
}
const tripsOf = (per) => store.trips.filter((t) => t.end >= iso(new Date()) && (t.travellers || []).concat(t.extended || []).some((x) => x.pid === per.id || (!x.pid && x.code === per.code)));
// one document's status: expired, runs out before/soon after a trip, or soon
function docStatus(doc, per) {
  if (!doc.expiry) return { level: "ok", text: "" };
  const today = iso(new Date()), name = docName(doc.type);
  if (doc.expiry < today) return { level: "bad", text: `${name} expired on ${longDate(doc.expiry)}` };
  for (const t of tripsOf(per).sort((a, b) => a.start.localeCompare(b.start))) {
    if (doc.expiry < t.end) return { level: "bad", text: `${name} expires ${longDate(doc.expiry)}, before the end of ${t.title} (${longDate(t.end)})` };
    if (doc.type === "passport" && doc.expiry < addMonths(t.end, 6)) return { level: "warn", text: `Passport expires ${longDate(doc.expiry)}, less than 6 months after ${t.title} ends - many countries require 6 months' validity` };
  }
  const days = dayDiff(today, doc.expiry);
  if (days <= 90) return { level: "warn", text: `${name} expires in ${days} day${days === 1 ? "" : "s"} (${longDate(doc.expiry)})` };
  return { level: "ok", text: `Valid to ${longDate(doc.expiry)}` };
}
function personStatus(per) {
  const sts = (per.docs || []).map((d) => docStatus(d, per)).filter((x) => x.level !== "ok");
  return sts.find((x) => x.level === "bad") || sts[0] || { level: "ok", text: "" };
}
// document problems for one trip, only for the people travelling on it: expired, runs out during the trip, or a passport with < 6 months left after it
function tripDocIssues(t) {
  if (!isEditor() || !store.people.length || !t.end || t.end < iso(new Date())) return [];
  const today = iso(new Date()), out = [];
  (t.travellers || []).concat(t.extended || []).forEach((x) => {
    const per = store.people.find((q) => q.id === x.pid) || (!x.pid && store.people.find((q) => q.code === x.code && (!x.name || q.name === x.name)));
    if (!per) return;
    (per.docs || []).filter((d) => d.expiry).forEach((d) => {
      const name = docName(d.type);
      const st = d.expiry < today ? { level: "bad", text: `${name} expired on ${fmtDate(d.expiry)}` }
        : d.expiry < t.end ? { level: "bad", text: `${name} expires ${fmtDate(d.expiry)}, before the trip ends (${fmtDate(t.end)})` }
        : d.type === "passport" && d.expiry < addMonths(t.end, 6) ? { level: "warn", text: `Passport expires ${fmtDate(d.expiry)}, less than 6 months after the trip ends - many countries require 6 months' validity` } : null;
      if (st) out.push({ per, d, st });
    });
  });
  return out.sort((a, b) => (a.st.level === b.st.level ? 0 : a.st.level === "bad" ? -1 : 1));
}
function showTripDocIssues(t) {
  const list = tripDocIssues(t); if (!list.length) return;
  infoBox(`<h2>Travel Documents · ${esc(t.title || "Trip")}</h2>
    <ul class="dalerts">${list.map((x) => `<li class="${x.st.level}"><b>${esc(x.per.name || x.per.code)}</b> - ${esc(x.st.text)}<button type="button" class="lnk" data-openp="${esc(x.per.id)}">Open</button></li>`).join("")}</ul>
    <p class="muted small">Update the document in the traveller's profile once it's renewed and the warning goes away.</p>`);
}
function infoBox(html) {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<div class="sheet">${html}<div class="row end"><span class="grow"></span><button type="button" class="btn primary" data-ok>OK</button></div></div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  m.querySelector("[data-ok]").onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelectorAll("[data-openp]").forEach((b) => (b.onclick = () => { close(); personForm(b.dataset.openp); }));
}
function peopleList() {
  const ppl = [...store.people].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  infoBox(`<h2>Traveller Profiles</h2>
    ${store.peopleError ? `<p class="jwarn small">${esc(store.peopleError)}</p>` : ""}
    <p class="muted small">Everyone you add to a trip gets a profile, so next time you can pick them in Trip Setup. A profile keeps the person's colour on every trip, their documents and private details.</p>
    <div class="plist">${ppl.map((x) => { const st = personStatus(x);
      return `<button type="button" class="prow2" data-openp="${esc(x.id)}" style="--pc:${upc(x.color) || "var(--muted)"}"><span class="av${x.avatar ? " has" : ""}" style="--pc:${upc(x.color) || "#5D6573"}">${avInner(x.avatar || "", (x.name || x.code || "?").slice(0, 1).toUpperCase(), upc(x.color) || "#5D6573")}</span><span class="pn">${esc(x.name || "")}<small>${(x.docs || []).length ? (x.docs || []).map((d) => docName(d.type)).join(", ") : "No documents yet"}</small></span>${st.level !== "ok" ? `<span class="dstat ${st.level}" title="${esc(st.text)}">!</span>` : ""}</button>`; }).join("") || `<p class="muted">Nobody saved yet - people are saved when you save a Trip Setup.</p>`}</div>
    <button type="button" class="btn small" data-newp>+ Add Traveller Profile</button>`);
  const m = [...document.querySelectorAll(".modal")].pop();
  m.querySelector("[data-newp]").onclick = () => { m.remove(); personForm(null); };
}
// Copy a profile colour onto every trip the person is on (trips keep a copy so the family login, which can't read profiles, sees it too)
async function syncPersonColor(per) {
  const c = upc(per.color); if (!c) return;
  for (const t of store.trips) {
    const tr = t.travellers || []; let changed = false;
    const next = tr.map((x) => ((x.pid === per.id || (!x.pid && x.code === per.code && (x.name || "") === (per.name || ""))) && upc(x.color) !== c ? (changed = true, { ...x, color: c, pid: per.id }) : x));
    if (changed) await data.saveTrip({ travellers: next }, t.id).catch((e) => console.warn("colour sync", t.id, e));
  }
}
// ---- the private part of a profile: unlocked for 14 minutes after confirming it's you (the rules allow 15)
const secure = { until: 0, vault: {} };
const unlocked = () => Date.now() < secure.until;
async function unlock() { const at = await data.confirmIdentity(); secure.until = at + 14 * 60e3; }
const VAULT_FIELDS = [
  ["Personal", [["dob", "Date of Birth", "date"], ["nationality", "Nationality"], ["phone", "Mobile", "tel"], ["email", "Email", "email"]]],
  ["Emergency Contact", [["emName", "Name"], ["emRelation", "Relationship"], ["emPhone", "Phone", "tel"]]],
  ["Health", [["allergies", "Allergies"], ["conditions", "Medical Conditions"], ["medications", "Medications"], ["blood", "Blood Type"]]],
  ["Travel Numbers", [["loyalty", "Frequent Flyer & Hotel Programs", "area", "One per line, e.g. Qantas FF 1234567"], ["ktn", "Known Traveller / Global Entry"], ["redress", "Redress Number"]]],
  ["Other", [["vnotes", "Private Notes", "area"]]],
];
function personForm(pid, opts = {}) {
  let per = store.people.find((x) => x.id === pid) || { code: "", name: "", fullName: "", docs: [] };
  let vault = per.id && secure.vault[per.id] && unlocked() ? secure.vault[per.id] : null;
  let color = upc(per.color) || opts.color || "", avatarVal = per.avatar || "";
  const avPrev = () => { const c = color || "#5D6573"; return `<span class="av lg${avatarVal ? " has" : ""}" style="--pc:${c}">${avInner(avatarVal, (per.name || per.code || "?").slice(0, 1).toUpperCase(), c)}</span>`; };
  const docsHtml = () => (per.docs || []).length ? (per.docs || []).slice().sort((a, b) => (a.expiry || "9").localeCompare(b.expiry || "9")).map((d) => { const st = docStatus(d, per);
    const num = vault ? (vault.docNumbers || {})[d.id] || d.number || "" : "";
    const hasFile = d.hasFile || d.file || (vault && (vault.files || {})[d.id]);
    return `<div class="drow ${st.level}"><div class="dmain"><b>${esc(docName(d.type))}${d.country ? ` · ${esc(d.country)}` : ""}</b>
      <small>${[vault ? num || "No number" : "Number hidden", d.expiry ? "Expires " + longDate(d.expiry) : "", d.notes].filter(Boolean).map(esc).join(" · ")}</small>
      ${st.level !== "ok" ? `<small class="dmsg">${esc(st.text)}</small>` : ""}</div>
      <div class="dacts">${hasFile ? `<button type="button" class="ibtn" data-dfile="${esc(d.id)}" title="Open the scan" aria-label="Open the scan">${I.file}</button>` : ""}
      <button type="button" class="btn tiny" data-dedit="${esc(d.id)}">Edit</button><button type="button" class="ibtn danger" data-ddel="${esc(d.id)}" title="Delete" aria-label="Delete">${I.trash}</button></div></div>`; }).join("")
    : `<p class="muted small">No documents yet.</p>`;
  const vaultHtml = () => !per.id ? `<p class="muted small">Save the profile first, then add private details.</p>`
    : !vault ? `<div class="vlocked"><i class="ic16">${I.lock}</i><div><b>Private details are locked</b><small>Birth date, contacts, health, document numbers and scans. Confirm it's you with Google to open them for 15 minutes.</small></div><button type="button" class="btn small primary" data-unlock>Unlock</button></div>`
    : VAULT_FIELDS.map(([g, fs]) => `<div class="vgroup"><p class="rlabel">${g}</p>${fs.map(([k, l, t, ph]) => t === "area"
        ? `<label>${l}<textarea name="v_${k}" rows="2" placeholder="${esc(ph || "")}">${esc(vault[k] || "")}</textarea></label>`
        : `<label>${l}<input name="v_${k}" type="${t || "text"}" value="${esc(vault[k] || "")}" autocomplete="off"></label>`).join("")}</div>`).join("")
      + `<p class="muted small vtimer">Unlocked until ${new Date(secure.until).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}.</p>`;
  modal(`<h3>${per.id ? esc(per.name || per.code) : opts.title || "New Traveller Profile"}</h3>
    <div class="row"><label>Initials<input name="code" maxlength="6" value="${esc(per.code)}" required></label><label>Preferred Name<input name="name" value="${esc(per.name)}" placeholder="What everyone calls them"></label></div>
    <label>Full Name (as on Passport)<input name="fullName" value="${esc(per.fullName || "")}"></label>
    <div><p class="rlabel">Colour (used on every trip)</p><div class="swrow pfsw" role="radiogroup" aria-label="Colour">${TCOLORS.map(([n, h]) => `<button type="button" class="swbtn${h === color ? " on" : ""}" style="--c:${h}" data-psw="${h}" role="radio" aria-checked="${h === color}" aria-label="${n}" title="${n}"></button>`).join("")}</div></div>
    <div><p class="rlabel">Photo or Avatar (framed in their colour)</p>
      <div class="avpick"><span data-avprev>${avPrev()}</span><div class="avbtns"><button type="button" class="btn tiny" data-avai>✨ Portrait from Photo…</button><button type="button" class="btn tiny" data-avphoto>Use Photo As Is…</button><button type="button" class="btn tiny" data-avnone>Use Initial</button><input type="file" accept="image/*" hidden data-avfile></div></div>
      <p class="muted small" data-avnote>Portrait from Photo: AI makes a lifelike studio-style portrait from the photo and the person's colour becomes its background.</p></div>
    <fieldset class="pbox"><legend>Travel Documents</legend><div class="dlist">${docsHtml()}</div>
      <button type="button" class="btn tiny" data-dadd>+ Add Document</button></fieldset>
    <fieldset class="pbox"><legend>Private Details</legend><div class="vbox">${vaultHtml()}</div></fieldset>`,
    async (fd) => {
      const code = String(fd.get("code")).trim().toUpperCase(), full = String(fd.get("fullName")).trim();
      const name = String(fd.get("name")).trim() || titleCase(full.split(/\s+/)[0] || "");   // blank: their first name
      if (!/^[A-Z0-9]{2,6}$/.test(code)) throw new Error("Initials: 2-6 letters, no spaces");
      if (!name) throw new Error("Enter a preferred name or the full name");
      const id = await data.savePerson({ ...(per.id ? { id: per.id } : {}), code, name, fullName: String(fd.get("fullName")).trim(), color, avatar: avatarVal || null, docs: per.docs || [] });
      if (avatarVal !== (per.avatar || "")) await syncPersonAvatar({ ...per, id, avatar: avatarVal });
      if (vault && unlocked()) { VAULT_FIELDS.forEach(([, fs]) => fs.forEach(([k]) => { const v = String(fd.get("v_" + k) ?? "").trim(); if (v) vault[k] = v; else delete vault[k]; }));
        await data.saveVault(id, vault); secure.vault[id] = vault; }
      if (color && color !== upc(per.color)) await syncPersonColor({ ...per, id, code, name, color });
      if (store.people.some((x) => x.id !== id && x.code === code)) toast(`Another profile also uses ${code} - initials must differ on a trip`);
      opts.onSaved && setTimeout(() => opts.onSaved(id, { id, code, name, fullName: String(fd.get("fullName")).trim(), color }), 0);
    }, per.id ? async () => { await unlock(); await data.deletePerson(per); } : null);
  const m = [...document.querySelectorAll(".modal")].pop(), form = m.querySelector("form");
  const redraw = () => { per = store.people.find((x) => x.id === per.id) || per; m.querySelector(".dlist").innerHTML = docsHtml(); refreshDocBtns(); };
  const avDraw = () => { m.querySelector("[data-avprev]").innerHTML = avPrev(); };
  let avMode = "photo";
  m.querySelector("[data-avphoto]").onclick = () => { avMode = "photo"; m.querySelector("[data-avfile]").click(); };
  m.querySelector("[data-avai]").onclick = () => { avMode = "ai"; m.querySelector("[data-avfile]").click(); };
  m.querySelector("[data-avfile]").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const note = m.querySelector("[data-avnote]"), btn = m.querySelector("[data-avai]");
    try {
      if (avMode === "photo") { avatarVal = await avatarFromFile(f); return avDraw(); }
      btn.disabled = true; note.textContent = "Making the portrait… this takes 10-20 seconds.";
      const drawn = await data.avatarAI(await avatarFromFile(f, 640));
      avatarVal = await cutWhite(drawn); avDraw(); note.textContent = "Done. Not quite right? Tap Portrait from Photo again for another go, or try a clearer photo.";
    } catch (x) { console.error(x); note.textContent = "Couldn't draw the portrait: " + (x.message || x); }
    btn.disabled = false; };
  m.querySelector("[data-avnone]").onclick = () => { avatarVal = ""; avDraw(); };
  avDraw();
  const ensure = async () => {   // a new person is saved before adding documents
    if (per.id) return true;
    const code = form.code.value.trim().toUpperCase(), name = form.name.value.trim() || titleCase(form.fullName.value.trim().split(/\s+/)[0] || "");
    if (!/^[A-Z0-9]{2,6}$/.test(code)) { toast("Enter the initials first (2-6 letters)"); return false; }
    per.id = await data.savePerson({ code, name, fullName: form.fullName.value.trim(), color, docs: [] }); per = { ...per, code, name };
    m.querySelector(".vbox").innerHTML = vaultHtml();
    return true;
  };
  const openVault = async () => {   // confirm it's you, then load the private part
    if (vault && unlocked()) return true;
    try { await unlock(); vault = await data.getVault(per.id);
      // documents saved before the vault existed: move their numbers and scans into it
      (per.docs || []).forEach((d) => { if (d.number) (vault.docNumbers ||= {})[d.id] = d.number; if (d.file) (vault.files ||= {})[d.id] = d.file; });
      secure.vault[per.id] = vault; m.querySelector(".vbox").innerHTML = vaultHtml(); m.querySelector(".dlist").innerHTML = docsHtml(); return true; }
    catch (e) { toast(e.code === "permission-denied" ? "Private details need the new security rules (vault)" : /popup|cancel|closed|Not confirmed/i.test(e.code + e.message) ? "Not unlocked" : "Couldn't unlock: " + (e.code || e.message)); return false; }
  };
  m.addEventListener("click", async (e) => {
    const sw = e.target.closest("[data-psw]");
    if (sw) { color = sw.dataset.psw; avDraw(); m.querySelectorAll("[data-psw]").forEach((b) => { b.classList.toggle("on", b === sw); b.setAttribute("aria-checked", b === sw); }); return; }
    if (e.target.closest("[data-unlock]")) { await openVault(); return; }
    const t = e.target.closest("[data-dadd],[data-dedit],[data-ddel],[data-dfile]"); if (!t) return;
    if (t.dataset.dadd !== undefined) { if (await ensure() && await openVault()) docForm(per, vault, null, redraw); }
    else if (t.dataset.dedit) { if (await openVault()) docForm(per, vault, (per.docs || []).find((d) => d.id === t.dataset.dedit), redraw); }
    else if (t.dataset.ddel) { const d = per.docs.find((x) => x.id === t.dataset.ddel); if (!confirm(`Delete ${docName(d.type)} and its scan?`) || !(await openVault())) return;
      try { const f = (vault.files || {})[d.id] || d.file; if (f) await data.deletePersonFile(f).catch(() => {});
        if (vault.files) delete vault.files[d.id]; if (vault.docNumbers) delete vault.docNumbers[d.id]; await data.saveVault(per.id, vault);
        per.docs = per.docs.filter((x) => x.id !== d.id); await data.savePerson({ id: per.id, docs: per.docs }); redraw(); } catch (x) { toast(x.message); } }
    else if (t.dataset.dfile) { const w = window.open("", "_blank"); if (!(await openVault())) { w && w.close(); return; }
      const d = per.docs.find((x) => x.id === t.dataset.dfile), f = (vault.files || {})[d.id] || d.file;
      try { const u = await data.personFileUrl(f); if (w) w.location = u; else location.href = u; } catch (x) { w && w.close(); toast("Couldn't open: " + (x.code || x.message)); } }
  });
}
function refreshDocBtns() {
  document.querySelectorAll(".prow[data-pid]").forEach((r) => { const per = store.people.find((x) => x.id === r.dataset.pid), b = r.querySelector("[data-docs]"); if (!per || !b) return;
    const st = personStatus(per); b.className = "btn tiny pdocs" + (st.level !== "ok" ? " " + st.level : ""); b.title = st.text || "Profile, passport, visas and other documents";
    b.innerHTML = `<i class="ic16">${I.file}</i>Profile${per.docs?.length ? ` · ${per.docs.length} doc${per.docs.length > 1 ? "s" : ""}` : ""}${st.level !== "ok" ? ` <span class="dwarn">!</span>` : ""}`;
    if (per.color && r.dataset.kind === "t") { const c = upc(per.color); r.dataset.color = c; r.style.setProperty("--pc", c); r.querySelectorAll("[data-sw]").forEach((x) => { x.classList.toggle("on", x.dataset.sw === c); x.setAttribute("aria-checked", x.dataset.sw === c); }); } });
}
// After reading a document: fill empty profile fields from it, and ask which value is right when they differ.
const titleCase = (t) => String(t || "").toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const sameName = (a, b) => { const k = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/).filter(Boolean).sort().join(" "); return k(a) === k(b); };
const sameCountry = (a, b) => { const k = (x) => String(x || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(ian|ean|an|n)$/, ""); return k(a) === k(b) || k(a).startsWith(k(b)) || k(b).startsWith(k(a)); };
const profileFormOpen = () => [...document.querySelectorAll(".modal form")].find((f) => f.fullName && f.querySelector("[data-dadd]"));
async function reconcileProfile(per, vault, x) {
  const pf = profileFormOpen(), cur = (k, fallback) => (pf && pf[k] ? pf[k].value.trim() : fallback) || "";   // what's typed in the open profile counts
  const fields = [
    ["fullName", "Full Name", cur("fullName", per.fullName), x.fullName && titleCase(x.fullName), sameName, (v) => v],
    ["dob", "Date of Birth", cur("v_dob", vault.dob), x.dob, (a, b) => a === b, (v) => (v && /^\d{4}-\d\d-\d\d$/.test(v) ? dmy(v) : v)],
    ["nationality", "Nationality", cur("v_nationality", vault.nationality), x.nationality && titleCase(x.nationality), sameCountry, (v) => v],
  ];
  const set = {}, filled = [], clashes = [];
  if (!cur("name", per.name) && x.fullName) { set.name = titleCase(x.fullName.trim().split(/\s+/)[0]); filled.push("preferred name"); }
  fields.forEach(([k, label, mine, theirs, same, show]) => {
    if (!theirs) return;
    if (!mine) { set[k] = theirs; filled.push(label.toLowerCase()); }
    else if (!same(mine, theirs)) clashes.push({ k, label, mine, theirs, show });
  });
  if (clashes.length) Object.assign(set, await askProfileClash(per, clashes));
  return { set, filled };
}
function askProfileClash(per, clashes) {
  return new Promise((done) => {
    const m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<form class="sheet"><h2>Which Is Correct?</h2>
      <p class="muted small">The document doesn't match ${esc(per.name)}'s profile. Choose the right value for each - the profile is updated when you save the document.</p>
      ${clashes.map((c, i) => `<fieldset class="pbox clash"><legend>${esc(c.label)}</legend>
        <label class="pick"><input type="radio" name="c${i}" value="mine" checked><span><small>In the profile</small><b>${esc(c.show(c.mine))}</b></span></label>
        <label class="pick"><input type="radio" name="c${i}" value="theirs"><span><small>On the document</small><b>${esc(c.show(c.theirs))}</b></span></label></fieldset>`).join("")}
      <div class="row end"><span class="grow"></span><button class="btn primary">Use Selected</button></div></form>`;
    document.body.appendChild(m);
    m.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); const out = {};
      clashes.forEach((c, i) => { if (m.querySelector(`[name=c${i}]:checked`).value === "theirs") out[c.k] = c.theirs; });
      m.remove(); done(out); };
  });
}
function applyProfileFix(per, vault, set) {
  if (set.fullName) per.fullName = set.fullName;
  if (set.name) per.name = set.name;
  if (set.dob) vault.dob = set.dob;
  if (set.nationality) vault.nationality = set.nationality;
  // keep the open profile form in step, so saving it doesn't put the old values back
  const pf = profileFormOpen();
  if (pf) { if (set.name && !pf.name.value.trim()) pf.name.value = set.name; if (set.fullName) pf.fullName.value = set.fullName; if (set.dob && pf.v_dob) pf.v_dob.value = set.dob; if (set.nationality && pf.v_nationality) pf.v_nationality.value = set.nationality; }
}
// Document: type, country, expiry and notes go in the profile (they drive the expiry warnings); the number and the scan go in the vault.
function docForm(per, vault, doc, done) {
  const isNew = !doc; doc = doc || { id: "d" + Date.now().toString(36), type: "passport" };
  let file = null, profileFix = null; const curFile = (vault.files || {})[doc.id] || doc.file;
  const m0 = document.createElement("div"); m0.className = "modal";
  m0.innerHTML = `<form class="sheet"><h3>${isNew ? "Add Document" : "Edit " + esc(docName(doc.type))} · ${esc(per.name || per.code)}</h3>
    <div class="extract"><label class="btn small pdfbtn"><i class="ic16">${I.scan}</i>${curFile ? "Replace Scan" : "Add Scan (PDF or Photo)"}<input type="file" hidden accept="application/pdf,image/*" data-dfilein></label>
      <span class="extract-status muted small">${curFile ? "Attached: " + esc(curFile.name) : "The details are read from the scan - check them before saving."}</span></div>
    <label>Type<select name="type">${DOC_TYPES.map(([k, n]) => `<option value="${k}" ${doc.type === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    <div class="row"><label>Number<input name="number" value="${esc((vault.docNumbers || {})[doc.id] || doc.number || "")}" autocomplete="off"></label><label>Country<input name="country" value="${esc(doc.country || "")}" placeholder="Issued by / for"></label></div>
    <label>Expiry Date<input type="date" name="expiry" value="${esc(doc.expiry || "")}"></label>
    <label>Notes<input name="notes" value="${esc(doc.notes || "")}" placeholder="e.g. multiple entry"></label>
    <div class="row end"><span class="grow"></span><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
  document.body.appendChild(m0);
  const f = m0.querySelector("form"), close = () => m0.remove();
  m0.querySelector("[data-cancel]").onclick = close;
  f.querySelector("[data-dfilein]").onchange = async (ev) => {
    file = ev.target.files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) { file = null; return toast("Files must be under 25 MB"); }
    const stEl = f.querySelector(".extract-status"); stEl.textContent = "Reading " + file.name + "…";
    try { const x = await data.extractDocFromFile(file);
      ["type", "number", "country", "expiry", "notes"].forEach((k) => { if (x[k] && f[k]) f[k].value = x[k]; });
      stEl.textContent = `${file.name} - details filled in. Check them before saving.`;
      profileFix = await reconcileProfile(per, vault, x);
      if (profileFix.filled.length) stEl.textContent += ` Profile updated: ${profileFix.filled.join(", ")}.`;
    } catch (e) { stEl.textContent = `${file.name} will be attached (couldn't read the details: ${e.code || e.message}).`; }
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault(); const btn = f.querySelector("button.primary"); btn.disabled = true; let step = "confirming it's you";
    try {
      if (!unlocked()) await unlock();
      const next = { id: doc.id, type: f.type.value, country: f.country.value.trim(), expiry: f.expiry.value, notes: f.notes.value.trim() };
      const num = f.number.value.trim();
      vault.docNumbers ||= {}; if (num) vault.docNumbers[doc.id] = num; else delete vault.docNumbers[doc.id];
      vault.files ||= {};
      step = "uploading the scan";
      if (file) { const nf = await data.uploadPersonFile(per.id, file); if (curFile) data.deletePersonFile(curFile).catch(() => {}); vault.files[doc.id] = nf; }
      else if (doc.file && !vault.files[doc.id]) vault.files[doc.id] = doc.file;
      if (vault.files[doc.id]) next.hasFile = true;
      Object.keys(next).forEach((k) => next[k] === "" && delete next[k]);
      if (profileFix) applyProfileFix(per, vault, profileFix.set);
      step = "saving the private details";
      await data.saveVault(per.id, vault);
      step = "saving the profile";
      const docs = (per.docs || []).filter((d) => d.id !== doc.id).concat(next);
      await data.savePerson({ id: per.id, docs, ...(profileFix?.set.fullName ? { fullName: profileFix.set.fullName } : {}), ...(profileFix?.set.name ? { name: profileFix.set.name } : {}) }); per.docs = docs;
      close(); done && done(); toast("Saved");
      const st = docStatus(next, per); if (st.level !== "ok") infoBox(`<h2>Check This Document</h2><ul class="dalerts"><li class="${st.level}"><b>${esc(per.name)}</b> - ${esc(st.text)}</li></ul>`);
    } catch (e) { btn.disabled = false; console.error(step, e);
      if (e.code === "permission-denied" || e.code === "storage/unauthorized") secure.until = 0;   // ask Google again next time
      toast(`Couldn't save while ${step}: ${e.code || e.message}${e.code === "permission-denied" || e.code === "storage/unauthorized" ? " - tap Save again to confirm it's you" : ""}`); }
  };
}

// ------------------------------------------------------------------ archive: all of a trip's documents in one zip, then (optionally) delete them from the app
let zipLib = null;
const loadZip = () => (zipLib ||= new Promise((ok, bad) => { if (window.JSZip) return ok(window.JSZip);
  const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  sc.onload = () => ok(window.JSZip); sc.onerror = () => { zipLib = null; bad(new Error("Couldn't load the zip tool (offline?)")); }; document.head.appendChild(sc); }));
const safeName = (t) => String(t || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
function archiveFolder(f) {   // which folder a file goes in: its booking, activity or day
  const it = f.itemId && store.items.find((i) => i.id === f.itemId), en = f.entryId && store.entries.find((e) => e.id === f.entryId);
  if (it) return `${it.start} ${it.type === "flight" ? `Flight ${it.route || ""} ${it.number || ""}` : it.type === "stay" ? `Stay ${it.short || it.name || ""}` : `Car ${it.company || ""}`}`;
  if (en) return `${en.date} Activity ${firstText(en.text)}`;
  if (f.date) return `${f.date} Day documents`;
  return "Other";
}
function archiveDocs() {
  const t = store.trip, files = store.files || [], size = files.reduce((a, f) => a + (f.size || 0), 0);
  const ended = t.end < iso(new Date());
  infoBox(`<h2>Archive Documents</h2>
    <p>${files.length ? `<b>${files.length}</b> document${files.length > 1 ? "s" : ""} (${(size / 1048576).toFixed(1)} MB) on <b>${esc(t.title)}</b>.` : "This trip has no documents."}</p>
    ${files.length ? `<p class="muted small">Downloads one zip with a folder per booking, activity and day, plus a list of what's inside. Keep it somewhere safe on your computer.</p>
    <label class="chk"><input type="checkbox" data-zdel ${ended ? "checked" : ""}> Then delete them from the app${ended ? "" : ` <span class="muted small">(this trip hasn't finished yet)</span>`}</label>
    <p class="muted small">Deleting only removes the files - bookings, activities, the journal and the budget stay. Profiles (passports, visas) aren't touched.</p>
    <p class="zstatus muted small"></p>
    <button type="button" class="btn primary" data-zgo>Download Zip</button>` : ""}`);
  const m = [...document.querySelectorAll(".modal")].pop(), go = m.querySelector("[data-zgo]"); if (!go) return;
  const st = (x) => (m.querySelector(".zstatus").textContent = x);
  go.onclick = async () => {
    const del = m.querySelector("[data-zdel]").checked;
    if (del && !confirm(`Download, then delete all ${files.length} documents of "${t.title}" from the app?\n\nOnly continue once the zip is saved on your computer.`)) return;
    go.disabled = true;
    try {
      const JSZip = await loadZip(), zip = new JSZip(), used = new Set(), lines = [];
      let n = 0;
      for (const f of [...files].sort((a, b) => archiveFolder(a).localeCompare(archiveFolder(b)))) {
        st(`Downloading ${++n} of ${files.length}: ${f.name}`);
        const blob = await data.fileBlob(f);
        let path = `${safeName(archiveFolder(f))}/${safeName(f.name)}`, k = 1;
        while (used.has(path)) path = path.replace(/(\.[^.]*)?$/, (ext) => ` (${++k})${ext || ""}`);
        used.add(path); zip.file(path, blob); lines.push(`${path}   (${Math.max(1, Math.round((f.size || blob.size) / 1024))} KB)`);
      }
      zip.file("Contents.txt", `${t.title} (${fmtDate(t.start)} to ${fmtDate(t.end)})\nDocuments archived ${fmtDate(iso(new Date()))} from Travel Planner\n\n${lines.join("\n")}\n`);
      st("Making the zip…");
      const out = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(out);
      a.download = `${safeName((t.title || "Trip").replace(/&/g, "and"))} Documents.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      if (!del) { st(`Done - ${files.length} documents in the zip.`); toast("Zip downloaded"); go.disabled = false; return; }
      if (!confirm(`The zip has been downloaded (${(out.size / 1048576).toFixed(1)} MB). Check it's in your Downloads, then press OK to delete the ${files.length} documents from the app.`)) { st("Zip downloaded - nothing deleted."); go.disabled = false; return; }
      n = 0; for (const f of files) { st(`Deleting ${++n} of ${files.length}…`); await data.deleteFile(f); }
      st(`Done - ${files.length} documents archived and removed from the app.`); toast("Documents archived");
    } catch (e) { go.disabled = false; st(`Stopped - nothing was deleted. ${e.code || e.message}`); console.error(e); }
  };
}

// ------------------------------------------------------------------ bulk attach (editors)
// Pick many files (or a whole folder); each is matched to a booking by its confirmation number, flight number, names and dates -
// first from the file name, then (PDFs and photos) by reading it with AI. Everything can be checked and changed before uploading.
const bnorm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const bwords = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^(hotel|resort|airport|terminal|booking|confirmation|reservation|rental|flight|international|the|and|with|from|nights?)$/.test(w));
function bulkTargets() {
  const its = store.items.map((i) => ({ kind: "item", id: i.id, type: i.type, start: i.start, end: i.end, rec: i, conf: bnorm(store.priv[i.id]?.confirmation),
    label: i.type === "flight" ? `Flight · ${shortDate(i.start)} · ${i.route || ""} ${i.number || ""}` : i.type === "stay" ? `Stay · ${shortDate(i.start)}–${shortDate(i.end)} · ${i.short || i.name || ""}` : `Car · ${shortDate(i.start)}–${shortDate(i.end)} · ${i.company || ""}`,
    names: i.type === "flight" ? [i.number, i.airline] : i.type === "stay" ? [i.name, i.short, areaOf(i)] : [i.company, i.vehicle] }));
  const acts = store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended").map((e) => ({ kind: "entry", id: e.id, type: "activity", start: e.date, end: e.endDate || e.date, rec: e,
    conf: bnorm(store.priv[e.id]?.confirmation), label: `Activity · ${shortDate(e.date)} · ${firstText(e.text)}`, names: [e.text, e.place] }));
  return its.concat(acts).sort((a, b) => a.start.localeCompare(b.start) || a.label.localeCompare(b.label));
}
const firstText = (t) => String(t || "").split("\n")[0].slice(0, 48);
// day + month in a file name ("25-Dec", "Dic28", "8-Jan-27", "Enero1", "08JAN"), English or Spanish, mapped onto the trip's years
const BMON = { jan: 0, ene: 0, enero: 0, feb: 1, mar: 2, apr: 3, abr: 3, may: 4, jun: 5, jul: 6, aug: 7, ago: 7, sep: 8, oct: 9, nov: 10, dec: 11, dic: 11 };
function fileDates(name) {
  const out = [], t = store.trip || {}, y0 = +(t.start || "2000").slice(0, 4), re = /(\d{1,2})\s*[-_ ]?\s*(enero|jan|ene|feb|mar|apr|abr|may|jun|jul|aug|ago|sep|oct|nov|dec|dic)[a-z]*|(enero|jan|ene|feb|mar|apr|abr|may|jun|jul|aug|ago|sep|oct|nov|dec|dic)[a-z]*\s*[-_ ]?\s*(\d{1,2})(?!\d)/gi;
  const nm = String(name).replace(/(\d{1,2})\s*-\s*(\d{1,2})\s*([a-z]{3,5})/gi, "$1$3 $2$3").replace(/([a-z]{3,5})\s*(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/gi, "$1$2 $1$3");
  for (const m of String(name).matchAll(/(?<!\d)(20\d\d)[-_.](\d\d)[-_.](\d\d)(?!\d)|(?<!\d)(\d\d)[-_.]?(\d\d)[-_.]?(20\d\d)(?!\d)/g)) {   // 2026-09-18, 18092026, 18-09-2026
    const [y, mo, d] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[5], m[4]], iso2 = `${y}-${mo}-${d}`;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && iso2 >= t.start && iso2 <= t.end) out.push(iso2);
  }
  for (const m of nm.matchAll(re)) {
    const d = +(m[1] || m[4]), mo = BMON[(m[2] || m[3]).toLowerCase()]; if (!(d >= 1 && d <= 31)) continue;
    for (const y of [y0, y0 + 1]) { const iso2 = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; if (iso2 >= t.start && iso2 <= t.end) { out.push(iso2); break; } }
  }
  return out;
}
// what kind of document the name suggests (English and Spanish)
function typeHint(name) {
  const n = String(name).toLowerCase();
  if (/hotel|airbnb|\bstay|hospedaje|hostal|\binn\b|resort/.test(n)) return "stay";
  if (/car ?rental|carrental|rent ?a ?car|alamo|hertz|avis|budget|enterprise|sixt|\bsuv\b|coche|auto/.test(n)) return "car";
  if (/vuelo|flight|e-?ticket|airlines?|avion|boarding|itinerary receipt/.test(n)) return "flight";
  if (/comida|cena|desayuno|dinner|lunch|breakfast|ticket|tour|entrada|park/.test(n)) return "activity";
  return "";
}
function scoreName(t, fileName, folder = "") {
  const f = bnorm(fileName); let sc = 0; const why = [];
  const hint = typeHint(fileName) || typeHint(folder); if (hint) sc += hint === t.type ? 15 : -40;
  if (t.type === "car") { const toks = new Set(String(fileName).toUpperCase().split(/[^A-Z]+/)); const codes = [t.rec.pickup, t.rec.dropoff].map((x) => String(x || "").trim().toUpperCase()).filter((x) => /^[A-Z]{3}$/.test(x));
    if (codes.some((c) => toks.has(c))) { sc += 20; why.push(codes.find((c) => toks.has(c))); } }
  if (t.conf && t.conf.length >= 4 && f.includes(t.conf)) return [100, "confirmation number in the file name"];
  if (t.type === "flight" && t.rec.number && f.includes(bnorm(t.rec.number))) { sc += 60; why.push("flight " + t.rec.number); }
  if (t.type === "flight" && t.rec.route) { const legs = String(t.rec.route).split("-"); if (legs.length > 1 && (f.includes(bnorm(legs[0] + legs[1])) || f.includes(bnorm(legs[0] + legs.at(-1))))) { sc += 30; why.push(legs.slice(0, 2).join("-")); } else if (f.includes(bnorm(legs.at(-2) + legs.at(-1)))) { sc += 30; why.push(legs.slice(-2).join("-")); } }
  const hits = [...new Set(t.names.flatMap(bwords))].filter((w) => f.includes(w));
  if (hits.length) { sc += Math.min(60, hits.length * 30); why.push(`"${hits[0]}"`); }
  const ds = fileDates(fileName);
  if (ds.length) {
    if (ds[0] === t.start) { sc += 30; why.push("date"); } else if (t.start <= ds[0] && ds[0] <= t.end && t.type !== "flight") sc += 10;
    else sc -= 20;
    if (ds[1] && ds[1] === t.end) sc += 15;
  }
  return [sc, why.length ? why.join(", ") + " in the file name" : ""];
}
function scoreAI(t, x) {
  if (!x) return [0, ""];
  const conf = bnorm(x.private?.confirmation);
  const sameDay = !(t.type === "flight" && x.start && x.start !== t.start);   // one ticket can hold several flights on different days
  if (sameDay && conf && t.conf && (conf === t.conf || (conf.length >= 5 && (t.conf.includes(conf) || conf.includes(t.conf))))) return [100, "same confirmation number"];
  if (t.type === "flight" && x.type === "flight" && x.start && x.start !== t.start && x.end !== t.end) return [-50, ""];
  let sc = 0; const why = [];
  const xt = x.type === "activity" ? "activity" : x.type;
  if (xt && xt !== t.type) sc -= 40;
  if (x.start && x.start === t.start) { sc += 30; why.push("same dates"); } else if (x.start && t.start <= x.start && x.start <= t.end) sc += 15;
  if (x.end && x.end === t.end && t.type !== "activity") sc += 15;
  if (t.type === "flight" && x.number && bnorm(x.number) === bnorm(t.rec.number)) { sc += 50; why.push("flight " + t.rec.number); }
  if (t.type === "flight" && x.route && bnorm(x.route) === bnorm(t.rec.route)) sc += 20;
  const xw = new Set(bwords([x.name, x.short, x.company, x.text, x.place, x.airline].join(" "))), hits = t.names.flatMap(bwords).filter((w) => xw.has(w));
  if (hits.length) { sc += Math.min(40, hits.length * 20); why.push("name matches"); }
  return [sc, why.join(", ")];
}
// The other journeys of a return / multi-city ticket (the first one is the booking itself)
const journeysOf = (x) => (x.journeys || []).slice(1).map((j) => ({ ...x, ...j, type: "flight", journeys: undefined }));
async function addOtherJourneys(x, file) {
  for (const j of journeysOf(x)) {
    const ex = bulkTargets().find((t) => t.type === "flight" && scoreAI(t, j)[0] >= 80);
    if (ex) { if (file && !store.files.some((f) => f.itemId === ex.id && f.name === file.name)) await data.uploadFile(file, { itemId: ex.id }); continue; }
    if (!confirm(`This confirmation also has ${j.route} on ${fmtDate(j.start)}${j.number ? " (" + j.number + ")" : ""}.\n\nAdd it as its own flight?`)) continue;
    const t = await createFromAI(j); if (file) await data.uploadFile(file, { itemId: t.id });
    toast(`${j.route} on ${fmtDate(j.start)} added`);
  }
}
// Open-dated vouchers (e.g. "valid 6 months"): ask which day to use it instead of filling every day of the trip
const needsDate = (x) => x && x.type === "activity" && (x.flexible || !x.start || (x.end && dayDiff(x.start, x.end) > 2));
function voucherDefault(x, fileName, prefer) {
  const t = store.trip, inTrip = (d) => d && d >= t.start && d <= t.end;
  return [fileDates(fileName || "")[0], prefer, x.start, iso(new Date())].find(inTrip) || t.start;
}
function askVoucherDate(x, fileName, prefer) {
  return new Promise((done) => {
    const t = store.trip, from = [t.start, x.validFrom || ""].sort().at(-1), to = [t.end, x.validTo || "9999"].sort()[0];
    const def = voucherDefault(x, fileName, prefer), m = document.createElement("div"); m.className = "modal";
    m.innerHTML = `<form class="sheet"><h2>When Will You Use It?</h2>
      <p class="muted small">${esc(x.text || x.name || "This voucher")} ${x.validFrom || x.validTo ? `can be used ${x.validFrom ? "from " + fmtDate(x.validFrom) : ""} ${x.validTo ? "until " + fmtDate(x.validTo) : ""}` : "has no fixed date"}. Choose the day to put it in the itinerary - you can change it later.</p>
      <label>Date<input type="date" name="d" value="${def}" min="${from}" max="${to}" required></label>
      <div class="row end"><span class="grow"></span>${x.start && x.end && x.start !== x.end ? `<button type="button" class="btn" data-range>Every Day ${fmtDate(x.start)} – ${fmtDate(x.end)}</button>` : ""}<button class="btn primary">Use This Date</button></div></form>`;
    document.body.appendChild(m);
    m.querySelector("[data-range]")?.addEventListener("click", () => { m.remove(); done(null); });
    m.querySelector("form").onsubmit = (ev) => { ev.preventDefault(); const d = m.querySelector("[name=d]").value; m.remove(); done(d); };
  });
}
// A booking built from what the AI read in a confirmation (bulk attach, when the trip doesn't have it yet)
function aiLabel(x) {
  const d = x.start ? shortDate(x.start) + (x.end && x.end !== x.start ? "–" + shortDate(x.end) : "") : "";
  const what = x.type === "flight" ? `Flight ${x.route || ""} ${x.number || ""}` : x.type === "stay" ? `Stay ${x.short || x.name || ""}` : x.type === "car" ? `Car ${x.company || ""}` : `Activity ${x.text || x.name || ""}`;
  return `${what.trim()} · ${d}`;
}
// arrival details (Wi-Fi, codes, host): keep what's there, fill the gaps from a newly read document
const arrOk = (a) => (a && Object.values(a).some((v) => v) ? a : null);
const mergeArr = (have, got) => { const out = { ...(have || {}) }; for (const [k, v] of Object.entries(got || {})) if (v && !out[k]) out[k] = v; return arrOk(out); };
const AI_FIELDS = { flight: ["route", "airline", "number", "dep", "arr"], stay: ["name", "short", "address", "area", "checkin", "checkout"], car: ["company", "vehicle", "pickup", "dropoff", "pickupTime", "dropoffTime", "address"] };
async function createFromAI(x) {
  const who = (x.who || []).filter((c) => PEOPLE().includes(c)); const people = who.length ? who : PEOPLE();
  const priv = Object.fromEntries(Object.entries(x.private || {}).filter(([k, v]) => v && (k !== "arrival" || (x.type === "stay" && arrOk(v)))));
  if (x.type === "activity") {
    const id = await data.saveEntry({ kind: "activity", status: "planned", confirmed: true, date: x.start, endDate: x.end || x.start, who: people,
      text: [x.time, x.text || x.name].filter(Boolean).join(" ") || "Activity", place: x.place || x.name || "", ...(x.note ? { note: x.note } : {}) });
    if (Object.keys(priv).length) await data.savePrivate(id, priv);
    return { kind: "entry", id, type: "activity", start: x.start, end: x.end || x.start, rec: { text: x.text || x.name || "", place: x.place || "" }, conf: bnorm(priv.confirmation), names: [x.text, x.name, x.place] };
  }
  const item = { type: x.type, who: people, start: x.start, end: x.end || x.start, status: "booked", ...(x.note ? { note: x.note } : {}) };
  (AI_FIELDS[x.type] || []).forEach((k) => { if (x[k]) item[k] = x[k]; });
  if (x.type === "stay" && !item.short && item.name) item.short = item.name.slice(0, 14);
  const id = await data.saveItem(item, Object.keys(priv).length ? priv : null);
  return { kind: "item", id, type: x.type, start: item.start, end: item.end, rec: item, conf: bnorm(priv.confirmation), names: x.type === "flight" ? [x.number, x.airline] : x.type === "stay" ? [x.name, x.short] : [x.company, x.vehicle] };
}
// ---- travel documents (ESTA, visas, passports…) found among the bookings go to the traveller's profile, not the itinerary
const DOC_RX = [["esta", /\besta\b|\beta\b|nz-?eta|travel authori[sz]ation|electronic system for travel/i], ["visa", /\bvisas?\b|\bvisado\b/i],
  ["passport", /passport|pasaporte/i], ["insurance", /travel insurance|insurance policy|seguro de viaje|\bpoliza\b|póliza/i],
  ["vaccination", /vaccin|vacuna/i], ["licence", /driv(er|ing)'?s? licen[cs]e|licencia de conducir/i], ["idp", /international driving permit|\bidp\b/i]];
const docKind = (t) => (DOC_RX.find(([, rx]) => rx.test(String(t || ""))) || [])[0] || "";
const tripPeople = () => (store.trip?.travellers || []).concat(store.trip?.extended || []);
function docOwner(x, fileName) {   // whose document: the holder's name on it, else initials / a name in the file name
  const ppl = tripPeople(), words = (v) => bwords(v).concat(String(v || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3));
  if (x?.fullName) { const xw = new Set(words(x.fullName));
    const best = ppl.map((p) => { const per = personFor(p); const ws = words([per?.fullName, p.fullName, per?.name, p.name].join(" ")); return [p, ws.filter((w) => xw.has(w)).length]; }).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2 || (best && best[1] === 1 && ppl.filter((p) => words([personFor(p)?.fullName, p.fullName, p.name].join(" ")).some((w) => xw.has(w))).length === 1)) return best[0]; }
  const toks = String(fileName).split(/[^A-Za-z]+/).filter(Boolean);
  return ppl.find((p) => toks.includes(p.code)) || ppl.find((p) => toks.some((t) => t.length >= 3 && [p.name, personFor(p)?.name].some((n) => n && n.toLowerCase().split(/\s+/)[0] === t.toLowerCase()))) || null;
}
function docDup(r) {
  const p = r.target?.startsWith("doc:") && tripPeople().find((q) => q.code === r.target.slice(4)), per = p && personFor(p), x = r.docx || {};
  return !!(per && x.type && (per.docs || []).some((d) => d.type === x.type && d.hasFile && (!x.expiry || d.expiry === x.expiry) && (!x.country || !d.country || sameCountry(d.country, x.country))));
}
// Save one document into its owner's profile (the caller has already confirmed it's you): scan + number in the vault, the rest in the profile
async function addDocToProfile(p, file, x, vaults) {
  const pid = personFor(p)?.id || await rememberPerson({ code: p.code, name: p.name, fullName: p.fullName, color: p.color });
  const per = store.people.find((q) => q.id === pid) || { id: pid, code: p.code, name: p.name, docs: [] };
  const vault = (vaults[pid] ||= await data.getVault(pid));
  const id = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const nf = await data.uploadPersonFile(pid, file);
  vault.files ||= {}; vault.files[id] = nf; vault.docNumbers ||= {}; if (x.number) vault.docNumbers[id] = x.number;
  if (!vault.dob && x.dob) vault.dob = x.dob; if (!vault.nationality && x.nationality) vault.nationality = titleCase(x.nationality);   // only fill gaps here
  await data.saveVault(pid, vault);
  const doc = { id, type: x.type || "other", country: x.country || "", expiry: x.expiry || "", notes: x.notes || "", hasFile: true };
  Object.keys(doc).forEach((k) => doc[k] === "" && delete doc[k]);
  const docs = (per.docs || []).concat(doc);
  await data.savePerson({ id: pid, docs, ...(!per.fullName && x.fullName ? { fullName: titleCase(x.fullName) } : {}) }); per.docs = docs;
  return { per, doc };
}
// A changed booking (e.g. the airline moved the departure): compare what the file says with the booking we have
const hhmm = (t) => { const m = String(t || "").match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, "0") + ":" + m[2] : ""; };
const CHG_FIELDS = { flight: [["start", "Date", "d"], ["dep", "Departure", "t"], ["arr", "Arrival", "t"], ["number", "Flight", "n"], ["route", "Route", "n"]],
  stay: [["start", "Check-in date", "d"], ["end", "Check-out date", "d"], ["checkin", "Check-in time", "t"], ["checkout", "Check-out time", "t"]],
  car: [["start", "Pick-up date", "d"], ["end", "Drop-off date", "d"], ["pickupTime", "Pick-up time", "t"], ["dropoffTime", "Drop-off time", "t"]] };
function bookingChanges(item, x) {
  if (!item || !x || !CHG_FIELDS[item.type] || (x.type && x.type !== item.type)) return [];
  if (item.type === "flight") {   // a ticket with several flights: compare with the one that is this booking
    const t = { type: "flight", conf: "", rec: item, start: item.start, end: item.end, names: [item.number, item.airline] };
    x = [x, ...journeysOf(x)].map((j) => [j, scoreAI(t, { ...j, private: {} })[0] + (bnorm(j.route) === bnorm(item.route) ? 40 : 0)]).sort((a, b) => b[1] - a[1])[0][0];
  }
  const norm = { d: (v) => (/^\d{4}-\d\d-\d\d$/.test(v || "") ? v : ""), t: hhmm, n: (v) => bnorm(v) };
  const show = { d: fmtDate, t: (v) => hhmm(v), n: (v) => String(v) };
  return CHG_FIELDS[item.type].map(([k, label, kind]) => { const a = norm[kind](item[k]), b = norm[kind](x[k]);
    return a && b && a !== b ? { k, label, old: show[kind](item[k]), nu: show[kind](x[k]), val: kind === "t" ? hhmm(x[k]) : x[k] } : null; }).filter(Boolean);
}
function bulkAttach() {
  const targets = bulkTargets();
  const opts = (sel, r) => `<option value="">Don't attach</option>` + (r && r.ai && r.ai.type && r.ai.start ? `<option value="new" ${sel === "new" ? "selected" : ""}>+ New booking: ${esc(aiLabel(r.ai))}</option>` : "")
    + (r?.doc ? docOpts(sel, r) : "")
    + targets.map((t) => `<option value="${t.kind}:${t.id}" ${sel === t.kind + ":" + t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")
    + (r?.doc ? "" : `<optgroup label="Travel Document → Traveller Profile">${docOpts(sel, r)}</optgroup>`);
  const docOpts = (sel, r) => tripPeople().map((p) => `<option value="doc:${esc(p.code)}" ${sel === "doc:" + p.code ? "selected" : ""}>${esc(docName(r?.docx?.type || r?.doc || "other"))} → ${esc(p.name || p.code)}'s Profile</option>`).join("");
  let rows = [];   // { file, target, why, state }
  modal(`<h2>Attach Documents</h2>
    <p class="muted small">Choose the confirmations, tickets and vouchers (or a whole folder). Each is matched to its booking - check the matches, change any that are wrong, then upload.</p>
    <div class="row bpick"><label class="btn small"><i class="ic16">${I.file}</i>Choose Files<input type="file" hidden multiple data-bfiles></label>
      <label class="btn small"><i class="ic16">${I.clip}</i>Choose Folder<input type="file" hidden webkitdirectory multiple data-bfolder></label></div>
    <p class="bstatus muted small"></p><div class="blist"></div>`, async () => {
    const go = rows.filter((r) => r.target && r.state !== "dup" && !(r.out && r.target === "new" && !r.outOk) && !(r.changes?.length && r.target === r.chgTarget && !r.chg) && !(r.target === "new" && !r.who?.length));
    if (!go.length) { toast("Nothing to attach"); throw Object.assign(new Error(""), { back: true }); }
    let n = 0, updated = 0, arrivals = 0; const made = [];   // bookings created in this upload (a second file for the same booking joins it)
    const docs = go.filter((r) => r.target.startsWith("doc:")), vaults = {}; let nd = 0;
    if (docs.length) {
      if (!unlocked()) { setStatus("Confirm it's you to add travel documents to the profiles…"); await unlock(); }
      for (const r of docs) {
        const p = tripPeople().find((q) => q.code === r.target.slice(4)); if (!p) continue;
        setStatus(`Adding ${r.file.name} to ${p.name || p.code}'s profile…`);
        if (!r.docx) { try { r.docx = await data.extractDocFromFile(r.file); } catch (e) { r.docx = { type: r.doc || "other" }; } }
        await addDocToProfile(p, r.file, r.docx, vaults); nd++;
      }
    }
    for (const r of go.filter((x) => !x.target.startsWith("doc:"))) {
      if (r.target === "new") {
        const same = made.find((m) => scoreAI(m.t, r.ai)[0] >= 80);
        if (same) r.target = same.t.kind + ":" + same.t.id;
        else { setStatus(`Creating ${aiLabel(r.ai)}…`); const t = await createFromAI({ ...r.ai, who: r.who }); made.push({ t }); r.target = t.kind + ":" + t.id; }
      }
      for (const mj of r.target ? r.more || [] : []) {   // the other journeys of a return ticket get the file too
        if (mj.target === "new") { const same = made.find((m) => scoreAI(m.t, mj.ai)[0] >= 80);
          if (same) mj.target = same.t.kind + ":" + same.t.id; else { const t = await createFromAI({ ...mj.ai, who: r.who || mj.ai.who }); made.push({ t }); mj.target = t.kind + ":" + t.id; } }
        const mid = mj.target.split(":")[1]; if (!store.files.some((f) => f.itemId === mid && f.name === r.file.name)) await data.uploadFile(r.file, { itemId: mid });
      }
      const [kind, id] = r.target.split(":");
      if (kind === "item" && r.chg === "new" && r.target === r.chgTarget) {   // the file has the new times: update the booking
        const it = store.items.find((x) => x.id === id);
        const now2 = it ? bookingChanges(it, r.ai).filter((c) => r.changes.some((o) => o.k === c.k)) : [];   // against the booking as it is now
        if (now2.length) { const patch = Object.fromEntries(now2.map((c) => [c.k, c.val]));
          if (patch.start && it.end < patch.start) patch.end = patch.start;
          const note = `Updated from ${r.file.name} on ${fmtDate(iso(new Date()))}: ${now2.map((c) => `${c.label.toLowerCase()} ${c.old} → ${c.nu}`).join(", ")}`;
          await data.saveItem({ ...it, ...patch, note: [it.note, note].filter(Boolean).join("\n") }); Object.assign(it, patch); updated++; }
      }
      setStatus(`Uploading ${++n} of ${go.length}: ${r.file.name}`);
      if (kind === "item") { await data.uploadFile(r.file, { itemId: id });
        const it = store.items.find((x) => x.id === id), got = arrOk(r.ai?.private?.arrival);
        if (it?.type === "stay" && got) { const had = store.priv[id] || {}; await data.savePrivate(id, { ...had, arrival: mergeArr(had.arrival, got) }); arrivals++; } }
      else { const e = store.entries.find((x) => x.id === id); await data.uploadFile(r.file, { entryId: id, date: e?.date || "" }); if (e && !e.confirmed) await data.saveEntry({ ...e, confirmed: true }); }
    }
    const nb = go.length - nd;
    toast([nb ? `${nb} document${nb > 1 ? "s" : ""} attached` : "", nd ? `${nd} travel document${nd > 1 ? "s" : ""} added to profiles` : "", made.length ? `${made.length} new booking${made.length > 1 ? "s" : ""} created - check them` : "", updated ? `${updated} booking${updated > 1 ? "s" : ""} updated with new times` : "", arrivals ? `arrival details added to ${arrivals} stay${arrivals > 1 ? "s" : ""}` : ""].filter(Boolean).join(", "));
  });
  const m = [...document.querySelectorAll(".modal")].pop(), list = m.querySelector(".blist"), btn = m.querySelector("button.primary");
  const setStatus = (t) => (m.querySelector(".bstatus").textContent = t);
  btn.textContent = "Upload"; btn.disabled = true;
  const draw = () => {
    const held = (r) => (r.out && r.target === "new" && !r.outOk) || (r.changes?.length && r.target === r.chgTarget && !r.chg) || (r.target === "new" && !r.who?.length);
    list.innerHTML = rows.map((r, i) => `<div class="brow ${held(r) ? "outw " : ""}${r.target?.startsWith("doc:") ? "pdoc" : r.target === "new" ? "new" : r.target ? "ok" : "none"}${r.state === "dup" ? " dup" : ""}">
      <div class="bname"><i class="ic16">${I.file}</i><span>${esc(r.file.name)}</span></div>
      <select data-bi="${i}" aria-label="Booking for ${esc(r.file.name)}" ${r.state === "reading" ? "disabled" : ""}>${opts(r.target, r)}</select>
      ${r.vdate && r.target === "new" ? `<label class="bvd small">Voucher - use it on <input type="date" data-bvd="${i}" value="${r.vdate}" min="${store.trip.start}" max="${store.trip.end}"></label>` : ""}
      ${r.target === "new" && r.ai ? `<div class="bwho small${r.who?.length ? "" : " need"}"><span>${r.who?.length ? "In the itinerary of" : `${I.warn}No traveller's name found on it - whose itinerary is it for?`}</span>
        <span class="ddots">${PEOPLE().map((c) => `<button type="button" class="dd${r.who?.includes(c) ? " on" : ""}" data-bwho="${i}" data-c="${esc(c)}" style="--pc:${pcolor(c)}" aria-pressed="${!!r.who?.includes(c)}" title="${esc(NAME(c))}">${ddIn(c)}</button>`).join("")}</span></div>` : ""}
      ${r.out && r.target === "new" ? `<label class="bout small"><input type="checkbox" data-bout="${i}" ${r.outOk ? "checked" : ""}><span><b>${I.warn}Out of trip dates.</b> Tick to add it anyway - it will show in the grey <b>${r.out === "before" ? "Before Trip" : "After Trip"}</b> block for the people on it, not in the day-by-day plan.</span></label>` : ""}
      ${r.changes?.length && r.target === r.chgTarget ? `<div class="bchg small"><span><b>${I.warn}Different from the booking</b> - this looks like an update:</span>
        <ul>${r.changes.map((c) => `<li>${esc(c.label)}: <s>${esc(c.old)}</s> → <b>${esc(c.nu)}</b></li>`).join("")}</ul>
        <label><input type="radio" name="chg${i}" data-chg="${i}" value="new" ${r.chg === "new" ? "checked" : ""}><span>Use the new details - update the booking and attach</span></label>
        <label><input type="radio" name="chg${i}" data-chg="${i}" value="keep" ${r.chg === "keep" ? "checked" : ""}><span>Keep the booking as it is - just attach the file</span></label></div>` : ""}
      ${r.more?.length && r.target ? `<div class="bmore small">Also: ${r.more.map((m) => `${esc(aiLabel(m.ai))} (${m.target === "new" ? "new booking" : "matched"})`).join(" · ")}</div>` : ""}
      <div class="bwhy small">${r.state === "reading" ? "Reading the document…" : r.state === "dup" ? (r.target?.startsWith("doc:") ? "Already in this traveller's profile - will be skipped" : "Already attached to this booking - will be skipped") : r.target === "new" || r.target?.startsWith("doc:") ? esc(r.why) : r.target ? "Matched: " + esc(r.why) : esc(r.why || "No match found - choose the booking, or leave it out")}</div></div>`).join("");
    list.querySelectorAll("[data-bwho]").forEach((b) => (b.onclick = () => { const r = rows[+b.dataset.bwho], c = b.dataset.c; r.who = r.who || [];
      r.who = r.who.includes(c) ? r.who.filter((x) => x !== c) : r.who.concat(c); draw(); }));
    list.querySelectorAll("[data-chg]").forEach((c) => (c.onchange = () => { rows[+c.dataset.chg].chg = c.value; draw(); }));
    list.querySelectorAll("[data-bout]").forEach((c) => (c.onchange = () => { rows[+c.dataset.bout].outOk = c.checked; draw(); }));
    list.querySelectorAll("[data-bvd]").forEach((d) => (d.onchange = () => { const r = rows[+d.dataset.bvd]; if (d.value) { r.vdate = d.value; r.ai.start = r.ai.end = d.value; } }));
    list.querySelectorAll("[data-bi]").forEach((s) => (s.onchange = () => { const r = rows[+s.dataset.bi]; r.target = s.value; r.why = s.value.startsWith("doc:") ? `Travel document - saved in the profile (private details), not the itinerary` : "chosen by you"; r.state = isDup(r) ? "dup" : "done"; draw(); }));
    const ready = rows.filter((r) => r.target && r.state !== "dup" && !held(r)).length;
    btn.disabled = !ready || rows.some((r) => r.state === "reading"); btn.textContent = ready ? `Upload ${ready}` : "Upload";
  };
  const isDup = (r) => { if (r.target?.startsWith("doc:")) return docDup(r); if (!r.target || r.target === "new") return false; const [kind, id] = r.target.split(":"); return store.files.some((f) => f.name === r.file.name && (!f.size || f.size === r.file.size) && (kind === "item" ? f.itemId === id : f.entryId === id)); };
  const pick = async (files) => {
    files = [...files].filter((f) => !/^\./.test(f.name) && !/\.(ds_store|ini|tmp)$/i.test(f.name));
    const big = files.filter((f) => f.size > 25 * 1024 * 1024); if (big.length) toast(`Skipped ${big.length} file(s) over 25 MB`);
    files = files.filter((f) => f.size <= 25 * 1024 * 1024 && !rows.some((r) => r.file.name === f.name && r.file.size === f.size));
    const fresh = files.map((file) => {
      const folder = String(file.webkitRelativePath || "").split("/").slice(1, -1).join(" ");
      const dk = docKind(file.name.replace(/[_.-]+/g, " "));
      if (dk) return { file, folder, doc: dk, target: "", why: "", sure: false, state: "done" };
      const best = targets.map((t) => [t, ...scoreName(t, file.name, folder)]).sort((a, b) => b[1] - a[1])[0];
      return { file, folder, target: best && best[1] >= 50 ? best[0].kind + ":" + best[0].id : "", why: best && best[1] >= 50 ? best[2] : "", sure: best && best[1] >= 70, state: "done" };
    });
    rows = rows.concat(fresh); fresh.forEach((r) => (r.state = isDup(r) ? "dup" : r.state)); draw();
    const readable = (r) => /pdf|image/.test(r.file.type || (/\.pdf$/i.test(r.file.name) ? "pdf" : ""));
    fresh.forEach((r) => { if (r.sure && r.target.startsWith("item:") && r.state !== "dup") { const id = r.target.slice(5);
      const st = store.items.find((x) => x.id === id);
      if (store.files.some((f) => f.itemId === id) || rows.some((o) => o !== r && o.target === r.target) || (st?.type === "stay" && !store.priv[id]?.arrival)) r.verify = true; } });
    const toRead = fresh.filter((r) => (!r.sure || r.verify) && r.state !== "dup" && readable(r));
    let k = 0;
    for (const r of toRead) {
      r.state = "reading"; draw(); setStatus(`Reading ${++k} of ${toRead.length} with AI…`);
      try {
        if (!r.doc) {   // a booking? (a travel document that wasn't obvious from its name is caught here)
          const x0 = await data.extractFromFile(r.file, "stay", { travellers: store.trip?.travellers || [], extended: store.trip?.extended || [], start: store.trip?.start, end: store.trip?.end });
          const dk = x0.type === "activity" && docKind([x0.text, x0.name, x0.note].join(" "));
          if (dk) r.doc = dk; else r.pre = x0;
        }
        if (r.doc) {
          const x = (r.docx = await data.extractDocFromFile(r.file)); if (!x.type || x.type === "other") x.type = r.doc;
          const owner = docOwner(x, r.file.name);
          r.target = owner ? "doc:" + owner.code : "";
          r.why = owner ? `${docName(x.type)}${x.expiry ? ", valid to " + fmtDate(x.expiry) : ""} - saved in ${owner.name || owner.code}'s profile (private details), not the itinerary` : `${docName(x.type)}${x.fullName ? " for " + titleCase(x.fullName) : ""} - choose whose profile it goes in`;
          r.state = isDup(r) ? "dup" : "done"; draw(); continue;
        }
        const x = r.pre || await data.extractFromFile(r.file, "stay", { travellers: store.trip?.travellers || [], extended: store.trip?.extended || [], start: store.trip?.start, end: store.trip?.end });
        if (r.verify) { r.ai = x; r.changes = bookingChanges(store.items.find((i) => "item:" + i.id === r.target), x); r.chgTarget = r.target; r.state = isDup(r) ? "dup" : "done"; draw(); continue; }
        const best = targets.map((t) => { const a = scoreAI(t, x), n = scoreName(t, r.file.name, r.folder); return [t, a[0] + n[0] / 2, a[1] || n[1]]; }).sort((a, b) => b[1] - a[1])[0];
        r.ai = x; r.who = (x.who || []).filter((c) => PEOPLE().includes(c));   // only registered travellers; none found -> ask
        if (needsDate(x)) { r.vdate = voucherDefault(x, r.file.name); x.start = x.end = r.vdate; }   // open-dated voucher: one day, editable in the row
        r.more = journeysOf(x).map((j) => { const b = targets.map((t) => [t, scoreAI(t, j)[0]]).sort((a, c) => c[1] - a[1])[0];
          return { ai: j, target: b && b[1] >= 50 ? b[0].kind + ":" + b[0].id : "new" }; });
        if (best && best[1] >= 50) { r.target = best[0].kind + ":" + best[0].id; r.why = best[2];
          if (best[0].kind === "item") { r.changes = bookingChanges(store.items.find((i) => i.id === best[0].id), x); r.chgTarget = r.target; } }
        else if (!r.target && x.type === "flight" && x.number && (() => {   // same flight number and route, but a new date: the airline moved it
          const same = store.items.find((i) => i.type === "flight" && bnorm(i.number) === bnorm(x.number) && bnorm(i.route) === bnorm(x.route) && Math.abs(dayDiff(i.start, x.start || i.start)) <= 3);
          if (same) { r.target = "item:" + same.id; r.why = `Same flight ${same.number}`; r.changes = bookingChanges(same, x); r.chgTarget = r.target; }
          return !!same; })()) { /* matched as a changed flight */ }
        else if (!r.target && x.type && x.start) {   // no booking for it yet: offer to create one from what the AI read
          r.target = "new"; r.out = (x.end || x.start) < store.trip.start ? "before" : x.start > store.trip.end ? "after" : "";
          r.why = r.out ? `Outside this trip's dates (${fmtDate(store.trip.start)} – ${fmtDate(store.trip.end)})` : "Not in the itinerary yet - a new booking will be created from the file"; }
        else if (!r.target) r.why = "Couldn't tell which booking - choose it, or leave it out";
      } catch (e) { r.why = r.target ? r.why : "Couldn't read it (" + (e.code || e.message || "error").toString().slice(0, 60) + ") - choose the booking"; }
      r.state = isDup(r) ? "dup" : "done"; draw();
    }
    const fresh2 = rows.filter((r) => r.target === "new").length, pdocs = rows.filter((r) => r.target?.startsWith("doc:")).length, matched = rows.filter((r) => r.target && r.target !== "new").length - pdocs, none = rows.length - matched - fresh2 - pdocs;
    setStatus(`${rows.length} file${rows.length > 1 ? "s" : ""} · ${matched} matched${pdocs ? ` · ${pdocs} travel document${pdocs > 1 ? "s" : ""} for the profiles` : ""}${fresh2 ? ` · ${fresh2} not in the itinerary yet (bookings will be created)` : ""}${rows.some((r) => r.out && r.target === "new") ? ` · ${rows.filter((r) => r.out && r.target === "new").length} outside the trip dates - tick to add` : ""}${none ? ` · ${none} to choose` : ""}${rows.some((r) => r.target === "new" && r.ai && !r.who?.length) ? ` · ${rows.filter((r) => r.target === "new" && r.ai && !r.who?.length).length} need travellers chosen` : ""}${rows.some((r) => r.changes?.length) ? ` · ${rows.filter((r) => r.changes?.length).length} with changed details - choose which to use` : ""}`);
  };
  m.querySelector("[data-bfiles]").onchange = (ev) => pick(ev.target.files);
  m.querySelector("[data-bfolder]").onchange = (ev) => pick(ev.target.files);
}

// ------------------------------------------------------------------ recommendations
// Every stay location gets the best-rated things to do and places to eat from Google (Places API).
// Results are cached on the trip (so the family sees them too); a new or changed location is looked up automatically.
// ---------------------------------------------------------------- weather (Open-Meteo: free, no key; CC BY 4.0)
// Forecast for where you're staying, up to 16 days ahead; past trip days (up to ~3 months back) show what the weather was.
const WX_TTL = 3 * 3600e3;
const wx = { geo: {}, fc: {}, busy: new Set(), failed: new Set() };
try { Object.assign(wx, JSON.parse(localStorage.getItem("tp.wx") || "{}"), { busy: new Set(), failed: new Set() }); } catch (e) { /* ignore */ }
const wxSave = () => { try { localStorage.setItem("tp.wx", JSON.stringify({ geo: wx.geo, fc: wx.fc })); } catch (e) { /* ignore */ } };
let wxUnit = "C"; try { wxUnit = localStorage.getItem("tp.wxUnit") || (/^en-US/.test(navigator.language) ? "F" : "C"); } catch (e) { /* ignore */ }
const WMO = (c) => c === 0 ? ["wsun", "Sunny", "sun"] : c <= 2 ? ["wpart", c === 1 ? "Mostly Sunny" : "Partly Cloudy", "sun"] : c === 3 ? ["wcloud", "Cloudy", "cloud"]
  : c <= 48 ? ["wfog", "Fog", "cloud"] : c <= 57 ? ["wdrizzle", "Drizzle", "rain"] : c <= 67 ? ["wrain", c >= 65 ? "Heavy Rain" : "Rain", "rain"]
  : c <= 77 ? ["wsnow", "Snow", "snow"] : c <= 82 ? ["wrain", "Showers", "rain"] : c <= 86 ? ["wsnow", "Snow Showers", "snow"] : ["wstorm", "Thunderstorms", "storm"];
const wxTemp = (c) => Math.round(wxUnit === "F" ? c * 9 / 5 + 32 : c) + "°";
// where to look up: a day's stay (and the one you left that morning) - the same places as the recommendations
function wxCountry(area) {   // the country at the end of that stay's address helps pick the right "San José"
  const s = store.items.find((i) => i.type === "stay" && recKey(stayArea(i)) === recKey(area));
  return (String(s?.address || "").split(",").map((x) => x.trim()).filter(Boolean).at(-1) || "").replace(/\d+/g, "").trim().toLowerCase();
}
async function wxGeo(loc) {
  if (wx.geo[loc.key]) return wx.geo[loc.key];
  const recs = (store.trip.recs || {})[loc.key], pts = recs ? [...(recs.do || []), ...(recs.eat || [])].filter((x) => x.lat != null) : [];
  if (pts.length >= 3) {   // middle of the recommended places - they're all around the stay
    const mid = (k) => pts.map((x) => x[k]).sort((a, b) => a - b)[pts.length >> 1];
    return (wx.geo[loc.key] = { lat: mid("lat"), lng: mid("lng") });
  }
  const want = wxCountry(loc.area), alias = { usa: "united states", us: "united states", "united states of america": "united states", méxico: "mexico", nz: "new zealand", uk: "united kingdom" };
  const cn = alias[want] || want;
  for (const name of [loc.area, loc.area.split(/[,(]/)[0].trim()].filter((v, k, a) => v && a.indexOf(v) === k)) {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`).then((x) => x.json());
    const list = r.results || [];
    const hit = list.find((x) => cn && (String(x.country || "").toLowerCase() === cn || String(x.country_code || "").toLowerCase() === cn)) || (!cn || cn.length < 3 ? list[0] : null) || list[0];
    if (hit) return (wx.geo[loc.key] = { lat: hit.latitude, lng: hit.longitude });
  }
  return null;
}
async function wxFetch(loc) {
  wx.busy.add(loc.key);
  try {
    const g = await wxGeo(loc); if (!g) throw new Error("place not found");
    const back = Math.max(0, Math.min(92, dayDiff(store.trip.start, iso(new Date()))));
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat.toFixed(3)}&longitude=${g.lng.toFixed(3)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&past_days=${back}&forecast_days=16`).then((x) => x.json());
    if (!r.daily?.time) throw new Error(r.reason || "no forecast");
    const d = r.daily, days = {};
    d.time.forEach((t, k) => { if (d.weather_code[k] != null) days[t] = [d.weather_code[k], d.temperature_2m_max[k], d.temperature_2m_min[k], d.precipitation_probability_max?.[k] ?? null]; });
    wx.fc[loc.key] = { at: Date.now(), days }; wxSave();
  } catch (e) { console.warn("weather", loc.area, e); wx.failed.add(loc.key); }
  finally { wx.busy.delete(loc.key); if (ui.day) { const y = scrollY; render(); scrollTo(0, y); } }
}
function wxStrip(p, date) {
  const today = iso(new Date()), ahead = dayDiff(today, date);
  if (ahead < -92) return "";
  const locs = dayLocations(p, date).reverse(); if (!locs.length) return "";   // moving day: where you woke up → where you sleep
  if (ahead > 15) return `<div class="wx muted small"><i class="wxi">${I.wpart}</i>Forecast from ${fmtDate(iso(new Date(D(date).getTime() - 15 * 864e5)))}</div>`;
  const chips = locs.map((loc) => {
    const fc = wx.fc[loc.key], fresh = fc && Date.now() - fc.at < WX_TTL && (fc.days[date] || ahead < 0);
    if (!fresh && !wx.busy.has(loc.key) && !wx.failed.has(loc.key)) setTimeout(() => wxFetch(loc), 0);
    const d = fc?.days[date];
    if (!d) return wx.failed.has(loc.key) || (fc && fresh) ? "" : `<span class="wxc muted small">${esc(loc.area)} · loading weather…</span>`;
    const [icon, label, tone] = WMO(d[0]);
    const rain = d[3] != null && d[3] >= 20 && ahead >= 0 ? `<i class="wxdrop">${I.drop}</i>${d[3]}%` : "", two = locs.length > 1;
    return `<button class="wxc" data-wxunit title="${esc(loc.area)}: ${label}${rain ? ", " + d[3] + "% chance of rain" : ""} - tap for °${wxUnit === "C" ? "F" : "C"}"><i class="wxi wx-${tone}">${I[icon]}</i>
      <span class="wxt"><b>${wxTemp(d[1])}</b><span class="muted">/${wxTemp(d[2])}</span></span>
      <span class="wxl">${two ? `<span class="muted">${esc(loc.area)}</span>` : `${label}${rain ? " · " + rain : ""}<span class="muted"> · ${esc(loc.area)}</span>`}</span></button>`;
  }).filter(Boolean);
  return chips.length ? `<div class="wx${locs.length > 1 ? " two" : ""}">${chips.join(locs.length > 1 ? `<span class="wxarrow muted">→</span>` : "")}<a class="wxsrc muted" href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a></div>` : "";
}

const REC_V = 2;   // v2 adds coordinates for the map
const recKey = (area) => area.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
const stayArea = (s) => areaOf(s) || s.short || s.name || "";
function recLocations() {
  const m = new Map();
  store.items.filter((i) => i.type === "stay" && stayArea(i)).forEach((s) => { const area = stayArea(s), key = recKey(area); if (!m.has(key)) m.set(key, { key, area, near: s.address || s.name }); });
  return [...m.values()];
}
function dayLocations(p, date) {
  const st = itemsFor(p).filter((i) => i.type === "stay" && i.start <= date && date <= i.end && stayArea(i));
  const night = st.find((i) => i.start <= date && date < i.end), left = st.find((i) => i.end === date && i !== night);
  const out = []; [night, left].filter(Boolean).forEach((s) => { const k = recKey(stayArea(s)); if (!out.some((o) => o.key === k)) out.push({ key: k, area: stayArea(s) }); });
  if (!out.length) {   // travel day or no hotel booked yet: use the closest stay (this traveller's first, then anyone's)
    const near = (list) => list.filter((i) => i.type === "stay" && stayArea(i)).sort((a, b) => dist(a) - dist(b))[0];
    const dist = (i) => (date < i.start ? dayDiff(date, i.start) : date > i.end ? dayDiff(i.end, date) : 0);
    const s = near(itemsFor(p)) || near(store.items);
    if (s) out.push({ key: recKey(stayArea(s)), area: stayArea(s) });
  }
  return out;
}
const recState = { busy: new Set(), tried: new Set(), error: "" };
const recScore = (x) => (x.rating * x.count + 4.2 * 150) / (x.count + 150);
const tidy = (list) => list.filter((x) => x.rating && x.count >= 15).sort((a, b) => recScore(b) - recScore(a)).slice(0, 20)
  .map(({ id, name, rating, count, address, type, url, lat, lng }) => ({ id, name, rating, count, address, type, url, lat, lng }));
async function fetchRecs(loc) {
  recState.busy.add(loc.key); recState.tried.add(loc.key); if (ui.day) render();
  try {
    const timeout = new Promise((_, bad) => setTimeout(() => bad(new Error("Google took too long to answer - try ↻ again")), 25000));
    const [todo, eat] = await Promise.race([Promise.all([searchPlaces(`top things to do in ${loc.area}`, loc.near), searchPlaces(`best restaurants in ${loc.area}`, loc.near)]), timeout]);
    await data.saveRecs(loc.key, { v: REC_V, area: loc.area, fetchedAt: new Date().toISOString(), do: tidy(todo), eat: tidy(eat) });
    recState.error = "";
  } catch (e) {
    console.warn("recs", e);
    recState.error = /not (been )?(used|enabled)|PERMISSION|403|ApiNotActivated|REQUEST_DENIED/i.test(String(e.message || e)) ? "Google Places isn't switched on for the Maps key yet. (Google said: " + String(e.message || e).slice(0, 160) + ")" : "Couldn't get recommendations: " + (e.message || e);
  } finally { recState.busy.delete(loc.key); if (ui.day) render(); }
}
let recQueue = Promise.resolve();
function ensureRecs() {
  if (!isEditor() || !store.trip || !mapsReady() || recState.error) return;
  const have = store.trip.recs || {};
  recLocations().filter((l) => (!have[l.key] || have[l.key].v !== REC_V) && !recState.tried.has(l.key) && !recState.busy.has(l.key))
    .forEach((l) => { recState.tried.add(l.key); recQueue = recQueue.then(() => fetchRecs(l)); });
}
// ---------------------------------------------------------------- travel times between the day's stops (on demand, Routes API)
const ROUTE_KEY = (p, date) => `${date}_${p}`;
const actSig = (acts) => acts.map((e) => [e.id, e.place || "", timeIn(e.text) || timeIn(e.time), e.routeSkip ? 1 : 0, e.geo ? 1 : 0].join("~")).join("|");
const fmtDur = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}`; };
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
// activities in the order chosen with "Use this order" (if any), otherwise as they are
function sortActs(acts, date) {
  if (!acts.some((e) => e.seq?.[date] != null)) return acts;
  return acts.slice().sort((a, b) => (a.seq?.[date] ?? 999) - (b.seq?.[date] ?? 999));
}
function dayStays(p, date) {
  const st = itemsFor(p).filter((i) => i.type === "stay");
  return { morning: st.find((i) => i.start < date && date <= i.end), night: st.find((i) => i.start <= date && date < i.end) };
}
function routePanel(p, date, acts) {
  const r = store.trip?.routes?.[ROUTE_KEY(p, date)];
  if (!acts.length) return "";
  if (!r) return isEditor() ? `<div class="rplan"><button class="btn small" data-route-plan>${I.route}Plan Route</button><span class="muted small">Travel times between today's stops and the best order to visit them</span></div>` : "";
  const stale = r.sig !== actSig(acts);
  const leg = (l) => `<li class="rleg ${l.mode}"><i>${l.mode === "walk" ? I.walk : ICON.car}</i>${fmtDur(l.sec)} · ${fmtDist(l.m)}</li>`;
  const stop = (x, cls) => `<li class="rstop ${cls || ""}"><b>${esc(x.name)}</b>${x.time ? `<span class="rtime">${esc(x.time)}</span>` : ""}${x.match && x.match !== x.name ? `<small class="muted">${esc(x.match)}</small>` : ""}</li>`;
  const pts = [r.from && { ...r.from, hotel: 1 }, ...r.stops, r.to && { ...r.to, hotel: 1 }].filter(Boolean);
  const drive = r.legs.filter((l) => l.mode === "drive"), walk = r.legs.filter((l) => l.mode === "walk"), sum = (a, k) => a.reduce((x, l) => x + l[k], 0);
  const cur = sortActs(acts, date).filter((e) => r.stops.some((x) => x.id === e.id)).map((e) => e.id).join(), sugg = r.stops.map((x) => x.id).join();
  const gm = `https://www.google.com/maps/dir/?api=1&origin=${pts[0].lat},${pts[0].lng}&destination=${pts.at(-1).lat},${pts.at(-1).lng}${pts.length > 2 ? "&waypoints=" + pts.slice(1, -1).slice(0, 9).map((x) => `${x.lat},${x.lng}`).join("|") : ""}&travelmode=${walk.length && !drive.length ? "walking" : "driving"}`;
  return `<div class="route${stale ? " stale" : ""}">
    <div class="rhead2"><b>${I.route}Route</b><span class="muted small">${drive.length ? `${ICON.car}${fmtDur(sum(drive, "sec"))} · ${fmtDist(sum(drive, "m"))}` : ""}${drive.length && walk.length ? " &nbsp; " : ""}${walk.length ? `${I.walk}${fmtDur(sum(walk, "sec"))} · ${fmtDist(sum(walk, "m"))}` : ""}</span></div>
    ${stale ? `<p class="jwarn small">The activities changed since this was worked out${isEditor() ? " - tap Recalculate" : ""}.</p>` : ""}
    <ol class="rlist">${pts.map((x, k) => (k ? leg(r.legs[k - 1] || { mode: "drive", sec: 0, m: 0 }) : "") + stop(x, x.hotel ? "hotel" : "")).join("")}</ol>
    ${(r.warn || []).map((w) => `<p class="jwarn small">${I.warn}${esc(w)}</p>`).join("")}
    ${r.skipped?.length ? `<p class="muted small">Not included: ${r.skipped.map((x) => `${esc(x.name)}${isEditor() ? ` <button class="lnk" data-route-unskip="${esc(x.id)}">include</button>` : ""}`).join(", ")}</p>` : ""}
    <div class="ractions">${isEditor() && !stale && cur !== sugg ? `<button class="btn small primary" data-route-apply>Use This Order</button>` : ""}
      <a class="btn small" href="${esc(gm)}" target="_blank" rel="noopener">Open in Google Maps</a>
      ${isEditor() ? `<span class="seg-mini rmode">${[["auto", "Auto"], ["walk", "Walk"], ["drive", "Drive"]].map(([v, l]) => `<button type="button" class="${(r.mode || "auto") === v ? "on" : ""}" data-route-mode="${v}">${l}</button>`).join("")}</span>
        <button class="btn small" data-route-plan>Recalculate</button>` : ""}</div>
    <p class="muted small">${r.optimised ? "Best order worked out by Google Maps" : r.fixed ? "Kept around the booked times" : "In the order planned"} · ${r.mode === "walk" ? "walking" : r.mode === "drive" ? "driving" : "walk under 1.5 km, otherwise drive"} · updated ${when(r.at)}</p>
  </div>`;
}
// Ask about places that are vague (a whole town, far away, or not found): pick a match, search again, or leave the activity out
function confirmPlaces(list, near) {
  return new Promise((done) => {
    let settled = false; const finish = (v) => { if (!settled) { settled = true; done(v); } };
    const opts = (x) => `${x.cands.map((c, k) => `<label class="pcand"><input type="radio" name="pl_${x.e.id}" value="${k}" ${k === 0 && !x.why.startsWith("Nothing") ? "checked" : ""}><span><b>${esc(c.name)}</b><small class="muted">${esc(c.address)}${c.km != null ? ` · ${c.km} km from the hotel` : ""}</small></span></label>`).join("")}
      <label class="pcand"><input type="radio" name="pl_${x.e.id}" value="skip" ${x.why.startsWith("Nothing") ? "checked" : ""}><span><b>Leave this activity out</b><small class="muted">It won't be part of the route</small></span></label>`;
    modal(`<h2>Check These Places</h2><p class="muted small">These activities don't have a clear location. Pick the right place, search for it, or leave the activity out of the route. Your choice is remembered.</p>
      ${list.map((x) => `<fieldset class="pconf" data-pc="${esc(x.e.id)}"><legend>${esc(firstText(x.e.text))}</legend><p class="small pwhy">${esc(x.why)}</p>
        <div class="pcands">${opts(x)}</div>
        <div class="psearch"><input type="text" placeholder="Search for the place…" value="${esc(x.e.place || firstText(x.e.text))}" data-pq><button type="button" class="btn small" data-ps>Search</button></div></fieldset>`).join("")}`,
      async (fd) => { const out = {}; list.forEach((x) => { const v = fd.get("pl_" + x.e.id); out[x.e.id] = v === "skip" || v == null ? "skip" : x.cands[+v]; }); finish(out); });
    const m = document.querySelector(".modal:last-of-type"); m.querySelector("button.primary").textContent = "Continue";
    m.querySelector("[data-cancel]").addEventListener("click", () => finish(null)); m.addEventListener("click", (e) => { if (e.target === m) finish(null); });
    m.querySelectorAll("fieldset[data-pc]").forEach((fs) => { const x = list.find((y) => y.e.id === fs.dataset.pc), q = fs.querySelector("[data-pq]");
      const go = async () => { const b = fs.querySelector("[data-ps]"); b.disabled = true; b.textContent = "Searching…";
        try { x.cands = await findPlace(q.value.trim(), near); x.why = x.cands.length ? "Pick the right one:" : "Nothing found - try another search, or leave it out"; }
        catch (e) { toast(e.message); }
        fs.querySelector(".pwhy").textContent = x.why; fs.querySelector(".pcands").innerHTML = opts(x); b.disabled = false; b.textContent = "Search"; };
      fs.querySelector("[data-ps]").onclick = go; q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } }; });
  });
}
async function planRoute(p, date, acts, mode) {
  mode ||= store.trip?.routes?.[ROUTE_KEY(p, date)]?.mode || "auto";
  const { morning, night } = dayStays(p, date);
  const hotelPos = async (s) => { if (!s) return null; const g = await geocodeText(s.address || s.name).catch(() => null); return g && { name: s.short || s.name, lat: g.lat, lng: g.lng }; };
  toast("Looking up today's places…");
  const from = await hotelPos(morning || night), to = night && night !== morning ? await hotelPos(night) : from;
  const near = (to || from) && { lat: (to || from).lat, lng: (to || from).lng };
  const stops = [], skipped = [], vague = [];
  for (const e of acts) {
    if (e.routeSkip) { skipped.push({ id: e.id, name: firstText(e.text) }); continue; }
    if (e.geo) { stops.push({ e, at: e.geo }); continue; }
    const q = e.place || firstText(e.text);
    let cands = []; try { cands = await findPlace(q, near); } catch (x) { throw x; }
    const top = cands[0];
    const why = !top ? `Nothing found for "${q}"` : !e.place ? `No place entered - is it ${top.name}?` : top.broad ? `"${q}" is a whole area, not a specific place` : top.km != null && top.km > 40 ? `${top.name} is ${top.km} km from the hotel` : "";
    if (why) vague.push({ e, cands, why }); else { stops.push({ e, at: top }); await data.saveEntry({ ...e, geo: { lat: top.lat, lng: top.lng, name: top.name, address: top.address } }).catch(() => {}); }
  }
  if (vague.length) {
    const ans = await confirmPlaces(vague, near); if (!ans) return;
    for (const x of vague) { const a = ans[x.e.id];
      if (a === "skip") { skipped.push({ id: x.e.id, name: firstText(x.e.text) }); await data.saveEntry({ ...x.e, routeSkip: true }); }
      else { const geo = { lat: a.lat, lng: a.lng, name: a.name, address: a.address }; stops.push({ e: x.e, at: geo }); await data.saveEntry({ ...x.e, geo }); } }
  }
  if (!stops.length) return toast("No activities with a place to route");
  // keep booked times in their order; fit the others in where they add the least distance
  const timeOf = (e) => timeIn(e.text) || timeIn(e.time);
  const order0 = acts.map((e) => e.id), ord = (a, b) => order0.indexOf(a.e.id) - order0.indexOf(b.e.id);
  stops.sort(ord);
  const timed = stops.filter((x) => timeOf(x.e)).sort((a, b) => timeOf(a.e).localeCompare(timeOf(b.e))), free = stops.filter((x) => !timeOf(x.e));
  let seq, optimise = false;
  const start = from || null, end = to || null;
  if (!timed.length) { seq = free; optimise = free.length >= 2 && !!start && !!end; }
  else { seq = timed.slice();
    for (const x of free) { let best = 0, cost = Infinity;
      for (let k = 0; k <= seq.length; k++) { const a = k ? seq[k - 1].at : start, b = k < seq.length ? seq[k].at : end;
        // not before an early-morning booking, nor after an evening one
        const prevT = seq.slice(0, k).map((y) => timeOf(y.e)).filter(Boolean).at(-1), nextT = seq.slice(k).map((y) => timeOf(y.e)).find(Boolean);
        const pen = (nextT && nextT < "10:00" ? 1e4 : 0) + (prevT && prevT >= "19:00" ? 1e4 : 0);
        const c = pen + (a ? distanceKm(a, x.at) : 0) + (b ? distanceKm(x.at, b) : 0) - (a && b ? distanceKm(a, b) : 0); if (c < cost) { cost = c; best = k; } }
      seq.splice(best, 0, x); } }
  const pts = [start, ...seq.map((x) => x.at), end].filter(Boolean);
  if (pts.length < 2) return toast("Need at least two places to work out travel times");
  toast("Working out travel times…");
  const first = await computeRoute(pts, mode === "walk" ? "WALK" : "DRIVE", optimise);
  if (first.order) { seq = first.order.map((k) => seq[k]); }
  const pts2 = [start, ...seq.map((x) => x.at), end].filter(Boolean);
  let legs = first.legs.map((l) => ({ ...l, mode: mode === "walk" ? "walk" : "drive" }));
  if (mode === "auto" && legs.some((l) => l.m < 2500)) {   // short hops on foot
    try { const w = await computeRoute(pts2, "WALK", false); legs = legs.map((l, k) => (w.legs[k] && w.legs[k].m <= 1500 ? { ...w.legs[k], mode: "walk" } : l)); } catch (x) { console.warn("walk legs", x); }
  }
  // tight connections between booked times
  const warn = [], idx = (x) => (start ? 1 : 0) + seq.indexOf(x);
  for (let k = 1; k < seq.length; k++) { const b = seq[k]; if (!timeOf(b.e)) continue;
    let j = k - 1; while (j >= 0 && !timeOf(seq[j].e)) j--; if (j < 0) continue; const a = seq[j];
    const travel = legs.slice(idx(a), idx(b)).reduce((t, l) => t + l.sec, 0), [h1, m1] = timeOf(a.e).split(":").map(Number), [h2, m2] = timeOf(b.e).split(":").map(Number);
    const gap = (h2 * 60 + m2) - (h1 * 60 + m1);
    if (travel / 60 > gap - 15) warn.push(`Tight: ${fmtDur(travel)} of travel between ${firstText(a.e.text)} (${timeOf(a.e)}) and ${firstText(b.e.text)} (${timeOf(b.e)})`); }
  const res = { at: new Date().toISOString(), mode, optimised: !!first.order, fixed: timed.length > 0, sig: "",
    from: start || null, to: end || null, stops: seq.map((x) => ({ id: x.e.id, name: firstText(x.e.text), match: x.at.name || "", time: timeOf(x.e), lat: x.at.lat, lng: x.at.lng })),
    legs: legs.map((l) => ({ mode: l.mode, sec: l.sec, m: l.m })), skipped, warn };
  const fresh = store.entries.filter((e) => acts.some((a) => a.id === e.id));   // after saving places / skips
  res.sig = actSig(acts.map((a) => fresh.find((e) => e.id === a.id) || a));
  await data.saveTrip({ routes: { ...(store.trip.routes || {}), [ROUTE_KEY(p, date)]: res } }, ui.tripId);
  toast(first.order ? "Route ready - best order worked out" : "Route ready");
}
function wireRoute(p, date, acts) {
  const keep = () => { const y = scrollY; render(); scrollTo(0, y); };
  const run = async (mode) => { const bs = root.querySelectorAll("[data-route-plan]"); bs.forEach((b) => (b.disabled = true));
    try { await planRoute(p, date, acts, mode); } catch (e) { toast(e.message || "Couldn't work out the route"); bs.forEach((b) => (b.disabled = false)); } keep(); };
  root.querySelectorAll("[data-route-plan]").forEach((b) => (b.onclick = () => (mapsReady() ? run() : toast("Needs the Google Maps key"))));
  root.querySelectorAll("[data-route-mode]").forEach((b) => (b.onclick = () => run(b.dataset.routeMode)));
  root.querySelectorAll("[data-route-unskip]").forEach((b) => (b.onclick = async () => { const e = store.entries.find((x) => x.id === b.dataset.routeUnskip);
    if (e) { const { routeSkip, ...rest } = e; await data.saveEntry(rest); run(); } }));
  root.querySelector("[data-route-apply]")?.addEventListener("click", async () => {
    const r = store.trip.routes[ROUTE_KEY(p, date)], ids = r.stops.map((x) => x.id), rest = sortActs(acts, date).filter((e) => !ids.includes(e.id)).map((e) => e.id);
    const all = ids.concat(rest);
    for (const e of acts) { const n = all.indexOf(e.id); if (e.seq?.[date] !== n) await data.saveEntry({ ...e, seq: { ...(e.seq || {}), [date]: n } }); }
    const fresh = store.entries.filter((e) => acts.some((a) => a.id === e.id));
    await data.saveTrip({ routes: { ...(store.trip.routes || {}), [ROUTE_KEY(p, date)]: { ...r, sig: actSig(acts.map((a) => fresh.find((e) => e.id === a.id) || a)) } } }, ui.tripId);
    toast("Activities reordered"); keep();
  });
}

// ---- family votes: 👍 on recommended places and ideas, as the traveller whose itinerary is showing
const votesFor = (key) => store.votes?.[key]?.up || [];
const voter = () => (ui.voter && ALL_CODES().includes(ui.voter) ? ui.voter : ui.person);   // anyone on the trip, incl. others joining
function voteBtn(key, name, kind) {
  const up = votesFor(key), me = voter(), mine = up.includes(me);
  return `<span class="vote"><button type="button" class="vbtn${mine ? " on" : ""}" data-vote="${esc(key)}" data-vname="${esc(name)}" data-vkind="${kind}" aria-pressed="${mine}"
      title="${mine ? `Remove ${esc(NAME(me))}'s vote` : `I'd like to do this (vote as ${esc(NAME(me))})`}" aria-label="${up.length} vote${up.length === 1 ? "" : "s"}${mine ? ", including yours" : ""} - ${mine ? "remove your vote" : "vote"}">${I.thumb}${up.length ? `<b>${up.length}</b>` : ""}</button>
    ${up.length ? `<span class="idots" role="img" aria-label="${esc(up.map(NAME).join(", "))}">${up.map((c) => `<i class="tdot" style="--pc:${pcolor(c)}" title="${esc(NAME(c))}"></i>`).join("")}</span>` : ""}</span>`;
}
function wireVotes() {
  const me = voter();
  root.querySelectorAll("[data-voter]").forEach((b) => (b.onclick = () => { ui.voter = b.dataset.voter; const y = scrollY; render(); scrollTo(0, y); }));
  root.querySelectorAll("[data-vote]").forEach((b) => (b.onclick = async (ev) => {
    ev.stopPropagation(); const key = b.dataset.vote, on = !votesFor(key).includes(me);
    b.disabled = true;
    try { await data.setVote(key, { name: b.dataset.vname, kind: b.dataset.vkind }, me, on); }
    catch (e) { b.disabled = false; toast(e.code === "permission-denied" ? "Voting needs the new Firestore rules (votes section)." : "Couldn't save the vote: " + (e.code || e.message)); }
  }));
}
function recsHtml(p, date, notesHtml) {
  const locs = dayLocations(p, date);
  if (!locs.length && !notesHtml) return "";
  if (!locs.some((l) => l.key === ui.recLoc)) ui.recLoc = locs[0]?.key;
  const loc = locs.find((l) => l.key === ui.recLoc), rec = loc && (store.trip.recs || {})[loc.key];
  const tab = ui.recTab || "do", list = rec ? rec[tab] || [] : [];
  const added = (x) => store.entries.some((e) => e.kind === "activity" && e.date <= date && date <= (e.endDate || e.date) && (e.text === x.name || String(e.place || "").startsWith(x.name)));
  const ranked = list.map((x, i) => [x, i]).sort((a, b) => votesFor("g_" + b[0].id).length - votesFor("g_" + a[0].id).length || a[1] - b[1]).map((a) => a[0]);   // family favourites first
  const shown = ui.recMore ? ranked : ranked.slice(0, 5);
  const row = (x, i) => `<li class="rec">
      <span class="rnum">${i + 1}</span>
      <div class="rmain"><a class="rname" href="${esc(x.url || maps(x.name + " " + x.address))}" target="_blank" rel="noopener">${esc(x.name)}</a>
        <div class="rsub"><span class="rstar">★ ${x.rating.toFixed(1)}</span><span class="muted">(${x.count.toLocaleString("en-AU")})</span>${x.type ? `<span class="muted">· ${esc(x.type)}</span>` : ""}</div></div>
      ${voteBtn("g_" + x.id, x.name, tab)}
      ${isEditor() ? (added(x) ? `<span class="radded">✓ In plan</span>` : `<button class="btn tiny" data-rec-add="${esc(x.id)}">+ Plan</button>`) : ""}</li>`;
  const busy = loc && recState.busy.has(loc.key);
  const anyBusy = locs.some((l) => recState.busy.has(l.key));
  return `<section class="recs"><h3 class="rhead"><span>Recommended${loc ? ` <span class="muted small">near ${esc(loc.area)}</span>` : ""}</span>
      ${isEditor() && locs.length ? `<button class="iconbtn rrefresh${anyBusy ? " spin" : ""}" data-rec-refresh ${anyBusy ? "disabled" : ""} aria-label="Search Google again for things to do and places to eat" title="Search again for things to do and places to eat">↻</button>` : ""}</h3>
    ${locs.length > 1 ? `<div class="seg-mini rlocs">${locs.map((l) => `<button class="${l.key === ui.recLoc ? "on" : ""}" data-rec-loc="${l.key}">${esc(l.area)}</button>`).join("")}</div>` : ""}
    ${notesHtml ? `<p class="rlabel">From Our Notes</p><ul class="entries">${notesHtml}</ul>` : ""}
    ${loc || notesHtml ? `<div class="vhint small"><span class="muted">${I.thumb}Vote for the places you'd like to go - the family's favourites move to the top. Voting as:</span>
      <span class="ddots">${ALL_CODES().map((c) => `<button type="button" class="dd${c === voter() ? " on" : ""}" data-voter="${esc(c)}" style="--pc:${pcolor(c)}" aria-pressed="${c === voter()}" title="${esc(NAME(c))}">${ddIn(c)}</button>`).join("")}</span></div>${store.votesError && isEditor() ? `<p class="jwarn small">${esc(store.votesError)}</p>` : ""}` : ""}
    ${loc ? `<div class="seg-mini rtabs"><button class="${tab === "do" ? "on" : ""}" data-rec-tab="do">Things to Do</button><button class="${tab === "eat" ? "on" : ""}" data-rec-tab="eat">Places to Eat</button></div>
      ${list.length ? `<ol class="reclist">${shown.map(row).join("")}</ol>
        ${list.length > 5 ? `<button class="lnk" data-rec-more>${ui.recMore ? "Show top 5" : `Show all ${list.length}`}</button>` : ""}`
      : `<p class="muted small">${busy ? "Finding the best-rated places…" : rec ? "Nothing found for this location." : isEditor() ? (recState.error || (mapsReady() ? "Looking these up…" : "Needs the Google Maps key.")) : "Recommendations will appear once Cesar or Debora opens the app."}</p>`}
      <p class="rfoot muted small">${busy && rec ? "Updating… · " : ""}${rec ? `Google ratings · updated ${shortDate(iso(new Date(rec.fetchedAt)))}` : ""}</p>
      ${isEditor() && recState.error && rec ? `<p class="jwarn small">${esc(recState.error)}</p>` : ""}` : ""}
  </section>`;
}
function wireRecs(p, date, others) {
  const sec = root.querySelector("section.recs"); if (!sec) return;
  const keep = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };
  sec.querySelectorAll("[data-rec-loc]").forEach((b) => (b.onclick = () => { ui.recLoc = b.dataset.recLoc; ui.recMore = false; keep(); }));
  sec.querySelectorAll("[data-rec-tab]").forEach((b) => (b.onclick = () => { ui.recTab = b.dataset.recTab; ui.recMore = false; keep(); }));
  sec.querySelector("[data-rec-more]")?.addEventListener("click", () => { ui.recMore = !ui.recMore; keep(); });
  sec.querySelector("[data-rec-refresh]")?.addEventListener("click", () => {
    if (!mapsReady()) return toast("Needs the Google Maps key");
    recState.error = ""; recState.tried.clear();
    const keys = dayLocations(p, date).map((l) => l.key), all = recLocations();
    all.filter((l) => keys.includes(l.key) && !recState.busy.has(l.key)).forEach((l) => { recState.busy.add(l.key); recQueue = recQueue.then(() => fetchRecs(l)); });
    toast("Searching Google…"); keep(); setTimeout(ensureRecs, 0);   // also picks up any other new locations
  });
  sec.querySelectorAll("[data-rec-add]").forEach((b) => (b.onclick = async () => {
    const rec = store.trip.recs?.[ui.recLoc], x = rec && (rec[ui.recTab || "do"] || []).find((r) => r.id === b.dataset.recAdd); if (!x) return;
    b.disabled = true;
    try { await data.saveEntry({ kind: "activity", status: "planned", confirmed: false, date, endDate: date, text: x.name, place: [x.name, x.address].filter(Boolean).join(", "),
      who: [p, ...others.filter((o) => together(p, o, date))] }); toast(`${x.name} added to the plan`); }
    catch (e) { b.disabled = false; toast("Couldn't add: " + (e.code || e.message)); }
  }));
}

// ------------------------------------------------------------------ journal
// The family can read and write here (and only here): comments, a discussion thread and activity ratings, per day.
const DEVICE = (() => { try { let d = localStorage.getItem("tp.device"); if (!d) { d = Math.random().toString(36).slice(2, 10); localStorage.setItem("tp.device", d); } return d; } catch { return "nodevice"; } })();
const jStore = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ""; localStorage.setItem(k, v); } catch {} return ""; };
const jui = { draft: {}, reply: null, edit: null, rate: {}, focus: null, photos: {}, drop: {} };   // photos: new ones waiting to upload; drop: existing ones to remove
const MAX_PHOTOS = 10;
// shrink a photo in the browser before upload: ~2560 px for the printed album and the full view, ~480 px for the journal grid
async function shrinkPhoto(file) {
  let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) { bmp = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(new Error("This photo format can't be opened here - try a JPEG or PNG")); im.src = URL.createObjectURL(file); }); }
  const W = bmp.width, H = bmp.height;
  const out = (max, q) => { const k = Math.min(1, max / Math.max(W, H)), c = document.createElement("canvas"); c.width = Math.round(W * k); c.height = Math.round(H * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((ok) => c.toBlob((b) => ok({ blob: b, w: c.width, h: c.height }), "image/jpeg", q)); };
  const full = await out(2560, 0.88), thumb = await out(480, 0.75);   // 2560 px prints sharp on a full A4 page
  return { full: full.blob, thumb: thumb.blob, w: full.w, h: full.h, preview: URL.createObjectURL(thumb.blob) };
}
function photoGrid(photos, postId) {
  if (!photos?.length) return "";
  return `<div class="jphotos n${Math.min(photos.length, 4)}">${photos.map((ph, k) => `<button type="button" class="jph" data-jphoto="${esc(postId)}" data-k="${k}" aria-label="Open photo ${k + 1} of ${photos.length}">
    <img src="${esc(ph.turl || ph.url)}" alt="" loading="lazy" decoding="async"></button>`).join("")}</div>`;
}
// full-screen photo viewer: swipe or arrows for the next one
function lightbox(photos, start) {
  let k = start; const box = document.createElement("div"); box.className = "lightbox"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Photo");
  const draw = () => { box.innerHTML = `<img src="${esc(photos[k].url)}" alt="">
    <div class="lb-bar"><span>${k + 1} / ${photos.length}</span><a class="lb-btn" href="${esc(photos[k].url)}" target="_blank" rel="noopener" download>Open</a><button class="lb-btn" data-lbx aria-label="Close">✕</button></div>
    ${photos.length > 1 ? `<button class="lb-nav prev" data-lbn="-1" aria-label="Previous">‹</button><button class="lb-nav next" data-lbn="1" aria-label="Next">›</button>` : ""}`;
    box.querySelector("[data-lbx]").onclick = close; box.querySelectorAll("[data-lbn]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); go(+b.dataset.lbn); })); };
  const go = (d) => { k = (k + d + photos.length) % photos.length; draw(); };
  const key = (e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowRight") go(1); else if (e.key === "ArrowLeft") go(-1); };
  const close = () => { box.remove(); document.removeEventListener("keydown", key); };
  let x0 = null; box.addEventListener("touchstart", (e) => (x0 = e.touches[0].clientX), { passive: true });
  box.addEventListener("touchend", (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); });
  box.addEventListener("click", (e) => { if (e.target === box || e.target.tagName === "IMG") close(); });
  document.addEventListener("keydown", key); draw(); document.body.appendChild(box);
}
const STARS = (n, cls = "") => `<span class="stars ${cls}" aria-label="${n} out of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}">★</i>`).join("")}</span>`;
function authors() {
  const t = store.trip || {};
  return (t.travellers || []).concat(t.extended || []).filter((x) => x.name || x.code).map((x) => ({ code: x.code, name: x.name || x.code }));
}
function myAuthor() {
  const saved = jStore("tp.author");
  if (saved) { const a = authors().find((x) => x.code === saved); return a || { code: "", name: saved }; }
  if (isEditor() && store.email) { const local = store.email.split("@")[0].toLowerCase();
    const a = authors().find((x) => x.name && local.includes(x.name.toLowerCase().slice(0, 3))); if (a) return a; }
  return null;
}
const dayActivities = (date) => store.entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && e.date <= date && date <= (e.endDate || e.date))
  .filter((e, i, a) => a.findIndex((x) => x.text === e.text) === i);
function ratingsFor(id) { return (store.journal || []).filter((j) => j.activityId === id && j.rating > 0 && !j.replyTo).map((j) => j.rating); }
function ratingBadge(id) {
  const r = ratingsFor(id); if (!r.length) return "";
  const avg = r.reduce((a, b) => a + b, 0) / r.length;
  return ` <span class="rbadge" title="${r.length} rating${r.length > 1 ? "s" : ""} in the journal">★ ${avg.toFixed(1).replace(/\.0$/, "")}<small>(${r.length})</small></span>`;
}
const canChange = (j) => isEditor() || (j.by === "family" && j.device === DEVICE);
const when = (s) => { if (!s) return ""; const d = new Date(s); return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
function avatar(j) {
  if (j.authorCode && ALL_CODES().includes(j.authorCode)) return avHtml(j.authorCode, "jav");
  const c = j.authorCode && pcolor(j.authorCode);
  const ini = (j.authorCode || (j.author || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3)).toUpperCase();
  return `<span class="javatar" style="${c ? `--pc:${c};color:${inkOn(c)}` : ""}">${esc(ini)}</span>`;
}
function composer(key, { placeholder, withRating, acts, value = "", rating = 0, actId = "", button = "Post", photos = null }) {
  const draft = jui.draft[key] ?? value;
  const keep = (photos || []).filter((ph) => !(jui.drop[key] || []).includes(ph.id)), adding = jui.photos[key] || [];
  const pics = photos ? `<div class="jpicks">${keep.map((ph) => `<span class="jpick"><img src="${esc(ph.turl || ph.url)}" alt=""><button type="button" data-jpdrop="${esc(ph.id)}" aria-label="Remove photo">✕</button></span>`).join("")}
      ${adding.map((ph, k) => `<span class="jpick${ph.busy ? " busy" : ""}">${ph.preview ? `<img src="${ph.preview}" alt="">` : ""}<button type="button" data-jpnew="${k}" aria-label="Remove photo">✕</button></span>`).join("")}
      ${keep.length + adding.length < MAX_PHOTOS ? `<label class="btn tiny jaddph">${I.camera}Add Photos<input type="file" accept="image/*" multiple hidden data-jpfile></label>` : `<span class="muted small">${MAX_PHOTOS} photos max</span>`}</div>` : "";
  const r = jui.rate[key] ?? { rating, actId };
  return `<form class="jcomposer" data-jform="${key}">
    <textarea name="text" rows="${key === "new" ? 3 : 2}" maxlength="4000" placeholder="${placeholder}" data-jkey="${key}">${esc(draft)}</textarea>
    ${withRating && acts.length ? `<div class="jrate"><select name="act" aria-label="Activity to rate"><option value="">Rate an activity (optional)…</option>${acts.map((a) => `<option value="${a.id}" ${a.id === r.actId ? "selected" : ""}>${esc(a.text.replace(/\s*\n[\s\S]*/, "").slice(0, 60))}</option>`).join("")}</select>
      <span class="starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" class="${i <= r.rating ? "on" : ""}" data-star="${i}" aria-label="${i} star${i > 1 ? "s" : ""}">★</button>`).join("")}</span><input type="hidden" name="rating" value="${r.rating}"></div>` : ""}
    ${pics}<div class="jfoot">${key !== "new" ? `<button type="button" class="btn tiny" data-jcancel>Cancel</button>` : ""}<button class="btn small primary">${button}</button></div></form>`;
}
function journalHtml(date) {
  const acts = dayActivities(date);
  const posts = (store.journal || []).filter((j) => j.date === date);
  const top = posts.filter((j) => !j.replyTo).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const replies = (id) => posts.filter((j) => j.replyTo === id).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const me = myAuthor();
  const actName = (id) => { const a = store.entries.find((e) => e.id === id); return a ? a.text.replace(/\s*\n[\s\S]*/, "").slice(0, 60) : "an activity"; };
  const post = (j, isReply) => jui.edit === j.id
    ? `<div class="jpost${isReply ? " reply" : ""}">${composer("edit:" + j.id, { placeholder: "", withRating: !isReply, acts, value: j.text, rating: j.rating || 0, actId: j.activityId || "", button: "Save", photos: isReply ? null : j.photos || [] })}</div>`
    : `<div class="jpost${isReply ? " reply" : ""}">${avatar(j)}<div class="jn-body">
      <div class="jmeta"><b>${esc(j.author || "Someone")}</b><span class="muted small">${when(j.createdAt)}${j.updatedAt && j.createdAt && j.updatedAt.slice(0, 16) !== j.createdAt.slice(0, 16) ? " · edited" : ""}</span></div>
      ${j.activityId && j.rating ? `<div class="jrated">${STARS(j.rating)} <span class="small">${esc(actName(j.activityId))}</span></div>` : ""}
      ${j.text ? `<p class="jtext">${esc(j.text).replace(/\n/g, "<br>")}</p>` : ""}${photoGrid(j.photos, j.id)}
      <div class="jn-acts">${!isReply ? `<button class="lnk" data-jreply="${j.id}">Reply</button>` : ""}${canChange(j) ? `<button class="lnk" data-jedit="${j.id}">Edit</button><button class="lnk danger" data-jdel="${j.id}">Delete</button>` : ""}</div></div></div>`;
  const thread = (j) => `<div class="jthread">${post(j, false)}${replies(j.id).map((r) => post(r, true)).join("")}
      ${jui.reply === j.id ? `<div class="jpost reply">${composer("reply:" + j.id, { placeholder: "Write a reply…", button: "Reply" })}</div>` : ""}</div>`;
  const rated = acts.map((a) => ({ a, r: ratingsFor(a.id) })).filter((x) => x.r.length);
  return `<section class="journal" id="journal"><h3>Journal</h3>
    ${store.journalError ? `<p class="jwarn small">${esc(store.journalError)}</p>` : ""}
    ${rated.length ? `<div class="jsummary">${rated.map(({ a, r }) => { const avg = r.reduce((x, y) => x + y, 0) / r.length;
      return `<div>${STARS(Math.round(avg), "sm")}<b>${avg.toFixed(1).replace(/\.0$/, "")}</b><span class="jsn">${esc(a.text.replace(/\s*\n[\s\S]*/, ""))}</span><span class="muted">${r.length} rating${r.length > 1 ? "s" : ""}</span></div>`; }).join("")}</div>` : ""}
    ${top.length ? top.map(thread).join("") : `<p class="muted">Nothing here yet. Share how the day went, a tip for the others, or rate what you did.</p>`}
    <div class="jnew">
      <div class="jas"><span class="muted small">Posting as</span>
        <select data-jauthor aria-label="Posting as">${me ? "" : `<option value="">Choose…</option>`}${authors().map((a) => `<option value="${esc(a.code)}" ${me && me.code === a.code ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          ${me && !me.code ? `<option value="name:${esc(me.name)}" selected>${esc(me.name)}</option>` : ""}<option value="other">Other…</option></select></div>
      ${composer("new", { placeholder: "How was the day? Share a story, a tip or what you'd do again…", withRating: true, acts, photos: [] })}
    </div></section>`;
}
function wireJournal(date) {
  const sec = root.querySelector("#journal"); if (!sec) return;
  const rerender = () => { const y = window.scrollY; render(); window.scrollTo(0, y); };
  sec.querySelector("[data-jauthor]").onchange = (ev) => {
    let v = ev.target.value;
    if (v === "other") { const n = (prompt("Name (not in Trip Setup):") || "").trim().slice(0, 60); if (!n) return rerender(); v = n; }
    else if (v.startsWith("name:")) v = v.slice(5);
    jStore("tp.author", v); rerender();
  };
  sec.querySelectorAll("textarea[data-jkey]").forEach((ta) => {
    ta.oninput = () => (jui.draft[ta.dataset.jkey] = ta.value);
    ta.onfocus = () => (jui.focus = ta.dataset.jkey);
    ta.onblur = () => setTimeout(() => { if (jui.focus === ta.dataset.jkey && document.activeElement !== ta) jui.focus = null; }, 0);
  });
  // keep typing intact when someone else's post arrives and the screen redraws
  if (jui.focus) { const ta = sec.querySelector(`textarea[data-jkey="${CSS.escape(jui.focus)}"]`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  sec.querySelectorAll("form[data-jform]").forEach((f) => {
    const key = f.dataset.jform, sel = f.querySelector("select[name=act]"), hid = f.querySelector("input[name=rating]");
    const setR = () => (jui.rate[key] = { rating: +(hid?.value || 0), actId: sel?.value || "" });
    if (sel) sel.onchange = () => { setR(); if (sel.value && !+hid.value) f.querySelector(".starpick button")?.focus(); };
    f.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => {
      const n = +b.dataset.star; hid.value = +hid.value === n ? 0 : n;
      f.querySelectorAll("[data-star]").forEach((x) => x.classList.toggle("on", +x.dataset.star <= +hid.value)); setR();
    }));
    f.querySelector("[data-jcancel]")?.addEventListener("click", () => { delete jui.draft[key]; delete jui.rate[key]; delete jui.photos[key]; delete jui.drop[key]; jui.reply = jui.edit = null; jui.focus = null; rerender(); });
    const inp = f.querySelector("[data-jpfile]");
    if (inp) inp.onchange = async () => {
      const list = (jui.photos[key] ||= []), room = MAX_PHOTOS - list.length - ((store.journal.find((j) => "edit:" + j.id === key)?.photos || []).filter((ph) => !(jui.drop[key] || []).includes(ph.id)).length);
      const files = [...inp.files].slice(0, Math.max(0, room)); if (inp.files.length > files.length) toast(`Up to ${MAX_PHOTOS} photos per post`);
      const slots = files.map(() => ({ busy: true })); list.push(...slots); rerender();
      for (let k = 0; k < files.length; k++) {
        try { Object.assign(slots[k], await shrinkPhoto(files[k]), { busy: false }); }
        catch (e) { list.splice(list.indexOf(slots[k]), 1); toast(e.message || "Couldn't open that photo"); }
        rerender();
      }
    };
    f.querySelectorAll("[data-jpnew]").forEach((b) => (b.onclick = () => { jui.photos[key].splice(+b.dataset.jpnew, 1); rerender(); }));
    f.querySelectorAll("[data-jpdrop]").forEach((b) => (b.onclick = () => { (jui.drop[key] ||= []).push(b.dataset.jpdrop); rerender(); }));
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const text = f.text.value.trim(), rating = +(hid?.value || 0), actId = sel?.value || "";
      if (rating && !actId) return toast("Pick which activity you're rating");
      if (actId && !rating) return toast("Tap the stars to rate it");
      const adding = jui.photos[key] || [];
      if (adding.some((ph) => ph.busy)) return toast("Still preparing the photos…");
      if (!text && !rating && !adding.length) return toast("Write something or add a photo first");
      const me = myAuthor();
      if (!me) { toast("Choose who's posting first"); sec.querySelector("[data-jauthor]").focus(); return; }
      const [mode, id] = key.split(":");
      const old = mode === "edit" ? store.journal.find((j) => j.id === id) : null;
      const post = old ? { ...old, text, ...(old.replyTo ? {} : { rating, activityId: actId }) }
        : { id: data.newJournalId(), date, text, author: me.name, authorCode: me.code || "", device: DEVICE, ...(mode === "reply" ? { replyTo: id } : { rating, activityId: actId }) };
      if (!post.activityId) { delete post.activityId; delete post.rating; }
      const btn = f.querySelector("button.primary"); btn.disabled = true;
      try {
        const dropped = (old?.photos || []).filter((ph) => (jui.drop[key] || []).includes(ph.id)), kept = (old?.photos || []).filter((ph) => !dropped.includes(ph));
        const up = [];
        for (let k = 0; k < adding.length; k++) { btn.textContent = `Uploading photo ${k + 1} of ${adding.length}…`; up.push(await data.uploadJournalPhoto(post.id, adding[k].full, adding[k].thumb, adding[k].w, adding[k].h)); }
        if (mode !== "reply") { post.photos = kept.concat(up); if (!post.photos.length) delete post.photos; }
        await data.saveJournal(post); if (dropped.length) data.deleteJournalPhotos(dropped);
        delete jui.draft[key]; delete jui.rate[key]; delete jui.photos[key]; delete jui.drop[key]; jui.reply = jui.edit = null; jui.focus = null; rerender(); toast(old ? "Saved" : "Posted"); }
      catch (x) { btn.disabled = false; btn.textContent = old ? "Save" : mode === "reply" ? "Reply" : "Post";
        toast(x.code === "permission-denied" ? "The journal needs the new Firestore rules published" : x.code === "storage/unauthorized" ? "Photos need the new Storage rules published" : "Couldn't post: " + (x.code || x.message)); }
    };
  });
  sec.querySelectorAll("[data-jphoto]").forEach((b) => (b.onclick = () => { const j = store.journal.find((x) => x.id === b.dataset.jphoto); if (j?.photos?.length) lightbox(j.photos, +b.dataset.k); }));
  sec.querySelectorAll("[data-jreply]").forEach((b) => (b.onclick = () => { jui.reply = b.dataset.jreply; jui.edit = null; jui.focus = "reply:" + jui.reply; rerender(); }));
  sec.querySelectorAll("[data-jedit]").forEach((b) => (b.onclick = () => { jui.edit = b.dataset.jedit; jui.reply = null; jui.focus = "edit:" + jui.edit; rerender(); }));
  sec.querySelectorAll("[data-jdel]").forEach((b) => (b.onclick = async () => {
    const j = store.journal.find((x) => x.id === b.dataset.jdel); const n = store.journal.filter((x) => x.replyTo === j.id).length;
    if (!confirm(`Delete this journal entry${n ? ` and its ${n} repl${n > 1 ? "ies" : "y"}` : ""}?`)) return;
    try { await data.deleteJournal(j.id); toast("Deleted"); } catch (x) { toast("Couldn't delete: " + (x.code || x.message)); }
  }));
}
async function upload(files, where) {
  toast(`Uploading ${files.length} file(s)…`);
  try { for (const f of files) { if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB`); continue; } await data.uploadFile(f, where); } toast("Uploaded"); }
  catch (e) { toast("Upload failed: " + (e.code || e.message)); }
}

// ---------------------------------------------------------------- forms
const FIELDS = {
  flight: [["route", "Route (e.g. BNE-LAX)"], ["airline", "Airline"], ["number", "Flight Number"], ["dep", "Departs"], ["arr", "Arrives"]],
  stay: [["name", "Hotel Name"], ["short", "Short Name (for the Itinerary)"], ["address", "Address"], ["area", "Town / City (for the Itinerary)"], ["checkin", "Check-In Time"], ["checkout", "Check-Out Time"]],
  car: [["company", "Company"], ["vehicle", "Vehicle"], ["pickup", "Pick-Up Location"], ["dropoff", "Drop-Off Location"], ["pickupTime", "Pick-Up Time"], ["dropoffTime", "Drop-Off Time"]],
};
const PRIV_KEYS = ["confirmation", "tickets", "seats", "cost", "paidWith", "dueAtHotel", "cancel", "phone", "notes"];
function modal(html, onSubmit, onDelete) {
  const m = document.createElement("div"); m.className = "modal";
  m.innerHTML = `<form class="sheet">${html}<div class="row end">
      ${onDelete ? `<button type="button" class="btn danger" data-del>Delete</button>` : ""}<span class="grow"></span>
      <button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary">Save</button></div></form>`;
  document.body.appendChild(m);
  const close = () => { m.remove(); render(); };
  m.querySelector("[data-cancel]").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  if (onDelete) m.querySelector("[data-del]").onclick = async () => { if (confirm("Delete this for everyone?")) { try { await onDelete(); close(); } catch (x) { toast(x.message); } } };
  m.querySelector("form").onsubmit = async (e) => { e.preventDefault(); const btn = e.target.querySelector("button.primary"); btn.disabled = true;
    try { await onSubmit(new FormData(e.target), e.target); close(); }
    catch (x) { btn.disabled = false; if (!x.back) toast("Save failed: " + (x.code || x.message)); } };
  m.querySelector("input,select,textarea")?.focus();
}
const whoBoxes = (who) => `<fieldset class="whobox"><legend>Who</legend>${PEOPLE().map((p) => `<label><input type="checkbox" name="who" value="${p}" ${who.includes(p) ? "checked" : ""}>${avHtml(p)}${esc(NAME(p))}</label>`).join("")}</fieldset>`;
const PDF_BTN = `<div class="extract"><label class="btn small pdfbtn"><i class="ic16">${I.scan}</i>Fill from PDF or Photo<input type="file" hidden accept="application/pdf,image/*" data-extract></label>
  <span class="extract-status muted small">The file is read by AI, then attached. Check the details before saving.</span></div>`;
function setVal(form, name, v) { const el = form.querySelector(`[name="${name}"]`); if (el && v !== undefined && v !== null && v !== "") el.value = v; }
// After AI fill: red label + * on the fields that matter most (and any the AI was unsure of); cleared once the field is touched.
const CRITICAL = {
  flight: ["who", "start", "end", "route", "number", "dep", "arr", "priv.confirmation"],
  stay: ["who", "start", "end", "name", "checkin", "checkout", "priv.confirmation", "priv.cost", "priv.cancel"],
  car: ["who", "start", "end", "pickup", "dropoff", "pickupTime", "dropoffTime", "priv.confirmation"],
  activity: ["who", "date", "endDate", "text", "place"],
};
function markCheck(form, type, unsure = []) {
  form.querySelectorAll(".verify").forEach((el) => el.classList.remove("verify"));
  const PRIV = new Set(["confirmation", "tickets", "seats", "cost", "paidWith", "dueAtHotel", "cancel", "phone", "notes"]);
  const names = new Set([...(CRITICAL[type] || []), ...unsure.map((n) => (PRIV.has(n) ? "priv." + n : n === "date" && type !== "activity" ? "start" : n))]);
  let n = 0;
  for (const name of names) {
    const box = name === "who" ? form.querySelector(".whobox") : form.querySelector(`[name="${name}"]`)?.closest("label");
    if (!box || box.classList.contains("verify")) continue;
    box.classList.add("verify"); n++;
    const tn = [...box.childNodes].find((c) => c.nodeType === 3 && c.textContent.trim());   // put the * inline with the label text
    if (tn) { const sp = document.createElement("span"); sp.className = "vtxt"; tn.replaceWith(sp); sp.appendChild(tn); }
    const clear = () => box.classList.remove("verify");
    box.addEventListener("input", clear, { once: true }); box.addEventListener("change", clear, { once: true });
  }
  return n;
}
function wireExtract(form, hint, onResult) {
  const inp = form.querySelector("[data-extract]"); const st = form.querySelector(".extract-status");
  if (!inp) return;
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 15 * 1024 * 1024) { st.textContent = "That file is over 15 MB - try a smaller PDF or a screenshot."; return; }
    form.dataset.pending = "1"; form._pendingFile = f;
    st.textContent = `Reading ${f.name}…`; st.classList.add("busy");
    try {
      const r = await data.extractFromFile(f, hint(), { travellers: store.trip?.travellers || [], extended: store.trip?.extended || [], start: store.trip?.start, end: store.trip?.end });
      form._ai = r || null;
      const type = onResult(r || {}) || hint();
      const n = markCheck(form, type, Array.isArray(r?.unsure) ? r.unsure : []);
      st.innerHTML = `✓ Filled from ${esc(f.name)}. <b class="verify-key">Check the ${n} fields marked * in red</b> - the mark goes when you edit one. Then Save (the file will be attached).`;
    } catch (x) {
      console.error(x); const why = String(x.message || x.code || x).replace(/^.*?googleapis\.com\S*:\s*/, "").slice(0, 400);
      st.textContent = `Couldn't read it automatically: ${why} - fill in by hand; ${f.name} will still be attached.`;
    } finally { st.classList.remove("busy"); }
  };
}
// ---- overlap: same type, at least one same person, dates overlap (stays/cars: nights overlap; flights: same day)
const overlaps = (a, b) => a.type === "flight" ? a.start <= b.end && b.start <= a.end : a.start < b.end && b.start < a.end;
function overlapGroups(list) {   // connected groups of mutually overlapping bookings
  const groups = [];
  for (const i of list) {
    const hit = groups.filter((g) => g.some((j) => overlaps(i, j)));
    const merged = [i, ...hit.flat()]; hit.forEach((g) => groups.splice(groups.indexOf(g), 1)); groups.push(merged);
  }
  return groups.map((g) => g.sort((a, b) => a.start.localeCompare(b.start) || (a.updatedAt || "").localeCompare(b.updatedAt || "")));
}
const findOverlaps = (out) => store.items.filter((i) => i.type === out.type && i.id !== out.id && (i.who || []).some((w) => out.who.includes(w)) && overlaps(i, out));
function cardLines(i, pv = {}) {
  const what = i.type === "flight" ? [i.route, [i.airline, i.number].filter(Boolean).join(" "), i.dep && "Dep " + i.dep + (i.arr ? " · Arr " + i.arr : "")]
    : i.type === "stay" ? [i.name || i.short, i.address, i.checkin && "Check-In " + i.checkin + (i.checkout ? " · Check-Out " + i.checkout : "")]
    : [i.company, i.vehicle, i.pickup && "Pick-Up " + i.pickup + (i.pickupTime ? " " + i.pickupTime : ""), i.dropoff && "Drop-Off " + i.dropoff + (i.dropoffTime ? " " + i.dropoffTime : "")];
  return `<div><b>${fmtDate(i.start)}${i.end !== i.start ? " → " + fmtDate(i.end) : ""}</b></div><div class="who">${esc((i.who || []).join(", "))}</div>`
    + [...what, pv.confirmation && "Confirmation " + pv.confirmation].filter(Boolean).map((t) => `<div>${esc(t)}</div>`).join("");
}
function askOverlap(existing, next) {
  const span = (a, b) => { const s = a.start > b.start ? a.start : b.start, e = a.end < b.end ? a.end : b.end;
    return next.type === "flight" ? fmtDate(s) + (e !== s ? " → " + fmtDate(e) : "") : (e === addDays(s, 1) ? "the night of " + fmtDate(s) : fmtDate(s) + " → " + fmtDate(e)); };
  const noun = { flight: "flight", stay: "stay", car: "car hire" }[next.type];
  return new Promise((done) => {
    const d = document.createElement("div"); d.className = "modal dupmodal";
    d.innerHTML = `<div class="sheet dup"><h3>Overlapping Booking</h3>
      <p>This ${noun} overlaps ${existing.length > 1 ? `<b>${existing.length}</b> bookings` : "a booking"} already in the trip, for
        ${existing.map((e) => `<b>${span(e, next)}</b> (${esc(e.who.filter((w) => next.who.includes(w)).join(", "))})`).join(" and ")}.</p>
      <div class="ovcols"><div><h4>Already Booked</h4>${existing.map((e) => `<div class="ovcard">${cardLines(e, store.priv[e.id])}</div>`).join("")}</div>
        <div><h4>New</h4><div class="ovcard new">${cardLines(next)}</div></div></div>
      <ul class="small ovhelp"><li><b>Replace</b> - remove the booking${existing.length > 1 ? "s" : ""} on the left and keep the new one (attached files move to the new booking).</li>
        <li><b>Keep Both</b> - save both. The itinerary shows one at a time with a <span class="swap static">⇄</span> button to switch between them.</li></ul>
      <div class="row end wrap"><button class="btn" data-a="back">Back to Editing</button><span class="grow"></span>
        <button class="btn" data-a="both">Keep Both</button><button class="btn primary" data-a="replace">Replace</button></div></div>`;
    document.body.appendChild(d);
    d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { d.remove(); done(b.dataset.a); }));
  });
}
// ---- duplicate check: same confirmation number, or same type + dates + key details for any of the same people
const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function findDuplicate(out, priv) {
  const key = (i) => i.type === "flight" ? [norm(i.number) || norm(i.route) + norm(i.dep)]
    : i.type === "stay" ? [norm(i.name), norm(i.short)].filter(Boolean) : [norm(i.company) + norm(i.pickup)];
  const conf = norm(priv.confirmation);
  return store.items.find((i) => {
    if (i.type !== out.type || i.id === out.id) return false;
    if (conf && norm(store.priv[i.id]?.confirmation) === conf) return true;
    const sameWho = (i.who || []).some((w) => out.who.includes(w));
    const k1 = key(i), k2 = key(out);
    return sameWho && i.start === out.start && i.end === out.end && k1.some((k) => k && k2.includes(k));
  });
}
// Side-by-side chooser: one row per field, tap the Previous or New value to keep (defaults: the one that has data, New if both differ)
function askDuplicate(prev, prevPriv, next, nextPriv, sameConf) {
  const rows = [["start", "From"], ["end", "To"], ["who", "Who"], ...FIELDS[next.type], ["status", "Status"], ["note", "Note"]]
    .map(([k, l]) => ({ k, l, a: prev[k], b: next[k] }))
    .concat([...new Set([...PRIV_KEYS, ...Object.keys(prevPriv), ...Object.keys(nextPriv)])].map((k) => ({ k: "priv." + k, l: label(k), a: prevPriv[k], b: nextPriv[k] })));
  const show = (k, v) => Array.isArray(v) ? v.join(", ") : (k === "start" || k === "end") && v ? fmtDate(v) : k === "status" && v ? (v === "tbc" ? "TBC" : "Booked") : String(v ?? "");
  const vis = rows.filter((r) => show(r.k, r.a) || show(r.k, r.b));
  vis.forEach((r) => { r.same = show(r.k, r.a) === show(r.k, r.b); r.pick = r.same || !show(r.k, r.b) ? "a" : "b"; if (!show(r.k, r.a)) r.pick = "b"; });
  const diffs = vis.filter((r) => !r.same).length;
  return new Promise((done) => {
    const d = document.createElement("div"); d.className = "modal dupmodal";
    d.innerHTML = `<div class="sheet dup"><h3>Possible Duplicate</h3>
      <p>${sameConf ? "A booking with the <b>same confirmation number</b> is already in this trip." : `This ${esc(next.type)} has the same dates and details as one already in this trip.`}
      ${diffs ? `<b>${diffs}</b> field${diffs > 1 ? "s differ" : " differs"} - tap the value you want to keep.` : "<b>All details are identical.</b>"}</p>
      <div class="duptable">
        <div class="dh"></div><div class="dh"><button type="button" class="linkbtn" data-all="a">Previous</button></div><div class="dh"><button type="button" class="linkbtn" data-all="b">New</button></div>
        ${vis.map((r, n) => `<div class="dl">${esc(r.l)}</div>${["a", "b"].map((s) => `<button type="button" class="dv ${r.same ? "same" : ""}" data-r="${n}" data-s="${s}">${esc(show(r.k, r[s])) || '<span class="muted">-</span>'}</button>`).join("")}`).join("")}
      </div>
      <p class="muted small">Tap "Previous" or "New" at the top to take a whole column. Files already attached stay with the booking.</p>
      <div class="row end wrap"><button class="btn" data-a="back">Back to Editing</button><span class="grow"></span>
        <button class="btn" data-a="both" title="Save the new one as a separate booking">Keep Both</button>
        <button class="btn primary" data-a="merge">Keep Selected</button></div></div>`;
    document.body.appendChild(d);
    const paint = () => d.querySelectorAll(".dv").forEach((el) => el.classList.toggle("on", vis[+el.dataset.r].pick === el.dataset.s));
    paint();
    d.querySelectorAll(".dv:not(.same)").forEach((el) => (el.onclick = () => { vis[+el.dataset.r].pick = el.dataset.s; paint(); }));
    d.querySelectorAll("[data-all]").forEach((el) => (el.onclick = () => { vis.forEach((r) => { if (!r.same) r.pick = el.dataset.all; }); paint(); }));
    d.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => {
      d.remove();
      if (b.dataset.a !== "merge") return done({ a: b.dataset.a });
      const item = { ...prev }, priv = { ...prevPriv };
      for (const r of vis) { const v = r[r.pick]; if (r.k.startsWith("priv.")) { if (v) priv[r.k.slice(5)] = v; else delete priv[r.k.slice(5)]; } else item[r.k] = v ?? ""; }
      done({ a: "merge", item: { ...item, type: next.type }, priv });
    }));
  });
}
function itemForm(item) {
  const isNew = !item.id; const pv = (item.id && store.priv[item.id]) || {};
  const typeSel = isNew ? `<label>Type<select name="type">${["flight", "stay", "car"].map((t) => `<option value="${t}" ${t === item.type ? "selected" : ""}>${cap(t)}</option>`).join("")}</select></label>` : "";
  const fieldsFor = (type, src = item) => FIELDS[type].map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(src[k] || "")}"></label>`).join("");
  const privKeys = [...new Set([...PRIV_KEYS, ...Object.keys(pv)])].filter((k) => !["share", "fam", "paidBy", "theirPct", "arrival", "updatedBy", "updatedAt", "kind"].includes(k));
  const statusSel = (st) => `<label>Status<select name="status"><option value="booked" ${st !== "tbc" ? "selected" : ""}>Booked</option><option value="tbc" ${st === "tbc" ? "selected" : ""}>TBC</option></select></label>`;
  modal(`<h3>${isNew ? "Add Booking" : "Edit " + cap(item.type)}</h3>${PDF_BTN}${typeSel}
    ${whoBoxes(item.who || [ui.person])}
    <div class="row"><label>From<input type="date" name="start" value="${item.start || ""}" required></label><label>To<input type="date" name="end" value="${item.end || ""}" required></label></div>
    <div id="typeFields">${fieldsFor(item.type || "stay")}</div>
    <div id="statusBox">${item.type !== "flight" ? statusSel(item.status) : ""}</div>
    <label>Note (Visible to Family)<input name="note" value="${esc(item.note || "")}"></label>
    <details class="privbox" ${Object.keys(pv).length ? "open" : ""}><summary>Private Details (Editors Only)</summary>
      ${privKeys.map((k) => k === "paidWith" ? payField(pv.paidWith, "priv.paidWith") : `<label>${esc(label(k))}<input name="priv.${k}" value="${esc(pv[k] || "")}"></label>`).join("")}
      ${shareFields(pv)}</details>`,
    async (fd, form) => {
      const type = fd.get("type") || item.type;
      const out = { ...item, type, who: fd.getAll("who"), start: fd.get("start"), end: fd.get("end"), note: fd.get("note"), status: fd.get("status") || item.status || "booked" };
      FIELDS[type].forEach(([k]) => (out[k] = fd.get(k) ?? ""));
      if (!out.who.length) throw new Error("Pick at least one person");
      if (out.end < out.start) throw new Error("'To' is before 'From'");
      let priv = {}; for (const [k, v] of fd.entries()) if (k.startsWith("priv.") && v) priv[k.slice(5)] = v;
      delete priv.paidWithOther; const pw = readPay(fd, "priv.paidWith"); if (pw) priv.paidWith = pw; else delete priv.paidWith;
      const arr = mergeArr(pv.arrival, form.__arrival); if (arr && (fd.get("type") || item.type) === "stay") priv.arrival = arr;
      let skipOverlap = false;
      if (isNew) {
        const dup = findDuplicate(out, priv);
        if (dup) {
          const pv = store.priv[dup.id] || {};
          const choice = await askDuplicate(dup, pv, out, priv, !!priv.confirmation && norm(pv.confirmation) === norm(priv.confirmation));
          if (choice.a === "back") throw Object.assign(new Error("back"), { back: true });
          if (choice.a === "merge") { Object.assign(out, choice.item, { id: dup.id }); priv = choice.priv; }
          // "both": fall through and save the new one separately
        }
        skipOverlap = !!dup;
      }
      let replaced = [];
      if (!skipOverlap) {
        const ov = findOverlaps(out);
        if (ov.length) {
          const a = await askOverlap(ov, out);
          if (a === "back") throw Object.assign(new Error("back"), { back: true });
          if (a === "replace") replaced = ov;
        }
      }
      const id = await data.saveItem(out, priv);
      for (const o of replaced) { await data.moveFiles(o.id, id); await data.deleteItem(o.id); }
      const already = form._pendingFile && store.files.some((f) => f.itemId === id && f.name === form._pendingFile.name);
      if (form._pendingFile && !already) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { itemId: id }); toast("Saved with file attached"); }
      else if (already) toast("Saved - " + form._pendingFile.name + " was already attached");
      if (form._ai?.journeys?.length > 1) await addOtherJourneys(form._ai, form._pendingFile);
    }, isNew ? null : () => data.deleteItem(item.id));
  const form = document.querySelector(".sheet");
  const sel = form.querySelector("select[name=type]");
  wirePay(form); wireShare(form);
  const switchType = (t, src) => {
    form.querySelector("#typeFields").innerHTML = fieldsFor(t, src);
    form.querySelector("#statusBox").innerHTML = t !== "flight" ? statusSel(src.status) : "";
  };
  if (sel) sel.onchange = () => switchType(sel.value, item);
  wireExtract(form, () => (sel ? sel.value : item.type), (r) => {
    if (arrOk(r.private?.arrival)) { form.__arrival = r.private.arrival; toast("Arrival details found too - saved with the stay"); }
    let t = sel ? sel.value : item.type;
    if (sel && r.type && ["flight", "stay", "car"].includes(r.type) && r.type !== t) { t = r.type; sel.value = t; switchType(t, {}); }
    FIELDS[t].forEach(([k]) => setVal(form, k, r[k]));
    setVal(form, "start", r.start); setVal(form, "end", r.end || r.start); setVal(form, "note", r.note);
    if (Array.isArray(r.who) && r.who.length) form.querySelectorAll("input[name=who]").forEach((cb) => (cb.checked = r.who.includes(cb.value)));
    const p = r.private || {};
    for (const [k, v] of Object.entries(p)) {
      if (!v) continue;
      if (k === "arrival" || typeof v === "object") continue;   // arrival details are kept separately (the stay's Arrival card)
      if (k === "paidWith") { setPay(form, "priv.paidWith", v); continue; }
      if (!form.querySelector(`[name="priv.${k}"]`)) form.querySelector(".privbox").insertAdjacentHTML("beforeend", `<label>${esc(label(k))}<input name="priv.${k}"></label>`);
      setVal(form, "priv." + k, v);
    }
    form.querySelector(".privbox").open = true;
    return t;
  });
}
function entryForm(e) {
  const isNew = !e.id;
  modal(`<h3>${isNew ? "Add" : "Edit"} ${cap(e.kind)}</h3>${e.kind === "activity" ? PDF_BTN : ""}
    <label>${e.kind === "comment" ? "Comment" : "Activity"}<textarea name="text" rows="3" required>${esc(e.text)}</textarea></label>
    ${e.kind === "activity" ? `<label>Place (for Google Maps)<input name="place" value="${esc(e.place || "")}" placeholder="e.g. Gran Cenote Tulum"></label>
      <label>Type<select name="status"><option value="planned" ${e.status !== "recommended" ? "selected" : ""}>In the Plan</option><option value="recommended" ${e.status === "recommended" ? "selected" : ""}>Recommended Idea</option></select></label>
      <label class="check"><input type="checkbox" name="confirmed" ${e.confirmed ? "checked" : ""}> Confirmed - Show It in the Itinerary</label>` : ""}
    <div class="row"><label>From<input type="date" name="date" value="${e.date}" required></label><label>To<input type="date" name="endDate" value="${e.endDate || e.date}"></label></div>
    ${whoBoxes(e.who)}
    ${e.kind === "activity" && isEditor() ? `<details class="privbox" ${store.priv[e.id]?.cost ? "open" : ""}><summary>Cost (Editors Only)</summary>
      <label>Cost<input name="pcost" value="${esc(store.priv[e.id]?.cost || "")}" placeholder="e.g. USD 240 or AU$95"></label>
      ${shareFields(store.priv[e.id] || {}, (k) => "p" + k)}</details>` : ""}`,
    async (fd, form) => {
      const out = { ...e, text: fd.get("text").trim(), place: fd.get("place") ?? e.place ?? "", status: fd.get("status") || "planned", confirmed: e.kind === "activity" ? (fd.get("confirmed") === "on" || !!form._pendingFile) && fd.get("status") !== "recommended" : true,
                    date: fd.get("date"), endDate: fd.get("endDate") || fd.get("date"), who: fd.getAll("who") };
      if (!out.who.length) throw new Error("Pick at least one person");
      if (out.place !== (e.place || "") || out.text.split("\n")[0] !== String(e.text || "").split("\n")[0]) { delete out.geo; delete out.routeSkip; }   // place changed: look it up again for routes
      const id = await data.saveEntry(out);
      const pc = (fd.get("pcost") || "").trim(), had = store.priv[id] || store.priv[e.id];
      if (pc || had?.cost) await data.savePrivate(id, { ...(had || {}), cost: pc, share: fd.get("pshare") || "ours", fam: fd.get("pfam") || "", paidBy: fd.get("ppaidBy") || "us", theirPct: fd.get("ptheirPct") || "" });
      if (form._pendingFile) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { entryId: id, date: out.date }); toast("Saved and confirmed, with file attached"); }
    }, isNew ? null : () => data.deleteEntry(e.id));
  const form = document.querySelector(".sheet"); wireShare(form);
  { const stay = store.items.find((i) => i.type === "stay" && i.status !== "tbc" && i.start <= e.date && e.date < i.end && (i.address || i.name));
    acAttach(form.querySelector("input[name=place]"), { any: true, near: stay ? stay.address || stay.name : "" }); }
  wireExtract(form, () => "activity", (r) => {
    const txt = [r.text || r.name, r.time ? "at " + r.time : ""].filter(Boolean).join(" ");
    setVal(form, "text", txt); setVal(form, "place", r.place || r.address); setVal(form, "pcost", r.private?.cost); setVal(form, "date", r.start || r.date); setVal(form, "endDate", r.end || r.start || r.date);
    if (Array.isArray(r.who) && r.who.length) form.querySelectorAll("input[name=who]").forEach((cb) => (cb.checked = r.who.includes(cb.value)));
    const day0 = form.dataset.day0 || (form.dataset.day0 = form.querySelector("[name=date]")?.defaultValue || "");
    if (needsDate(r)) askVoucherDate(r, form._pendingFile?.name, day0).then((d) => { if (d) { setVal(form, "date", d); setVal(form, "endDate", d); } });
    return "activity";
  });
}

// ---------------------------------------------------------------- menu actions
const actions = {
  signout: () => data.signOut(),
  newtrip: () => tripForm(null),
  settings: () => tripForm(store.trips.find((t) => t.id === ui.tripId) || { id: ui.tripId, ...store.trip }),
  add: () => itemForm({ type: "stay", who: [ui.person], start: ui.day || store.trip?.start, end: ui.day || store.trip?.start, status: "booked" }),
  export: () => {
    const blob = new Blob([JSON.stringify(data.exportAll(), null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `trip-backup-${iso(new Date())}.json`; a.click();
  },
  album: () => {
    const t = store.trip;
    modal(`<h2>Export Album</h2><p class="muted small">A Word document with a page per day: where you stayed, what you did and the journal. No costs or confirmation numbers.</p>
      <div class="row2"><label>From<input type="date" name="from" value="${t.start}" min="${t.start}" max="${t.end}" required></label>
      <label>To<input type="date" name="to" value="${t.end}" min="${t.start}" max="${t.end}" required></label></div>
      <label class="pswitch"><input type="checkbox" name="recap" checked><span>Start with a Trip Recap page (the trip in numbers)</span></label>
      ${(store.journal || []).some((j) => j.photos?.length) ? `<label class="pswitch"><input type="checkbox" name="photos" checked><span>Include the journal photos</span></label>` : ""}`, async (fd) => {
      const from = fd.get("from"), to = fd.get("to");
      if (from > to) { toast("'From' must be before 'To'"); throw Object.assign(new Error(""), { back: true }); }
      toast("Building the album…");
      const docx = await import("https://cdn.jsdelivr.net/npm/docx@9.5.1/+esm");
      const photos = new Map();
      if (fd.get("photos")) {
        const want = (store.journal || []).filter((j) => j.date >= from && j.date <= to && !j.replyTo).flatMap((j) => j.photos || []);
        let n = 0, bad = 0;
        for (const ph of want) { toast(`Adding photos… ${++n} of ${want.length}`); try { photos.set(ph.id, new Uint8Array(await data.photoBytes(ph))); } catch (e) { bad++; console.warn("photo", e); } }
        if (bad) toast(`${bad} photo${bad > 1 ? "s" : ""} couldn't be downloaded and were left out`);
      }
      let recap = null; if (fd.get("recap")) { try { recap = await tripRecap(ui.tripId); } catch (e) { console.warn("recap", e); } }
      const doc = buildAlbum(docx, { trip: t, items: store.items, entries: store.entries, journal: store.journal }, { from, to, photos, recap });
      const blob = await docx.Packer.toBlob(doc);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `${(t.title || "Trip").replace(/&/g, "and").replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim()} Album ${from}${to !== from ? " to " + to : ""}.docx`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const b = document.querySelector(".modal button.primary"); if (b) b.textContent = "Download";
  },
  bulk: () => bulkAttach(),
  offline: () => offlineForm(),
  ask: () => askTrip(),
  tripmap: () => openTripMap(ui.tripId),
  recap: () => showRecap(ui.tripId),
  sos: () => emergencySheet(),
  reel: () => travelReel(),
  pack: () => packingSheet(),
  todo: () => todoSheet(),
  docwarn: () => showTripDocIssues(store.trips.find((t) => t.id === ui.tripId) || { id: ui.tripId, ...store.trip }),
  country: () => (store.trip?.countryInfo?.codes?.length ? showCountryInfo({ id: ui.tripId, ...store.trip }) : isEditor() ? countryInfoFlow() : toast("No country info yet")),
  people: () => peopleList(),
  archive: () => archiveDocs(),
  import: () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = async () => {
      try { const seed = JSON.parse(await inp.files[0].text());
        if (store.items.length && !confirm("Restore from this backup? Bookings and activities in the file will be added, or replace the ones with the same ID. Nothing else is deleted.")) return;
        toast("Importing…"); const id = await data.importSeed(seed); toast("Trip data imported"); if (!ui.tripId) routeTo(id); }
      catch (e) { toast("Import failed: " + (e.code || e.message)); }
    };
    inp.click();
  },
};
function toast(msg) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3000);
}

// ================================================================= start
parseRoute();
if (!ui.tripId && /^#\d{4}-\d{2}-\d{2}$/.test(location.hash)) routeTo("usmx-2026", location.hash.slice(1), true); // old links
const PLANNED_IDS = ["e007","e008","e009","e010","e011","e012","e013","e014","e015","e016","e017","e020"]; // Tulum day plans + Ruta del Vino: not booked yet
let migrating = false;
data.onChange(() => {
  if (isEditor() && store.tripId === "usmx-2026" && store.trip && (store.trip.schema || 1) < 2 && store.entries.length && !migrating) {
    migrating = true;
    data.migrateConfirmed((e) => e.kind === "comment" || (e.status !== "recommended" && !PLANNED_IDS.includes(e.id)))
      .then(() => toast("Updated: activities now have a Confirmed tick")).catch((x) => { console.error(x); migrating = false; });
  }
  if (!document.querySelector(".modal")) render();
});
render();
data.init(() => render()).catch((e) => { root.innerHTML = `<div class="login"><img class="logo-lg" src="icons/logo.svg" alt="Travel Planner logo"><h1 class="title-red">Travel Planner</h1><p class="err">Couldn't start: ${esc(e.message)}. Check your connection and reload.</p></div>`; });
if ("serviceWorker" in navigator && !data.DEMO) navigator.serviceWorker.register("./sw.js").catch(() => {});
