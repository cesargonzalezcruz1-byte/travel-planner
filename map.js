// Embedded Google Map for the day screen: one pin per place, coloured by kind.
// Needs MAPS_API_KEY in firebase-config.js (Maps JavaScript API + Geocoding API enabled, key restricted to the site).
import { MAPS_API_KEY, MAP_ID } from "./firebase-config.js";
// Also used for recommendations: Places API (New) enabled on the same key.

let loading = null, authFailed = false;
window.gm_authFailure = () => { authFailed = true; document.querySelectorAll(".daymap-msg").forEach((m) => (m.textContent = "Google Maps rejected the key - check the key's website restriction and that Maps JavaScript API is enabled.")); };

export const mapsReady = () => !!(MAPS_API_KEY || window.google?.maps?.importLibrary);

function load() {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (!MAPS_API_KEY) return Promise.reject(new Error("No Google Maps key set up yet"));
  return (loading ||= new Promise((ok, bad) => {
    window.__gmReady = ok;
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_API_KEY)}&v=weekly&loading=async&callback=__gmReady`;
    s.async = true; s.onerror = () => { loading = null; bad(new Error("Couldn't load Google Maps (offline?)")); };
    document.head.appendChild(s);
  }));
}

// address -> {lat,lng} cache kept on this device, so each place is looked up once
let cache = {};
try { cache = JSON.parse(localStorage.getItem("tp.geo") || "{}"); } catch (e) { /* private mode */ }
async function geocode(gc, q) {
  if (q in cache) return cache[q];
  let r = null;
  try {
    const { results } = await gc.geocode({ address: q });
    if (results?.[0]) { const l = results[0].geometry.location; r = { lat: l.lat(), lng: l.lng(), addr: results[0].formatted_address || "" }; }
  } catch (e) { if (!/ZERO_RESULTS/.test(String(e.code || e.message))) throw e; }
  cache[q] = r; try { localStorage.setItem("tp.geo", JSON.stringify(cache)); } catch (e) { /* ignore */ }
  return r;
}

// One map instance re-used across re-renders (each new map counts as a "map load")
let mapEl = null, map = null, markers = [], info = null, lastSig = "";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const link = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

// pins: [{ q: search text, name, kind: label, glyph, color }]
export async function drawDayMap(holder, pins, msgEl) {
  if (!pins.length) { holder.hidden = true; return; }
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load();
  const { Map, InfoWindow } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
  const { Geocoder } = await google.maps.importLibrary("geocoding");
  if (!mapEl) {
    mapEl = document.createElement("div"); mapEl.className = "daymap-canvas";
    map = new Map(mapEl, { mapId: MAP_ID || "DEMO_MAP_ID", center: { lat: 20, lng: -90 }, zoom: 4, gestureHandling: "cooperative",
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    info = new InfoWindow();
  }
  holder.appendChild(mapEl);
  const sig = JSON.stringify(pins);
  if (sig === lastSig) return;   // same day, same places - keep the map as it is
  lastSig = sig;
  markers.forEach((m) => (m.map = null)); markers = []; info.close();
  const gc = new Geocoder();
  const pos = await Promise.all(pins.map((p) => (p.pos ? p.pos : geocode(gc, p.q).catch(() => null))));
  if (sig !== lastSig) return;   // another day was opened meanwhile
  const bounds = new google.maps.LatLngBounds(); const seen = {}; const missing = [];
  pins.forEach((p, i) => {
    const at = pos[i]; if (!at) { missing.push(p.name); return; }
    const k = at.lat.toFixed(4) + "," + at.lng.toFixed(4); const dup = (seen[k] = (seen[k] || 0) + 1) - 1;   // nudge pins on the same spot
    const position = { lat: at.lat + dup * 0.0004, lng: at.lng + dup * 0.0004 };
    const el = document.createElement("div"); el.className = "mpin" + (p.hollow ? " hollow" : ""); el.style.setProperty("--pin", p.color);
    el.innerHTML = `<span>${p.glyph}</span>`;
    const m = new AdvancedMarkerElement({ map, position, content: el, title: `${p.kind}: ${p.name}` });
    m.addListener("click", () => {
      info.setContent(`<div class="mpop"><b>${esc(p.name)}</b><div class="k" style="color:${p.color}">${esc(p.kind)}</div>${at.addr ? `<div>${esc(at.addr)}</div>` : ""}<a target="_blank" rel="noopener" href="${p.url || link(p.q)}">Open in Google Maps</a></div>`);
      info.open({ anchor: m, map });
    });
    markers.push(m); bounds.extend(position);
  });
  if (markers.length === 1) { map.setCenter(bounds.getCenter()); map.setZoom(13); }
  else if (markers.length) map.fitBounds(bounds, 48);
  if (msgEl) msgEl.textContent = missing.length ? `Couldn't find on the map: ${missing.join(", ")}` : "";
}

// Best-rated places near a location (Places API (New) - must be enabled for the key). Returns plain objects.
const PLACE_FIELDS = ["id", "displayName", "rating", "userRatingCount", "formattedAddress", "primaryTypeDisplayName", "googleMapsURI", "location"];
export async function searchPlaces(textQuery, near) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load();
  const { Place } = await google.maps.importLibrary("places");
  let bias;
  if (near) { const { Geocoder } = await google.maps.importLibrary("geocoding"); const g = await geocode(new Geocoder(), near).catch(() => null); if (g) bias = { center: { lat: g.lat, lng: g.lng }, radius: 25000 }; }
  const { places } = await Place.searchByText({ textQuery, fields: PLACE_FIELDS, maxResultCount: 20, language: "en", ...(bias ? { locationBias: bias } : {}) });
  return (places || []).map((p) => ({ id: p.id, name: p.displayName || "", rating: p.rating || 0, count: p.userRatingCount || 0, address: p.formattedAddress || "",
    type: p.primaryTypeDisplayName || "", url: p.googleMapsURI || "", lat: p.location?.lat?.() ?? null, lng: p.location?.lng?.() ?? null }));
}

// ---- Emergency card: the nearest hospital, pharmacy and supermarket to a stay, and the nearest embassy / consulate of a country
const ESS_FIELDS = ["id", "displayName", "formattedAddress", "location", "nationalPhoneNumber", "internationalPhoneNumber", "googleMapsURI", "regularOpeningHours", "types"];
const essOut = (p, at) => { const lat = p.location?.lat?.(), lng = p.location?.lng?.();
  return { id: p.id, name: p.displayName || "", address: p.formattedAddress || "", phone: p.internationalPhoneNumber || p.nationalPhoneNumber || "", url: p.googleMapsURI || "",
    lat, lng, km: lat != null ? Math.round(km(at, { lat, lng }) * 10) / 10 : null, h24: !!(p.regularOpeningHours?.periods || []).some((x) => !x.close && x.open?.day === 0 && x.open?.hour === 0) }; };
export async function nearbyEssentials(address) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load(); const at = await geocodeText(address); if (!at) throw new Error("Couldn't find " + address);
  const { Place, SearchByTextRankPreference } = await google.maps.importLibrary("places");
  const one = async (textQuery, includedType, test) => { try {
      const { places } = await Place.searchByText({ textQuery, includedType, useStrictTypeFiltering: true, fields: ESS_FIELDS, maxResultCount: 8, language: "en",
        locationBias: { center: { lat: at.lat, lng: at.lng }, radius: 20000 }, ...(SearchByTextRankPreference ? { rankPreference: SearchByTextRankPreference.DISTANCE } : {}) });
      const list = (places || []).map((p) => essOut(p, at)).filter((x) => x.km != null && (!test || test(x))).sort((a, b) => a.km - b.km);
      return list[0] || null; } catch (e) { console.warn("nearby", textQuery, e); return null; } };
  const [hospital, pharmacy, supermarket] = await Promise.all([
    one("hospital emergency department", "hospital", (x) => /hospital|medical cent|centro m[eé]dico|cl[ií]nica|sanatorio|health/i.test(x.name)),
    one("pharmacy", "pharmacy"), one("supermarket", "supermarket")]);
  return { lat: at.lat, lng: at.lng, addr: at.addr, hospital, pharmacy, supermarket };
}
const fold = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
export async function nearestConsulate(country, at) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load(); const { Place } = await google.maps.importLibrary("places");
  const root = fold(country).slice(0, 5);
  const { places } = await Place.searchByText({ textQuery: `embassy or consulate of ${country}`, includedType: "embassy", fields: ESS_FIELDS, maxResultCount: 10, language: "en",
    locationBias: { center: { lat: at.lat, lng: at.lng }, radius: 50000 } });
  return (places || []).map((p) => essOut(p, at)).filter((x) => x.km != null && fold(x.name).includes(root) && !/honorary.*closed/i.test(x.name)).sort((a, b) => a.km - b.km)[0] || null;
}

// Address suggestions while typing (Places Autocomplete; one session token per field so it's billed as one lookup)
let acToken = null;
export async function addressSuggest(input, opts = {}) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load(); const { AutocompleteSuggestion, AutocompleteSessionToken } = await google.maps.importLibrary("places");
  acToken ||= new AutocompleteSessionToken();
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions({ input, sessionToken: acToken, language: "en", ...(opts.any ? {} : { includedPrimaryTypes: ["street_address", "premise", "subpremise", "route"] }),
    ...(opts.near ? { locationBias: { center: opts.near, radius: 50000 } } : {}) });
  return (suggestions || []).map((x) => x.placePrediction).filter(Boolean).map((p) => ({ main: p.mainText?.toString() || "", sub: p.secondaryText?.toString() || "", text: p.text?.toString() || "" }));
}
export const addressDone = () => { acToken = null; };

// ---------------------------------------------------------------- travel times between a day's stops (on demand)
// Look a place up for routing: up to 3 candidates near the stay, with whether it looks vague (a whole town, far away, or nothing found).
const BROAD = /^(locality|sublocality|administrative_area_level_\d|country|political|colloquial_area|postal_code|neighborhood|natural_feature)$/;
const km = (a, b) => { const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
export { km as distanceKm };
export async function geocodeText(q) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load(); const { Geocoder } = await google.maps.importLibrary("geocoding");
  return geocode(new Geocoder(), q);
}
export async function findPlace(textQuery, near) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load();
  const { Place } = await google.maps.importLibrary("places");
  const { places } = await Place.searchByText({ textQuery, fields: ["id", "displayName", "formattedAddress", "location", "types"], maxResultCount: 3, language: "en",
    ...(near ? { locationBias: { center: near, radius: 30000 } } : {}) });
  return (places || []).map((p) => { const lat = p.location?.lat?.(), lng = p.location?.lng?.();
    return { id: p.id, name: p.displayName || "", address: p.formattedAddress || "", lat, lng, broad: (p.types || []).every((t) => BROAD.test(t)) && (p.types || []).length > 0,
      km: near && lat != null ? Math.round(km(near, { lat, lng }) * 10) / 10 : null }; });
}
// One request to the Routes API: legs between origin, stops and destination (optionally letting Google pick the best order of the stops)
export async function computeRoute(points, mode, optimize) {
  if (!MAPS_API_KEY) throw new Error("No Google Maps key set up yet");
  const wp = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = { origin: wp(points[0]), destination: wp(points.at(-1)), intermediates: points.slice(1, -1).map(wp), travelMode: mode,
    ...(mode === "DRIVE" ? { routingPreference: "TRAFFIC_UNAWARE" } : {}), ...(optimize && points.length > 3 ? { optimizeWaypointOrder: true } : {}), units: "METRIC" };
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": MAPS_API_KEY, "X-Goog-FieldMask": "routes.legs.duration,routes.legs.distanceMeters,routes.optimizedIntermediateWaypointIndex" },
    body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const m = j.error?.message || `HTTP ${r.status}`;
    throw new Error(/not been used|disabled|not enabled|SERVICE_DISABLED/i.test(m) ? "The Routes API isn't switched on for the Google key yet" : /referer|API_KEY_.*BLOCKED|not authorized/i.test(m) ? "The Google key doesn't allow the Routes API yet (key restrictions)" : m); }
  const route = j.routes?.[0]; if (!route) throw new Error(mode === "WALK" ? "No walking route found" : "No route found between these places");
  return { order: route.optimizedIntermediateWaypointIndex || null,
    legs: (route.legs || []).map((l) => ({ sec: parseInt(String(l.duration || "0").replace("s", ""), 10) || 0, m: l.distanceMeters || 0 })) };
}

// ---------------------------------------------------------------- whole-trip map: stays, flight paths, activities, and a day-by-day focus
// model: { points: [{ key, q?, pos?, name, kind, glyph, color, days: [dates], small? }], flights: [{ from, to, days, label, color }], ground: [{ from, to, days }] }
let tEl = null, tMap = null, tInfo = null;
export async function drawTripMap(holder, model, msgEl) {
  if (authFailed) throw new Error("Google Maps rejected the key");
  await load();
  const { Map, InfoWindow, Polyline } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
  const { Geocoder } = await google.maps.importLibrary("geocoding");
  if (!tEl) {
    tEl = document.createElement("div"); tEl.className = "tmap-canvas-inner";
    tMap = new Map(tEl, { mapId: MAP_ID || "DEMO_MAP_ID", center: { lat: 20, lng: -90 }, zoom: 3, gestureHandling: "greedy", mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    tInfo = new InfoWindow();
  }
  holder.appendChild(tEl);
  const sig = JSON.stringify(model);
  if (sig === tMap.__sig && tMap.__ctl) { if (msgEl) msgEl.textContent = tMap.__msg || ""; return tMap.__ctl; }   // same trip and person: keep what's drawn
  const token = (tMap.__token = (tMap.__token || 0) + 1);
  const gc = new Geocoder(), pos = {}, missing = [];
  await Promise.all(model.points.map(async (p) => { pos[p.key] = p.pos || (p.q ? await geocode(gc, p.q).catch(() => null) : null); if (!pos[p.key]) missing.push(p.name); }));
  if (token !== tMap.__token) return tMap.__ready;   // a newer drawing started meanwhile
  (tMap.__objs || []).forEach((o) => (o.setMap ? o.setMap(null) : (o.map = null))); tMap.__objs = [];
  const markers = [], lines = [], all = new google.maps.LatLngBounds(); let any = false;
  const seen = {};
  for (const p of model.points) {
    const at = pos[p.key]; if (!at) continue;
    const k = at.lat.toFixed(3) + "," + at.lng.toFixed(3), dup = (seen[k] = (seen[k] || 0) + 1) - 1;
    const position = { lat: at.lat + dup * 0.0006, lng: at.lng + dup * 0.0006 };
    const el = document.createElement("div"); el.className = "mpin" + (p.small ? " small" : ""); el.style.setProperty("--pin", p.color); el.innerHTML = `<span>${p.glyph}</span>`;
    const m = new AdvancedMarkerElement({ map: tMap, position, content: el, title: `${p.kind}: ${p.name}`, zIndex: p.small ? 1 : 5 });
    m.addListener("click", () => { tInfo.setContent(`<div class="mpop"><b>${esc(p.name)}</b><div class="k" style="color:${p.color}">${esc(p.kind)}</div>${p.sub ? `<div>${esc(p.sub)}</div>` : ""}<a target="_blank" rel="noopener" href="${link(p.q || `${at.lat},${at.lng}`)}">Open in Google Maps</a></div>`); tInfo.open({ anchor: m, map: tMap }); });
    markers.push({ p, m, el, position }); tMap.__objs.push(m); all.extend(position); any = true;
  }
  const mk = (from, to, opt) => { const a = pos[from], b = pos[to]; if (!a || !b) return null;
    const l = new Polyline({ map: tMap, path: [a, b], ...opt }); tMap.__objs.push(l); return l; };
  for (const f of model.flights) { const l = mk(f.from, f.to, { geodesic: true, strokeColor: f.color, strokeOpacity: 0, strokeWeight: 2,
    icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: f.color, scale: 2.5 }, offset: "0", repeat: "12px" }, { icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3, strokeColor: f.color, fillColor: f.color, fillOpacity: 1 }, offset: "55%" }] });
    if (l) lines.push({ f, l, base: f.color }); }
  for (const g of model.ground) { const l = mk(g.from, g.to, { strokeColor: g.color, strokeOpacity: 0.8, strokeWeight: 3 }); if (l) lines.push({ f: g, l, ground: true }); }
  if (any) { tMap.fitBounds(all, 40); }
  tMap.__msg = missing.length ? `Couldn't find on the map: ${[...new Set(missing)].join(", ")}` : "";
  if (msgEl) msgEl.textContent = tMap.__msg;
  // focus one day (or null = the whole trip)
  const ctl = {
    focus(date) {
      const b = new google.maps.LatLngBounds(); let n = 0;
      for (const x of markers) { const on = !date || x.p.days.includes(date); x.el.classList.toggle("dim", !on); x.el.classList.toggle("hot", !!date && on); x.m.zIndex = on ? 10 : 1; if (on) { b.extend(x.position); n++; } }
      for (const x of lines) { const on = !date || x.f.days.includes(date);
        if (x.ground) x.l.setOptions({ strokeOpacity: on ? 0.85 : 0.15, strokeWeight: date && on ? 5 : 3 });
        else x.l.setOptions({ icons: x.l.get("icons").map((ic, k) => ({ ...ic, icon: { ...ic.icon, strokeOpacity: on ? 1 : 0.18, ...(k ? { fillOpacity: on ? 1 : 0.18 } : {}) } })) });
        if (date && on) x.l.getPath().forEach((ll) => { b.extend(ll); n++; }); }
      if (!date) { if (any) tMap.fitBounds(all, 40); return; }
      if (n === 1) { tMap.setCenter(b.getCenter()); tMap.setZoom(11); } else if (n > 1) tMap.fitBounds(b, 60);
    },
  };
  tMap.__sig = sig; tMap.__ctl = ctl; return ctl;
}
