// Check-in notifications: every 15 minutes, find flights whose online check-in has just opened
// and send a phone notification to the devices that turned notifications on for a traveller on that flight.
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { checkinInfo, codesOf, AIRPORT_TZ } from "./checkin-core.js";

initializeApp();
const db = getFirestore();
const APP_URL = "https://cesargonzalezcruz1-byte.github.io/travel-planner/";
const WINDOW_MS = 12 * 3600e3;   // only alert within 12 hours of check-in opening (no alerts for old flights)

function depLabel(f, c) {
  const tz = AIRPORT_TZ[codesOf(f.route)[0]];
  try { return c.dep.toLocaleString("en-AU", { timeZone: tz || "UTC", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); }
  catch (e) { return `${f.start} ${f.dep}`; }
}

export const checkinAlerts = onSchedule({ schedule: "every 15 minutes", region: "us-east1", timeoutSeconds: 120, memory: "256MiB" }, async () => {
  const now = Date.now();
  const tokens = (await db.collection("push").get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.token && Array.isArray(t.people) && t.people.length);
  if (!tokens.length) return;
  const today = new Date(now - 2 * 86400e3).toISOString().slice(0, 10);
  const trips = (await db.collection("trips").get()).docs.filter((d) => (d.data().end || "9999") >= today);
  let sent = 0;
  for (const trip of trips) {
    const flights = (await trip.ref.collection("items").where("type", "==", "flight").get()).docs;
    for (const fd of flights) {
      const f = fd.data(), c = checkinInfo(f, now);
      if (!c || c.status !== "open" || now - c.opens > WINDOW_MS) continue;
      const key = `${trip.id}_${fd.id}_${f.start}_${f.dep}`.replace(/[^\w-]/g, "-");
      const mark = db.collection("pushSent").doc(key);
      if ((await mark.get()).exists) continue;
      const who = f.who || [];
      const targets = tokens.filter((t) => t.people.some((p) => who.includes(p)));
      await mark.set({ at: new Date(), trip: trip.id, item: fd.id, devices: targets.length });   // once per flight, even if nobody is subscribed
      if (!targets.length) continue;
      const route = codesOf(f.route).join(" → ");
      const res = await getMessaging().sendEachForMulticast({
        tokens: targets.map((t) => t.token),
        data: {
          title: `Check-in is open: ${[f.airline, f.number].filter(Boolean).join(" ")}`.trim(),
          body: `${route} · departs ${depLabel(f, c)}. Tap to check in.`,
          url: c.url, app: `${APP_URL}#/t/${trip.id}/${f.start}`, tag: `checkin-${fd.id}`,
        },
        webpush: { headers: { Urgency: "high", TTL: String(6 * 3600) } },
      });
      sent += res.successCount;
      // forget devices that have uninstalled or turned notifications off
      await Promise.all(res.responses.map((r, k) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code || "")
        ? db.collection("push").doc(targets[k].id).delete() : null)));
      logger.info("check-in alert", { trip: trip.id, flight: f.number, route, devices: targets.length, ok: res.successCount });
    }
  }
  if (sent) logger.info(`sent ${sent} check-in notifications`);
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
    data: { title: "Test notification ✓", body: "Notifications work on this phone. You'll get one when check-in opens.", app: APP_URL, tag: "test" } });
  return { ok: true };
});
