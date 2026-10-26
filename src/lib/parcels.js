// Turns KML / KMZ / GeoJSON files (e.g. from parselsorgu.tkgm.gov.tr) into parcel objects.
// Pure module: the XML DOMParser is injected so it also runs under Node for tests.

import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import {
  bbox,
  openRing,
  polygonArea,
  ringCentroid,
  ringPerimeter,
  hashSeed,
} from './geo.js';

/** Attribute aliases → canonical keys. Keys are compared after normalizeKey(). */
const ALIASES = {
  il: ['il', 'ilad', 'iladi', 'sehir', 'city', 'province'],
  ilce: ['ilce', 'ilcead', 'ilceadi', 'district'],
  mahalle: ['mahalle', 'mahallead', 'mahalleadi', 'mahallekoy', 'mahallekoyadi', 'koy', 'koyadi', 'neighbourhood', 'neighborhood'],
  ada: ['ada', 'adano', 'adanumarasi', 'block'],
  parsel: ['parsel', 'parselno', 'parselnumarasi', 'parcel', 'parcelno'],
  alan: ['alan', 'yuzolcum', 'yuzolcumu', 'tapualani', 'tapualan', 'area', 'alanm2'],
  nitelik: ['nitelik', 'niteligi', 'cins', 'cinsi', 'cinsinitelik', 'tasinmazniteligi'],
  mevkii: ['mevkii', 'mevki', 'locality'],
  pafta: ['pafta', 'paftano'],
};

const ALIAS_LOOKUP = new Map();
for (const [canon, list] of Object.entries(ALIASES)) for (const a of list) ALIAS_LOOKUP.set(a, canon);

export const ATTRIBUTE_KEYS = Object.keys(ALIASES);

/** Lower-case, de-accent Turkish letters and drop anything that is not a-z / 0-9. */
export function normalizeKey(key) {
  return String(key)
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/â/g, 'a')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parses numbers written either Turkish style ("1.234,56") or English style ("1,234.56" / "1234.56").
 * Returns NaN when no number is found.
 */
export function parseLocaleNumber(value) {
  if (typeof value === 'number') return value;
  if (value == null) return NaN;
  const m = String(value).match(/-?[\d.,]+/);
  if (!m) return NaN;
  let s = m[0];
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Both present: whichever comes last is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // TKGM writes decimals with a comma: "2471,75". Several commas = thousands groups.
    s = s.split(',').length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (lastDot > -1) {
    // Several dots, or one dot followed by exactly three digits ("2.471"), are thousands groups.
    const parts = s.split('.');
    if (parts.length > 2 || parts[1].length === 3) s = parts.join('');
  }
  return parseFloat(s);
}

/** Pulls "key / value" pairs out of an HTML or plain-text KML description. */
export function parseDescription(html) {
  const out = {};
  if (!html) return out;
  const text = String(html);
  const strip = (s) =>
    s
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  // <tr><td>Key</td><td>Value</td></tr> (also th)
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(text))) {
    const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => strip(c[1]));
    if (cells.length >= 2 && cells[0]) out[cells[0].replace(/:$/, '')] = cells[1];
  }

  // "Key: Value" lines, separated by <br>, newlines or <p>
  const lines = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|table|tbody|thead|tr)\b[^>]*>/gi, '\n')
    .split('\n')
    .map(strip)
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (m && !(m[1].trim() in out)) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

/** Maps arbitrary properties onto canonical TKGM attributes. */
export function extractAttributes(props = {}) {
  const attrs = {};
  const merged = { ...parseDescription(props.description), ...props };
  for (const [k, v] of Object.entries(merged)) {
    if (v == null || v === '' || typeof v === 'object') continue;
    const canon = ALIAS_LOOKUP.get(normalizeKey(k));
    if (canon && attrs[canon] == null) attrs[canon] = String(v).trim();
  }
  // TKGM names are often "ADA/PARSEL", e.g. "101/5".
  if ((!attrs.ada || !attrs.parsel) && props.name) {
    const m = String(props.name).match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      attrs.ada ??= m[1];
      attrs.parsel ??= m[2];
    }
  }
  return attrs;
}

const isLonLat = ([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90;
// Rough Turkey bounds, used to fix files whose lat/lon were swapped.
const inTurkey = ([x, y]) => x > 25 && x < 45.5 && y > 35 && y < 42.5;

function cleanRing(ring) {
  const pts = ring
    .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[0], c[1]]);
  const open = openRing(pts);
  // drop consecutive duplicates
  const dedup = open.filter((p, i) => i === 0 || p[0] !== open[i - 1][0] || p[1] !== open[i - 1][1]);
  return dedup;
}

/** Collects polygons ([outer, ...holes]) from any GeoJSON geometry. */
export function geometryToPolygons(geom) {
  if (!geom) return [];
  switch (geom.type) {
    case 'Polygon':
      return [geom.coordinates.map(cleanRing).filter((r) => r.length >= 3)].filter((p) => p.length);
    case 'MultiPolygon':
      return geom.coordinates.flatMap((poly) => geometryToPolygons({ type: 'Polygon', coordinates: poly }));
    case 'LineString': {
      const r = cleanRing(geom.coordinates);
      return r.length >= 3 ? [[r]] : [];
    }
    case 'MultiLineString':
      return geom.coordinates.flatMap((c) => geometryToPolygons({ type: 'LineString', coordinates: c }));
    case 'GeometryCollection':
      return geom.geometries.flatMap(geometryToPolygons);
    default:
      return [];
  }
}

function fixAxisOrder(polygons) {
  const first = polygons[0]?.[0]?.[0];
  if (!first) return { polygons, swapped: false };
  if (!inTurkey(first) && inTurkey([first[1], first[0]])) {
    return {
      polygons: polygons.map((p) => p.map((r) => r.map(([x, y]) => [y, x]))),
      swapped: true,
    };
  }
  return { polygons, swapped: false };
}

let counter = 0;

/** Builds the parcel object used across the app. */
export function makeParcel(feature, sourceFile) {
  const props = feature.properties || {};
  let polygons = geometryToPolygons(feature.geometry);
  if (!polygons.length) return null;
  const allCoords = polygons.flat(2);
  if (!allCoords.every(isLonLat)) {
    const err = new Error('PROJECTED_COORDINATES');
    err.code = 'PROJECTED_COORDINATES';
    throw err;
  }
  const fixed = fixAxisOrder(polygons);
  polygons = fixed.polygons;

  const attrs = extractAttributes(props);
  const computedArea = polygons.reduce((s, p) => s + polygonArea(p), 0);
  const perimeter = polygons.reduce((s, p) => s + ringPerimeter(p[0]), 0);
  // Centroid of the largest polygon
  const largest = polygons.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a));
  const centroid = ringCentroid(largest[0]);
  const box = bbox(polygons.flatMap((p) => p[0]));

  const label =
    attrs.ada && attrs.parsel
      ? `${attrs.ada}/${attrs.parsel}`
      : props.name || sourceFile?.replace(/\.(kml|kmz|geojson|json)$/i, '') || 'Parsel';

  const id = `p${hashSeed(JSON.stringify(polygons[0][0].slice(0, 6)) + label)}_${(counter++).toString(36)}`;

  return {
    id,
    label,
    name: props.name || '',
    sourceFile: sourceFile || '',
    polygons,
    attrs,
    declaredArea: parseLocaleNumber(attrs.alan),
    computedArea,
    perimeter,
    centroid,
    bbox: box,
    axisSwapped: fixed.swapped,
    raw: Object.fromEntries(
      Object.entries(props).filter(([k, v]) => typeof v !== 'object' && !/^(styleUrl|styleHash|styleMapHash|stroke|fill|stroke-opacity|fill-opacity|stroke-width)$/.test(k)),
    ),
  };
}

function featuresFromGeoJSON(gj) {
  if (!gj) return [];
  if (gj.type === 'FeatureCollection') return gj.features || [];
  if (gj.type === 'Feature') return [gj];
  if (gj.type && gj.coordinates) return [{ type: 'Feature', properties: {}, geometry: gj }];
  if (gj.type === 'GeometryCollection') return [{ type: 'Feature', properties: {}, geometry: gj }];
  return [];
}

export function parcelsFromGeoJSON(gj, sourceFile) {
  return featuresFromGeoJSON(gj)
    .map((f) => makeParcel(f, sourceFile))
    .filter(Boolean);
}

export function parseKmlText(text, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(text, 'text/xml');
  return kmlToGeoJSON(doc);
}

/**
 * Parses a File/Blob-like ({name, arrayBuffer()}) into parcels.
 * @param file the uploaded file
 * @param deps {DOMParser, JSZip}
 */
export async function parseParcelFile(file, { DOMParser: DP, JSZip }) {
  const name = file.name || 'file';
  const lower = name.toLowerCase();
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // "PK"

  if (lower.endsWith('.kmz') || isZip) {
    const zip = await JSZip.loadAsync(buf);
    const kmlEntries = Object.values(zip.files).filter((f) => !f.dir && /\.kml$/i.test(f.name));
    if (!kmlEntries.length) throw Object.assign(new Error('NO_KML_IN_KMZ'), { code: 'NO_KML_IN_KMZ' });
    const parcels = [];
    for (const entry of kmlEntries) {
      const text = await entry.async('string');
      parcels.push(...parcelsFromGeoJSON(parseKmlText(text, DP), name));
    }
    return parcels;
  }

  const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parcelsFromGeoJSON(JSON.parse(trimmed), name);
  }
  if (trimmed.startsWith('<')) {
    return parcelsFromGeoJSON(parseKmlText(text, DP), name);
  }
  throw Object.assign(new Error('UNSUPPORTED_FILE'), { code: 'UNSUPPORTED_FILE' });
}

/** Serializable copy for localStorage. */
export function serializeParcel(p) {
  return {
    type: 'Feature',
    properties: { ...p.raw, name: p.name, __label: p.label, __source: p.sourceFile, __color: p.color },
    geometry: { type: 'MultiPolygon', coordinates: p.polygons.map((poly) => poly.map((r) => [...r, r[0]])) },
  };
}

export function deserializeParcel(feature) {
  const p = makeParcel(feature, feature.properties?.__source);
  if (!p) return null;
  if (feature.properties?.__label) p.label = feature.properties.__label;
  if (feature.properties?.__color) p.color = feature.properties.__color;
  delete p.raw.__label;
  delete p.raw.__source;
  delete p.raw.__color;
  return p;
}
