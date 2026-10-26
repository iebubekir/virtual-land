import { test } from 'node:test';
import assert from 'node:assert/strict';
import { osmToScene, buildingAppearance, parseHeight, assembleRings, buildOverpassQuery } from '../src/lib/osm.js';
import { pointInRing } from '../src/lib/geo.js';

const sq = (lon, lat, d) => [
  { lon, lat },
  { lon: lon + d, lat },
  { lon: lon + d, lat: lat + d },
  { lon, lat: lat + d },
  { lon, lat },
];

test('parses heights', () => {
  assert.equal(parseHeight('12'), 12);
  assert.equal(parseHeight('7,5 m'), 7.5);
  assert.ok(Math.abs(parseHeight("10'") - 3.048) < 1e-9);
  assert.ok(Number.isNaN(parseHeight('tall')));
});

test('building height from tags', () => {
  assert.equal(buildingAppearance({ building: 'yes', height: '20' }).height, 20);
  assert.equal(buildingAppearance({ building: 'apartments', 'building:levels': '6' }).height, 18.5);
  const house = buildingAppearance({ building: 'house' }, 3);
  assert.ok(house.height >= 6 && house.height <= 10);
  assert.equal(house.roofShape, 'pitched');
  assert.equal(buildingAppearance({ building: 'greenhouse' }).translucent, true);
});

test('assembles split multipolygon rings', () => {
  const rings = assembleRings([
    [[0, 0], [1, 0], [1, 1]],
    [[0, 1], [0, 0]],
    [[0, 1], [1, 1]], // reversed segment
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
});

test('generates buildings and trees, skipping building footprints and the parcel', () => {
  const data = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house' }, geometry: sq(30.0004, 39.0004, 0.0001) },
      { type: 'node', id: 2, lat: 39.0, lon: 30.0, tags: { natural: 'tree', height: '8' } },
      { type: 'way', id: 3, tags: { landuse: 'orchard', trees: 'olive_trees' }, geometry: sq(30.0, 39.0, 0.001) },
      { type: 'way', id: 4, tags: { natural: 'wood', leaf_type: 'needleleaved' }, geometry: sq(30.002, 39.0, 0.0005) },
    ],
  };
  const parcel = [[[30.0007, 39.0007], [30.0009, 39.0007], [30.0009, 39.0009], [30.0007, 39.0009]]];
  const scene = osmToScene(data, { center: [30.0005, 39.0005], clip: [29.99, 38.99, 30.01, 39.01], exclude: [parcel] });
  assert.equal(scene.buildings.length, 1);
  assert.ok(scene.trees.length > 100, `trees: ${scene.trees.length}`);
  const house = scene.buildings[0].ring;
  assert.ok(!scene.trees.some((t) => pointInRing(t.pos, house)), 'no tree inside a house');
  assert.ok(!scene.trees.some((t) => pointInRing(t.pos, parcel[0])), 'no generated tree inside the parcel');
  assert.ok(scene.trees.some((t) => t.style === 'olive'));
  assert.ok(scene.trees.some((t) => t.style === 'conifer'));
  assert.ok(scene.trees.some((t) => t.height === 8));
  // nearest-first ordering
  for (let i = 1; i < scene.trees.length; i++) assert.ok(scene.trees[i].dist >= scene.trees[i - 1].dist);
});

test('respects maxTrees by keeping the nearest', () => {
  const data = { elements: [{ type: 'way', id: 9, tags: { landuse: 'forest' }, geometry: sq(30, 39, 0.005) }] };
  const scene = osmToScene(data, { center: [30, 39], clip: [29.99, 38.99, 30.01, 39.01], maxTrees: 500 });
  assert.equal(scene.trees.length, 500);
  assert.ok(scene.stats.trees > 500);
});

test('overpass query uses s,w,n,e order', () => {
  const q = buildOverpassQuery([30, 39, 30.1, 39.1]);
  assert.match(q, /\(39\.000000,30\.000000,39\.100000,30\.100000\)/);
});
