import * as data from "./data.js";
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
const WEEKDAY_CLASS = (s) => "wd-" + WD[D(s).getDay()].toLowerCase();
const maps = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
const isEditor = () => store.role === "editor";
const PEOPLE = () => (store.trip?.travellers || [{ code: "CGC" }, { code: "CGM" }, { code: "DBMV" }]).map((t) => t.code);
const NAME = (code) => (store.trip?.travellers || []).concat(store.trip?.extended || []).find((t) => t.code === code)?.name || code;

let ui = { person: localStorage.getItem("tp.person") || "CGC", day: null };
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
  const names = mainNames(); const key = names.join("|");
  if (!tokenRe || key !== tokenKey) {
    tokenKey = key;
    const nameAlt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    tokenRe = new RegExp(
      `(?<init>\\b(?:CGC|CGM|DBMV|RGA|MCN)\\b|^All(?=:))|(?<tbc>\\bTBC\\b)|(?<main>\\b[A-Z]{3}(?:-[A-Z]{3})+\\b${nameAlt ? "|" + nameAlt : ""})` +
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
  if (!store.trip && !store.items.length) return renderEmpty();
  if (!PEOPLE().includes(ui.person)) ui.person = PEOPLE()[0];
  if (ui.day) renderDay(); else renderGrid();
}

function renderLogin(err = "") {
  root.innerHTML = `
  <div class="login">
    <h1 class="title-red">Travel Planner</h1>
    <p class="muted">Family itinerary</p>
    <form id="famForm" class="card">
      <label>Family password</label>
      <input id="famPw" type="password" autocomplete="current-password" required placeholder="Enter the family password">
      <button class="btn primary" type="submit">Open itinerary</button>
    </form>
    <div class="or">or</div>
    <button id="gBtn" class="btn">Sign in with Google (editors)</button>
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
    <p>${esc(store.email)} isn't set up as an editor.</p><button class="btn" id="out">Sign out</button></div>`;
  $("#out").onclick = data.signOut;
}
function renderEmpty() {
  root.innerHTML = `${header()}<div class="empty card"><h2>No trip data yet</h2>
    ${isEditor() ? `<p>Import the trip data file Claude sent you to load the whole trip.</p><button class="btn primary" data-act="import">Import trip data</button>` : `<p>The itinerary hasn't been loaded yet - check back soon.</p>`}</div>`;
  wireHeader();
}

function header() {
  const ppl = PEOPLE().map((p) => `<button class="chip ${p === ui.person ? "on" : ""}" data-person="${p}"><b>${p}</b><span>${esc(NAME(p))}</span></button>`).join("");
  return `<header class="top">
    <div class="brand"><span class="title-red">${esc(store.trip?.title || "Travel Planner")}</span>
      <span class="role ${store.role}">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span></div>
    <nav class="people">${ppl}</nav>
    <div class="menu">
      ${isEditor() ? `<button class="btn small" data-act="add">+ Booking</button>` : ""}
      <details class="more"><summary class="btn small">⋯</summary><div class="pop">
        ${isEditor() ? `<button data-act="import">Import trip data</button><button data-act="export">Download backup</button>` : ""}
        <button data-act="signout">Sign out</button></div></details>
    </div></header>
    ${store.error ? `<div class="banner err">${esc(store.error)}</div>` : ""}`;
}
function wireHeader() {
  root.querySelectorAll("[data-person]").forEach((b) => (b.onclick = () => { ui.person = b.dataset.person; localStorage.setItem("tp.person", ui.person); render(); }));
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.(b)));
}

// ---------------------------------------------------------------- grid
const COL = { day: 1, o1: 2, o2: 3, flight: 4, hout: 5, hin: 6, cdrop: 7, cpick: 8, act: 9, com: 10 };
function renderGrid() {
  const p = ui.person; const others = PEOPLE().filter((x) => x !== p); const ds = days();
  const R = (date) => dayDiff(store.trip.start, date) + 2; // grid row (row 1 = header)
  const cells = [];
  const cell = (r1, r2, c1, c2, cls, html, attrs = "") =>
    cells.push(`<div class="cell ${cls}" style="grid-row:${r1}/${r2 + 1};grid-column:${c1}/${c2 + 1}" ${attrs}><div class="txt">${html}</div></div>`);
  // header
  const heads = [["Day", 1, 1], [others[0], 2, 2, "rot"], [others[1], 3, 3, "rot"], ["Flight", 4, 4], ["Hotel", 5, 6], ["Car", 7, 8], ["Activity", 9, 9], ["Comments", 10, 10]];
  heads.forEach(([t, a, b, c]) => cell(1, 1, a, b, "head " + (c || ""), `<span>${esc(t)}</span>`));
  // days + ticks
  ds.forEach((date) => {
    const r = R(date);
    cell(r, r, 1, 1, "day " + WEEKDAY_CLASS(date), `<span class="wd">${WD[D(date).getDay()]}</span><span class="dt">${fmtDate(date)}</span>`, `data-day="${date}" role="button" tabindex="0"`);
    others.forEach((o, k) => { const t = together(p, o, date); cell(r, r, 2 + k, 2 + k, "tick " + (t ? "yes" : "no"), t ? "☑" : "☐", `title="${t ? "With" : "Not with"} ${o}"`); });
  });
  // flights
  const used = { flight: new Set(), hout: new Set(), hin: new Set(), cdrop: new Set(), cpick: new Set() };
  const its = itemsFor(p).sort((a, b) => a.start.localeCompare(b.start));
  its.filter((i) => i.type === "flight").forEach((i) => {
    const r1 = R(i.start), r2 = R(i.end); for (let r = r1; r <= r2; r++) used.flight.add(r);
    cell(r1, r2, COL.flight, COL.flight, "flight block", fmt(texts(i).block), `data-day="${i.start}"`);
  });
  // stays & cars
  const place = (type, cOut, cIn, kOut, kIn, fills) => {
    its.filter((i) => i.type === type).forEach((i, n) => {
      const fill = fills[n % 2] + (i.status === "tbc" ? " tbc" : ""); const t = texts(i);
      const rs = R(i.start), re = R(i.end);
      if (rs >= 2) { cell(rs, rs, cIn, cIn, `${fill} b-start`, fmt(t.start), `data-day="${i.start}"`); used[kIn].add(rs); }
      if (re - rs > 1) {
        cell(rs + 1, re - 1, cOut, cIn, `${fill} b-mid`, fmt(t.mid), `data-day="${addDays(i.start, 1)}"`);
        for (let r = rs + 1; r < re; r++) { used[kOut].add(r); used[kIn].add(r); }
      }
      if (re <= ds.length + 1) { cell(re, re, cOut, cOut, `${fill} b-end`, fmt(t.end), `data-day="${i.end}"`); used[kOut].add(re); }
    });
  };
  place("stay", COL.hout, COL.hin, "hout", "hin", ["hotel-a", "hotel-b"]);
  place("car", COL.cdrop, COL.cpick, "cdrop", "cpick", ["car-a", "car-b"]);
  // stripes for empty runs
  const rows = ds.map((d) => R(d));
  const slotOf = (c) => (c === COL.flight ? "flight" : c <= COL.hin ? "stay" : "car");
  const stripeRuns = (isEmpty, c1, c2) => {
    let s = null;
    rows.concat([null]).forEach((r) => {
      if (r !== null && isEmpty(r)) { if (s === null) s = r; }
      else if (s !== null) { cell(s, (r ?? rows.at(-1) + 1) - 1, c1, c2, "stripe", "", `data-slot="${slotOf(c1)}" data-r1="${s}"`); s = null; }
    });
  };
  stripeRuns((r) => !used.flight.has(r), COL.flight, COL.flight);
  stripeRuns((r) => !used.hout.has(r) && !used.hin.has(r), COL.hout, COL.hin);
  stripeRuns((r) => !used.hout.has(r) && used.hin.has(r), COL.hout, COL.hout);
  stripeRuns((r) => !used.hin.has(r) && used.hout.has(r), COL.hin, COL.hin);
  stripeRuns((r) => !used.cdrop.has(r) && !used.cpick.has(r), COL.cdrop, COL.cpick);
  stripeRuns((r) => !used.cdrop.has(r) && used.cpick.has(r), COL.cdrop, COL.cdrop);
  stripeRuns((r) => !used.cpick.has(r) && used.cdrop.has(r), COL.cpick, COL.cpick);
  // activities & comments (confirmed only), identical consecutive runs merged
  const textFor = (kind, date) => entriesFor(p, date).filter((e) => e.kind === kind && e.status !== "recommended").map((e) => e.text).join("\n");
  const runs = (kind, c, cls) => {
    let k = 0;
    while (k < ds.length) {
      const v = textFor(kind, ds[k]); let j = k;
      while (j + 1 < ds.length && textFor(kind, ds[j + 1]) === v && v) j++;
      cell(R(ds[k]), R(ds[j]), c, c, cls, fmt(v), `data-day="${ds[k]}"`);
      k = j + 1;
    }
  };
  runs("activity", COL.act, "act");
  runs("comment", COL.com, "com");

  root.innerHTML = `${header()}
    <div class="gridwrap"><div class="grid" style="grid-template-rows:var(--head-h) repeat(${ds.length}, var(--row-h))">${cells.join("")}</div></div>
    <p class="hint">Tap a day to see its activities, places and documents.</p>`;
  wireHeader();
  root.querySelectorAll(".grid [data-slot]").forEach((el) => {
    el.onclick = (ev) => {
      const box = el.getBoundingClientRect(); const rowPx = box.height / (parseInt(el.style.gridRow.split("/")[1]) - parseInt(el.dataset.r1));
      const k = Math.min(ds.length - 1, +el.dataset.r1 - 2 + Math.floor((ev.clientY - box.top) / rowPx));
      const date = ds[Math.max(0, k)];
      if (!isEditor()) return openDay(date);
      itemForm({ type: el.dataset.slot, who: [ui.person, ...others.filter((o) => together(ui.person, o, date))], start: date, end: el.dataset.slot === "flight" ? date : addDays(date, 1), status: "booked" });
    };
  });
  root.querySelectorAll(".grid [data-day]").forEach((el) => {
    el.onclick = () => openDay(el.dataset.day);
    el.onkeydown = (e) => { if (e.key === "Enter") openDay(el.dataset.day); };
  });
  const sc = sessionStorage.getItem("tp.scroll"); if (sc) { $(".gridwrap").scrollTop = +sc; window.scrollTo(0, +sessionStorage.getItem("tp.wscroll") || 0); }
}
function openDay(date) {
  sessionStorage.setItem("tp.wscroll", window.scrollY);
  ui.day = date; history.pushState({ day: date }, "", "#" + date); render(); window.scrollTo(0, 0);
}
window.onpopstate = () => { ui.day = location.hash.slice(1) || null; render(); };

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
  const cls = i.type === "flight" ? "flight" : i.type === "stay" ? "hotel-a" : "car-a";
  return `<article class="icard ${cls}">
    <div class="ihead"><span class="tag">${role}</span>${i.status === "tbc" ? `<span class="t-tbc">TBC</span>` : ""}
      <span class="who">${i.who.map((w) => `<span class="t-init">${w}</span>`).join(" ")}</span></div>
    <div class="ibody">${fmt(body)}</div>
    ${i.note ? `<div class="inote">${fmt(i.note)}</div>` : ""}
    ${pvHtml}
    <div class="ilinks">${mapLinks}${files.map(fileLink).join("")}</div>
    ${isEditor() ? `<div class="iacts"><button class="btn small" data-edit-item="${i.id}">Edit</button>
       <label class="btn small">Attach file<input type="file" hidden data-attach-item="${i.id}" multiple></label></div>` : ""}
  </article>`;
}
const LABELS = { confirmation: "Confirmation", tickets: "Tickets", seats: "Seats", cost: "Cost", paidWith: "Paid with", dueAtHotel: "Due at hotel",
  cancel: "Cancellation", phone: "Phone", host: "Host", checkIn: "Check-in", bags: "Bags", extras: "Extras", notes: "Notes" };
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
  const places = [];
  its.forEach((i) => { if (i.type === "stay" && i.status !== "tbc" && i.address) places.push([i.short || i.name, i.address]); });
  acts.forEach((e) => e.place && places.push([e.place, e.place]));
  const dayFiles = isEditor() ? store.files.filter((f) => f.date === date || (f.itemId && its.some((i) => i.id === f.itemId))) : [];
  const route = places.length >= 2 ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(places[0][1])}&destination=${encodeURIComponent(places.at(-1)[1])}${places.length > 2 ? "&waypoints=" + encodeURIComponent(places.slice(1, -1).map((x) => x[1]).join("|")) : ""}` : "";
  const entryLi = (e) => `<li class="entry ${e.status}">
      <div class="etext">${e.status === "recommended" ? "☆ " : e.kind === "activity" ? "✓ " : ""}${fmt(e.text)}
        ${(e.endDate && e.endDate !== e.date) ? `<span class="muted small"> (${fmtDate(e.date)} – ${fmtDate(e.endDate)})</span>` : ""}
        ${e.who.length < PEOPLE().length ? `<span class="whos">${e.who.map((w) => `<span class="t-init">${w}</span>`).join(" ")}</span>` : ""}</div>
      <div class="eacts">${e.place ? `<a class="maplink" target="_blank" rel="noopener" href="${maps(e.place)}">📍</a>` : ""}
        ${isEditor() ? `${e.status === "recommended" ? `<button class="btn tiny" data-plan="${e.id}">Add to plan</button>` : ""}
        <button class="btn tiny" data-edit-entry="${e.id}">Edit</button>` : ""}</div></li>`;
  root.innerHTML = `${header()}
  <div class="dayview">
    <div class="dayhead ${WEEKDAY_CLASS(date)}">
      <button class="nav" data-go="-1" ${idx === 0 ? "disabled" : ""}>‹</button>
      <div><div class="wd">${WD[D(date).getDay()]}</div><div class="dt">${longDate(date)}</div></div>
      <button class="nav" data-go="1" ${idx === ds.length - 1 ? "disabled" : ""}>›</button>
    </div>
    <button class="btn back" data-back>← Itinerary</button>
    <div class="withrow"><span class="muted">With ${esc(NAME(p))} tonight:</span>
      ${others.map((o) => together(p, o, date) ? `<span class="pill yes">☑ <span class="t-init">${o}</span> ${esc(NAME(o))}</span>` : `<span class="pill no">☐ ${o}</span>`).join("")}</div>

    <section><h3>Travel & stays</h3>${its.length ? its.map((i) => itemCard(i, date)).join("") : `<p class="muted">No flights, hotels or cars today.</p>`}</section>

    <section><h3>Activities</h3><ul class="entries">${acts.map(entryLi).join("") || `<li class="muted">Nothing planned yet.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="activity">+ Add activity</button>` : ""}</section>

    ${recs.length ? `<section><h3>Recommended</h3><ul class="entries">${recs.map(entryLi).join("")}</ul></section>` : ""}

    <section><h3>Comments</h3><ul class="entries">${coms.map(entryLi).join("") || `<li class="muted">No comments.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="comment">+ Add comment</button>` : ""}</section>

    <section><h3>Places</h3>
      ${places.length ? `<ul class="places">${places.map(([n, q]) => `<li><a class="maplink" target="_blank" rel="noopener" href="${maps(q)}">📍 ${fmt(n)}</a></li>`).join("")}</ul>` : `<p class="muted">No places for this day.</p>`}
      ${route ? `<a class="btn small" target="_blank" rel="noopener" href="${route}">🗺 Day route in Google Maps</a>` : ""}</section>

    ${isEditor() ? `<section><h3>Documents</h3>
      ${dayFiles.length ? `<div class="files">${dayFiles.map((f) => `<div class="frow">${fileLink(f)}<button class="btn tiny" data-del-file="${f.id}">Remove</button></div>`).join("")}</div>` : `<p class="muted">No documents for this day.</p>`}
      <label class="btn small">Upload for this day<input type="file" hidden data-attach-day="${date}" multiple></label></section>` : ""}
  </div>`;
  wireHeader();
  root.querySelector("[data-back]").onclick = () => history.back();
  root.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { ui.day = ds[idx + +b.dataset.go]; history.replaceState({ day: ui.day }, "", "#" + ui.day); render(); }));
  root.querySelectorAll("[data-edit-item]").forEach((b) => (b.onclick = () => itemForm(store.items.find((i) => i.id === b.dataset.editItem))));
  root.querySelectorAll("[data-edit-entry]").forEach((b) => (b.onclick = () => entryForm(store.entries.find((e) => e.id === b.dataset.editEntry))));
  root.querySelectorAll("[data-new-entry]").forEach((b) => (b.onclick = () => entryForm({ kind: b.dataset.newEntry, date, endDate: date, who: [p, ...others.filter((o) => together(p, o, date))], status: "confirmed", text: "", place: "" })));
  root.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => { const e = store.entries.find((x) => x.id === b.dataset.plan); data.saveEntry({ ...e, status: "confirmed", date, endDate: date }); }));
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
  flight: [["route", "Route (e.g. BNE-LAX)"], ["airline", "Airline"], ["number", "Flight number"], ["dep", "Departs"], ["arr", "Arrives"]],
  stay: [["name", "Hotel name"], ["short", "Short name (for the grid)"], ["address", "Address"], ["checkin", "Check-in time"], ["checkout", "Check-out time"]],
  car: [["company", "Company"], ["vehicle", "Vehicle"], ["pickup", "Pick-up location"], ["dropoff", "Drop-off location"], ["pickupTime", "Pick-up time"], ["dropoffTime", "Drop-off time"]],
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
  if (onDelete) m.querySelector("[data-del]").onclick = async () => { if (confirm("Delete this for everyone?")) { await onDelete(); close(); } };
  m.querySelector("form").onsubmit = async (e) => { e.preventDefault(); const btn = e.target.querySelector("button.primary"); btn.disabled = true; try { await onSubmit(new FormData(e.target), e.target); close(); } catch (x) { btn.disabled = false; toast("Save failed: " + (x.code || x.message)); } };
  m.querySelector("input,select,textarea")?.focus();
}
const whoBoxes = (who) => `<fieldset class="whobox"><legend>Who</legend>${PEOPLE().map((p) => `<label><input type="checkbox" name="who" value="${p}" ${who.includes(p) ? "checked" : ""}> ${p}</label>`).join("")}</fieldset>`;
const PDF_BTN = `<div class="extract"><label class="btn small pdfbtn">📄 Fill from PDF or photo<input type="file" hidden accept="application/pdf,image/*" data-extract></label>
  <span class="extract-status muted small">The file is read by AI, then attached. Check the details before saving.</span></div>`;
function setVal(form, name, v) { const el = form.querySelector(`[name="${name}"]`); if (el && v !== undefined && v !== null && v !== "") el.value = v; }
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
      onResult(r || {});
      st.textContent = `✓ Filled from ${f.name} - please check, then Save (the file will be attached).`;
    } catch (x) {
      console.error(x); const why = String(x.message || x.code || x).replace(/^.*?googleapis\.com\S*:\s*/, "").slice(0, 400);
      st.textContent = `Couldn't read it automatically: ${why} - fill in by hand; ${f.name} will still be attached.`;
    } finally { st.classList.remove("busy"); }
  };
}
function itemForm(item) {
  const isNew = !item.id; const pv = (item.id && store.priv[item.id]) || {};
  const typeSel = isNew ? `<label>Type<select name="type">${["flight", "stay", "car"].map((t) => `<option ${t === item.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>` : "";
  const fieldsFor = (type, src = item) => FIELDS[type].map(([k, l]) => `<label>${l}<input name="${k}" value="${esc(src[k] || "")}"></label>`).join("");
  const privKeys = [...new Set([...PRIV_KEYS, ...Object.keys(pv)])];
  const statusSel = (st) => `<label>Status<select name="status"><option value="booked" ${st !== "tbc" ? "selected" : ""}>Booked</option><option value="tbc" ${st === "tbc" ? "selected" : ""}>TBC</option></select></label>`;
  modal(`<h3>${isNew ? "Add booking" : "Edit " + item.type}</h3>${PDF_BTN}${typeSel}
    ${whoBoxes(item.who || [ui.person])}
    <div class="row"><label>From<input type="date" name="start" value="${item.start || ""}" required></label><label>To<input type="date" name="end" value="${item.end || ""}" required></label></div>
    <div id="typeFields">${fieldsFor(item.type || "stay")}</div>
    <div id="statusBox">${item.type !== "flight" ? statusSel(item.status) : ""}</div>
    <label>Note (visible to family)<input name="note" value="${esc(item.note || "")}"></label>
    <details class="privbox" ${Object.keys(pv).length ? "open" : ""}><summary>Private details (editors only)</summary>
      ${privKeys.map((k) => `<label>${esc(label(k))}<input name="priv.${k}" value="${esc(pv[k] || "")}"></label>`).join("")}</details>`,
    async (fd, form) => {
      const type = fd.get("type") || item.type;
      const out = { ...item, type, who: fd.getAll("who"), start: fd.get("start"), end: fd.get("end"), note: fd.get("note"), status: fd.get("status") || item.status || "booked" };
      FIELDS[type].forEach(([k]) => (out[k] = fd.get(k) ?? ""));
      if (!out.who.length) throw new Error("Pick at least one person");
      if (out.end < out.start) throw new Error("'To' is before 'From'");
      const priv = {}; for (const [k, v] of fd.entries()) if (k.startsWith("priv.") && v) priv[k.slice(5)] = v;
      const id = await data.saveItem(out, priv);
      if (form._pendingFile) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { itemId: id }); toast("Saved with file attached"); }
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
  });
}
function entryForm(e) {
  const isNew = !e.id;
  modal(`<h3>${isNew ? "Add" : "Edit"} ${e.kind}</h3>${e.kind === "activity" ? PDF_BTN : ""}
    <label>${e.kind === "comment" ? "Comment" : "Activity"}<textarea name="text" rows="3" required>${esc(e.text)}</textarea></label>
    ${e.kind === "activity" ? `<label>Place (for Google Maps)<input name="place" value="${esc(e.place || "")}" placeholder="e.g. Gran Cenote Tulum"></label>
      <label>Status<select name="status"><option value="confirmed" ${e.status !== "recommended" ? "selected" : ""}>Confirmed</option><option value="recommended" ${e.status === "recommended" ? "selected" : ""}>Recommended</option></select></label>` : ""}
    <div class="row"><label>From<input type="date" name="date" value="${e.date}" required></label><label>To<input type="date" name="endDate" value="${e.endDate || e.date}"></label></div>
    ${whoBoxes(e.who)}`,
    async (fd, form) => {
      const out = { ...e, text: fd.get("text").trim(), place: fd.get("place") ?? e.place ?? "", status: fd.get("status") || "confirmed",
                    date: fd.get("date"), endDate: fd.get("endDate") || fd.get("date"), who: fd.getAll("who") };
      if (!out.who.length) throw new Error("Pick at least one person");
      await data.saveEntry(out);
      if (form._pendingFile) { toast("Attaching file…"); await data.uploadFile(form._pendingFile, { date: out.date }); toast("Saved with file attached"); }
    }, isNew ? null : () => data.deleteEntry(e.id));
  const form = document.querySelector(".sheet");
  wireExtract(form, () => "activity", (r) => {
    const txt = [r.text || r.name, r.time ? "at " + r.time : ""].filter(Boolean).join(" ");
    setVal(form, "text", txt); setVal(form, "place", r.place || r.address); setVal(form, "date", r.start || r.date); setVal(form, "endDate", r.end || r.start || r.date);
    if (Array.isArray(r.who) && r.who.length) form.querySelectorAll("input[name=who]").forEach((cb) => (cb.checked = r.who.includes(cb.value)));
  });
}

// ---------------------------------------------------------------- menu actions
const actions = {
  signout: () => data.signOut(),
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
        toast("Importing…"); await data.importSeed(seed); toast("Trip data imported"); }
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
ui.day = location.hash.slice(1) || null;
data.onChange(() => { if (!document.querySelector(".modal")) render(); });
render();
data.init(() => render()).catch((e) => { root.innerHTML = `<div class="login"><h1 class="title-red">Travel Planner</h1><p class="err">Couldn't start: ${esc(e.message)}. Check your connection and reload.</p></div>`; });
if ("serviceWorker" in navigator && !data.DEMO) navigator.serviceWorker.register("./sw.js").catch(() => {});
