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

function areaOf(i) {
  if (i.area) return i.area;
  const parts = String(i.address || "").split(",").map((x) => x.trim()).filter(Boolean);
  const cand = parts.filter((x) => !/\d/.test(x) && !/^[A-Z]{2,3}$/.test(x) && !/^(USA|US|United States( of America)?|Mexico|México|Australia|Canada)$/i.test(x));
  return parts.length > 1 && cand.length ? cand.at(-1) : "";
}

const C = { accent: "6E4BD8", ink: "1F1B2E", muted: "6B6880", star: "E59A0B", line: "D9D4EA" };

export function buildAlbum(docx, { trip, items, entries, journal }, opts = {}) {
  const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat, BorderStyle } = docx;
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
      default: { document: { run: { font: "Calibri", size: 23, color: C.ink }, paragraph: { spacing: { line: 300 } } } },
      paragraphStyles: [{ id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { font: "Georgia", size: 44, bold: true, color: C.ink }, paragraph: { outlineLevel: 0 } }],
    },
    numbering: { config: [{ reference: "dots", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 360, hanging: 260 } }, run: { color: C.accent } } }] }] },
    sections: [{ properties: { page: { margin: { top: 1300, bottom: 1300, left: 1300, right: 1300 } } }, children: body }],
  });
}
