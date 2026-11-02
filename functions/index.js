// Phone notifications for the travel planner. Every 15 minutes:
//  Important - check-in open, leave for the airport, hotel check-out, car return, travel document problems
//  Extras    - new journal posts / replies, itinerary changes, newly confirmed activities
// Each device (push/{id}) says which travellers it follows and which categories it wants ({ cats: { important, extras } }).
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { checkinInfo, codesOf, timeIn, zonedDate, isInternational, AIRPORT_TZ } from "./checkin-core.js";

initializeApp();
const db = getFirestore();
const APP_URL = "https://cesargonzalezcruz1-byte.github.io/travel-planner/";
const HOME_TZ = "Australia/Brisbane";
const MIN = 60e3, HOUR = 3600e3;

const wants = (t, cat) => (t.cats ? t.cats[cat] !== false : true);   // devices from before categories existed get everything
const follows = (t, who) => (t.people || []).some((p) => (who || []).includes(p));
function when(d, tz) {
  try { return d.toLocaleString("en-AU", { timeZone: tz || HOME_TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); }
  catch (e) { return d.toISOString(); }
}
const hm = (d, tz) => { try { return d.toLocaleTimeString("en-AU", { timeZone: tz || HOME_TZ, hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };

// Send once per key (pushSent/{key}) to the given devices; drops devices that no longer exist
async function sendOnce(key, targets, msg) {
  const mark = db.collection("pushSent").doc(key.replace(/[^\w-]/g, "-").slice(0, 400));
  if ((await mark.get()).exists) return 0;
  await mark.set({ at: new Date(), devices: targets.length, title: msg.title });
  if (!targets.length) return 0;
  const data = Object.fromEntries(Object.entries(msg).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const res = await getMessaging().sendEachForMulticast({ tokens: targets.map((t) => t.token), data, webpush: { headers: { Urgency: "high", TTL: String(6 * 3600) } } });
  await Promise.all(res.responses.map((r, k) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code || "")
    ? db.collection("push").doc(targets[k].id).delete() : null)));
  logger.info("sent", { key, title: msg.title, devices: targets.length, ok: res.successCount });
  return res.successCount;
}

// Time zone a traveller is in on a date: where their last flight landed (or will leave from), else home
function tzOn(items, who, date) {
  const fl = items.filter((i) => i.type === "flight" && (i.who || []).some((w) => (who || []).includes(w)) && i.start).sort((a, b) => a.start.localeCompare(b.start));
  const before = fl.filter((f) => (f.end || f.start) <= date).at(-1);
  if (before) return AIRPORT_TZ[codesOf(before.route).at(-1)] || HOME_TZ;
  const first = fl[0]; return first ? AIRPORT_TZ[codesOf(first.route)[0]] || HOME_TZ : HOME_TZ;
}
const placeTz = (place, fallback) => { const m = String(place || "").trim().match(/^([A-Z]{3})\b/); return (m && AIRPORT_TZ[m[1]]) || fallback; };
// a reminder is due when its time has come, but not more than `grace` ago (so nothing is sent late or twice)
const due = (at, now, grace = 45 * MIN) => at && now >= +at && now - at < grace;

export const checkinAlerts = onSchedule({ schedule: "every 15 minutes", region: "us-east1", timeoutSeconds: 240, memory: "256MiB" }, async () => {
  const now = Date.now();
  const tokens = (await db.collection("push").get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token && (t.people || []).length);
  if (!tokens.length) return;
  const metaRef = db.collection("pushMeta").doc("state"), meta = (await metaRef.get()).data() || {};
  const since = meta.lastRun ? meta.lastRun.toMillis() : null;   // first run: just take a snapshot, no "changed" alerts
  const today = new Date(now - 2 * 86400e3).toISOString().slice(0, 10);
  const trips = (await db.collection("trips").get()).docs.filter((d) => (d.data().end || "9999") >= today);
  const important = tokens.filter((t) => wants(t, "important")), extras = tokens.filter((t) => wants(t, "extras"));

  for (const tripDoc of trips) {
    const trip = tripDoc.data(), tid = tripDoc.id, link = (d) => `${APP_URL}#/t/${tid}${d ? "/" + d : ""}`;
    const items = (await tripDoc.ref.collection("items").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    for (const i of items) {
      const who = i.who || [], tgt = important.filter((t) => follows(t, who));
      if (i.status === "tbc") continue;
      if (i.type === "flight") {
        const route = codesOf(i.route), fl = [i.airline, i.number].filter(Boolean).join(" ");
        // check-in open
        const c = checkinInfo(i, now);
        if (c && c.status === "open" && now - c.opens < 12 * HOUR)
          await sendOnce(`ci_${tid}_${i.id}_${i.start}_${i.dep}`, tgt, { title: `Check-in is open: ${fl}`.trim(), body: `${route.join(" → ")} · departs ${when(c.dep, AIRPORT_TZ[route[0]])}. Tap to check in.`, url: c.url, app: link(i.start), tag: `checkin-${i.id}` });
        // leave for the airport: 3 h before international, 2 h before domestic
        const dep = c?.dep, lead = isInternational(i) ? 3 : 2;
        if (dep && due(new Date(dep - lead * HOUR), now))
          await sendOnce(`go_${tid}_${i.id}_${i.start}_${i.dep}`, tgt, { title: `Time to head to ${route[0]} airport`, body: `${fl} to ${route.at(-1)} departs at ${hm(dep, AIRPORT_TZ[route[0]])} - aim to be there ${lead} hours before.`,
            url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(route[0] + " airport")}`, app: link(i.start), tag: `go-${i.id}` });
      } else if (i.type === "stay" && i.end) {
        const tz = tzOn(items, who, i.end), out = zonedDate(i.end, timeIn(i.checkout) || "10:00", tz);
        if (due(new Date(out - HOUR), now))
          await sendOnce(`co_${tid}_${i.id}_${i.end}_${i.checkout || ""}`, tgt, { title: `Check out of ${i.short || i.name} by ${hm(out, tz)}`, body: `Pack up and check nothing is left behind${i.checkout ? "" : " (check-out time not set - usually 10-11 am)"}.`, app: link(i.end), tag: `co-${i.id}` });
      } else if (i.type === "car" && i.end) {
        const tz = placeTz(i.dropoff, tzOn(items, who, i.end)), ret = zonedDate(i.end, timeIn(i.dropoffTime) || "10:00", tz);
        if (due(new Date(ret - 2 * HOUR), now))
          await sendOnce(`car_${tid}_${i.id}_${i.end}_${i.dropoffTime || ""}`, tgt, { title: `Return the ${i.company || "rental"} car by ${hm(ret, tz)}`, body: `${i.dropoff ? "Drop-off at " + i.dropoff + ". " : ""}Leave time to refuel and return it.`,
            url: i.dropoff ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([i.company, i.dropoff].filter(Boolean).join(" "))}` : undefined, app: link(i.end), tag: `car-${i.id}` });
      }
    }

    // ---- Extras: what changed since the last run
    if (since !== null) {
      const sigRef = db.collection("pushMeta").doc(`sig_${tid}`), sigs = (await sigRef.get()).data() || {};
      const nextSigs = {}, sigOf = (i) => [i.type, i.start, i.end, i.dep, i.arr, i.route, i.number, i.name, i.checkin, i.checkout, i.pickup, i.dropoff, i.pickupTime, i.dropoffTime, i.status].join("|");
      for (const i of items) {
        nextSigs[i.id] = sigOf(i);
        if (sigs[i.id] === nextSigs[i.id] || !sigs.__init) continue;
        const what = i.type === "flight" ? `flight ${codesOf(i.route).join(" → ")}` : i.type === "stay" ? i.short || i.name : `${i.company || ""} car`;
        const tgt = extras.filter((t) => follows(t, i.who) && t.email !== i.updatedBy);
        await sendOnce(`chg_${tid}_${i.id}_${nextSigs[i.id]}`, tgt, { title: sigs[i.id] ? "Itinerary updated" : "New booking added", body: `${trip.title || "Trip"}: ${what} (${i.start}${i.end && i.end !== i.start ? " – " + i.end : ""})`, app: link(i.start), tag: `chg-${i.id}` });
      }
      const ents = (await tripDoc.ref.collection("entries").where("updatedAt", ">", new Date(since - 5 * MIN).toISOString()).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      for (const e of ents) {
        if (e.kind !== "activity" || !e.confirmed || e.status === "recommended" || sigs[`a_${e.id}`] === "1") continue;
        nextSigs[`a_${e.id}`] = "1";
        const tgt = extras.filter((t) => follows(t, e.who) && t.email !== e.updatedBy);
        await sendOnce(`act_${tid}_${e.id}`, tgt, { title: "Activity booked", body: `${String(e.text || "").split("\n")[0]} · ${e.date}`, app: link(e.date), tag: `act-${e.id}` });
      }
      Object.keys(sigs).filter((k) => k.startsWith("a_")).forEach((k) => (nextSigs[k] = sigs[k]));
      await sigRef.set({ ...nextSigs, __init: true });
      // journal: new posts and replies
      const posts = (await tripDoc.ref.collection("journal").where("createdAt", ">", new Date(since - 5 * MIN).toISOString()).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      const travellers = (trip.travellers || []).map((x) => x.code);
      for (const j of posts) {
        const tgt = extras.filter((t) => follows(t, travellers) && !(j.device && t.device === j.device) && !(j.by === "editor" && t.email && t.email === j.updatedBy));
        await sendOnce(`jr_${tid}_${j.id}`, tgt, { title: j.replyTo ? `${j.author || "Someone"} replied in the journal` : `${j.author || "Someone"} posted in the journal`, body: (j.rating ? "★".repeat(j.rating) + " " : "") + String(j.text || "").slice(0, 140), app: link(j.date), tag: `jr-${j.id}` });
      }
    } else if (since === null) {
      const sigOf = (i) => [i.type, i.start, i.end, i.dep, i.arr, i.route, i.number, i.name, i.checkin, i.checkout, i.pickup, i.dropoff, i.pickupTime, i.dropoffTime, i.status].join("|");
      await db.collection("pushMeta").doc(`sig_${tid}`).set({ ...Object.fromEntries(items.map((i) => [i.id, sigOf(i)])), __init: true });
    }
  }

  // ---- Important: travel document problems (passports, visas...) - editors' devices, daytime in Brisbane only
  const bneHour = +new Date(now).toLocaleString("en-AU", { timeZone: HOME_TZ, hour: "numeric", hour12: false });
  if (bneHour >= 8 && bneHour < 20) {
    const eds = important.filter((t) => t.role === "editor");
    if (eds.length) {
      const people = (await db.collection("people").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
      const iso = new Date(now).toISOString().slice(0, 10);
      const addMonths = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
      for (const per of people) for (const doc of per.docs || []) {
        if (!doc.expiry) continue;
        const name = { passport: "passport", visa: "visa", esta: "ESTA", licence: "driver licence", idp: "driving permit", insurance: "travel insurance", vaccination: "vaccination" }[doc.type] || "document";
        let problem = "";
        if (doc.expiry < iso) problem = `expired on ${doc.expiry}`;
        else for (const t of trips.map((x) => x.data()).filter((t) => (t.travellers || []).concat(t.extended || []).some((x) => x.pid === per.id || (!x.pid && x.code === per.code)))) {
          if (doc.expiry < t.end) { problem = `expires ${doc.expiry}, before ${t.title} ends`; break; }
          if (doc.type === "passport" && doc.expiry < addMonths(t.end, 6)) { problem = `expires ${doc.expiry}, less than 6 months after ${t.title}`; break; }
        }
        if (!problem && (new Date(doc.expiry) - now) / 86400e3 <= 30) problem = `expires on ${doc.expiry}`;
        if (problem) await sendOnce(`doc_${per.id}_${doc.id}_${doc.expiry}_${problem.split(" ")[0]}`, eds, { title: `Check ${per.name || per.code}'s ${name}`, body: `The ${name} ${problem}.`, app: APP_URL, tag: `doc-${doc.id}` });
      }
    }
  }
  await metaRef.set({ lastRun: new Date(now) }, { merge: true });
});

// "Send Test Notification" button: sends one notification to the device that asks (signed-in editors and the family login only)
const ALLOWED = ["cesar.gonzalez.cruz1@gmail.com", "deb777deb@gmail.com", "family@travelplanner.app"];
export const sendTestPush = onCall({ region: "us-east1" }, async (req) => {
  const email = req.auth?.token?.email || "";
  if (!ALLOWED.includes(email)) throw new HttpsError("permission-denied", "Not allowed");
  const id = String(req.data?.id || "");
  const doc = id && (await db.collection("push").doc(id).get());
  if (!doc || !doc.exists) throw new HttpsError("not-found", "This phone isn't signed up for notifications - turn them on again");
  await getMessaging().send({ token: doc.data().token, webpush: { headers: { Urgency: "high", TTL: "600" } },
    data: { title: "Test notification ✓", body: "Notifications work on this phone.", app: APP_URL, tag: "test" } });
  return { ok: true };
});
