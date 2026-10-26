import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import {
  parseParcelFile,
  parseLocaleNumber,
  extractAttributes,
  parseDescription,
  serializeParcel,
  deserializeParcel,
} from '../src/lib/parcels.js';
import { polygonArea, distance, ringEdges } from '../src/lib/geo.js';

const deps = { DOMParser, JSZip };
const fileFrom = (name, data) => ({
  name,
  arrayBuffer: async () => (typeof data === 'string' ? new TextEncoder().encode(data).buffer : data),
});

test('parses Turkish and English number formats', () => {
  assert.equal(parseLocaleNumber('2.402,18'), 2402.18);
  assert.equal(parseLocaleNumber('2402,18'), 2402.18);
  assert.equal(parseLocaleNumber('2,402.18'), 2402.18);
  assert.equal(parseLocaleNumber('2402.18'), 2402.18);
  assert.equal(parseLocaleNumber('2.402'), 2402);
  assert.equal(parseLocaleNumber('1.234.567,5'), 1234567.5);
  assert.equal(parseLocaleNumber('850 m²'), 850);
  assert.ok(Number.isNaN(parseLocaleNumber('yok')));
});

test('maps TKGM attribute names regardless of spelling', () => {
  const a = extractAttributes({ İl: 'Bursa', ilceAd: 'Mudanya', mahalleAd: 'X', adaNo: '5', parselNo: '9', Alan: '100,5', Nitelik: 'Tarla', Mevkii: 'Y' });
  assert.deepEqual(a, { il: 'Bursa', ilce: 'Mudanya', mahalle: 'X', ada: '5', parsel: '9', alan: '100,5', nitelik: 'Tarla', mevkii: 'Y' });
  assert.deepEqual(extractAttributes({ name: '1203/14' }), { ada: '1203', parsel: '14' });
});

test('reads key/value pairs from HTML descriptions', () => {
  const d = parseDescription('<b>Ada</b>: 12<br/>Parsel No: 3<table><tr><th>Nitelik</th><td>Bağ</td></tr></table>');
  assert.equal(d.Ada, '12');
  assert.equal(d['Parsel No'], '3');
  assert.equal(d.Nitelik, 'Bağ');
});

test('parses the sample TKGM KML', async () => {
  const text = await readFile(new URL('../public/samples/ornek-parsel.kml', import.meta.url), 'utf8');
  const parcels = await parseParcelFile(fileFrom('ornek-parsel.kml', text), deps);
  assert.equal(parcels.length, 1);
  const p = parcels[0];
  assert.equal(p.label, '101/7');
  assert.equal(p.attrs.il, 'Bursa');
  assert.equal(p.attrs.nitelik, 'Zeytinlik');
  assert.equal(p.declaredArea, 2565.4);
  assert.equal(p.polygons[0][0].length, 5); // ring is open (no repeated last point)
  // Computed area should be in the same ballpark as the declared one.
  assert.ok(Math.abs(p.computedArea - p.declaredArea) / p.declaredArea < 0.15, `area ${p.computedArea}`);
  assert.ok(p.perimeter > 150 && p.perimeter < 250, `perimeter ${p.perimeter}`);
});

test('parses KMZ archives', async () => {
  const text = await readFile(new URL('../public/samples/ornek-parsel.kml', import.meta.url), 'utf8');
  const zip = new JSZip();
  zip.file('doc.kml', text);
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  const parcels = await parseParcelFile(fileFrom('parsel.kmz', buf), deps);
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].attrs.ada, '101');
});

test('parses TKGM GeoJSON and fixes swapped lat/lon', async () => {
  const gj = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { ilAd: 'Ankara', adaNo: '1', parselNo: '2', alan: '1.000,00' },
        geometry: { type: 'Polygon', coordinates: [[[39.9, 32.8], [39.9, 32.801], [39.901, 32.801], [39.901, 32.8], [39.9, 32.8]]] },
      },
    ],
  };
  const [p] = await parseParcelFile(fileFrom('p.geojson', JSON.stringify(gj)), deps);
  assert.equal(p.axisSwapped, true);
  assert.ok(p.centroid[0] > 32 && p.centroid[0] < 33);
  assert.equal(p.attrs.il, 'Ankara');
});

test('handles boundaries exported as LineString and MultiGeometry', async () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>5/6</name><MultiGeometry>
    <Point><coordinates>30.5,39.5</coordinates></Point>
    <LineString><coordinates>30.5,39.5 30.501,39.5 30.501,39.501 30.5,39.501 30.5,39.5</coordinates></LineString>
  </MultiGeometry></Placemark></Document></kml>`;
  const parcels = await parseParcelFile(fileFrom('x.kml', kml), deps);
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].polygons[0][0].length, 4);
});

test('rejects projected (metre) coordinates with a clear code', async () => {
  const gj = { type: 'Polygon', coordinates: [[[450000, 4470000], [450100, 4470000], [450100, 4470100], [450000, 4470000]]] };
  await assert.rejects(parseParcelFile(fileFrom('tm.json', JSON.stringify(gj)), deps), (e) => e.code === 'PROJECTED_COORDINATES');
});

test('round-trips through storage serialization', async () => {
  const text = await readFile(new URL('../public/samples/ornek-parsel.kml', import.meta.url), 'utf8');
  const [p] = await parseParcelFile(fileFrom('ornek-parsel.kml', text), deps);
  p.color = '#ff0000';
  const back = deserializeParcel(JSON.parse(JSON.stringify(serializeParcel(p))));
  assert.equal(back.label, p.label);
  assert.equal(back.color, '#ff0000');
  assert.equal(back.attrs.parsel, '7');
  assert.ok(Math.abs(back.computedArea - p.computedArea) < 1e-6);
});

test('geometry: 100 m square has ~10,000 m² and 4 edges of ~100 m', () => {
  const lat = 39;
  const dLat = 100 / 111195;
  const dLon = 100 / (111195 * Math.cos((lat * Math.PI) / 180));
  const ring = [[30, lat], [30 + dLon, lat], [30 + dLon, lat + dLat], [30, lat + dLat]];
  assert.ok(Math.abs(polygonArea([ring]) - 10000) < 30);
  const edges = ringEdges(ring);
  assert.equal(edges.length, 4);
  for (const e of edges) assert.ok(Math.abs(e.length - 100) < 0.5);
  assert.ok(Math.abs(distance([30, lat], [30, lat + dLat]) - 100) < 0.5);
});
