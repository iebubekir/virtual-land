// Converts OpenStreetMap (Overpass API) data around a parcel into simple 3D scene data:
// extruded buildings and individual trees. Pure module (no Cesium), unit tested in Node.

import {
  bbox as computeBbox,
  distance,
  hashSeed,
  metresPerDegree,
  openRing,
  pointInPolygon,
  pointInRing,
  seededRandom,
} from './geo.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/** Overpass QL for buildings + vegetation inside [w, s, e, n]. */
export function buildOverpassQuery([w, s, e, n]) {
  const b = `${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)}`;
  return `[out:json][timeout:40];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  node["natural"="tree"](${b});
  way["natural"="tree_row"](${b});
  way["natural"~"^(wood|scrub)$"](${b});
  relation["natural"="wood"](${b});
  way["landuse"~"^(forest|orchard)$"](${b});
  relation["landuse"~"^(forest|orchard)$"](${b});
  way["leisure"~"^(park|garden)$"](${b});
);
out geom qt;`;
}

/** Parses "12", "12 m", "12.5m", "40'" (feet) into metres. */
export function parseHeight(value) {
  if (value == null) return NaN;
  const s = String(value).trim().replace(',', '.');
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|')?/i);
  if (!m) return NaN;
  const v = parseFloat(m[1]);
  return m[2] && /ft|'/i.test(m[2]) ? v * 0.3048 : v;
}

const LEVEL_HEIGHT = 3;

const BUILDING_STYLES = {
  // kind: [default levels, wall colour, roof colour, roof shape]
  house: [2, '#efe4d2', '#b5523b', 'pitched'],
  detached: [2, '#efe4d2', '#b5523b', 'pitched'],
  semidetached_house: [2, '#eadcc6', '#a94a35', 'pitched'],
  terrace: [2, '#e8dcc8', '#a94a35', 'pitched'],
  farm: [2, '#e6d8bf', '#a44b33', 'pitched'],
  residential: [4, '#ece6dc', '#9b4a37', 'pitched'],
  apartments: [5, '#e9e4dc', '#8f8a84', 'flat'],
  commercial: [3, '#dfe3e6', '#7d8388', 'flat'],
  retail: [2, '#e3e1dc', '#7d8388', 'flat'],
  office: [5, '#d9e1e8', '#717880', 'flat'],
  industrial: [3, '#d7d9db', '#8c9399', 'flat'],
  warehouse: [3, '#d4d6d8', '#8c9399', 'flat'],
  school: [3, '#efe2c9', '#a6503a', 'pitched'],
  mosque: [3, '#f2efe9', '#9aa3ad', 'flat'],
  barn: [2, '#c9b08f', '#8a4632', 'pitched'],
  farm_auxiliary: [1, '#cdb795', '#8a4632', 'pitched'],
  shed: [1, '#c8b79c', '#7b6a58', 'flat'],
  hut: [1, '#c8b79c', '#7b6a58', 'flat'],
  garage: [1, '#d3cfc8', '#8b8680', 'flat'],
  garages: [1, '#d3cfc8', '#8b8680', 'flat'],
  greenhouse: [1, '#e9f2ee', '#e9f2ee', 'flat'],
  roof: [1, '#cfcac2', '#8b8680', 'flat'],
  construction: [3, '#c9c4bb', '#a29c93', 'flat'],
};
const DEFAULT_STYLE = [2, '#ebe2d3', '#a9503a', 'pitched'];

const WALL_TINTS = ['#efe4d2', '#e9ddc8', '#f2ece1', '#e4d6c0', '#ece3d6', '#e7e0d6'];

/** Height (m) and look of a building from its OSM tags. */
export function buildingAppearance(tags = {}, seed = 0) {
  const kind = tags.building === 'yes' ? (tags['building:use'] || 'yes') : tags.building;
  const style = BUILDING_STYLES[kind] || DEFAULT_STYLE;
  const rnd = seededRandom(seed);
  let height = parseHeight(tags.height);
  const levels = parseFloat(tags['building:levels']);
  const roofLevels = parseFloat(tags['roof:levels']) || 0;
  if (!Number.isFinite(height)) {
    if (Number.isFinite(levels)) height = (levels + roofLevels) * LEVEL_HEIGHT + 0.5;
    else {
      // Unknown: vary a little around the style default so the scene does not look flat.
      const lv = style[0] + (kind === 'yes' || kind === 'house' ? Math.floor(rnd() * 2) : 0);
      height = lv * LEVEL_HEIGHT + 0.5;
    }
  }
  let minHeight = parseHeight(tags.min_height);
  if (!Number.isFinite(minHeight)) {
    const minLevel = parseFloat(tags['building:min_level']);
    minHeight = Number.isFinite(minLevel) ? minLevel * LEVEL_HEIGHT : 0;
  }
  const wall = tags['building:colour'] || (style === DEFAULT_STYLE || style[1] === '#efe4d2' ? WALL_TINTS[Math.floor(rnd() * WALL_TINTS.length)] : style[1]);
  const roof = tags['roof:colour'] || style[2];
  const roofShape = tags['roof:shape'] ? (tags['roof:shape'] === 'flat' ? 'flat' : 'pitched') : style[3];
  return {
    kind,
    height: Math.max(2.5, Math.min(height, 300)),
    minHeight: Math.max(0, minHeight),
    wallColor: wall,
    roofColor: roof,
    roofShape,
    translucent: kind === 'greenhouse',
  };
}

const geomToRing = (geometry) => (geometry || []).map((p) => [p.lon, p.lat]);

/** Joins way segments into closed rings (for multipolygon relations). */
export function assembleRings(segments) {
  const rings = [];
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  while (pool.length) {
    let ring = pool.shift();
    let progress = true;
    while (!same(ring[0], ring[ring.length - 1]) && progress) {
      progress = false;
      for (let i = 0; i < pool.length; i++) {
        const seg = pool[i];
        const end = ring[ring.length - 1];
        if (same(seg[0], end)) ring = ring.concat(seg.slice(1));
        else if (same(seg[seg.length - 1], end)) ring = ring.concat(seg.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        progress = true;
        break;
      }
    }
    const open = openRing(ring);
    if (open.length >= 3) rings.push(open);
  }
  return rings;
}

/** Polygons ([outer, ...holes]) from an Overpass element with `out geom`. */
export function elementPolygons(el) {
  if (el.type === 'way') {
    const ring = openRing(geomToRing(el.geometry));
    return ring.length >= 3 ? [[ring]] : [];
  }
  if (el.type === 'relation') {
    const outers = assembleRings(el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => geomToRing(m.geometry)));
    const inners = assembleRings(el.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => geomToRing(m.geometry)));
    return outers.map((outer) => [outer, ...inners.filter((inner) => pointInRing(inner[0], outer))]);
  }
  return [];
}

/** Uniform grid index of building footprints for fast "is this point inside a building" tests. */
class FootprintIndex {
  constructor(buildings, cell = 0.0005) {
    this.cell = cell;
    this.grid = new Map();
    for (const b of buildings) {
      const [w, s, e, n] = computeBbox(b.ring);
      for (let x = Math.floor(w / cell); x <= Math.floor(e / cell); x++)
        for (let y = Math.floor(s / cell); y <= Math.floor(n / cell); y++) {
          const k = `${x},${y}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k).push(b);
        }
    }
  }
  contains(p, padding = 0) {
    const list = this.grid.get(`${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`);
    if (!list) return false;
    return list.some((b) => pointInRing(p, b.ring) || (padding > 0 && nearRing(p, b.ring, padding)));
  }
}

function nearRing(p, ring, metres) {
  return ring.some((q) => distance(p, q) < metres);
}

/** Tree look for a vegetation area or single tree. */
export function treeStyle(tags = {}, area = null) {
  const leaf = tags.leaf_type || area?.leaf_type;
  const genus = (tags.genus || tags.species || tags.taxon || '').toLowerCase();
  const crop = (area?.trees || area?.crop || '').toLowerCase();
  if (leaf === 'needleleaved' || /pinus|picea|abies|cedrus|cupressus|çam|cam|pine/.test(genus)) return 'conifer';
  if (/olea|olive|zeytin/.test(genus + crop)) return 'olive';
  if (area?.kind === 'orchard') return 'fruit';
  if (leaf === 'mixed' || area?.leaf_type === 'mixed') return 'mixed';
  return 'broad';
}

const SPACING = { forest: 5.5, wood: 5.5, scrub: 7, orchard: 6, park: 13, garden: 11 };

function scatterInPolygon(rings, spacing, rnd, clip, grid) {
  const pts = [];
  const [w0, s0, e0, n0] = computeBbox(rings[0]);
  const w = Math.max(w0, clip[0]);
  const s = Math.max(s0, clip[1]);
  const e = Math.min(e0, clip[2]);
  const n = Math.min(n0, clip[3]);
  if (w >= e || s >= n) return pts;
  const [mLon, mLat] = metresPerDegree((s + n) / 2);
  const dx = spacing / mLon;
  const dy = spacing / mLat;
  // Hard ceiling on candidate count for huge forests clipped to large windows.
  if (((e - w) / dx) * ((n - s) / dy) > 400000) return pts;
  for (let x = w + dx / 2; x < e; x += dx) {
    for (let y = s + dy / 2; y < n; y += dy) {
      const jx = grid ? (rnd() - 0.5) * dx * 0.25 : (rnd() - 0.5) * dx * 0.9;
      const jy = grid ? (rnd() - 0.5) * dy * 0.25 : (rnd() - 0.5) * dy * 0.9;
      const p = [x + jx, y + jy];
      if (pointInPolygon(p, rings)) pts.push(p);
    }
  }
  return pts;
}

function sampleLine(coords, spacing) {
  const pts = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const d = distance(a, b);
    const n = Math.max(1, Math.round(d / spacing));
    for (let k = 0; k < n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  if (coords.length) pts.push(coords[coords.length - 1]);
  return pts;
}

const TREE_SIZE = {
  // [min height, max height, crown radius factor (of height)]
  broad: [6, 12, 0.32],
  mixed: [7, 14, 0.3],
  conifer: [9, 18, 0.2],
  olive: [3.5, 6, 0.45],
  fruit: [3.5, 5.5, 0.42],
};

function makeTree(pos, style, rnd, tags = {}) {
  const resolved = style === 'mixed' ? (rnd() < 0.45 ? 'conifer' : 'broad') : style;
  const [hmin, hmax, rf] = TREE_SIZE[resolved] || TREE_SIZE.broad;
  let height = parseHeight(tags.height);
  if (!Number.isFinite(height)) height = hmin + rnd() * (hmax - hmin);
  const crownDiameter = parseHeight(tags.diameter_crown);
  const crown = Number.isFinite(crownDiameter) ? crownDiameter / 2 : height * rf * (0.85 + rnd() * 0.3);
  return { pos, height, crown, style: resolved, shade: rnd() };
}

/**
 * Turns an Overpass JSON response into buildings and trees.
 * @param data Overpass JSON
 * @param options.center [lon, lat] — elements nearest to it are kept when limits are hit
 * @param options.clip [w, s, e, n] — area to generate trees in
 * @param options.exclude polygons ([[outer, ...holes]]) where nothing should be generated (the parcel)
 */
export function osmToScene(data, { center, clip, maxBuildings = 2500, maxTrees = 7000, exclude = [] } = {}) {
  const buildings = [];
  const areas = [];
  const singles = [];
  const rows = [];

  for (const el of data.elements || []) {
    const tags = el.tags || {};
    if (tags.building && tags.building !== 'no') {
      for (const rings of elementPolygons(el)) {
        const ring = rings[0];
        if (ring.length < 3) continue;
        buildings.push({ id: `${el.type}/${el.id}`, ring, holes: rings.slice(1), ...buildingAppearance(tags, hashSeed(el.id)) });
      }
    } else if (el.type === 'node' && tags.natural === 'tree') {
      singles.push(el);
    } else if (el.type === 'way' && tags.natural === 'tree_row') {
      rows.push(el);
    } else {
      const kind = tags.landuse || tags.natural || tags.leisure;
      if (!SPACING[kind]) continue;
      for (const rings of elementPolygons(el)) areas.push({ id: el.id, kind, rings, tags });
    }
  }

  // Keep buildings nearest the parcel when there are too many.
  const distTo = (p) => (center ? distance(p, center) : 0);
  for (const b of buildings) b.dist = distTo(b.ring[0]);
  buildings.sort((a, b) => a.dist - b.dist);
  const keptBuildings = buildings.slice(0, maxBuildings);
  const index = new FootprintIndex(keptBuildings);

  const trees = [];
  const insideExcluded = (p) => exclude.some((rings) => pointInPolygon(p, rings));

  for (const el of singles) {
    const p = [el.lon, el.lat];
    trees.push(makeTree(p, treeStyle(el.tags), seededRandom(hashSeed(el.id)), el.tags));
  }
  for (const el of rows) {
    const rnd = seededRandom(hashSeed(el.id));
    const style = treeStyle(el.tags);
    for (const p of sampleLine(geomToRing(el.geometry), 7)) if (!index.contains(p)) trees.push(makeTree(p, style, rnd, {}));
  }
  const fullClip = clip || [-180, -90, 180, 90];
  for (const area of areas) {
    const rnd = seededRandom(hashSeed(`${area.id}`));
    const style = treeStyle({}, { ...area.tags, kind: area.kind });
    const spacing = SPACING[area.kind];
    for (const p of scatterInPolygon(area.rings, spacing, rnd, fullClip, area.kind === 'orchard')) {
      if (index.contains(p, 1.5) || insideExcluded(p)) continue;
      trees.push(makeTree(p, style, rnd, {}));
    }
  }

  for (const t of trees) t.dist = distTo(t.pos);
  trees.sort((a, b) => a.dist - b.dist);

  return { buildings: keptBuildings, trees: trees.slice(0, maxTrees), stats: { buildings: buildings.length, trees: trees.length, areas: areas.length } };
}

/** Fetches Overpass data, trying mirrors in turn. */
export async function fetchOverpass(box, { signal, fetchImpl = fetch } = {}) {
  const query = buildOverpassQuery(box);
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}
