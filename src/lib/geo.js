// Pure geometry helpers (no Cesium dependency) so they can be unit tested in Node.
// Coordinates are [lon, lat] in degrees (WGS84), as in GeoJSON.

const R = 6371008.8; // mean Earth radius in metres
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres between two [lon, lat] points. */
export function distance(a, b) {
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Removes the closing coordinate of a ring if it repeats the first one. */
export function openRing(ring) {
  if (ring.length > 1) {
    const f = ring[0];
    const l = ring[ring.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) return ring.slice(0, -1);
  }
  return ring.slice();
}

/**
 * Geodesic polygon ring area in m² (spherical excess method used by
 * Turf / OpenLayers). Accurate to well under 0.1% for land parcels.
 */
export function ringArea(ring) {
  const pts = openRing(ring);
  const n = pts.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    total += (toRad(p3[0]) - toRad(p1[0])) * Math.sin(toRad(p2[1]));
  }
  return Math.abs((total * R * R) / 2);
}

/** Area of a polygon given as [outer, ...holes]. */
export function polygonArea(rings) {
  if (!rings.length) return 0;
  let a = ringArea(rings[0]);
  for (let i = 1; i < rings.length; i++) a -= ringArea(rings[i]);
  return Math.max(0, a);
}

export function ringPerimeter(ring) {
  const pts = openRing(ring);
  let p = 0;
  for (let i = 0; i < pts.length; i++) p += distance(pts[i], pts[(i + 1) % pts.length]);
  return p;
}

/** Edges of a ring: [{from, to, mid, length}] */
export function ringEdges(ring) {
  const pts = openRing(ring);
  const edges = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    edges.push({
      from: a,
      to: b,
      mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      length: distance(a, b),
    });
  }
  return edges;
}

/** Area-weighted centroid of a ring (planar, fine at parcel scale). */
export function ringCentroid(ring) {
  const pts = openRing(ring);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-18) {
    const s = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [s[0] / pts.length, s[1] / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(coords) {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [x, y] of coords) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Grows a [w, s, e, n] box by `metres` on every side. */
export function bufferBbox([w, s, e, n], metres) {
  const lat = (s + n) / 2;
  const dLat = toDeg(metres / R);
  const dLon = toDeg(metres / (R * Math.cos(toRad(lat))));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
}

/** Ray-casting point-in-ring test. */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in polygon with holes ([outer, ...holes]). */
export function pointInPolygon(p, rings) {
  if (!pointInRing(p, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false;
  return true;
}

/** Offsets a [lon, lat] point by metres east / north. */
export function offset([lon, lat], east, north) {
  return [lon + toDeg(east / (R * Math.cos(toRad(lat)))), lat + toDeg(north / R)];
}

/** Metres per degree at a latitude: [perDegLon, perDegLat]. */
export function metresPerDegree(lat) {
  return [toRad(1) * R * Math.cos(toRad(lat)), toRad(1) * R];
}

/** Small deterministic PRNG (mulberry32) so generated scenes are stable. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashes a string or number into a 32-bit seed. */
export function hashSeed(value) {
  const s = String(value);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Formats metres² for display; dönüm = 1000 m² (used in Turkey). */
export function formatArea(m2, locale = 'tr-TR') {
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  return { m2: nf.format(m2), donum: nf.format(m2 / 1000), hectare: nf.format(m2 / 10000) };
}
