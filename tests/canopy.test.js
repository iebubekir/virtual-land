import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TileMosaic,
  detectTrees,
  isPlaceholderTile,
  lonLatToPixel,
  meanLuminance,
  metresPerPixel,
  tileRange,
  TILE_SIZE,
} from '../src/lib/canopy.js';
import { pointInRing, seededRandom } from '../src/lib/geo.js';

const Z = 17;
const LON = 28.885;
const LAT = 40.372;

/** Builds a synthetic satellite tile mosaic around (LON, LAT): tan fields + a forest patch + a smooth dark lake. */
function syntheticMosaic(paint) {
  const c = lonLatToPixel(LON, LAT, Z);
  const cx = Math.floor(c.x / TILE_SIZE);
  const cy = Math.floor(c.y / TILE_SIZE);
  const tiles = new Map();
  const rnd = seededRandom(7);
  for (let tx = cx - 1; tx <= cx + 1; tx++)
    for (let ty = cy - 1; ty <= cy + 1; ty++) {
      const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
      for (let py = 0; py < TILE_SIZE; py++)
        for (let px = 0; px < TILE_SIZE; px++) {
          const gx = tx * TILE_SIZE + px;
          const gy = ty * TILE_SIZE + py;
          const [r, g, b] = paint(gx - c.x, gy - c.y, rnd);
          const i = (py * TILE_SIZE + px) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = 255;
        }
      tiles.set(`${Z}/${tx}/${ty}`, { data, mean: meanLuminance(data) });
    }
  return new TileMosaic(Z, tiles);
}

const mpp = metresPerPixel(LAT, Z);
const metresToPx = (m) => m / mpp;

const paint = (dx, dy, rnd) => {
  const noise = (rnd() - 0.5) * 30;
  // forest: 60 m square east of center
  if (dx > metresToPx(20) && dx < metresToPx(80) && Math.abs(dy) < metresToPx(30)) return [38 + noise, 62 + noise, 30 + noise / 2];
  // lake: smooth dark green-blue water west of center
  if (dx < metresToPx(-20) && dx > metresToPx(-80) && Math.abs(dy) < metresToPx(30)) return [30, 52, 40];
  return [165 + noise / 3, 145 + noise / 3, 105 + noise / 3]; // dry field
};

test('tile maths', () => {
  const p = lonLatToPixel(0, 0, 1);
  assert.equal(p.x, 256);
  assert.equal(p.y, 256);
  const r = tileRange([28.88, 40.37, 28.89, 40.375], 17);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
  assert.ok(Math.abs(metresPerPixel(40, 17) - 0.915) < 0.01);
});

test('detects the Esri placeholder tile', () => {
  const ph = new Uint8ClampedArray(256 * 256 * 4).fill(222);
  assert.equal(isPlaceholderTile(ph), true);
  const field = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < field.length; i += 4) field.set([150, 130, 90, 255], i);
  assert.equal(isPlaceholderTile(field), false);
});

test('finds trees in the forest patch only (not fields, not water)', () => {
  const mosaic = syntheticMosaic(paint);
  const d = 120 / 111132;
  const box = [LON - d * 1.3, LAT - d, LON + d * 1.3, LAT + d];
  const trees = detectTrees(mosaic, { box, center: [LON, LAT] });
  assert.ok(trees.length > 80, `found ${trees.length}`);
  const [mLon] = [111320 * Math.cos((LAT * Math.PI) / 180)];
  for (const t of trees) {
    const east = (t.pos[0] - LON) * mLon;
    assert.ok(east > 12 && east < 88, `tree outside forest at ${east.toFixed(1)} m east`);
  }
  // nearest first
  for (let i = 1; i < trees.length; i++) assert.ok(trees[i].dist >= trees[i - 1].dist);
});

test('skips positions rejected by the caller (e.g. buildings)', () => {
  const mosaic = syntheticMosaic(paint);
  const d = 120 / 111132;
  const box = [LON - d * 1.3, LAT - d, LON + d * 1.3, LAT + d];
  const all = detectTrees(mosaic, { box, center: [LON, LAT] });
  const half = detectTrees(mosaic, { box, center: [LON, LAT], skip: (p) => p[1] > LAT });
  assert.ok(half.length < all.length * 0.7);
  assert.ok(half.every((t) => t.pos[1] <= LAT));
  assert.ok(!pointInRing([0, 0], [[1, 1], [2, 1], [2, 2]]));
});

test('respects maxTrees', () => {
  const mosaic = syntheticMosaic(paint);
  const d = 120 / 111132;
  const trees = detectTrees(mosaic, { box: [LON - d, LAT - d, LON + d, LAT + d], center: [LON, LAT], maxTrees: 25 });
  assert.equal(trees.length, 25);
});
