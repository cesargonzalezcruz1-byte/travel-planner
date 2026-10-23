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
const PEOPLE = () => (store.trip?.travellers || []).map((t) => t.code);
const ALL_CODES = () => (store.trip?.travellers || []).concat(store.trip?.extended || []).map((t) => t.code).filter(Boolean);
const NAME = (code) => (store.trip?.travellers || []).concat(store.trip?.extended || []).find((t) => t.code === code)?.name || code;

let ui = { person: localStorage.getItem("tp.person") || "", day: null, tripId: null, swap: {} };
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
  if (ui.day) renderDay(); else renderGrid();
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

function header() {
  const ppl = PEOPLE().map((p) => `<button class="chip ${p === ui.person ? "on" : ""}" data-person="${p}"><b>${p}</b><span>${esc(NAME(p))}</span></button>`).join("");
  return `<header class="top">
    <div class="brand"><button class="btn small" data-home title="All Trips">☰ Trips</button><span class="title-red">${esc(store.trip?.title || "Travel Planner")}</span>
      <span class="role ${store.role}">${store.role === "editor" ? "Editor" : "Family"}${data.DEMO ? " · demo" : ""}</span></div>
    <nav class="people">${ppl}</nav>
    <div class="menu">
      ${isEditor() ? `<button class="btn small" data-act="add">+ Booking</button>` : ""}
      <details class="more"><summary class="btn small">⋯</summary><div class="pop">
        ${isEditor() ? `<button data-act="settings">Trip Setup</button><button data-act="import">Import Trip Data</button><button data-act="export">Download Backup</button>` : ""}
        <button data-act="signout">Sign Out</button></div></details>
    </div></header>
    ${store.error ? `<div class="banner err">${esc(store.error)}</div>` : ""}`;
}
function wireHeader() {
  root.querySelectorAll("[data-person]").forEach((b) => (b.onclick = () => { ui.person = b.dataset.person; localStorage.setItem("tp.person", ui.person); render(); }));
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act]?.(b)));
  root.querySelectorAll("[data-home]").forEach((b) => (b.onclick = () => routeTo(null)));
}

// ---------------------------------------------------------------- grid
let COL = {};
const makeCols = (n) => { const b = 1 + n; COL = { day: 1, flight: b + 1, hout: b + 2, hin: b + 3, cdrop: b + 4, cpick: b + 5, act: b + 6, com: b + 7 }; };
function renderGrid() {
  const p = ui.person; const others = PEOPLE().filter((x) => x !== p); const ds = days(); makeCols(others.length);
  const R = (date) => dayDiff(store.trip.start, date) + 2; // grid row (row 1 = header)
  const cells = [];
  const cell = (r1, r2, c1, c2, cls, html, attrs = "") =>
    cells.push(`<div class="cell ${cls}" style="grid-row:${r1}/${r2 + 1};grid-column:${c1}/${c2 + 1}" ${attrs}><div class="txt">${html}</div></div>`);
  // header
  const heads = [["Day", 1, 1], ...others.map((o, k) => [o, 2 + k, 2 + k, "rot"]), ["Flight", COL.flight, COL.flight], ["Hotel", COL.hout, COL.hin],
                 ["Car", COL.cdrop, COL.cpick], ["Activity", COL.act, COL.act], ["Comments", COL.com, COL.com, "c-com"]];
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
  // overlapping bookings of the same type: show one at a time, with a swap button
  const shown = new Map(), hidden = new Set();
  ["flight", "stay", "car"].forEach((type) => {
    for (const g of overlapGroups(its.filter((i) => i.type === type))) {
      if (g.length < 2) { shown.set(g[0].id, ""); continue; }
      const key = g.map((i) => i.id).sort().join("|"); const k = (ui.swap[key] || 0) % g.length;
      g.forEach((i, n) => (n === k ? shown.set(i.id, `<button class="swap" data-swap="${key}" data-n="${g.length}" title="${g.length} overlapping bookings - tap to switch">⇄ ${k + 1}/${g.length}</button>`) : hidden.add(i.id)));
    }
  });
  const swapBtn = (i) => shown.get(i.id) || "";
  its.filter((i) => i.type === "flight").forEach((i) => {
    if (hidden.has(i.id)) return;
    const r1 = R(i.start), r2 = R(i.end); for (let r = r1; r <= r2; r++) used.flight.add(r);
    cell(r1, r2, COL.flight, COL.flight, "flight block", fmt(texts(i).block) + swapBtn(i), `data-day="${i.start}"`);
  });
  // stays & cars
  const place = (type, cOut, cIn, kOut, kIn, fills) => {
    its.filter((i) => i.type === type).forEach((i, n) => {
      const fill = fills[n % 2] + (i.status === "tbc" ? " tbc" : ""); const t = texts(i);
      const rs = R(i.start), re = R(i.end);
      if (hidden.has(i.id)) return;   // shown via the swap button; its rows stay empty (striped) in this view
      const hasMid = re - rs > 1; let sw = swapBtn(i);
      const put = (badge, ...a) => { a[5] = fmt(a[5]) + (badge ? sw : ""); if (badge) sw = ""; cell(...a); };
      if (hasMid) {
        put(true, rs + 1, re - 1, cOut, cIn, `${fill} b-mid`, t.mid, `data-day="${addDays(i.start, 1)}"`);
        for (let r = rs + 1; r < re; r++) { used[kOut].add(r); used[kIn].add(r); }
      }
      if (rs >= 2) { put(!!sw, rs, rs, cIn, cIn, `${fill} b-start`, t.start, `data-day="${i.start}"`); used[kIn].add(rs); }
      if (re <= ds.length + 1) { put(!!sw, re, re, cOut, cOut, `${fill} b-end`, t.end, `data-day="${i.end}"`); used[kOut].add(re); }
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
  const textFor = (kind, date) => entriesFor(p, date).filter((e) => e.kind === kind && e.status !== "recommended" && (kind === "comment" || e.confirmed)).map((e) => e.text).join("\n");
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
  runs("comment", COL.com, "com c-com");

  root.innerHTML = `${header()}
    <div class="gridwrap"><div class="grid" style="--ticks:${others.length};grid-template-columns:var(--c-day) repeat(${others.length}, var(--c-tick)) var(--c-flight) repeat(4, var(--c-half)) var(--c-act) var(--c-com);grid-template-rows:var(--head-h) repeat(${ds.length}, var(--row-h))">${cells.join("")}</div></div>
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
  root.querySelectorAll(".grid [data-swap]").forEach((b) => (b.onclick = (ev) => {
    ev.stopPropagation(); const k = b.dataset.swap;
    ui.swap[k] = ((ui.swap[k] || 0) + 1) % +b.dataset.n;
    try { localStorage.setItem("tp.swap", JSON.stringify(ui.swap)); } catch (e) { /* ignore */ }
    sessionStorage.setItem("tp.scroll", $(".gridwrap").scrollTop); render();
  }));
  root.querySelectorAll(".grid [data-day]").forEach((el) => {
    el.onclick = () => openDay(el.dataset.day);
    el.onkeydown = (e) => { if (e.key === "Enter") openDay(el.dataset.day); };
  });
  const sc = sessionStorage.getItem("tp.scroll"); if (sc) { $(".gridwrap").scrollTop = +sc; window.scrollTo(0, +sessionStorage.getItem("tp.wscroll") || 0); }
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
  const cls = i.type === "flight" ? "flight" : i.type === "stay" ? "hotel-a" : "car-a";
  return `<article class="icard ${cls}">
    <div class="ihead"><span class="tag">${role}</span>${i.status === "tbc" ? `<span class="t-tbc">TBC</span>` : ""}
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
  const places = [];
  its.forEach((i) => { if (i.type === "stay" && i.status !== "tbc" && i.address) places.push([i.short || i.name, i.address]); });
  acts.forEach((e) => e.place && places.push([e.place, e.place]));
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
    <div class="dayhead ${WEEKDAY_CLASS(date)}">
      <button class="nav" data-go="-1" ${idx === 0 ? "disabled" : ""}>‹</button>
      <div><div class="wd">${WD[D(date).getDay()]}</div><div class="dt">${longDate(date)}</div></div>
      <button class="nav" data-go="1" ${idx === ds.length - 1 ? "disabled" : ""}>›</button>
    </div>
    <button class="btn back" data-back>← Itinerary</button>
    <div class="withrow"><span class="muted">With ${esc(NAME(p))} tonight:</span>
      ${others.map((o) => together(p, o, date) ? `<span class="pill yes">☑ <span class="t-init">${o}</span> ${esc(NAME(o))}</span>` : `<span class="pill no">☐ ${o}</span>`).join("")}</div>

    <section><h3>Travel & Stays</h3>${its.length ? its.map((i) => itemCard(i, date)).join("") : `<p class="muted">No flights, hotels or cars today.</p>`}</section>

    <section><h3>Activities</h3>${isEditor() ? `<p class="muted small">Tick ☑ to confirm - only confirmed activities show in the itinerary. Attaching a booking confirms it.</p>` : ""}<ul class="entries">${acts.map(entryLi).join("") || `<li class="muted">Nothing planned yet.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="activity">+ Add Activity</button>` : ""}</section>

    ${recs.length ? `<section><h3>Recommended</h3><ul class="entries">${recs.map(entryLi).join("")}</ul></section>` : ""}

    <section><h3>Comments</h3><ul class="entries">${coms.map(entryLi).join("") || `<li class="muted">No comments.</li>`}</ul>
      ${isEditor() ? `<button class="btn small" data-new-entry="comment">+ Add Comment</button>` : ""}</section>

    <section><h3>Places</h3>
      ${places.length ? `<ul class="places">${places.map(([n, q]) => `<li><a class="maplink" target="_blank" rel="noopener" href="${maps(q)}">📍 ${fmt(n)}</a></li>`).join("")}</ul>` : `<p class="muted">No places for this day.</p>`}
      ${route ? `<a class="btn small" target="_blank" rel="noopener" href="${route}">🗺 Day Route in Google Maps</a>` : ""}</section>

    ${isEditor() ? `<section><h3>Documents</h3>
      ${dayFiles.length ? `<div class="files">${dayFiles.map((f) => `<div class="frow">${fileLink(f)}<button class="btn tiny" data-del-file="${f.id}">Remove</button></div>`).join("")}</div>` : `<p class="muted">No documents for this day.</p>`}
      <label class="btn small">Upload for This Day<input type="file" hidden data-attach-day="${date}" multiple></label></section>` : ""}
  </div>`;
  wireHeader();
  root.querySelector("[data-back]").onclick = () => routeTo(ui.tripId, null);
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
    if (confirm(`Delete ${nm} (${fmtDate(i.start)} – ${fmtDate(i.end)}) for everyone? Its attached documents stay in Documents.`)) data.deleteItem(i.id); }));
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
  stay: [["name", "Hotel Name"], ["short", "Short Name (for the Grid)"], ["address", "Address"], ["checkin", "Check-In Time"], ["checkout", "Check-Out Time"]],
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
