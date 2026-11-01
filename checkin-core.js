// Shared by the app and the check-in notification function (functions/checkin-core.js is a copy - keep them the same).
// Airport time zones, airline check-in pages and windows, and when online check-in opens for a flight.
export const codesOf = (route) => String(route || "").split(/[-–>]+/).map((c) => c.trim()).filter(Boolean);
export const timeIn = (t) => { const m = String(t || "").match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""; };
export const AIRPORT_TZ = Object.entries({
  "Australia/Brisbane": "BNE OOL CNS TSV MKY ROK HTI PPP",
  "Australia/Sydney": "SYD CBR NTL BNK", "Australia/Melbourne": "MEL AVV", "Australia/Hobart": "HBA LST", "Australia/Adelaide": "ADL", "Australia/Perth": "PER", "Australia/Darwin": "DRW", "Australia/Lord_Howe": "LDH",
  "Pacific/Auckland": "AKL WLG CHC ZQN DUD NSN ROT NPL NPE PMR TRG HLZ IVC WKA TEU", "Pacific/Fiji": "NAN SUV", "Pacific/Honolulu": "HNL OGG KOA LIH ITO", "Pacific/Tahiti": "PPT", "Pacific/Noumea": "NOU", "Pacific/Port_Moresby": "POM",
  "Asia/Singapore": "SIN", "Asia/Tokyo": "NRT HND KIX ITM NGO CTS FUK OKA", "Asia/Seoul": "ICN GMP", "Asia/Hong_Kong": "HKG", "Asia/Shanghai": "PVG SHA PEK PKX CAN SZX CTU", "Asia/Taipei": "TPE", "Asia/Bangkok": "BKK DMK HKT CNX USM",
  "Asia/Makassar": "DPS", "Asia/Jakarta": "CGK", "Asia/Kuala_Lumpur": "KUL", "Asia/Manila": "MNL CEB", "Asia/Ho_Chi_Minh": "SGN", "Asia/Dubai": "DXB DWC", "Asia/Qatar": "DOH", "Asia/Kolkata": "DEL BOM BLR MAA",
  "America/Los_Angeles": "LAX SFO SAN SJC OAK SMF BUR SNA ONT LGB PSP SEA PDX LAS RNO", "America/Phoenix": "PHX TUS", "America/Denver": "DEN SLC ABQ BOI", "America/Chicago": "ORD MDW DFW DAL IAH HOU AUS SAT MSP MSY STL MCI BNA MEM OKC",
  "America/New_York": "JFK LGA EWR BOS IAD DCA BWI PHL ATL MIA FLL MCO TPA RSW PBI CLT DTW CLE PIT RDU CVG IND CMH BUF EYW", "America/Anchorage": "ANC", "America/Toronto": "YYZ YOW YUL", "America/Vancouver": "YVR YYJ", "America/Edmonton": "YYC YEG",
  "America/Cancun": "CUN TQO CZM", "America/Mexico_City": "MEX NLU GDL MTY OAX PVR SJD BJX QRO VER MID", "America/Tijuana": "TIJ", "America/Mazatlan": "MZT", "America/Hermosillo": "HMO", "America/Bogota": "BOG MDE CTG", "America/Lima": "LIM CUZ",
  "America/Santiago": "SCL", "America/Argentina/Buenos_Aires": "EZE AEP", "America/Sao_Paulo": "GRU GIG", "America/Panama": "PTY", "America/Costa_Rica": "SJO LIR", "America/Havana": "HAV",
  "Europe/London": "LHR LGW STN LTN MAN EDI", "Europe/Dublin": "DUB", "Europe/Paris": "CDG ORY NCE", "Europe/Madrid": "MAD BCN AGP", "Europe/Rome": "FCO MXP VCE", "Europe/Berlin": "FRA MUC BER", "Europe/Amsterdam": "AMS", "Europe/Zurich": "ZRH", "Europe/Lisbon": "LIS", "Europe/Athens": "ATH", "Europe/Istanbul": "IST",
}).reduce((m, [tz, codes]) => { codes.split(" ").forEach((c) => (m[c] = tz)); return m; }, {});
export const CHECKIN = [   // airline online check-in pages
  [/delta/i, "https://www.delta.com/mytrips/"], [/united/i, "https://www.united.com/en/us/checkin"], [/american/i, "https://www.aa.com/reservation/view/find-your-trip"],
  [/southwest/i, "https://www.southwest.com/air/check-in/"], [/alaska/i, "https://www.alaskaair.com/checkin"], [/jetblue/i, "https://www.jetblue.com/check-in"],
  [/aerom[eé]xico/i, "https://aeromexico.com/en-us/check-in"], [/volaris/i, "https://www.volaris.com/en/check-in"], [/viva ?aerobus/i, "https://www.vivaaerobus.com/en-us/check-in"],
  [/air new zealand/i, "https://www.airnewzealand.com.au/check-in"], [/qantas/i, "https://www.qantas.com/au/en/travel-info/check-in.html"], [/jetstar/i, "https://www.jetstar.com/au/en/check-in"],
  [/virgin australia/i, "https://www.virginaustralia.com/au/en/manage-booking/check-in/"], [/air canada/i, "https://www.aircanada.com/checkin"], [/latam/i, "https://www.latamairlines.com/us/en/check-in"],
];
export const checkinUrl = (airline) => (CHECKIN.find(([re]) => re.test(airline || "")) || [, `https://www.google.com/search?q=${encodeURIComponent((airline || "") + " online check-in")}`])[1];;
export const CHECKIN_HOURS = [[/aerom[eé]xico/i, 48], [/volaris/i, 48], [/viva ?aerobus/i, 48]];   // most airlines: 24 h
export const checkinHours = (airline) => (CHECKIN_HOURS.find(([re]) => re.test(airline || "")) || [, 24])[1];
// "2026-12-25" + "10:40" in an IANA zone -> a real moment (Date)
export function zonedDate(date, hm, tz) {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = (hm || "00:00").split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  if (!tz) return new Date(y, mo - 1, d, h, mi);
  try {
    const off = (t) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t));
      const g = (k) => +p.find((x) => x.type === k).value; return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) - t; };
    let t = guess - off(guess); t = guess - off(t); return new Date(t);
  } catch (e) { return new Date(y, mo - 1, d, h, mi); }
}
// when check-in opens for a flight item, and its status at "now"
export function checkinInfo(f, now = Date.now()) {
  const hm = timeIn(f.dep); if (!f.start || !hm) return null;
  const from = codesOf(f.route)[0], dep = zonedDate(f.start, hm, AIRPORT_TZ[from]), hours = checkinHours(f.airline);
  const opens = new Date(dep - hours * 3600e3);
  const status = now >= dep - 45 * 60e3 ? "closed" : now >= opens ? "open" : opens - now < 72 * 3600e3 ? "soon" : "later";
  return { dep, opens, hours, status, url: checkinUrl(f.airline) };
}
