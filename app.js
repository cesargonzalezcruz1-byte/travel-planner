import * as data from "./data.js";
import { drawDayMap, mapsReady } from "./map.js";
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

let ui = { person: localStorage.getItem("tp.person") || "", day: null, tripId: null, swap: {}, view: "timeline" };
try { if (localStorage.getItem("tp.view") === "journey") ui.view = "journey"; } catch (e) { /* ignore */ }
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
const together = (a, b, date) => { const ka = nightKey(a, date); return ka !== null && ka === nightKey(b, date); };

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
  if (!store.ready) { root.innerHTML = `<div class="loading">Loading…</div>`; return; }
  if (!store.role) return renderLogin();
  if (store.role === "none") return renderNoAccess();
  if (!ui.tripId) { data.openTrip(null); return renderHome(); }
  data.openTrip(ui.tripId);
  if (!store.trip && !store.items.length) return renderEmpty();
  if (!PEOPLE().includes(ui.person)) ui.person = PEOPLE()[0];
  if (!ui.person) return renderEmpty();
  if (ui.day) renderDay(); else if (ui.view === "journey") renderJourney(); else renderTimeline();
}

function renderLogin(err = "") {
  root.innerHTML = `
  <div class="login">
    <h1 class="title-red">Travel Planner</h1>
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
  root.innerHTML = `<div class="login"><h1 class="title-red">Travel Planner</h1>
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
      <div class="tc-people">${(t.travellers || []).map((p) => `<span class="pchip"><b>${esc(p.code)}</b> ${esc(p.name || "")}</span>`).join("")}</div>
      ${isEditor() ? `<div class="tc-acts"><button class="btn tiny" data-settings="${esc(t.id)}">Setup</button></div>` : ""}
    </article>`;
  };
  root.innerHTML = `<header class="top"><div class="brand"><span class="title-red">Travel Planner</span>
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
  const row = (p, kind) => `<div class="prow" data-kind="${kind}">
      <input class="pcode" placeholder="Initials" maxlength="6" value="${esc(p.code || "")}" required>
      <input class="pname" placeholder="Name" value="${esc(p.name || "")}" ${kind === "t" ? "required" : ""}>
      <input class="pfull" placeholder="Full Name (as on Bookings)" value="${esc(p.fullName || "")}">
      <button type="button" class="btn tiny danger" data-rm title="Remove">✕</button></div>`;
  modal(`<h3>${isNew ? "New Trip" : "Trip Setup"}</h3>
    <label>Trip Name<input name="title" value="${esc(t.title)}" placeholder="e.g. Japan 2027" required></label>
    <div class="row"><label>Start<input type="date" name="start" value="${t.start || ""}" required></label><label>End<input type="date" name="end" value="${t.end || ""}" required></label></div>
    <fieldset class="pbox"><legend>Travellers (Each Gets Their Own Itinerary)</legend>
      <div id="trav">${(t.travellers || []).map((p) => row(p, "t")).join("")}</div>
      <button type="button" class="btn tiny" data-addp="t">+ Add Traveller</button></fieldset>
    <fieldset class="pbox"><legend>Others Joining Sometimes (Optional)</legend>
      <div id="ext">${(t.extended || []).map((p) => row(p, "e")).join("")}</div>
      <button type="button" class="btn tiny" data-addp="e">+ Add Person</button></fieldset>
    <p class="muted small">Initials are how people appear in the itinerary (e.g. CGC). Full names help the AI match names on bookings.</p>`,
    async (fd, form) => {
      const read = (kind) => [...form.querySelectorAll(`.prow[data-kind="${kind}"]`)].map((r) => ({
        code: r.querySelector(".pcode").value.trim().toUpperCase(), name: r.querySelector(".pname").value.trim(), fullName: r.querySelector(".pfull").value.trim() }))
        .filter((p) => p.code).map((p) => (p.fullName ? p : { code: p.code, name: p.name }));
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
      const id = await data.saveTrip({ title: fd.get("title").trim(), start: fd.get("start"), end: fd.get("end"), travellers, extended }, isNew ? null : t.id);
      if (isNew) { ui.person = travellers[0].code; localStorage.setItem("tp.person", ui.person); routeTo(id); }
    }, isNew ? null : async () => {
      const typed = prompt(`This deletes "${t.title}" with all its bookings, activities and documents for everyone. Type DELETE to confirm.`);
      if (typed !== "DELETE") throw new Error("Not deleted");
      await data.deleteTrip(t.id); routeTo(null);
    });
  const form = document.querySelector(".sheet");
  form.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]"); if (rm) rm.closest(".prow").remove();
    const add = e.target.closest("[data-addp]"); if (add) form.querySelector(add.dataset.addp === "t" ? "#trav" : "#ext").insertAdjacentHTML("beforeend", row({}, add.dataset.addp));
  });
}

// ---------------------------------------------------------------- icons + type colours (same everywhere)
const SV = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
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
};
const KIND = { flight: "flight", stay: "stay", car: "car", activity: "act", act: "act" };
const shortDate = (s) => { const d = D(s); return `${d.getDate()} ${MON[d.getMonth()]}`; };
const WD3 = (s) => WD[D(s).getDay()].slice(0, 3).toUpperCase();
const minus1 = (t) => { const [h, m] = t.split(":").map(Number); const x = Math.max(0, h * 60 + (m || 0) - 1); return String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"); };
const cleanTime = (t) => String(t || "").replace(/\s*\(.*\)\s*$/, "").trim();
const codesOf = (route) => String(route || "").split(/[-–>]+/).map((c) => c.trim()).filter(Boolean);
const withText = (p, date) => { const w = PEOPLE().filter((o) => o !== p && together(p, o, date)).map(NAME); return w.length ? "With " + w.join(" & ") : ""; };

function header(opts = {}) {
  const t = store.trip || {}; const today = iso(new Date());
  const when = !t.start ? "" : t.start > today ? `In ${dayDiff(today, t.start)} days` : today <= t.end ? "On now" : "";
  const sub = [NAME(ui.person), t.start ? `${shortDate(t.start)} – ${shortDate(t.end)}` : "", when].filter(Boolean).join(" · ");
  return `<header class="hero">
    <div class="hero-top">
      <button class="iconbtn" data-home aria-label="All trips" title="All trips">${ICON.menu}</button>
      <div class="hero-title"><span class="hero-sub">${esc(sub)}</span><span class="hero-name">${esc(t.title || "Travel Planner")}</span></div>
      ${isEditor() ? `<button class="iconbtn" data-act="add" aria-label="Add booking" title="Add booking">${ICON.plus}</button>` : ""}
      <details class="more"><summary class="iconbtn" aria-label="More">${ICON.dots}</summary><div class="pop">
        <span class="pop-role">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span>
        ${isEditor() ? `<button data-act="settings">Trip Setup</button><button data-act="import">Import Trip Data</button><button data-act="export">Download Backup</button>` : ""}
        <button data-act="signout">Sign Out</button></div></details>
    </div>
    <nav class="seg people" aria-label="Traveller">${PEOPLE().map((p) => `<button class="${p === ui.person ? "on" : ""}" data-person="${p}">${esc(NAME(p))}</button>`).join("")}</nav>
    ${opts.views ? `<nav class="seg views" aria-label="View">${[["timeline", "Timeline"], ["journey", "Journey"]].map(([k, l]) => `<button class="${ui.view === k ? "on" : ""}" data-view="${k}">${l}</button>`).join("")}</nav>` : ""}
  </header>
  ${store.error ? `<div class="banner err">${esc(store.error)}</div>` : ""}`;
}
function wireHeader() {
  root.querySelectorAll("[data-person]").forEach((b) => (b.onclick = () => { ui.person = b.dataset.person; localStorage.setItem("tp.person", ui.person); render(); }));
  root.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { ui.view = b.dataset.view; try { localStorage.setItem("tp.view", ui.view); } catch (e) { /* ignore */ } sessionStorage.removeItem("tp.wscroll"); render(); }));
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.(b)));
  root.querySelectorAll("[data-home]").forEach((b) => (b.onclick = () => routeTo(null)));
}
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
  const p = ui.person, ord = { flight: 0, car: 1, stay: 2 };
  const its = itemsFor(p).slice().sort((a, b) => a.start.localeCompare(b.start) || ord[a.type] - ord[b.type]);
  const actText = (date) => entriesFor(p, date).find((e) => e.kind === "activity" && e.status !== "recommended" && e.confirmed)?.text || "";
  const stops = its.map((i) => {
    if (i.type === "stay") {
      const N = dayDiff(i.start, i.end); const inner = [];
      for (let d = addDays(i.start, 1); d < i.end; d = addDays(d, 1)) inner.push(d);
      return `<li class="jrow station${i.status === "tbc" ? " tbc" : ""}">
        <span class="jnode k-stay">${ICON.stay}</span>
        <div class="jbody">
          <button class="jcard" data-day="${i.start}"><b>${esc(i.name)}${i.status === "tbc" ? ` <span class="tbctag">TBC</span>` : ""}</b>
            <small>${shortDate(i.start)} – ${shortDate(i.end)} · ${N} night${N === 1 ? "" : "s"}${i.address ? " · " + esc(i.address) : ""}</small></button>
          ${inner.length ? `<div class="jdays">${inner.map((d) => { const a = actText(d); return `<button class="jday" data-day="${d}"><span class="jd">${WD3(d).slice(0, 3)} ${D(d).getDate()}</span>${a ? `<span class="jdot"></span><span class="jt">${esc(a)}</span>` : ""}</button>`; }).join("")}</div>` : ""}
        </div></li>`;
    }
    const isF = i.type === "flight", k = isF ? "flight" : "car";
    const title = isF ? `${codesOf(i.route).join(" → ")}` : `${i.company || "Car"}${i.pickup ? " · " + i.pickup : ""}`;
    const sub = isF ? [[i.airline, i.number].filter(Boolean).join(" "), [cleanTime(i.dep), i.arr].filter(Boolean).join(" – ")].filter(Boolean).join(" · ")
      : [i.vehicle && i.vehicle.replace(/\s*\(.*\)$/, ""), `until ${shortDate(i.end)}`, i.dropoff && i.dropoff !== i.pickup ? "return " + i.dropoff : ""].filter(Boolean).join(" · ");
    return `<li class="jrow leg">
      <span class="jnode k-${k}">${ICON[k]}</span>
      <div class="jbody"><button class="jleg k-${k}${i.status === "tbc" ? " tbc" : ""}" data-day="${i.start}">
        <span class="jl-top"><b>${esc(title)}</b><span class="jl-date">${WD3(i.start)} ${D(i.start).getDate()}</span></span>
        <small>${esc(sub)}</small></button></div></li>`;
  }).join("");
  const t = store.trip;
  root.innerHTML = `${header({ views: true })}
    <ol class="journey">${stops || `<li class="jempty">No bookings yet${isEditor() ? " - add one with +" : ""}.</li>`}
      ${t ? `<li class="jrow station end"><span class="jnode k-home">${ICON.home}</span><div class="jbody"><div class="jcard plain"><b>End of Trip</b><small>${WD[D(t.end).getDay()]} ${longDate(t.end)}</small></div></div></li>` : ""}</ol>`;
  wireHeader(); wireDays();
  const back = sessionStorage.getItem("tp.wscroll"); if (back) { window.scrollTo(0, +back); sessionStorage.removeItem("tp.wscroll"); }
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
  const mapLinks = Array.isArray(mapQ) ? mapQ.map((q) => `<a class="maplink" target="_blank" rel="noopener" href="${maps(q)}">📍 ${esc(q.replace(" airport", ""))}</a>`).join("")
                                       : (i.status !== "tbc" && mapQ ? `<a class="maplink" target="_blank" rel="noopener" href="${maps(mapQ)}">📍 Open in Google Maps</a>` : "");
  const pv = isEditor() ? store.priv[i.id] : null;
  const pvHtml = pv && Object.keys(pv).length ? `<dl class="priv">${Object.entries(pv).filter(([, v]) => v).map(([k, v]) => `<dt>${esc(label(k))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "";
  const files = isEditor() ? store.files.filter((f) => f.itemId === i.id) : [];
  const k = KIND[i.type];
  return `<article class="icard k-${k}">
    <div class="ihead"><span class="ic">${ICON[k]}</span><span class="tag">${role}</span>${i.status === "tbc" ? `<span class="tbctag">TBC</span>` : ""}
      <span class="who">${i.who.map((w) => `<span class="t-init">${w}</span>`).join(" ")}</span></div>
    <div class="ibody">${fmt(body)}</div>
    ${i.note ? `<div class="inote">${fmt(i.note)}</div>` : ""}
    ${pvHtml}
    <div class="ilinks">${mapLinks}${files.map(fileLink).join("")}</div>
    ${isEditor() ? `<div class="iacts"><button class="btn small" data-edit-item="${i.id}">Edit</button>
       <button class="btn small danger" data-del-item="${i.id}">🗑 Delete</button>
       <label class="btn small">Attach File<input type="file" hidden data-attach-item="${i.id}" multiple></label></div>` : ""}
  </article>`;
}
const LABELS = { confirmation: "Confirmation", tickets: "Tickets", seats: "Seats", cost: "Cost", paidWith: "Paid With", dueAtHotel: "Due at Hotel",
  cancel: "Cancellation", phone: "Phone", host: "Host", checkIn: "Check-In", bags: "Bags", extras: "Extras", notes: "Notes" };
const cap = (w) => String(w || "").replace(/^./, (c) => c.toUpperCase());
const label = (k) => LABELS[k] || k;
const fileLink = (f) => `<button class="filelink" data-file="${f.id}">📄 ${esc(f.name)}</button>`;

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
  const COLOR = { flight: "#1F5FBF", stay: "#B4530A", car: "#1E7A4E", act: "#6A3FB5" };
  const pins = [];
  const apt = (c) => (/^[A-Z]{3}$/.test(c.trim()) ? c.trim() + " airport" : c.trim());
  its.forEach((i) => {
    if (i.type === "flight") {
      const codes = codesOf(i.route);
      const todays = i.start === i.end ? codes : date === i.start ? codes.slice(0, -1) : date === i.end ? codes.slice(-1) : [];
      todays.forEach((c) => pins.push({ q: apt(c), name: c, kind: "Airport" + (i.number ? " · " + i.number : ""), glyph: "✈", color: COLOR.flight }));
    } else if (i.type === "stay") {
      if (i.address || i.name) pins.push({ q: i.address || i.name, name: i.short || i.name, kind: i.status === "tbc" ? "Hotel (TBC)" : "Hotel", glyph: "🛏", color: COLOR.stay, hollow: i.status === "tbc" });
    } else if (i.type === "car") {
      const at = (loc, what) => loc && pins.push({ q: [i.company, apt(loc)].filter(Boolean).join(" "), name: `${i.company || "Car"} ${loc}`, kind: what, glyph: "🚗", color: COLOR.car });
      if (date === i.start) at(i.pickup, "Car Pick-Up" + (i.pickupTime ? " " + i.pickupTime : ""));
      if (date === i.end) at(i.dropoff, "Car Drop-Off" + (i.dropoffTime ? " " + i.dropoffTime : ""));
    }
  });
  ents.filter((e) => e.kind === "activity" && e.place).forEach((e) => {
    const ok = e.confirmed && e.status !== "recommended";
    pins.push({ q: e.place, name: e.place, kind: ok ? "Confirmed Activity" : e.status === "recommended" ? "Recommended" : "Planned - Not Confirmed", glyph: ok ? "★" : "☆", color: COLOR.act, hollow: !ok });
  });
  const places = pins.filter((x) => !x.hollow).map((x) => [x.name, x.q]);
  const dayFiles = isEditor() ? store.files.filter((f) => f.date === date || (f.itemId && its.some((i) => i.id === f.itemId)) || (f.entryId && ents.some((e) => e.id === f.entryId))) : [];
  const route = places.length >= 2 ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(places[0][1])}&destination=${encodeURIComponent(places.at(-1)[1])}${places.length > 2 ? "&waypoints=" + encodeURIComponent(places.slice(1, -1).map((x) => x[1]).join("|")) : ""}` : "";
  const entryLi = (e) => {
    const isAct = e.kind === "activity" && e.status !== "recommended";
    const mark = e.status === "recommended" ? "☆ " : !isAct ? "" : isEditor()
      ? `<label class="conf" title="Confirmed activities show in the itinerary"><input type="checkbox" data-confirm="${e.id}" ${e.confirmed ? "checked" : ""}></label>`
      : (e.confirmed ? "✓ " : "○ ");
    const efiles = isEditor() ? store.files.filter((f) => f.entryId === e.id) : [];
    return `<li class="entry ${e.status} ${isAct ? (e.confirmed ? "is-conf" : "is-plan") : ""}">
      <div class="etext">${mark}${fmt(e.text)}${isAct && !e.confirmed ? ` <span class="planned">planned</span>` : ""}
        ${(e.endDate && e.endDate !== e.date) ? `<span class="muted small"> (${fmtDate(e.date)} – ${fmtDate(e.endDate)})</span>` : ""}
        ${e.who.length < PEOPLE().length ? `<span class="whos">${e.who.map((w) => `<span class="t-init">${w}</span>`).join(" ")}</span>` : ""}</div>
      <div class="eacts">${e.place ? `<a class="maplink" target="_blank" rel="noopener" href="${maps(e.place)}">📍</a>` : ""}
        ${isEditor() ? `${e.status === "recommended" ? `<button class="btn tiny" data-plan="${e.id}">Add to Plan</button>` : ""}
        ${isAct ? `<label class="btn tiny" title="Attach a booking / ticket - marks it confirmed">📎<input type="file" hidden data-attach-entry="${e.id}"></label>` : ""}
        <button class="btn tiny" data-edit-entry="${e.id}">Edit</button>
        <button class="btn tiny danger" data-del-entry="${e.id}" title="Delete">🗑</button>` : ""}</div>
      ${efiles.length ? `<div class="efiles">${efiles.map(fileLink).join("")}</div>` : ""}</li>`; };
  root.innerHTML = `${header()}
  <div class="dayview">
    <div class="dayhead">
      <button class="nav" data-go="-1" ${idx === 0 ? "disabled" : ""}>‹</button>
      <div><div class="wd">${WD[D(date).getDay()]}</div><div class="dt">${longDate(date)}</div></div>
      <button class="nav" data-go="1" ${idx === ds.length - 1 ? "disabled" : ""}>›</button>
    </div>
    <button class="btn back" data-back>← ${ui.view === "journey" ? "Journey" : "Timeline"}</button>
    <div class="withrow"><span class="muted">With ${esc(NAME(p))} tonight:</span>
      ${others.map((o) => together(p, o, date) ? `<span class="pill yes">☑ <span class="t-init">${o}</span> ${esc(NAME(o))}</span>` : `<span class="pill no">☐ ${o}</span>`).join("")}</div>

    <section><h3>Travel & Stays</h3>${its.length ? its.map((i) => itemCard(i, date)).join("") : `<p class="muted">No flights, hotels or cars today.</p>`}</section>

    <section><h3>Activities</h3>${isEditor() ? `<p class="muted small">Tick ☑ to confirm - only confirmed activities show in the itinerary. Attaching a booking confirms it.</p>` : ""}<ul class="entries">${acts.map(entryLi).join("") || `<li class="muted">Nothing planned yet.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="activity">+ Add Activity</button>` : ""}</section>

    ${recs.length ? `<section><h3>Recommended</h3><ul class="entries">${recs.map(entryLi).join("")}</ul></section>` : ""}

    <section><h3>Comments</h3><ul class="entries">${coms.map(entryLi).join("") || `<li class="muted">No comments.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="comment">+ Add Comment</button>` : ""}</section>

    <section><h3>Map</h3>
      ${pins.length ? `${mapsReady() ? `<div class="daymap" id="daymap"></div><p class="daymap-msg muted small"></p>` : isEditor() ? `<p class="muted small">The embedded map isn't set up yet (needs a Google Maps key).</p>` : ""}
      <div class="maplegend"><span><i style="background:${COLOR.flight}"></i>Flight</span><span><i style="background:${COLOR.stay}"></i>Stay</span><span><i style="background:${COLOR.car}"></i>Car</span><span><i style="background:${COLOR.act}"></i>Activity</span><span><i class="hollow" style="border-color:${COLOR.act}"></i>Recommended / Not Confirmed</span></div>
      <ul class="places">${pins.map((x) => `<li><a class="maplink" target="_blank" rel="noopener" href="${maps(x.q)}"><i class="pdot${x.hollow ? " hollow" : ""}" style="--pin:${x.color}">${x.glyph}</i> ${esc(x.name)} <span class="muted small">${esc(x.kind)}</span></a></li>`).join("")}</ul>` : `<p class="muted">No places for this day.</p>`}
      ${route ? `<a class="btn small" target="_blank" rel="noopener" href="${route}">🗺 Day Route in Google Maps</a>` : ""}</section>

    ${isEditor() ? `<section><h3>Documents</h3>
      ${dayFiles.length ? `<div class="files">${dayFiles.map((f) => `<div class="frow">${fileLink(f)}<button class="btn tiny" data-del-file="${f.id}">Remove</button></div>`).join("")}</div>` : `<p class="muted">No documents for this day.</p>`}
      <label class="btn small">Upload for This Day<input type="file" hidden data-attach-day="${date}" multiple></label></section>` : ""}
  </div>`;
  wireHeader();
  root.querySelector("[data-back]").onclick = () => routeTo(ui.tripId, null);
  const mapBox = root.querySelector("#daymap");
  if (mapBox) drawDayMap(mapBox, pins, root.querySelector(".daymap-msg")).catch((x) => { mapBox.hidden = true; const m = root.querySelector(".daymap-msg"); if (m) m.textContent = "Map unavailable: " + x.message; });
  root.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => routeTo(ui.tripId, ds[idx + +b.dataset.go], true)));
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
const PDF_BTN = `<div class="extract"><label class="btn small pdfbtn">📄 Fill from PDF or Photo<input type="file" hidden accept="application/pdf,image/*" data-extract></label>
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
  const privKeys = [...new Set([...PRIV_KEYS, ...Object.keys(pv)])];
  const statusSel = (st) => `<label>Status<select name="status"><option value="booked" ${st !== "tbc" ? "selected" : ""}>Booked</option><option value="tbc" ${st === "tbc" ? "selected" : ""}>TBC</option></select></label>`;
  modal(`<h3>${isNew ? "Add Booking" : "Edit " + cap(item.type)}</h3>${PDF_BTN}${typeSel}
    ${whoBoxes(item.who || [ui.person])}
    <div class="row"><label>From<input type="date" name="start" value="${item.start || ""}" required></label><label>To<input type="date" name="end" value="${item.end || ""}" required></label></div>
    <div id="typeFields">${fieldsFor(item.type || "stay")}</div>
    <div id="statusBox">${item.type !== "flight" ? statusSel(item.status) : ""}</div>
    <label>Note (Visible to Family)<input name="note" value="${esc(item.note || "")}"></label>
    <details class="privbox" ${Object.keys(pv).length ? "open" : ""}><summary>Private Details (Editors Only)</summary>
      ${privKeys.map((k) => `<label>${esc(label(k))}<input name="priv.${k}" value="${esc(pv[k] || "")}"></label>`).join("")}</details>`,
    async (fd, form) => {
      const type = fd.get("type") || item.type;
      const out = { ...item, type, who: fd.getAll("who"), start: fd.get("start"), end: fd.get("end"), note: fd.get("note"), status: fd.get("status") || item.status || "booked" };
      FIELDS[type].forEach(([k]) => (out[k] = fd.get(k) ?? ""));
      if (!out.who.length) throw new Error("Pick at least one person");
      if (out.end < out.start) throw new Error("'To' is before 'From'");
      let priv = {}; for (const [k, v] of fd.entries()) if (k.startsWith("priv.") && v) priv[k.slice(5)] = v;
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
    ${whoBoxes(e.who)}`,
    async (fd, form) => {
      const out = { ...e, text: fd.get("text").trim(), place: fd.get("place") ?? e.place ?? "", status: fd.get("status") || "planned", confirmed: e.kind === "activity" ? (fd.get("confirmed") === "on" || !!form._pendingFile) && fd.get("status") !== "recommended" : true,
                    date: fd.get("date"), endDate: fd.get("endDate") || fd.get("date"), who: fd.getAll("who") };
      if (!out.who.length) throw new Error("Pick at least one person");
      const id = await data.saveEntry(out);
      if (form._pendingFile) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { entryId: id, date: out.date }); toast("Saved and confirmed, with file attached"); }
    }, isNew ? null : () => data.deleteEntry(e.id));
  const form = document.querySelector(".sheet");
  wireExtract(form, () => "activity", (r) => {
    const txt = [r.text || r.name, r.time ? "at " + r.time : ""].filter(Boolean).join(" ");
    setVal(form, "text", txt); setVal(form, "place", r.place || r.address); setVal(form, "date", r.start || r.date); setVal(form, "endDate", r.end || r.start || r.date);
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
data.init(() => render()).catch((e) => { root.innerHTML = `<div class="login"><h1 class="title-red">Travel Planner</h1><p class="err">Couldn't start: ${esc(e.message)}. Check your connection and reload.</p></div>`; });
if ("serviceWorker" in navigator && !data.DEMO) navigator.serviceWorker.register("./sw.js").catch(() => {});
