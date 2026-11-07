// Album export: a Word document with one page per day - where we were, what we did, and the journal.
// Nothing private goes in (no confirmation numbers, costs or documents), so it is safe to share with the family.
// buildAlbum(docx, trip) works in the browser (docx from a CDN) and in Node (for previews).

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const D = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const longDate = (s) => { const d = D(s); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
const shortDate = (s) => { const d = D(s); return `${d.getDate()} ${MON[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`; };
const firstLine = (t) => String(t || "").split("\n")[0].trim();
const joinNames = (a) => (a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " & " + a.at(-1));

// Town or city of a stay, from its address (or the Town / City field). Skips street, postcode, state/region and country parts.
const COUNTRY = /^(USA|US|U\.S\.A?\.?|United States( of America)?|America|Mexico|México|Australia|Canada|New Zealand|NZ|Aotearoa|United Kingdom|UK|Great Britain|England|Scotland|Wales|Ireland|Japan|France|Spain|España|Italy|Italia|Germany|Deutschland|Portugal|Greece|Netherlands|Switzerland|Austria|Thailand|Indonesia|Bali|Singapore|Malaysia|Fiji|China|Hong Kong|Korea|South Korea|Vietnam|Philippines|India|Brazil|Argentina|Chile|Peru|Colombia|Costa Rica|Cuba|Canada)$/i;
const REGION = /\b(region|state|province|county|prefecture|district|territory|estado|municipality)\b|^(Northland|Waikato|Bay of Plenty|Gisborne|Hawke's Bay|Taranaki|Manawatu-Whanganui|Wellington Region|Tasman|Marlborough|West Coast|Canterbury|Otago|Southland|Queensland|New South Wales|Tasmania|Western Australia|South Australia|Northern Territory|Quintana Roo|Baja California|Baja California Sur|Yucatán|Yucatan|Jalisco|Florida|California|Texas|Hawaii|Nevada)$/i;
const STREET = /\b(street|st|road|rd|drive|dr|avenue|ave|av|highway|hwy|sh|lane|ln|place|pl|boulevard|blvd|way|terrace|tce|crescent|cres|parade|pde|court|ct|close|grove|calle|carretera|lote|km|rue|via|unit|suite|level|floor|apt|building|po box)\b\.?/i;
export function areaOf(i) {
  if (i.area) return i.area;
  const raw = String(i.address || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (raw.length < 2) return "";
  const parts = raw.map((x, k) => ({ k, digits: /\d/.test(x), t: x.replace(/\b\d[\d-]*\b/g, " ").replace(/\s+/g, " ").trim().replace(/\s+[A-Z]{2,3}$/, "") }));
  const cand = parts.filter((p) => p.t && !(p.k === 0 && /^\d/.test(raw[0])) && !/^[A-Z]{2,3}$/.test(p.t) && !COUNTRY.test(p.t) && !REGION.test(p.t) && !STREET.test(p.t));
  const withCode = cand.filter((p) => p.digits);   // "Queenstown 9371", "75001 Paris": the part with the postcode is usually the town
  return (withCode.at(-1) || cand.at(-1))?.t || "";
}

const C = { accent: "6E4BD8", ink: "1F1B2E", muted: "6B6880", star: "E59A0B", line: "D9D4EA" };

export function buildAlbum(docx, { trip, items, entries, journal }, opts = {}) {
  const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat, BorderStyle, ImageRun, Table, TableRow, TableCell, WidthType } = docx;
  const pics = opts.photos || new Map();   // photo id -> bytes (fetched by the app before building)
  const img = (ph, maxW, maxH) => { const k = Math.min(maxW / ph.w, maxH / ph.h, 1e9);
    return new ImageRun({ type: "jpg", data: pics.get(ph.id), transformation: { width: Math.round(ph.w * k), height: Math.round(ph.h * k) } }); };
  const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, noBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };
  // one photo: full width; more: two to a row
  const photoBlock = (list) => {
    list = (list || []).filter((ph) => pics.has(ph.id) && ph.w && ph.h); if (!list.length) return [];
    if (list.length === 1) return [new Paragraph({ children: [img(list[0], 600, 450)], alignment: AlignmentType.CENTER, spacing: { before: 120, after: 120 } })];
    const rows = []; for (let k = 0; k < list.length; k += 2) rows.push(list.slice(k, k + 2));
    return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders,
      rows: rows.map((r) => new TableRow({ cantSplit: true, children: [0, 1].map((c) => new TableCell({ borders: noBorders, width: { size: 50, type: WidthType.PERCENTAGE },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: r[c] ? [img(r[c], 292, 260)] : [] })] })) })) }),
      new Paragraph({ spacing: { after: 60 }, children: [] })];
  };
  const from = opts.from || trip.start, to = opts.to || trip.end;
  const travellers = trip.travellers || [];
  const everyone = travellers.concat(trip.extended || []);
  const name = (c) => everyone.find((t) => t.code === c)?.name?.replace(/\s*\(.*\)$/, "") || c;
  const all = travellers.map((t) => t.code);
  const whoTxt = (who) => (!who || all.every((c) => who.includes(c)) && who.length <= all.length ? "" : joinNames(who.map(name)));
  const days = []; for (let d = D(trip.start); iso(d) <= trip.end; d.setDate(d.getDate() + 1)) days.push(iso(d));
  const posts = journal || [];
  const ratings = (id) => posts.filter((j) => j.activityId === id && j.rating > 0 && !j.replyTo).map((j) => j.rating);
  const stars = (n) => new TextRun({ text: "★".repeat(n) + "☆".repeat(5 - n), color: C.star, font: "Segoe UI Symbol" });

  const P = (runs, o = {}) => new Paragraph({ children: Array.isArray(runs) ? runs : [runs], ...o });
  const T = (text, o = {}) => new TextRun({ text, ...o });
  const label = (text) => P(T(text.toUpperCase(), { bold: true, color: C.accent, size: 18, characterSpacing: 40 }), { spacing: { before: 280, after: 80 } });
  const bullet = (runs, level = 0) => P(runs, { numbering: { reference: "dots", level }, spacing: { after: 60 } });

  const body = [];
  // ----- cover
  body.push(P(T(trip.title || "Our Trip", { size: 64, bold: true, color: C.ink, font: "Georgia" }), { spacing: { before: 2400, after: 200 } }));
  body.push(P(T(`${shortDate(from)} – ${shortDate(to)}`, { size: 30, color: C.accent })));
  body.push(P(T(joinNames(travellers.map((t) => t.name)), { size: 26, color: C.muted }), { spacing: { before: 120 } }));
  if ((trip.extended || []).length) body.push(P(T("With " + joinNames(trip.extended.map((t) => name(t.code))), { size: 22, color: C.muted, italics: true })));

  // ----- trip recap page (the trip in numbers)
  const R = opts.recap;
  if (R) {
    const nf = (n) => Number(n || 0).toLocaleString("en-AU");
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [T("Trip Recap")], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.line, space: 6 } }, spacing: { after: 160 } }));
    const tiles = [[R.days, "days"], [R.nights, "nights away"], [R.countries.length, R.countries.length === 1 ? "country" : "countries"], [R.places.filter((x) => !x.tbc).length, R.places.filter((x) => !x.tbc).length === 1 ? "place" : "places"],
      [R.flights, R.flights === 1 ? "flight" : "flights"], [nf(R.flownKm), "km flown"], ["~" + nf(R.roadKm), "km by road"], [R.activities, "activities"]];
    const cell = ([v, l]) => new TableCell({ borders: noBorders, width: { size: 25, type: WidthType.PERCENTAGE }, margins: { top: 80, bottom: 80, left: 60, right: 60 },
      children: [P(T(String(v), { size: 44, bold: true, color: C.accent, font: "Georgia" }), { alignment: AlignmentType.CENTER, spacing: { after: 0 } }), P(T(l, { size: 18, color: C.muted }), { alignment: AlignmentType.CENTER })] });
    body.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: [0, 4].map((k) => new TableRow({ children: tiles.slice(k, k + 4).map(cell) })) }));
    if (R.countries.length) body.push(P([T("Countries: ", { bold: true }), T(R.countries.join(", "))], { spacing: { before: 200, after: 60 } }));
    if (R.longest) body.push(P([T("Longest flight: ", { bold: true }), T(`${R.longest.route} · ${nf(R.longest.km)} km`)], { spacing: { after: 60 } }));
    if (R.places.length) { body.push(label("Nights by Place")); R.places.forEach((x) => body.push(bullet([T(x.name, { bold: true }), T(`  ${x.nights} night${x.nights > 1 ? "s" : ""}`, { color: C.muted })]))); }
    if (R.rated.length) { body.push(label("Top-Rated Activities")); R.rated.forEach((x) => body.push(bullet([T(x.name + "  "), stars(Math.round(x.avg))]))); }
    if (R.voted.length) { body.push(label("Family Favourites")); R.voted.forEach((x) => body.push(bullet([T(x.name), T(`  ${x.n} vote${x.n > 1 ? "s" : ""}`, { color: C.muted })]))); }
    body.push(label("Each Traveller"));
    R.people.forEach((x) => body.push(bullet([T(name(x.code), { bold: true }), T(`  ${x.flights} flight${x.flights === 1 ? "" : "s"} · ${nf(x.km)} km flown · ${x.nights} night${x.nights === 1 ? "" : "s"} away`, { color: C.muted })])));
    if (R.journal.posts) body.push(P(T(`The journal: ${R.journal.posts} posts, ${R.journal.photos} photos and ${R.journal.replies} replies from ${R.journal.authors} writer${R.journal.authors === 1 ? "" : "s"}.`, { italics: true, color: C.muted }), { spacing: { before: 240 } }));
  }

  days.filter((d) => d >= from && d <= to).forEach((date) => {
    const n = days.indexOf(date) + 1;
    const its = items.filter((i) => i.start <= date && date <= i.end);
    // where each traveller slept (or the stay they left today)
    const stayOf = (c) => its.filter((i) => i.type === "stay" && (i.who || []).includes(c)).sort((a, b) => (a.start <= date && date < a.end ? -1 : 1))[0];
    const groups = new Map();
    all.forEach((c) => { const s = stayOf(c); const k = s ? s.id : "none"; if (!groups.has(k)) groups.set(k, { s, who: [] }); groups.get(k).who.push(c); });
    const places = [...groups.values()].filter((g) => g.s).map((g) => areaOf(g.s) || g.s.short || g.s.name);
    const flights = its.filter((i) => i.type === "flight" && (i.start === date || i.end === date));
    const cars = its.filter((i) => i.type === "car" && (i.start === date || i.end === date));
    const acts = entries.filter((e) => e.kind === "activity" && e.status !== "recommended" && (e.confirmed || ratings(e.id).length) && e.date <= date && date <= (e.endDate || e.date))
      .filter((e, i, a) => a.findIndex((x) => firstLine(x.text) === firstLine(e.text)) === i);
    const dayPosts = posts.filter((j) => j.date === date && !j.replyTo).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));

    body.push(P([T(`Day ${n}`, { color: C.accent, bold: true }), T("   ·   " + longDate(date), { color: C.muted })], { pageBreakBefore: true, spacing: { after: 60 } }));
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [T([...new Set(places)].join(" · ") || "On the Road")],
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.line, space: 6 } }, spacing: { after: 120 } }));

    if (flights.length || cars.length) {
      body.push(label("Travel"));
      flights.forEach((f) => { const w = whoTxt(f.who);
        body.push(bullet([T(String(f.route || "").replace(/-/g, " → "), { bold: true }), T(`  ${[f.airline, f.number].filter(Boolean).join(" ")}${f.dep ? ` · ${f.dep}` : ""}${f.arr ? ` – ${f.arr}` : ""}`), ...(w ? [T(`  (${w})`, { color: C.muted })] : [])])); });
      cars.forEach((c) => { const w = whoTxt(c.who);
        const what = c.start === date && c.end === date ? "Car for the day" : c.start === date ? "Picked up the car" : "Returned the car";
        body.push(bullet([T(what, { bold: true }), T(`  ${[c.company, c.vehicle && c.vehicle.replace(/\s*\(.*\)$/, "")].filter(Boolean).join(" – ")}${c.start === date && c.pickup ? ` at ${c.pickup}` : c.end === date && c.dropoff ? ` at ${c.dropoff}` : ""}`), ...(w ? [T(`  (${w})`, { color: C.muted })] : [])])); });
    }
    const stays = [...groups.values()].filter((g) => g.s);
    if (stays.length) {
      body.push(label("Stayed At"));
      stays.forEach((g) => { const w = groups.size > 1 ? joinNames(g.who.map(name)) : "";
        const leaving = g.s.end === date;
        body.push(bullet([T(g.s.name, { bold: true }), T(areaOf(g.s) ? `, ${areaOf(g.s)}` : ""), ...(leaving ? [T("  (checked out)", { color: C.muted })] : []), ...(w ? [T(`  – ${w}`, { color: C.muted })] : [])])); });
    }
    if (acts.length) {
      body.push(label("What We Did"));
      acts.forEach((a) => { const r = ratings(a.id), w = whoTxt(a.who);
        const avg = r.length ? Math.round(r.reduce((x, y) => x + y, 0) / r.length) : 0;
        body.push(bullet([T(firstLine(a.text), { bold: true }), ...(a.place && !firstLine(a.text).includes(a.place) ? [T(`  ${a.place}`, { color: C.muted })] : []),
          ...(w ? [T(`  (${w})`, { color: C.muted })] : []), ...(avg ? [T("  "), stars(avg)] : [])])); });
    }
    if (dayPosts.length) {
      body.push(label("Journal"));
      dayPosts.forEach((j) => {
        const act = j.activityId && entries.find((e) => e.id === j.activityId);
        body.push(P([T(j.author || "Someone", { bold: true }), ...(j.rating && act ? [T("  "), stars(j.rating), T(`  ${firstLine(act.text)}`, { color: C.muted, size: 18 })] : [])], { spacing: { before: 160, after: 40 }, keepNext: true }));
        String(j.text || "").split(/\n+/).filter(Boolean).forEach((line) => body.push(P(T(line, { italics: false }), { spacing: { after: 40 } })));
        body.push(...photoBlock(j.photos));
        posts.filter((r) => r.replyTo === j.id).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")).forEach((r) =>
          body.push(P([T(`${r.author || "Someone"}: `, { bold: true, color: C.muted }), T(String(r.text || "").replace(/\n+/g, " "), { color: C.muted })],
            { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: C.line, space: 8 } }, spacing: { before: 40, after: 40 } })));
      });
    }
    if (!flights.length && !cars.length && !acts.length && !dayPosts.length) body.push(P(T("A quiet day.", { color: C.muted, italics: true }), { spacing: { before: 200 } }));
  });

  return new Document({
    creator: "Travel Planner", title: `${trip.title} – Album`,
    styles: {
      default: { document: { run: { font: "Calibri", size: 23, color: C.ink }, paragraph: { spacing: { line: 300, lineRule: "auto" } } } },
      paragraphStyles: [{ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Georgia", size: 44, bold: true, color: C.ink }, paragraph: { outlineLevel: 0 } }],
    },
    numbering: { config: [{ reference: "dots", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360, hanging: 260 } }, run: { color: C.accent } } }] }] },
    sections: [{ properties: { page: { margin: { top: 1300, bottom: 1300, left: 1300, right: 1300 } } }, children: body }],
  });
}
