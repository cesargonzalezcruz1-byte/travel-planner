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
