import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mosaicLayout, matchTileName, tileName } from '../src/lib/mosaic.js';
import { distance } from '../src/lib/geo.js';

test('3×3 grid covers the area around the parcel with overlapping tiles', () => {
  const c = [29.5, 40.7];
  const { tiles, side } = mosaicLayout(c, 40, 3);
  assert.equal(tiles.length, 9);
  assert.ok(side >= 270 && side <= 275);
  const mid = tiles.find((t) => t.row === 1 && t.col === 1);
  assert.ok(distance(mid.center, c) < 0.01, 'centre tile is centred on the parcel');
  // row 0 is north, col 0 is west
  const nw = tiles.find((t) => t.row === 0 && t.col === 0);
  assert.ok(nw.center[1] > c[1] && nw.center[0] < c[0]);
  // neighbours overlap
  const east = tiles.find((t) => t.row === 1 && t.col === 2);
  assert.ok(mid.rect[2] > east.rect[0], 'middle and east tiles overlap');
  // tiles are square on the ground
  const w = distance([mid.rect[0], mid.center[1]], [mid.rect[2], mid.center[1]]);
  const h = distance([mid.center[0], mid.rect[1]], [mid.center[0], mid.rect[3]]);
  assert.ok(Math.abs(w - h) < 0.5);
});

test('single image mode centres one tile', () => {
  const { tiles } = mosaicLayout([29.5, 40.7], 40, 1);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].name, 'vl_r0_c0');
});

test('matches tile names, including upscaler output names', () => {
  assert.deepEqual(matchTileName('vl_r2_c1.png'), { row: 2, col: 1 });
  assert.deepEqual(matchTileName('vl_r0_c2_upscayl_4x_realesrgan-x4plus.png'), { row: 0, col: 2 });
  assert.equal(matchTileName('ChatGPT Image Oct 27.png'), null);
  assert.equal(tileName(1, 2), 'vl_r1_c2');
});
