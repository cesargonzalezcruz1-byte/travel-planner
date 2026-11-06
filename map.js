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
