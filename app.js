import * as data from "./data.js";
import { drawDayMap, mapsReady, searchPlaces } from "./map.js";
import { buildAlbum } from "./album.js";
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
try { const v = localStorage.getItem("tp.view"); ui.view = ["overview", "timeline", "journey", "budget"].includes(v) ? v : "overview"; } catch (e) { ui.view = "overview"; }
try { ui.swap = JSON.parse(localStorage.getItem("tp.swap") || "{}"); } catch (e) { /* private mode */ }
// routes:  #/  (trips)   #/t/<tripId>   #/t/<tripId>/<YYYY-MM-DD>
function parseRoute() {
  const m = location.hash.match(/^#\/t\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?/);
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
  const names = mainNames(); const codes = ALL_CODES(); const key = names.join("|") + "#" + codes.join("|");
  if (!tokenRe || key !== tokenKey) {
    tokenKey = key;
    const nameAlt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    tokenRe = new RegExp(
      `(?<init>${codes.length ? `\\b(?:${codes.map((c) => c.replace(/[^A-Za-z0-9]/g, "")).join("|")})\\b|` : ""}^All(?=:))|(?<tbc>\\bTBC\\b)|(?<main>\\b[A-Z]{3}(?:-[A-Z]{3})+\\b${nameAlt ? "|" + nameAlt : ""})` +
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
const whoLabel = (who) => (PEOPLE().every((p) => who.includes(p)) ? "All" : who.join("/"));

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
const root = $("#app");
function render() {
  if (!store.ready) { root.innerHTML = `<div class="loading"><img class="logo-lg" src="icons/logo.svg" alt=""><br>Loading…</div>`; return; }
  if (!store.role) return renderLogin();
  if (store.role === "none") return renderNoAccess();
  if (!ui.tripId) { data.openTrip(null); applyTheme(); return renderHome(); }
  data.openTrip(ui.tripId);
  if (!store.trip && !store.items.length) return renderEmpty();
  if (!PEOPLE().includes(ui.person)) ui.person = PEOPLE()[0];
  if (!ui.person) return renderEmpty();
  applyTheme();
  if (ui.view === "budget" && !isEditor()) ui.view = "overview";
  if (ui.day) renderDay(); else if (ui.view === "journey") renderJourney(); else if (ui.view === "timeline") renderTimeline(); else if (ui.view === "budget") renderBudget(); else renderOverview();
  if (ui.slide) { root.querySelector(".ov,.tl,.journey,.dayview,.bd")?.classList.add(ui.slide); ui.slide = null; }
  if (isEditor() && store.trip) setTimeout(ensureRecs, 0);
}

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
      <div class="tc-top"><h3>${esc(t.title || "Untitled Trip")}</h3>${status}</div>
      <div class="tc-dates">${t.start ? `${longDate(t.start)} – ${longDate(t.end)} · ${days} days` : "Dates not set"}</div>
      <div class="tc-people">${(t.travellers || []).map((p, k) => `<span class="pchip tp" style="--pc:${upc(p.color) || TCOLORS[k % TCOLORS.length][1]}" title="${esc(p.name || p.code)}"><b>${esc(p.code)}</b></span>`).join("")}</div>
      ${isEditor() ? `<div class="tc-acts"><button class="btn tiny" data-settings="${esc(t.id)}">Setup</button></div>` : ""}
    </article>`;
  };
  root.innerHTML = `<header class="top"><div class="brand"><img class="logo-sm" src="icons/logo.svg" alt=""><span class="title-red">Travel Planner</span>
      <span class="role ${store.role}">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span></div>
    <div class="menu">${isEditor() ? `<button class="btn small primary" data-act="newtrip">+ New Trip</button>` : ""}
      <details class="more"><summary class="btn small">⋯</summary><div class="pop">
        ${isEditor() ? `<button data-act="import">Import a Trip File</button>` : ""}<button data-act="signout">Sign Out</button></div></details></div></header>
  <div class="home">
    ${!store.tripsLoaded ? `<p class="muted">Loading trips…</p>` : !trips.length ? `<div class="empty card"><h2>No Trips Yet</h2>
       ${isEditor() ? `<p>Create your first trip: name, dates and who's travelling.</p><button class="btn primary" data-act="newtrip">+ New Trip</button>` : `<p>Nothing has been planned yet.</p>`}</div>` : ""}
    ${upcoming.length ? `<h2 class="hsec">Upcoming</h2><div class="trips">${upcoming.map(card).join("")}</div>` : ""}
    ${past.length ? `<h2 class="hsec">Past Trips</h2><div class="trips">${past.map(card).join("")}</div>` : ""}
  </div>`;
  wireHeader();
  root.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = (e) => { if (e.target.closest("[data-settings]")) return; localStorage.setItem("tp.trip", el.dataset.open); routeTo(el.dataset.open); };
    el.onkeydown = (e) => { if (e.key === "Enter") el.click(); };
  });
  root.querySelectorAll("[data-settings]").forEach((b) => (b.onclick = () => tripForm(store.trips.find((t) => t.id === b.dataset.settings))));
}

// ---------------------------------------------------------------- trip setup window
function tripForm(t) {
  const isNew = !t; t = t || { title: "", start: "", end: "", travellers: [{ code: "", name: "" }], extended: [] };
  const used = (t.travellers || []).map((x) => upc(x.color)).filter(Boolean);
  const nextColor = () => { const all = [...document.querySelectorAll('.prow[data-kind="t"]')].map((r) => r.dataset.color); return (TCOLORS.find(([, h]) => !all.includes(h) && !used.includes(h)) || TCOLORS[all.length % TCOLORS.length])[1]; };
  const row = (p, kind, k = 0) => { const c = upc(p.color) || (kind === "t" ? TCOLORS[k % TCOLORS.length][1] : "");
    return `<div class="prow" data-kind="${kind}" ${kind === "t" ? `data-color="${c}" style="--pc:${c}"` : ""}>
      <input class="pcode" placeholder="Initials" maxlength="6" value="${esc(p.code || "")}" required>
      <input class="pname" placeholder="Name" value="${esc(p.name || "")}" ${kind === "t" ? "required" : ""}>
      <input class="pfull" placeholder="Full Name (as on Bookings)" value="${esc(p.fullName || "")}">
      <button type="button" class="btn tiny danger" data-rm title="Remove">✕</button>
      ${kind === "t" ? `<div class="swrow" role="radiogroup" aria-label="Colour">${TCOLORS.map(([n, h]) => `<button type="button" class="swbtn${h === c ? " on" : ""}" style="--c:${h}" data-sw="${h}" role="radio" aria-checked="${h === c}" aria-label="${n}" title="${n}"></button>`).join("")}</div>` : ""}</div>`; };
  modal(`<h3>${isNew ? "New Trip" : "Trip Setup"}</h3>
    <label>Trip Name<input name="title" value="${esc(t.title)}" placeholder="e.g. Japan 2027" required></label>
    <div class="row"><label>Start<input type="date" name="start" value="${t.start || ""}" required></label><label>End<input type="date" name="end" value="${t.end || ""}" required></label></div>
    <fieldset class="pbox"><legend>Travellers (Each Gets Their Own Itinerary)</legend>
      <div id="trav">${(t.travellers || []).map((p, k) => row(p, "t", k)).join("")}</div>
      <button type="button" class="btn tiny" data-addp="t">+ Add Traveller</button></fieldset>
    <fieldset class="pbox"><legend>Others Joining Sometimes (Optional)</legend>
      <div id="ext">${(t.extended || []).map((p) => row(p, "e")).join("")}</div>
      <button type="button" class="btn tiny" data-addp="e">+ Add Person</button></fieldset>
    <p class="muted small">Initials are how people appear in the itinerary (e.g. CGC). Full names help the AI match names on bookings. The colour is each traveller's dot in the Overview.</p>
    <fieldset class="pbox"><legend>Colour Theme</legend><div class="themes">
      ${THEMES.map(([k, n, cs]) => `<label class="themecard"><input type="radio" name="theme" value="${k}" ${(t.theme || "ink") === k ? "checked" : ""}><span class="tsw">${cs.map((c) => `<i style="background:${c}"></i>`).join("")}</span><b>${n}</b></label>`).join("")}</div></fieldset>`,
    async (fd, form) => {
      const read = (kind) => [...form.querySelectorAll(`.prow[data-kind="${kind}"]`)].map((r) => ({
        code: r.querySelector(".pcode").value.trim().toUpperCase(), name: r.querySelector(".pname").value.trim(), fullName: r.querySelector(".pfull").value.trim(), color: r.dataset.color || "" }))
        .filter((p) => p.code).map(({ fullName, color, ...p }) => ({ ...p, ...(fullName ? { fullName } : {}), ...(color ? { color } : {}) }));
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
      const id = await data.saveTrip({ title: fd.get("title").trim(), start: fd.get("start"), end: fd.get("end"), travellers, extended, theme: fd.get("theme") || "ink" }, isNew ? null : t.id);
      if (isNew) { ui.person = travellers[0].code; localStorage.setItem("tp.person", ui.person); routeTo(id); }
    }, isNew ? null : async () => {
      const typed = prompt(`This deletes "${t.title}" with all its bookings, activities and documents for everyone. Type DELETE to confirm.`);
      if (typed !== "DELETE") throw new Error("Not deleted");
      await data.deleteTrip(t.id); routeTo(null);
    });
  const form = document.querySelector(".sheet");
  form.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]"); if (rm) rm.closest(".prow").remove();
    const add = e.target.closest("[data-addp]"); if (add) form.querySelector(add.dataset.addp === "t" ? "#trav" : "#ext").insertAdjacentHTML("beforeend", row(add.dataset.addp === "t" ? { color: nextColor() } : {}, add.dataset.addp));
    const sw = e.target.closest("[data-sw]");
    if (sw) { const r = sw.closest(".prow"); r.dataset.color = sw.dataset.sw; r.style.setProperty("--pc", sw.dataset.sw);
      r.querySelectorAll("[data-sw]").forEach((b) => { b.classList.toggle("on", b === sw); b.setAttribute("aria-checked", b === sw); }); }
  });
}

// ---------------------------------------------------------------- icons + type colours (same everywhere)
const SV = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
const I = {
  pin: SV('<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
  clip: SV('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  trash: SV('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>'),
  file: SV('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h4"/>'),
  map: SV('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>'),
  star: SV('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>'),
  eat: SV('<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2 1-3.5 3.5-3.5 7 0 2 1.5 3 3.5 3"/>'),
  scan: SV('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8"/>'),
};
const ICON = {
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
  route: SV('<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>'),
};
const KIND = { flight: "flight", stay: "stay", car: "car", activity: "act", act: "act" };
const shortDate = (s) => { const d = D(s); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const WD3 = (s) => WD[D(s).getDay()].slice(0, 3).toUpperCase();
const minus1 = (t) => { const [h, m] = t.split(":").map(Number); const x = Math.max(0, h * 60 + (m || 0) - 1); return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
const cleanTime = (t) => String(t || "").replace(/\s*\(.*\)\s*$/, "").trim();
const codesOf = (route) => String(route || "").split(/[-–>]+/).map((c) => c.trim()).filter(Boolean);
const withText = (p, date) => { const w = PEOPLE().filter((o) => o !== p && together(p, o, date)).map(NAME); return w.length ? "With " + w.join(" & ") : ""; };

// ---------------------------------------------------------------- traveller colours (picked in Trip Setup; none of them is used by a theme)
// Traveller colours: all dark enough for white initials (contrast 4.5:1 or more), none clashing with the theme colours
const TCOLORS = [["Teal", "#0F7C72"], ["Coral", "#D2442C"], ["Ochre", "#A15F08"], ["Forest", "#2E7D32"], ["Ocean", "#0B76A0"], ["Olive", "#5B7A14"], ["Rust", "#9A3F24"], ["Mocha", "#7A5C3E"]];
// earlier, lighter versions -> their darker replacement (so trips set up before keep the same choice)
const OLDC = { "#14B8A6": "#0F7C72", "#FF7A59": "#D2442C", "#F2A93B": "#A15F08", "#22A06B": "#2E7D32", "#17B2D9": "#0B76A0", "#8BBF2B": "#5B7A14", "#C8553D": "#9A3F24", "#C9A66B": "#7A5C3E" };
const upc = (h) => (h && OLDC[h.toUpperCase()]) || h;
const THEMES = [["ink", "Ink & Violet", ["#16141F", "#2F6FED", "#7A4BD6", "#5D6573", "#E0457B"]],
  ["lavender", "Lavender & Pink", ["#4B2A8C", "#3D6BE0", "#C2367A", "#5D6573", "#7C4DDB"]],
  ["midnight", "Midnight (dark)", ["#000000", "#6E9BFF", "#A47BFF", "#9AA3B2", "#FF5FA2"]]];
function pcolor(code) {
  const tr = store.trip?.travellers || []; const k = tr.findIndex((t) => t.code === code);
  return (k >= 0 && upc(tr[k].color)) || TCOLORS[Math.max(0, k) % TCOLORS.length][1];
}
const inkOn = (hex) => { const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#16141F" : "#FFFFFF"; };
function applyTheme() {
  const th = (ui.tripId && store.trip?.theme) || "ink";
  if (th === "ink") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = th;
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = THEMES.find((t) => t[0] === th)?.[2][0] || "#16141F";
}

// ---------------------------------------------------------------- header: trip title, initials (traveller menu), view icons, + and ⋯
const VIEWS = [["overview", "Overview", "grid"], ["timeline", "Timeline", "list"], ["journey", "Journey", "route"], ["budget", "Budget", "wallet"]];
const viewsFor = () => VIEWS.filter((v) => v[0] !== "budget" || isEditor());
function header(opts = {}) {
  const t = store.trip || {}; const today = iso(new Date());
  const when = !t.start ? "" : t.start > today ? `In ${dayDiff(today, t.start)} days` : today <= t.end ? "On now" : "";
  const sub = [window.__previewDate ? "Preview" : "", t.start ? `${shortDate(t.start)} – ${shortDate(t.end)}` : "", when].filter(Boolean).join(" · ");
  const me = ui.person, mc = pcolor(me);
  return `<header class="hero">
    <div class="hero-top">
      <button class="iconbtn" data-home aria-label="All trips" title="All trips">${ICON.menu}</button>
      <div class="hero-title"><span class="hero-sub">${esc(sub)}</span><span class="hero-name">${esc(t.title || "Travel Planner")}</span></div>
      <details class="more who"><summary class="pbtn" style="--pc:${mc};--pi:${inkOn(mc)}" aria-label="Traveller: ${esc(NAME(me))} - change" title="Change traveller">${esc(me)}</summary>
        <div class="pop"><span class="pop-role">Show itinerary for</span>
        ${PEOPLE().map((p) => `<button data-person="${p}" class="${p === me ? "on" : ""}"><span class="sw" style="background:${pcolor(p)};color:${inkOn(pcolor(p))}">${esc(p)}</span><span class="grow">${esc(NAME(p))}</span>${p === me ? "✓" : ""}</button>`).join("")}</div></details>
    </div>
    <div class="hero-bar">
      ${!opts.views && ui.day ? `<button class="iconbtn" data-itinerary data-back aria-label="Back to ${VIEWS.find((v) => v[0] === ui.view)?.[1] || "Overview"}" title="Back to ${VIEWS.find((v) => v[0] === ui.view)?.[1] || "Overview"}">${ICON.home}</button>` : ""}
      ${opts.views ? `<nav class="vseg${viewsFor().length > 3 ? " icons" : ""}" aria-label="View">${viewsFor().map(([k, l, ic]) => `<button class="${ui.view === k ? "on" : ""}" data-view="${k}" aria-label="${l}" title="${l}">${ICON[ic]}${ui.view === k && viewsFor().length <= 3 ? `<span>${l}</span>` : ""}</button>`).join("")}</nav>` : `<span class="hero-hint">${esc(NAME(me))}'s day</span>`}
      <span class="grow"></span>
      ${isEditor() ? `<button class="iconbtn" data-act="add" aria-label="Add booking" title="Add booking">${ICON.plus}</button>` : ""}
      <details class="more"><summary class="iconbtn" aria-label="More">${ICON.dots}</summary><div class="pop">
        <span class="pop-role">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span>
        ${isEditor() ? `<button data-act="settings">Trip Setup</button><button data-act="import">Import Trip Data</button><button data-act="export">Download Backup</button>` : ""}
        <button data-act="album">Export Album (Word)</button>
        <button data-act="signout">Sign Out</button></div></details>
    </div>
  </header>
  ${store.error ? `<div class="banner err">${esc(store.error)}</div>` : ""}`;
}
function wireHeader() {
  root.querySelectorAll("[data-person]").forEach((b) => (b.onclick = () => { ui.person = b.dataset.person; localStorage.setItem("tp.person", ui.person); render(); }));
  root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { ui.view = b.dataset.view; try { localStorage.setItem("tp.view", ui.view); } catch (e) { /* ignore */ } sessionStorage.removeItem("tp.wscroll"); render(); }));
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.(b)));
  root.querySelectorAll("[data-home]").forEach((b) => (b.onclick = () => routeTo(null)));
  root.querySelectorAll("[data-itinerary]").forEach((b) => (b.onclick = () => routeTo(ui.tripId, null)));
  // close an open menu when tapping elsewhere
  document.onclick = (e) => root.querySelectorAll("details.more[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });
}

// ---------------------------------------------------------------- budget & spending (editors only - costs live in the private collection)
const BCATS = [["flight", "Flights", "flight"], ["stay", "Stays", "stay"], ["car", "Cars", "car"], ["act", "Activities", "act"],
  ["food", "Food & Drink", "food"], ["transport", "Transport", "bus"], ["shopping", "Shopping", "bag"], ["other", "Other", "dots"]];
const CURRENCIES = ["AUD", "USD", "MXN", "CAD", "NZD", "EUR", "GBP"];
const SHARE = { ours: "Us", split: "Shared - split TBC", theirs: "Family (not ours)" };
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
      m, home: toHome(m, S), due: toHome(due, S), share: pv.share || "ours", paidWith: pv.paidWith || "" });
  }
  for (const e of store.entries.filter((x) => x.kind === "activity" && x.status !== "recommended")) {
    const pv = store.priv[e.id] || {}; const m = parseMoney(pv.cost, S.home); if (!m) continue;
    rows.push({ src: "entry", id: e.id, cat: "act", date: e.date, name: e.text, who: e.who || [], m, home: toHome(m, S), share: pv.share || "ours", planned: !e.confirmed });
  }
  for (const x of expenses()) {
    const m = { amt: +x.amount || 0, cur: x.currency || S.home };
    rows.push({ src: "expense", id: x.id, cat: x.cat || "other", date: x.date, name: x.text || "Expense", who: x.who || [], m, home: toHome(m, S), share: "ours", paidWith: x.paidWith || "" });
  }
  const cats = Object.fromEntries(BCATS.map(([k]) => [k, { booked: 0, spent: 0, shared: 0, due: 0 }]));
  let noCost = 0, unknownRate = new Set();
  for (const r of rows) {
    if (r.src === "item" && !r.m && !r.tbc) noCost++;
    if (r.m && r.home === null) unknownRate.add(r.m.cur);
    const c = cats[r.cat] || cats.other, v = r.home || 0;
    if (r.share === "theirs") continue;
    if (r.share === "split") { c.shared += v; continue; }
    if (r.src === "expense") c.spent += v; else c.booked += v;
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
      ${byDay[d].map((r) => `<button class="bl-row c-${r.cat}" data-exp="${r.id}"><span class="dot"></span><span class="bl-name">${esc(r.name)}${r.paidWith ? `<small>${esc(r.paidWith)}</small>` : ""}</span><span class="bl-amt">${money(r.m.amt, r.m.cur, 2)}${r.m.cur !== cur && r.home !== null ? `<small>${money(r.home, cur, 2)}</small>` : ""}</span></button>`).join("")}`).join("");
  const bk = B.rows.filter((r) => r.src !== "expense").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const bkHtml = bk.map((r) => `<button class="bl-row c-${r.cat}${!r.m ? " missing" : ""}" data-${r.src === "item" ? "bk" : "bact"}="${r.id}"><span class="dot"></span>
      <span class="bl-name">${esc(r.name)}<small>${r.date ? shortDate(r.date) + (r.end && r.end !== r.date ? " – " + shortDate(r.end) : "") : ""}${r.share !== "ours" ? " · " + SHARE[r.share] : ""}${r.planned ? " · not confirmed" : ""}${r.tbc ? " · to book" : ""}</small></span>
      <span class="bl-amt">${r.m ? money(r.m.amt, r.m.cur, 2) : (r.tbc ? "To book" : "Add cost")}${r.m && r.m.cur !== cur && r.home !== null ? `<small>${money(r.home, cur, 2)}</small>` : ""}${r.due ? `<small>+ ${money(r.due, cur, 2)} due</small>` : ""}</span></button>`).join("");
  root.innerHTML = `${header({ views: true })}
    <div class="bd">
      <section class="bd-sum">
        <div class="bd-total"><small>Trip cost so far</small><b>${money(total, cur)}</b>
          <span>${money(B.booked, cur)} booked · ${money(B.spent, cur)} spent</span></div>
        ${S.total ? `<div class="bar big${total > S.total ? " over" : ""}"><i style="width:${pct}%"></i></div><p class="bd-target">${pct}% of ${money(S.total, cur)} budget · ${total > S.total ? `${money(total - S.total, cur)} over` : `${money(S.total - total, cur)} left`}</p>` : `<p class="bd-target">No total budget set yet - add one in Budget Settings.</p>`}
        <div class="bd-chips">
          ${B.due ? `<span>Still to pay at properties <b>${money(B.due, cur)}</b></span>` : ""}
          ${B.shared ? `<span>Family shares to settle <b>${money(B.shared, cur)}</b></span>` : ""}
          ${B.noCost ? `<span class="warn">${B.noCost} booking${B.noCost > 1 ? "s" : ""} without a cost</span>` : ""}
          ${B.toBook ? `<span>${B.toBook} still to book</span>` : ""}
          ${B.unknownRate.length ? `<span class="warn">Add an exchange rate for ${B.unknownRate.join(", ")}</span>` : ""}
        </div>
        <div class="bd-acts"><button class="btn primary" data-add-exp>+ Add Expense</button><button class="btn" data-bsettings>Budget Settings</button></div>
      </section>
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
  root.querySelectorAll("[data-bk]").forEach((b) => (b.onclick = () => itemForm(store.items.find((i) => i.id === b.dataset.bk))));
  root.querySelectorAll("[data-bact]").forEach((b) => (b.onclick = () => entryForm(store.entries.find((e) => e.id === b.dataset.bact))));
  root.querySelectorAll("[data-bsettings]").forEach((b) => (b.onclick = budgetForm));
  root.querySelectorAll("[data-rates]").forEach((b) => (b.onclick = refreshRates));
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
const catLabel = (k) => (BCATS.find((c) => c[0] === k) || [k, k])[1];
const catVar = (k) => `var(--${k === "act" ? "act" : k})`;
// spread each cost over the trip days it covers: stays per night, cars per rental day, everything else on its date
function dailyCosts(B, spentOnly) {
  const ds = days(), idx = Object.fromEntries(ds.map((d, i) => [d, i])), out = ds.map(() => Object.fromEntries(CHART_ORDER.map((k) => [k, 0])));
  const put = (d, k, v) => { if (d in idx) out[idx[d]][k] += v; else if (ds.length) out[d < ds[0] ? 0 : ds.length - 1][k] += v; };
  for (const r of B.rows) {
    if (!r.home || r.share !== "ours" || (spentOnly && r.src !== "expense")) continue;
    const k = CHART_ORDER.includes(r.cat) ? r.cat : "other";
    if (r.src === "item" && (r.cat === "stay" || r.cat === "car") && r.end && r.end > r.date) {
      const n = dayDiff(r.date, r.end); for (let j = 0; j < n; j++) put(addDays(r.date, j), k, r.home / n);
    } else put(r.date, k, r.home);
  }
  return { ds, out };
}
const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; };
const kfmt = (v, cur) => (v >= 1000 ? `${money(v / 1000, cur, Number.isInteger(Math.round(v / 100) / 10) ? 0 : 1)}k` : money(v, cur));
const pctTxt = (v, t) => { const p = v / t * 100; return p > 0 && p < 1 ? "<1%" : Math.round(p) + "%"; };
function donutChart(B) {
  const cur = B.S.home, parts = CHART_ORDER.map((k) => ({ k, v: B.cats[k].booked + B.cats[k].spent })).filter((p) => p.v > 0);
  const total = parts.reduce((a, p) => a + p.v, 0); if (!total) return "";
  const R = 64, r = 42, cx = 80, cy = 80; let a0 = -Math.PI / 2;
  const arc = (a1, a2) => { const big = a2 - a1 > Math.PI ? 1 : 0, p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(a1, R)}A${R} ${R} 0 ${big} 1 ${p(a2, R)}L${p(a2, r)}A${r} ${r} 0 ${big} 0 ${p(a1, r)}Z`; };
  const segs = parts.map((p) => { const a1 = a0, a2 = a0 + p.v / total * Math.PI * 2 - (parts.length > 1 ? 0.0001 : 0.0002); a0 = a1 + p.v / total * Math.PI * 2;
    const tip = `${catLabel(p.k)}: ${money(p.v, cur)} (${pctTxt(p.v, total)})`;
    return parts.length === 1 ? `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${catVar(p.k)}" stroke-width="${R - r}" data-tip="${esc(tip)}"></circle>`
      : `<path d="${arc(a1, a2)}" style="fill:${catVar(p.k)};stroke:var(--card);stroke-width:2" data-tip="${esc(tip)}"></path>`; }).join("");
  return `<figure class="chart"><figcaption>Where the money goes</figcaption>
    <div class="donut-wrap"><svg viewBox="0 0 160 160" class="donut" role="img" aria-label="Costs by type">${segs}
      <text x="80" y="76" text-anchor="middle" class="d-lab">Total</text><text x="80" y="94" text-anchor="middle" class="d-val">${esc(kfmt(total, cur))}</text></svg>
    <ul class="legend">${parts.map((p) => `<li><i style="background:${catVar(p.k)}"></i><span>${catLabel(p.k)}</span><b>${money(p.v, cur)}</b><small>${pctTxt(p.v, total)}</small></li>`).join("")}</ul></div></figure>`;
}
function dailyChart(B) {
  const cur = B.S.home, spentOnly = ui.chartMode === "spent", { ds, out } = dailyCosts(B, spentOnly);
  const tot = out.map((o) => Object.values(o).reduce((a, b) => a + b, 0)), max = niceMax(Math.max(0, ...tot));
  const W = 340, H = 170, L = 38, T = 8, Bm = 22, cw = (W - L - 4) / Math.max(1, ds.length), bw = Math.max(3, Math.min(18, cw - 2)), ph = H - T - Bm;
  const y = (v) => T + ph - v / max * ph;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="g"></line><text x="${L - 5}" y="${y(max * f) + 3.5}" text-anchor="end" class="ax">${esc(kfmt(max * f, cur))}</text>`).join("");
  const bars = ds.map((d, i) => {
    const x = L + 2 + i * cw + (cw - bw) / 2; let acc = 0, segs = "";
    const ks = CHART_ORDER.filter((k) => out[i][k] > 0);
    ks.forEach((k, j) => { const v = out[i][k], y0 = y(acc), y1 = y(acc + v), h = Math.max(0, y0 - y1 - (j < ks.length - 1 ? 1.5 : 0)); acc += v;
      segs += j === ks.length - 1 ? `<path d="M${x} ${y0}V${y1 + Math.min(3, h / 2)}Q${x} ${y1} ${x + Math.min(3, bw / 2)} ${y1}H${x + bw - Math.min(3, bw / 2)}Q${x + bw} ${y1} ${x + bw} ${y1 + Math.min(3, h / 2)}V${y0}Z" style="fill:${catVar(k)}"></path>`
        : `<rect x="${x}" y="${y0 - h}" width="${bw}" height="${h}" style="fill:${catVar(k)}"></rect>`; });
    const tip = `${WD[D(d).getDay()].slice(0, 3)} ${shortDate(d)}: ${money(tot[i], cur)}${ks.length ? " · " + ks.map((k) => `${catLabel(k)} ${money(out[i][k], cur)}`).join(" · ") : ""}`;
    const lab = i === 0 || D(d).getDate() === 1 || D(d).getDay() === 1 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" class="ax">${D(d).getDate()}${i === 0 || D(d).getDate() === 1 ? " " + MON[D(d).getMonth()] : ""}</text>` : "";
    return `<g>${d === iso(new Date()) ? `<rect x="${L + 2 + i * cw}" y="${T}" width="${cw}" height="${ph}" rx="3" class="today-col"></rect>` : ""}${segs}<rect x="${L + 2 + i * cw}" y="${T}" width="${cw}" height="${ph}" fill="transparent" data-tip="${esc((d === iso(new Date()) ? "Today · " : "") + tip)}" data-day="${d}"></rect>${lab}</g>`;
  }).join("");
  const used = CHART_ORDER.filter((k) => out.some((o) => o[k] > 0));
  return `<figure class="chart"><figcaption>${spentOnly ? "Spending by day" : "Cost by day"}
      <span class="seg-mini"><button class="${spentOnly ? "" : "on"}" data-chart-mode="all">All costs</button><button class="${spentOnly ? "on" : ""}" data-chart-mode="spent">Spending only</button></span></figcaption>
    ${tot.some((v) => v) ? `<svg viewBox="0 0 ${W} ${H}" class="bars" role="img" aria-label="${spentOnly ? "Spending" : "Costs"} per trip day">${grid}${bars}</svg>
    <ul class="legend inline">${used.map((k) => `<li><i style="background:${catVar(k)}"></i><span>${catLabel(k)}</span></li>`).join("")}</ul>
    <p class="muted small">${spentOnly ? "Expenses you logged, by the day you spent them." : "Hotels and cars are spread across the nights / days they cover; flights and activities sit on their date."} Tap a bar to open that day.</p>`
    : `<p class="muted">${spentOnly ? "No expenses logged yet." : "No costs yet."}</p>`}</figure>`;
}
function cumulativeChart(B) {
  const cur = B.S.home, { ds, out } = dailyCosts(B, false); if (!ds.length) return "";
  let run = 0; const cum = out.map((o) => (run += Object.values(o).reduce((a, b) => a + b, 0)));
  if (!run) return "";
  const target = B.S.total, max = niceMax(Math.max(run, target || 0));
  const W = 340, H = 150, L = 38, T = 10, Bm = 20, ph = H - T - Bm, step = (W - L - 8) / Math.max(1, ds.length - 1);
  const x = (i) => L + 4 + i * step, y = (v) => T + ph - v / max * ph;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${L}" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" class="g"></line><text x="${L - 5}" y="${y(max * f) + 3.5}" text-anchor="end" class="ax">${esc(kfmt(max * f, cur))}</text>`).join("");
  const pts = cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const today = iso(new Date()), ti = ds.indexOf(today);
  const hits = ds.map((d, i) => `<rect x="${x(i) - step / 2}" y="${T}" width="${step}" height="${ph}" fill="transparent" data-tip="${esc(`${WD[D(d).getDay()].slice(0, 3)} ${shortDate(d)}: ${money(cum[i], cur)} so far${target ? ` · ${Math.round(cum[i] / target * 100)}% of budget` : ""}`)}" data-x="${x(i)}" data-y="${y(cum[i])}"></rect>`).join("");
  return `<figure class="chart"><figcaption>Running total${target ? " vs budget" : ""}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" class="line" role="img" aria-label="Cumulative trip cost${target ? " against the budget" : ""}">${grid}
      ${target ? `<line x1="${L}" x2="${W}" y1="${y(target)}" y2="${y(target)}" class="budget"></line><text x="${W - 2}" y="${y(target) - 4}" text-anchor="end" class="ax strong">Budget ${esc(kfmt(target, cur))}</text>` : ""}
      ${ti >= 0 ? `<line x1="${x(ti)}" x2="${x(ti)}" y1="${T}" y2="${T + ph}" class="today"></line>` : ""}
      <polyline points="${pts}" class="run"></polyline>
      <circle cx="${x(ds.length - 1)}" cy="${y(run)}" r="4" class="run-end"></circle>
      <text x="${x(ds.length - 1) - 6}" y="${y(run) + (y(run) < T + 14 ? 14 : -8)}" text-anchor="end" class="ax strong">${esc(kfmt(run, cur))}</text>
      <text x="${L + 4}" y="${H - 5}" class="ax">${shortDate(ds[0])}</text><text x="${W}" y="${H - 5}" text-anchor="end" class="ax">${shortDate(ds.at(-1))}</text>
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
  root.querySelectorAll(".chart [data-day]").forEach((el) => (el.onclick = () => { hide(); openDay(el.dataset.day); }));
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
function expenseForm(x) {
  const S = budgetSettings(), isNew = !x.id;
  const curs = [...new Set([S.home, ...Object.keys(S.rates), ...CURRENCIES])];
  modal(`<h3>${isNew ? "Add Expense" : "Edit Expense"}</h3>
    <label>What For<input name="text" value="${esc(x.text || "")}" placeholder="e.g. Dinner at Hartwood" required></label>
    <div class="row"><label>Amount<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${x.amount ?? ""}" required></label>
      <label>Currency<select name="currency">${curs.map((c) => `<option ${c === (x.currency || S.home) ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
    <div class="row"><label>Category<select name="cat">${BCATS.map(([k, l]) => `<option value="${k}" ${k === (x.cat || "food") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Date<input type="date" name="date" value="${x.date || defaultExpenseDate()}"></label></div>
    ${payField(x.paidWith)}
    ${whoBoxes(x.who || PEOPLE())}`,
    async (fd) => {
      const amount = parseFloat(fd.get("amount")); if (!(amount >= 0)) throw new Error("Enter an amount");
      await data.savePrivate(x.id || null, { kind: "expense", text: fd.get("text").trim(), amount, currency: fd.get("currency"), cat: fd.get("cat"), date: fd.get("date"), paidWith: readPay(fd), who: fd.getAll("who") });
    }, isNew ? null : () => data.deletePrivate(x.id));
  wirePay(document.querySelector(".sheet"));
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
  const form = document.querySelector(".sheet");
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
function areaOf(i) {
  if (i.area) return i.area;
  const parts = String(i.address || "").split(",").map((x) => x.trim()).filter(Boolean);
  const cand = parts.filter((x) => !/\d/.test(x) && !/^[A-Z]{2,3}$/.test(x) && !/^(USA|US|United States( of America)?|Mexico|México|Australia|Canada)$/i.test(x));
  return parts.length > 1 && cand.length ? cand.at(-1) : "";
}
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
  // flights: one rounded block per flight in the Flight column
  its.filter((i) => i.type === "flight").forEach((i) => {
    const s = Math.max(0, ix(i.start)), e = Math.min(N - 1, ix(i.end)); const c = codesOf(i.route);
    const lab = c.length ? `${c[0]}-${c.at(-1)}` : (i.number || "Flight");
    cells.push(`<button class="ov-fl${i.status === "tbc" ? " tbc" : ""}" data-day="${i.start}" style="grid-row:${s + 1} / ${e + 2}" title="${esc(c.join(" → "))}"><b>${esc(lab)}</b></button>`);
  });
  // stays and cars: one shape per booking (overlapping ones: the first is drawn, the label says +n)
  const shapes = [];
  const lab = (col, r1, r2, cls, d, title, sub) => cells.push(`<button class="ov-lab ${cls}" data-day="${d}" style="grid-column:${col};grid-row:${r1} / ${r2}">${title ? `<b>${esc(title)}</b>` : ""}${sub ? `<small>${esc(sub)}</small>` : ""}</button>`);
  [["stay", 3], ["car", 5]].forEach(([type, col]) => {
    const groups = overlapGroups(its.filter((i) => i.type === type)).sort((a, b) => a[0].start.localeCompare(b[0].start));
    groups.forEach((g, n) => {
      const i = g[0], extra = g.length > 1 ? ` +${g.length - 1}` : "";
      const s0 = ix(i.start), e0 = ix(i.end), cutTop = s0 < 0, cutBot = e0 > N - 1;
      const s = Math.max(0, s0), e = Math.min(N - 1, e0);
      shapes.push({ type, half: col === 3 ? 0 : 1, s, e, cutTop, cutBot, shade: n % 2, tbc: i.status === "tbc", day: i.start });
      const name = (type === "stay" ? (i.short || i.name) : (i.company || "Car")) + extra;
      const sub = type === "stay" ? areaOf(i) : (i.vehicle || "").replace(/\s*\(.*\)$/, "");
      const inLab = type === "car" ? placeCode(i.pickup) : "", outLab = type === "car" ? placeCode(i.dropoff) : "";
      const mid0 = cutTop ? s : s + 1, mid1 = cutBot ? e : e - 1, hasMid = mid1 >= mid0 && e > s;
      const tbc = i.status === "tbc" ? " (TBC)" : "";
      if (e === s) { lab(`${col} / span 2`, s + 1, s + 2, "", i.start, name + tbc, ""); return; }
      if (!cutTop) lab(`${col + 1} / span 1`, s + 1, s + 2, "half", i.start, hasMid ? inLab : name + tbc, "");
      if (hasMid) lab(`${col} / span 2`, mid0 + 1, mid1 + 2, "", addDays(i.start, cutTop ? 0 : 1), name + tbc, sub);
      if (!cutBot) lab(`${col} / span 1`, e + 1, e + 2, "half", i.end, hasMid ? outLab : (type === "stay" ? sub : outLab), "");
    });
  });
  const legend = others.length ? `<div class="ov-legend"><span class="muted">Traveling together with:</span>${others.map((o) => `<span><i style="background:${pcolor(o)}"></i>${esc(NAME(o))}</span>`).join("")}</div>` : "";
  root.innerHTML = `${header({ views: true })}
    <div class="ov"><div class="ov-card">
      <div class="ov-head"><span class="l">DAY</span><span class="k-flight">FLIGHT</span><span class="k-stay" style="grid-column:3 / span 2">STAY</span><span class="k-car" style="grid-column:5 / span 2">CAR</span></div>
      <div class="ov-grid" style="--n:${N}">${cells.join("")}<svg class="ov-svg" aria-hidden="true"></svg></div>
      ${legend}</div></div>`;
  ui.ovShapes = shapes; drawOverviewShapes();
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll");
  if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (ds.includes(today) && !ui.ovScrolled) { ui.ovScrolled = true; const el = root.querySelector(".ov-day.today"); if (el) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 200)); }
}
function drawOverviewShapes() {
  const svg = root.querySelector(".ov-svg"); if (!svg || !ui.ovShapes) return;
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
  const pathOf = (pts) => {   // shrink by INSET (even gap between neighbours), then round every corner
    const M = pts.length;
    const ins = pts.map((v, i) => {
      const a = unit(pts[(i - 1 + M) % M], v), b = unit(v, pts[(i + 1) % M]);
      const na = [-a[1], a[0]], nb = [-b[1], b[0]], k = 1 + na[0] * nb[0] + na[1] * nb[1];
      return [v[0] + INSET * (na[0] + nb[0]) / k, v[1] + INSET * (na[1] + nb[1]) / k];
    });
    return ins.map((v, i) => {
      const p0 = ins[(i - 1 + M) % M], q = ins[(i + 1) % M];
      const t = Math.min(R, Math.hypot(v[0] - p0[0], v[1] - p0[1]) / 2, Math.hypot(q[0] - v[0], q[1] - v[1]) / 2);
      const a = unit(p0, v), b = unit(v, q);
      return `${i ? "L" : "M"}${(v[0] - a[0] * t).toFixed(1)} ${(v[1] - a[1] * t).toFixed(1)}Q${v[0].toFixed(1)} ${v[1].toFixed(1)} ${(v[0] + b[0] * t).toFixed(1)} ${(v[1] + b[1] * t).toFixed(1)}`;
    }).join("") + "Z";
  };
  svg.innerHTML = ui.ovShapes.map((x) => {
    const fill = x.tbc ? "var(--card)" : `var(--${x.type}-t${x.shade ? "2" : ""})`;
    const stroke = x.tbc ? `stroke:var(--${x.type});stroke-width:1.5;stroke-dasharray:4 3;` : "";
    return `<path data-day="${x.day}" d="${pathOf(outline(x.half * (PAIR + GAP), x.s, x.e, x.cutTop, x.cutBot))}" style="fill:${fill};${stroke}"></path>`;
  }).join("");
  svg.querySelectorAll("[data-day]").forEach((el) => (el.onclick = () => openDay(el.dataset.day)));
}
window.addEventListener("resize", () => { if (ui.view === "overview" && !ui.day) drawOverviewShapes(); });
// swipe left / right on the itinerary to move between Overview, Timeline and Journey (phones)
(() => {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    ok = e.touches.length === 1 && !!ui.tripId && !document.querySelector(".modal") && !e.target.closest(".seg,.vseg,.daymap,.pop,input,textarea,select");
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
      if (date === i.start) steps.push({ k: "flight", time: cleanTime(i.dep), title: c.join(" → ") || "Flight", sub: [fl, i.arr && "lands " + i.arr].filter(Boolean).join(" · "), id: i.id });
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
  const comments = ents.filter((e) => e.kind === "comment");
  return { allDay, steps, comments, travel: steps.some((s) => s.k !== "act") };
}

// ---------------------------------------------------------------- Timeline view (one card per day)
function renderTimeline() {
  const p = ui.person, ds = days(), today = iso(new Date());
  const cards = ds.map((date) => {
    const { allDay, steps, comments, travel } = dayInfo(p, date);
    const w = withText(p, date);
    return `<section class="dcard${travel ? " travel" : ""}${date === today ? " today" : ""}" id="d-${date}" data-day="${date}" role="button" tabindex="0" aria-label="${WD[D(date).getDay()]} ${longDate(date)}">
      <div class="dc-head">
        <span class="dnum"><small>${WD3(date)}</small><b>${D(date).getDate()}</b></span>
        <span class="dc-title"><b>${WD[D(date).getDay()]} ${shortDate(date)}</b>${w ? `<small>${esc(w)}</small>` : ""}</span>
        ${date === today ? `<span class="tbadge now">Today</span>` : travel ? `<span class="tbadge">Travel Day</span>` : ""}
        ${isEditor() ? `<button class="iconbtn sm" data-add-on="${date}" aria-label="Add booking on ${shortDate(date)}" title="Add booking">${ICON.plus}</button>` : ""}
      </div>
      ${allDay.length ? `<div class="allday">${allDay.map((s) => `<span class="chip k-${s.k}${s.tbc ? " tbc" : ""}"><span class="ic">${ICON[s.k]}</span>${esc(s.title)}${s.sub ? ` <span class="cs">· ${esc(s.sub)}</span>` : ""}</span>`).join("")}</div>` : ""}
      ${steps.length ? `<ol class="steps">${steps.map((s) => `<li><span class="st-time">${esc(s.time) || "–"}</span><span class="st-dot k-${s.k}"></span>${pillHtml(s)}</li>`).join("")}</ol>` : ""}
      ${!allDay.length && !steps.length ? `<p class="dc-empty">Nothing booked yet</p>` : ""}
      ${comments.map((c) => `<p class="dcom">${ICON.chat}<span>${fmt(c.text)}</span></p>`).join("")}
    </section>`;
  }).join("");
  root.innerHTML = `${header({ views: true })}<div class="tl">${cards}</div>`;
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll");
  if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (ds.includes(today) && !ui.scrolled) { ui.scrolled = true; document.getElementById("d-" + today)?.scrollIntoView({ block: "start" }); }
}

// ---------------------------------------------------------------- Journey view (stays as stations, flights / cars as connectors)
function renderJourney() {
  const today = iso(new Date());
  const p = ui.person, ord = { flight: 0, car: 1, stay: 2 };
  const its = itemsFor(p).slice().sort((a, b) => a.start.localeCompare(b.start) || ord[a.type] - ord[b.type]);
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
          <button class="jcard${i.start <= today && today < i.end ? " today" : ""}" data-day="${i.start}"><b>${esc(i.name)}${i.status === "tbc" ? ` <span class="tbctag">TBC</span>` : ""}</b>
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
        <span class="jl-top"><b>${esc(title)}</b><span class="jl-date">${WD3(i.start)} ${D(i.start).getDate()}</span></span>
        <small>${esc(sub)}</small></button>${extra[i.id] ? `<div class="jdays">${chips(extra[i.id])}</div>` : ""}</div></li>`;
  }).join("");
  const t = store.trip;
  root.innerHTML = `${header({ views: true })}
    <ol class="journey">${stops || `<li class="jempty">No bookings yet${isEditor() ? " - add one with +" : ""}.</li>`}
      ${t ? `<li class="jrow station end"><span class="jnode k-home">${ICON.home}</span><div class="jn-body"><div class="jcard plain"><b>End of Trip</b><small>${WD[D(t.end).getDay()]} ${longDate(t.end)}</small></div></div></li>` : ""}</ol>`;
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll"); if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
  else if (!ui.jScrolled) { const el = root.querySelector(".jday.today, .jleg.today, .jcard.today"); if (el) { ui.jScrolled = true; window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 200)); } }
}
function wireDays() {
  root.querySelectorAll("[data-add-on]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation(); const date = b.dataset.addOn; const others = PEOPLE().filter((o) => o !== ui.person);
    itemForm({ type: "stay", who: [ui.person, ...others.filter((o) => together(ui.person, o, date))], start: date, end: addDays(date, 1), status: "booked" });
  }));
  root.querySelectorAll("[data-day]").forEach((el) => {
    el.onclick = (ev) => { if (ev.target.closest("[data-add-on]")) return; ev.stopPropagation(); openDay(el.dataset.day); };
    if (el.tagName !== "BUTTON") el.onkeydown = (e) => { if (e.key === "Enter") openDay(el.dataset.day); };
  });
}

function openDay(date) {
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
  return `<article class="icard k-${k}">
    <div class="ihead"><span class="ic">${ICON[k]}</span><span class="tag">${role}</span>${i.status === "tbc" ? `<span class="tbctag">TBC</span>` : ""}
      <span class="who idots" role="img" aria-label="${esc(i.who.map(NAME).join(", "))}">${ALL_CODES().filter((c) => i.who.includes(c)).concat(i.who.filter((c) => !ALL_CODES().includes(c))).map((w) => `<i class="tdot" style="--pc:${pcolor(w)}" title="${esc(NAME(w))}"></i>`).join("")}</span></div>
    <div class="ibody">${fmt(body)}</div>
    ${i.note ? `<div class="inote">${fmt(i.note)}</div>` : ""}
    ${pvHtml}
    <div class="ilinks">${mapLinks}${files.map(fileLink).join("")}</div>
    ${isEditor() ? `<div class="iacts"><button class="btn small" data-edit-item="${i.id}">Edit</button>
       <button class="btn small danger" data-del-item="${i.id}"><i class="ic16">${I.trash}</i>Delete</button>
       <label class="btn small"><i class="ic16">${I.clip}</i>Attach File<input type="file" hidden data-attach-item="${i.id}" multiple></label></div>` : ""}
  </article>`;
}
const LABELS = { confirmation: "Confirmation", tickets: "Tickets", seats: "Seats", cost: "Cost", paidWith: "Paid With", dueAtHotel: "Due at Hotel",
  cancel: "Cancellation", phone: "Phone", share: "Who Pays", host: "Host", checkIn: "Check-In", bags: "Bags", extras: "Extras", notes: "Notes" };
const cap = (w) => String(w || "").replace(/^./, (c) => c.toUpperCase());
const label = (k) => LABELS[k] || k;
const fileLink = (f) => `<button class="filelink" data-file="${f.id}"><i class="ic16">${I.file}</i>${esc(f.name)}</button>`;

function renderDay() {
  const p = ui.person, date = ui.day, ds = days();
  const idx = ds.indexOf(date);
  if (idx < 0) { ui.day = null; return render(); }
  const others = PEOPLE().filter((x) => x !== p);
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
  const entryLi = (e) => {
    const isAct = e.kind === "activity" && e.status !== "recommended";
    const mark = e.status === "recommended" ? "☆ " : !isAct ? "" : isEditor()
      ? `<label class="conf" title="Confirmed activities show in the itinerary"><input type="checkbox" data-confirm="${e.id}" ${e.confirmed ? "checked" : ""}></label>`
      : (e.confirmed ? "✓ " : "○ ");
    const efiles = isEditor() ? store.files.filter((f) => f.entryId === e.id) : [];
    return `<li class="entry st-${e.status} ${isAct ? (e.confirmed ? "is-conf" : "is-plan") : ""}">
      <div class="etext">${mark}${fmt(e.text)}${isAct && !e.confirmed ? ` <span class="planned">planned</span>` : ""}${ratingBadge(e.id)}
        ${(e.endDate && e.endDate !== e.date) ? `<span class="muted small"> (${fmtDate(e.date)} – ${fmtDate(e.endDate)})</span>` : ""}
        ${e.who.length < PEOPLE().length ? `<span class="whos">${e.who.map((w) => `<span class="t-init">${w}</span>`).join(" ")}</span>` : ""}</div>
      <div class="eacts">${e.place ? `<a class="ibtn pin" target="_blank" rel="noopener" href="${maps(e.place)}" title="Open in Google Maps" aria-label="Open in Google Maps">${I.pin}</a>` : ""}
        ${isEditor() ? `${e.status === "recommended" ? `<button class="btn tiny" data-plan="${e.id}">Add to Plan</button>` : ""}
        ${isAct ? `<label class="ibtn" title="Attach a booking / ticket - marks it confirmed" aria-label="Attach a booking or ticket">${I.clip}<input type="file" hidden data-attach-entry="${e.id}"></label>` : ""}
        <button class="btn tiny" data-edit-entry="${e.id}">Edit</button>
        <button class="ibtn danger" data-del-entry="${e.id}" title="Delete" aria-label="Delete">${I.trash}</button>` : ""}</div>
      ${efiles.length ? `<div class="efiles">${efiles.map(fileLink).join("")}</div>` : ""}</li>`; };
  root.innerHTML = `${header()}
  <div class="dayview">
    <div class="dayhead${date === iso(new Date()) ? " today" : ""}">
      <button class="nav" data-go="-1" ${idx === 0 ? "disabled" : ""}>‹</button>
      <div><div class="wd">${date === iso(new Date()) ? "Today · " : ""}${WD[D(date).getDay()]}</div><div class="dt">${longDate(date)}</div>${others.length ? `<div class="ddots" role="group" aria-label="Travelling with">${others.map((o) => { const on = together(p, o, date);
        return `<button class="dd${on ? " on" : ""}" ${isEditor() ? `data-with="${o}"` : "disabled"} aria-pressed="${on}" aria-label="${esc(NAME(o))}: ${on ? "travelling with " + esc(NAME(p)) : "not with " + esc(NAME(p))}" title="${esc(NAME(o))}${on ? " - together" : " - apart"}${isEditor() ? " (tap to change)" : ""}" style="--pc:${pcolor(o)};--pi:${inkOn(pcolor(o))}">${esc(o)}</button>`; }).join("")}</div>` : ""}</div>
      <button class="nav" data-go="1" ${idx === ds.length - 1 ? "disabled" : ""}>›</button>
    </div>
    

    <section><h3>Travel & Stays</h3>${its.length ? its.map((i) => itemCard(i, date)).join("") : `<p class="muted">No flights, hotels or cars today.</p>`}</section>

    <section><h3>Activities</h3>${isEditor() ? `<p class="muted small">Tick ☑ to confirm - only confirmed activities show in the itinerary. Attaching a booking confirms it.</p>` : ""}<ul class="entries">${acts.map(entryLi).join("") || `<li class="muted">Nothing planned yet.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="activity">+ Add Activity</button>` : ""}</section>

    ${recsHtml(p, date, recs.map(entryLi).join(""))}

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
        <button class="btn small" data-add-exp="${date}">+ Add Expense</button></section>`; })() : ""}
    ${isEditor() ? `<section><h3>Documents</h3>
      ${dayFiles.length ? `<div class="files">${dayFiles.map((f) => `<div class="frow">${fileLink(f)}<button class="btn tiny" data-del-file="${f.id}">Remove</button></div>`).join("")}</div>` : `<p class="muted">No documents for this day.</p>`}
      <label class="btn small">Upload for This Day<input type="file" hidden data-attach-day="${date}" multiple></label></section>` : ""}
    ${journalHtml(date)}
  </div>`;
  wireHeader();
  root.querySelector("[data-back]").onclick = () => routeTo(ui.tripId, null);
  if (isEditor()) wireBudget();
  wireJournal(date); wireRecs(p, date, others);
  root.querySelectorAll("[data-with]").forEach((b) => (b.onclick = async () => {
    const o = b.dataset.with, next = !together(p, o, date), auto = autoTogether(p, o, date);
    try { await data.setTogether(date, p, o, next === auto ? null : next); toast(`${NAME(o)} ${next ? "with" : "not with"} ${NAME(p)} on ${shortDate(date)}`); }
    catch (x) { toast("Couldn't save: " + (x.code || x.message)); }
  }));
  const mapBox = root.querySelector("#daymap");
  if (mapBox) drawDayMap(mapBox, mapPins, root.querySelector(".daymap-msg")).catch((x) => { mapBox.hidden = true; const m = root.querySelector(".daymap-msg"); if (m) m.textContent = "Map unavailable: " + x.message; });
  root.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { ui.slide = +b.dataset.go > 0 ? "from-right" : "from-left"; routeTo(ui.tripId, ds[idx + +b.dataset.go], true); }));
  root.querySelectorAll("[data-edit-item]").forEach((b) => (b.onclick = () => itemForm(store.items.find((i) => i.id === b.dataset.editItem))));
  root.querySelectorAll("[data-edit-entry]").forEach((b) => (b.onclick = () => entryForm(store.entries.find((e) => e.id === b.dataset.editEntry))));
  root.querySelectorAll("[data-new-entry]").forEach((b) => (b.onclick = () => entryForm({ kind: b.dataset.newEntry, date, endDate: date, who: [p, ...others.filter((o) => together(p, o, date))], status: "planned", confirmed: false, text: "", place: "" })));
  root.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => { const e = store.entries.find((x) => x.id === b.dataset.plan); data.saveEntry({ ...e, status: "planned", confirmed: false, date, endDate: date }); }));
  root.querySelectorAll("[data-confirm]").forEach((cb) => (cb.onchange = () => { const e = store.entries.find((x) => x.id === cb.dataset.confirm); data.saveEntry({ ...e, confirmed: cb.checked }); }));
  root.querySelectorAll("[data-del-entry]").forEach((b) => (b.onclick = () => { const e = store.entries.find((x) => x.id === b.dataset.delEntry);
    if (confirm(`Delete "${e.text}"${e.endDate && e.endDate !== e.date ? " (all its days)" : ""} for everyone?`)) data.deleteEntry(e.id); }));
  root.querySelectorAll("[data-del-item]").forEach((b) => (b.onclick = () => { const i = store.items.find((x) => x.id === b.dataset.delItem);
    const nm = i.type === "flight" ? `${i.route} ${i.number}` : i.type === "stay" ? i.name : `${i.company} car`;
    if (confirm(`Delete ${nm} (${fmtDate(i.start)} – ${fmtDate(i.end)}) and its attached documents for everyone?`)) data.deleteItem(i.id); }));
  root.querySelectorAll("[data-attach-entry]").forEach((inp) => (inp.onchange = async () => {
    const e = store.entries.find((x) => x.id === inp.dataset.attachEntry);
    await upload(inp.files, { entryId: e.id, date: e.date }); await data.saveEntry({ ...e, confirmed: true }); }));
  root.querySelectorAll("[data-file]").forEach((b) => (b.onclick = async () => { const f = store.files.find((x) => x.id === b.dataset.file); const w = window.open("", "_blank"); const u = await data.fileUrl(f); if (w) w.location = u; else location.href = u; }));
  root.querySelectorAll("[data-del-file]").forEach((b) => (b.onclick = () => { const f = store.files.find((x) => x.id === b.dataset.delFile); if (confirm(`Remove ${f.name}?`)) data.deleteFile(f); }));
  root.querySelectorAll("[data-attach-item]").forEach((inp) => (inp.onchange = () => upload(inp.files, { itemId: inp.dataset.attachItem })));
  root.querySelectorAll("[data-attach-day]").forEach((inp) => (inp.onchange = () => upload(inp.files, { date: inp.dataset.attachDay })));
}
// ------------------------------------------------------------------ recommendations
// Every stay location gets the best-rated things to do and places to eat from Google (Places API).
// Results are cached on the trip (so the family sees them too); a new or changed location is looked up automatically.
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
function recsHtml(p, date, notesHtml) {
  const locs = dayLocations(p, date);
  if (!locs.length && !notesHtml) return "";
  if (!locs.some((l) => l.key === ui.recLoc)) ui.recLoc = locs[0]?.key;
  const loc = locs.find((l) => l.key === ui.recLoc), rec = loc && (store.trip.recs || {})[loc.key];
  const tab = ui.recTab || "do", list = rec ? rec[tab] || [] : [];
  const added = (x) => store.entries.some((e) => e.kind === "activity" && e.date <= date && date <= (e.endDate || e.date) && (e.text === x.name || String(e.place || "").startsWith(x.name)));
  const shown = ui.recMore ? list : list.slice(0, 5);
  const row = (x, i) => `<li class="rec">
      <span class="rnum">${i + 1}</span>
      <div class="rmain"><a class="rname" href="${esc(x.url || maps(x.name + " " + x.address))}" target="_blank" rel="noopener">${esc(x.name)}</a>
        <div class="rsub"><span class="rstar">★ ${x.rating.toFixed(1)}</span><span class="muted">(${x.count.toLocaleString("en-AU")})</span>${x.type ? `<span class="muted">· ${esc(x.type)}</span>` : ""}</div></div>
      ${isEditor() ? (added(x) ? `<span class="radded">✓ In plan</span>` : `<button class="btn tiny" data-rec-add="${esc(x.id)}">+ Plan</button>`) : ""}</li>`;
  const busy = loc && recState.busy.has(loc.key);
  const anyBusy = locs.some((l) => recState.busy.has(l.key));
  return `<section class="recs"><h3 class="rhead"><span>Recommended${loc ? ` <span class="muted small">near ${esc(loc.area)}</span>` : ""}</span>
      ${isEditor() && locs.length ? `<button class="iconbtn rrefresh${anyBusy ? " spin" : ""}" data-rec-refresh ${anyBusy ? "disabled" : ""} aria-label="Search Google again for things to do and places to eat" title="Search again for things to do and places to eat">↻</button>` : ""}</h3>
    ${locs.length > 1 ? `<div class="seg-mini rlocs">${locs.map((l) => `<button class="${l.key === ui.recLoc ? "on" : ""}" data-rec-loc="${l.key}">${esc(l.area)}</button>`).join("")}</div>` : ""}
    ${notesHtml ? `<p class="rlabel">From Our Notes</p><ul class="entries">${notesHtml}</ul>` : ""}
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
const jui = { draft: {}, reply: null, edit: null, rate: {}, focus: null };
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
  const c = j.authorCode && pcolor(j.authorCode);
  const ini = (j.authorCode || (j.author || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3)).toUpperCase();
  return `<span class="javatar" style="${c ? `--pc:${c};color:${inkOn(c)}` : ""}">${esc(ini)}</span>`;
}
function composer(key, { placeholder, withRating, acts, value = "", rating = 0, actId = "", button = "Post" }) {
  const draft = jui.draft[key] ?? value;
  const r = jui.rate[key] ?? { rating, actId };
  return `<form class="jcomposer" data-jform="${key}">
    <textarea name="text" rows="${key === "new" ? 3 : 2}" maxlength="4000" placeholder="${placeholder}" data-jkey="${key}">${esc(draft)}</textarea>
    ${withRating && acts.length ? `<div class="jrate"><select name="act" aria-label="Activity to rate"><option value="">Rate an activity (optional)…</option>${acts.map((a) => `<option value="${a.id}" ${a.id === r.actId ? "selected" : ""}>${esc(a.text.replace(/\s*\n[\s\S]*/, "").slice(0, 60))}</option>`).join("")}</select>
      <span class="starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" class="${i <= r.rating ? "on" : ""}" data-star="${i}" aria-label="${i} star${i > 1 ? "s" : ""}">★</button>`).join("")}</span><input type="hidden" name="rating" value="${r.rating}"></div>` : ""}
    <div class="jfoot">${key !== "new" ? `<button type="button" class="btn tiny" data-jcancel>Cancel</button>` : ""}<button class="btn small primary">${button}</button></div></form>`;
}
function journalHtml(date) {
  const acts = dayActivities(date);
  const posts = (store.journal || []).filter((j) => j.date === date);
  const top = posts.filter((j) => !j.replyTo).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const replies = (id) => posts.filter((j) => j.replyTo === id).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const me = myAuthor();
  const actName = (id) => { const a = store.entries.find((e) => e.id === id); return a ? a.text.replace(/\s*\n[\s\S]*/, "").slice(0, 60) : "an activity"; };
  const post = (j, isReply) => jui.edit === j.id
    ? `<div class="jpost${isReply ? " reply" : ""}">${composer("edit:" + j.id, { placeholder: "", withRating: !isReply, acts, value: j.text, rating: j.rating || 0, actId: j.activityId || "", button: "Save" })}</div>`
    : `<div class="jpost${isReply ? " reply" : ""}">${avatar(j)}<div class="jn-body">
      <div class="jmeta"><b>${esc(j.author || "Someone")}</b><span class="muted small">${when(j.createdAt)}${j.updatedAt && j.createdAt && j.updatedAt.slice(0, 16) !== j.createdAt.slice(0, 16) ? " · edited" : ""}</span></div>
      ${j.activityId && j.rating ? `<div class="jrated">${STARS(j.rating)} <span class="small">${esc(actName(j.activityId))}</span></div>` : ""}
      ${j.text ? `<p class="jtext">${esc(j.text).replace(/\n/g, "<br>")}</p>` : ""}
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
      ${composer("new", { placeholder: "How was the day? Share a story, a tip or what you'd do again…", withRating: true, acts })}
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
    f.querySelector("[data-jcancel]")?.addEventListener("click", () => { delete jui.draft[key]; delete jui.rate[key]; jui.reply = jui.edit = null; jui.focus = null; rerender(); });
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const text = f.text.value.trim(), rating = +(hid?.value || 0), actId = sel?.value || "";
      if (rating && !actId) return toast("Pick which activity you're rating");
      if (actId && !rating) return toast("Tap the stars to rate it");
      if (!text && !rating) return toast("Write something first");
      const me = myAuthor();
      if (!me) { toast("Choose who's posting first"); sec.querySelector("[data-jauthor]").focus(); return; }
      const [mode, id] = key.split(":");
      const old = mode === "edit" ? store.journal.find((j) => j.id === id) : null;
      const post = old ? { ...old, text, ...(old.replyTo ? {} : { rating, activityId: actId }) }
        : { date, text, author: me.name, authorCode: me.code || "", device: DEVICE, ...(mode === "reply" ? { replyTo: id } : { rating, activityId: actId }) };
      if (!post.activityId) { delete post.activityId; delete post.rating; }
      f.querySelector("button.primary").disabled = true;
      try { await data.saveJournal(post); delete jui.draft[key]; delete jui.rate[key]; jui.reply = jui.edit = null; jui.focus = null; rerender(); toast(old ? "Saved" : "Posted"); }
      catch (x) { f.querySelector("button.primary").disabled = false; toast(x.code === "permission-denied" ? "The journal needs the new Firestore rules published" : "Couldn't post: " + (x.code || x.message)); }
    };
  });
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
  stay: [["name", "Hotel Name"], ["short", "Short Name (for the Itinerary)"], ["address", "Address"], ["checkin", "Check-In Time"], ["checkout", "Check-Out Time"]],
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
const whoBoxes = (who) => `<fieldset class="whobox"><legend>Who</legend>${PEOPLE().map((p) => `<label><input type="checkbox" name="who" value="${p}" ${who.includes(p) ? "checked" : ""}> ${p}</label>`).join("")}</fieldset>`;
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
  const privKeys = [...new Set([...PRIV_KEYS, ...Object.keys(pv)])].filter((k) => !["share", "updatedBy", "updatedAt", "kind"].includes(k));
  const statusSel = (st) => `<label>Status<select name="status"><option value="booked" ${st !== "tbc" ? "selected" : ""}>Booked</option><option value="tbc" ${st === "tbc" ? "selected" : ""}>TBC</option></select></label>`;
  modal(`<h3>${isNew ? "Add Booking" : "Edit " + cap(item.type)}</h3>${PDF_BTN}${typeSel}
    ${whoBoxes(item.who || [ui.person])}
    <div class="row"><label>From<input type="date" name="start" value="${item.start || ""}" required></label><label>To<input type="date" name="end" value="${item.end || ""}" required></label></div>
    <div id="typeFields">${fieldsFor(item.type || "stay")}</div>
    <div id="statusBox">${item.type !== "flight" ? statusSel(item.status) : ""}</div>
    <label>Note (Visible to Family)<input name="note" value="${esc(item.note || "")}"></label>
    <details class="privbox" ${Object.keys(pv).length ? "open" : ""}><summary>Private Details (Editors Only)</summary>
      ${privKeys.map((k) => k === "paidWith" ? payField(pv.paidWith, "priv.paidWith") : `<label>${esc(label(k))}<input name="priv.${k}" value="${esc(pv[k] || "")}"></label>`).join("")}
      <label>Who Pays<select name="priv.share">${Object.entries(SHARE).map(([k, l]) => `<option value="${k}" ${(pv.share || "ours") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></details>`,
    async (fd, form) => {
      const type = fd.get("type") || item.type;
      const out = { ...item, type, who: fd.getAll("who"), start: fd.get("start"), end: fd.get("end"), note: fd.get("note"), status: fd.get("status") || item.status || "booked" };
      FIELDS[type].forEach(([k]) => (out[k] = fd.get(k) ?? ""));
      if (!out.who.length) throw new Error("Pick at least one person");
      if (out.end < out.start) throw new Error("'To' is before 'From'");
      let priv = {}; for (const [k, v] of fd.entries()) if (k.startsWith("priv.") && v) priv[k.slice(5)] = v;
      delete priv.paidWithOther; const pw = readPay(fd, "priv.paidWith"); if (pw) priv.paidWith = pw; else delete priv.paidWith;
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
    }, isNew ? null : () => data.deleteItem(item.id));
  const form = document.querySelector(".sheet");
  const sel = form.querySelector("select[name=type]");
  wirePay(form);
  const switchType = (t, src) => {
    form.querySelector("#typeFields").innerHTML = fieldsFor(t, src);
    form.querySelector("#statusBox").innerHTML = t !== "flight" ? statusSel(src.status) : "";
  };
  if (sel) sel.onchange = () => switchType(sel.value, item);
  wireExtract(form, () => (sel ? sel.value : item.type), (r) => {
    let t = sel ? sel.value : item.type;
    if (sel && r.type && ["flight", "stay", "car"].includes(r.type) && r.type !== t) { t = r.type; sel.value = t; switchType(t, {}); }
    FIELDS[t].forEach(([k]) => setVal(form, k, r[k]));
    setVal(form, "start", r.start); setVal(form, "end", r.end || r.start); setVal(form, "note", r.note);
    if (Array.isArray(r.who) && r.who.length) form.querySelectorAll("input[name=who]").forEach((cb) => (cb.checked = r.who.includes(cb.value)));
    const p = r.private || {};
    for (const [k, v] of Object.entries(p)) {
      if (!v) continue;
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
      <label>Who Pays<select name="pshare">${Object.entries(SHARE).map(([k, l]) => `<option value="${k}" ${(store.priv[e.id]?.share || "ours") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></details>` : ""}`,
    async (fd, form) => {
      const out = { ...e, text: fd.get("text").trim(), place: fd.get("place") ?? e.place ?? "", status: fd.get("status") || "planned", confirmed: e.kind === "activity" ? (fd.get("confirmed") === "on" || !!form._pendingFile) && fd.get("status") !== "recommended" : true,
                    date: fd.get("date"), endDate: fd.get("endDate") || fd.get("date"), who: fd.getAll("who") };
      if (!out.who.length) throw new Error("Pick at least one person");
      const id = await data.saveEntry(out);
      const pc = (fd.get("pcost") || "").trim(), had = store.priv[id] || store.priv[e.id];
      if (pc || had?.cost) await data.savePrivate(id, { ...(had || {}), cost: pc, share: fd.get("pshare") || "ours" });
      if (form._pendingFile) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { entryId: id, date: out.date }); toast("Saved and confirmed, with file attached"); }
    }, isNew ? null : () => data.deleteEntry(e.id));
  const form = document.querySelector(".sheet");
  wireExtract(form, () => "activity", (r) => {
    const txt = [r.text || r.name, r.time ? "at " + r.time : ""].filter(Boolean).join(" ");
    setVal(form, "text", txt); setVal(form, "place", r.place || r.address); setVal(form, "pcost", r.private?.cost); setVal(form, "date", r.start || r.date); setVal(form, "endDate", r.end || r.start || r.date);
    if (Array.isArray(r.who) && r.who.length) form.querySelectorAll("input[name=who]").forEach((cb) => (cb.checked = r.who.includes(cb.value)));
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
      <label>To<input type="date" name="to" value="${t.end}" min="${t.start}" max="${t.end}" required></label></div>`, async (fd) => {
      const from = fd.get("from"), to = fd.get("to");
      if (from > to) { toast("'From' must be before 'To'"); throw Object.assign(new Error(""), { back: true }); }
      toast("Building the album…");
      const docx = await import("https://cdn.jsdelivr.net/npm/docx@9.5.1/+esm");
      const doc = buildAlbum(docx, { trip: t, items: store.items, entries: store.entries, journal: store.journal }, { from, to });
      const blob = await docx.Packer.toBlob(doc);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `${(t.title || "Trip").replace(/&/g, "and").replace(/[^\w\- ]+/g, "").replace(/\s+/g, " ").trim()} Album ${from}${to !== from ? " to " + to : ""}.docx`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const b = document.querySelector(".modal button.primary"); if (b) b.textContent = "Download";
  },
  import: () => {
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/json,.json";
    inp.onchange = async () => {
      try { const seed = JSON.parse(await inp.files[0].text());
        if (store.items.length && !confirm("Import will add/overwrite bookings and activities with the file's contents. Continue?")) return;
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
