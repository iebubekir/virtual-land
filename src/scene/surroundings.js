import * as Cesium from 'cesium';
import { bufferBbox, distance, metresPerDegree, openRing, polygonArea, ringCentroid, seededRandom, hashSeed } from '../lib/geo.js';
import { fetchOverpass, osmToScene } from '../lib/osm.js';
import { detectTrees, styleFromColor } from '../lib/canopy.js';
import { loadImageryMosaic } from './imageryTiles.js';
import { TreeBatch } from './treeModel.js';

/* ------------------------------------------------------------------ colours */

const TREE_COLORS = {
  broad: ['#3f6b2a', '#4a7a2f', '#567f34', '#3b6326', '#5d8a3a', '#466f2c'],
  pine: ['#2f5226', '#365c2b', '#2a4a22', '#3c6430'],
  conifer: ['#24452a', '#2b5131', '#1f3d27', '#30563a'],
  cypress: ['#22402a', '#28472e', '#1d3a25'],
  olive: ['#7d8f5c', '#6f8455', '#889868', '#76875a'],
  fruit: ['#4f7d33', '#5b8a3a', '#467230', '#61903f'],
};
const TRUNK = Cesium.Color.fromCssColorString('#5b4330');
const TRUNK_OLIVE = Cesium.Color.fromCssColorString('#6e6252');

const pick = (list, v) => list[Math.min(list.length - 1, Math.floor(v * list.length))];

/** Crown colour: the style colour blended with the real canopy colour seen from the satellite. */
function crownColor(t, variation = 0) {
  const base = Cesium.Color.fromCssColorString(pick(TREE_COLORS[t.style] || TREE_COLORS.broad, t.shade));
  let c = base;
  if (t.tint) {
    // Satellite canopy is darker than a lit 3D surface; brighten before mixing.
    const k = 1.6;
    const sat = new Cesium.Color(Math.min(1, (t.tint[0] * k) / 255), Math.min(1, (t.tint[1] * k) / 255), Math.min(1, (t.tint[2] * k) / 255));
    c = Cesium.Color.lerp(base, sat, 0.55, new Cesium.Color());
  }
  if (variation) c = Cesium.Color.multiplyByScalar(c, 1 + variation, new Cesium.Color());
  c.alpha = 1;
  return c;
}

/* ------------------------------------------------------------------ roofs */

/** Local metric frame around a building so roof maths can be done in metres. */
function localFrame(ring) {
  const [cLon, cLat] = ringCentroid(ring);
  const [mLon, mLat] = metresPerDegree(cLat);
  return {
    toXY: ([lon, lat]) => [(lon - cLon) * mLon, (lat - cLat) * mLat],
    toCart: ([x, y], z) => Cesium.Cartesian3.fromDegrees(cLon + x / mLon, cLat + y / mLat, z),
  };
}

const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const len2 = (a) => Math.hypot(a[0], a[1]);
const unit2 = (a) => mul2(a, 1 / (len2(a) || 1));

/** Drops nearly collinear vertices (OSM footprints often have extra points on straight walls). */
function simplify(pts) {
  let out = pts.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const u = unit2(sub2(b, a));
      const v = unit2(sub2(c, b));
      if (len2(sub2(b, a)) < 0.4 || Math.abs(u[0] * v[1] - u[1] * v[0]) < 0.12) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function isRectangle(p) {
  if (p.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = unit2(sub2(p[(i + 3) % 4], p[i]));
    const b = unit2(sub2(p[(i + 1) % 4], p[i]));
    if (Math.abs(dot2(a, b)) > 0.26) return false; // ~±15° from square
  }
  return true;
}

function isConvex(p) {
  let sign = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const c = p[(i + 2) % p.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** Flat-shaded indexed geometry from polygon faces (3 or 4 corners, Cartesian3). */
function facesGeometry(faces, interior) {
  const positions = [];
  const normals = [];
  const e1 = new Cesium.Cartesian3();
  const e2 = new Cesium.Cartesian3();
  const n = new Cesium.Cartesian3();
  const center = new Cesium.Cartesian3();
  const ref = new Cesium.Cartesian3();
  for (const face of faces) {
    Cesium.Cartesian3.subtract(face[1], face[0], e1);
    Cesium.Cartesian3.subtract(face[2], face[0], e2);
    Cesium.Cartesian3.cross(e1, e2, n);
    if (Cesium.Cartesian3.magnitudeSquared(n) < 1e-12) continue;
    Cesium.Cartesian3.normalize(n, n);
    Cesium.Cartesian3.clone(Cesium.Cartesian3.ZERO, center);
    face.forEach((p) => Cesium.Cartesian3.add(center, p, center));
    Cesium.Cartesian3.divideByScalar(center, face.length, center);
    Cesium.Cartesian3.subtract(center, interior, ref);
    if (Cesium.Cartesian3.dot(n, ref) < 0) Cesium.Cartesian3.negate(n, n);
    for (let i = 1; i < face.length - 1; i++) {
      for (const p of [face[0], face[i], face[i + 1]]) {
        positions.push(p.x, p.y, p.z);
        normals.push(n.x, n.y, n.z);
      }
    }
  }
  if (!positions.length) return null;
  const count = positions.length / 3;
  const indices = Cesium.IndexDatatype.createTypedArray(count, count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return new Cesium.Geometry({
    indices,
    attributes: {
      position: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(positions) }),
      normal: new Cesium.GeometryAttribute({ componentDatatype: Cesium.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(normals) }),
    },
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });
}

const OVERHANG = 0.45;

/**
 * Pitched roof for a footprint. Rectangles get a gable roof along their long side (typical
 * Turkish village house); other convex footprints get a hip roof. Both have eaves.
 * Returns { roof, gables, wallTop } or null when a flat roof should be used.
 */
function pitchedRoof(ring, top) {
  const frame = localFrame(ring);
  const pts = simplify(ring.map(frame.toXY));
  if (pts.length < 3 || pts.length > 10 || !isConvex(pts)) return null;
  const sides = pts.map((p, i) => len2(sub2(pts[(i + 1) % pts.length], p)));
  if (Math.min(...sides) < 3.2) return null;
  const m = mul2(pts.reduce(add2, [0, 0]), 1 / pts.length);
  const interior = frame.toCart(m, top - 1);

  if (isRectangle(pts)) {
    // A→B is a long side
    let [A, B, C, D] = pts;
    if (len2(sub2(B, A)) < len2(sub2(C, B))) [A, B, C, D] = [B, C, D, A];
    const u = unit2(sub2(B, A));
    let v = [-u[1], u[0]];
    if (dot2(v, sub2(D, A)) < 0) v = mul2(v, -1);
    const hl = len2(sub2(B, A)) / 2;
    const hs = len2(sub2(D, A)) / 2;
    const rise = Math.min(3.6, Math.max(1.4, hs * 0.72));
    const drop = (OVERHANG * rise) / hs;
    const at = (qu, qv) => add2(m, add2(mul2(u, qu), mul2(v, qv)));
    const eave = top - drop;
    const L = hl + OVERHANG;
    const W = hs + OVERHANG; // roof edge offset across the slope
    const r1 = frame.toCart(at(-L, 0), top + rise);
    const r2 = frame.toCart(at(L, 0), top + rise);
    const roof = facesGeometry(
      [
        [frame.toCart(at(-L, -W), eave), frame.toCart(at(L, -W), eave), r2, r1],
        [frame.toCart(at(L, W), eave), frame.toCart(at(-L, W), eave), r1, r2],
      ],
      interior,
    );
    const gables = facesGeometry(
      [
        [frame.toCart(at(-hl, -hs), top), frame.toCart(at(-hl, hs), top), frame.toCart(at(-hl, 0), top + rise)],
        [frame.toCart(at(hl, -hs), top), frame.toCart(at(hl, hs), top), frame.toCart(at(hl, 0), top + rise)],
      ],
      interior,
    );
    return roof ? { roof, gables } : null;
  }

  // Hip roof
  const area = polygonArea([ring]);
  const rise = Math.min(3.2, Math.max(1.2, Math.sqrt(area) * 0.28));
  const minHalf = Math.min(...sides) / 2;
  const drop = (OVERHANG * rise) / Math.max(minHalf, 1);
  const apex = frame.toCart(m, top + rise);
  const eaves = pts.map((p) => frame.toCart(add2(p, mul2(unit2(sub2(p, m)), OVERHANG)), top - drop));
  const roof = facesGeometry(
    eaves.map((p, i) => [p, eaves[(i + 1) % eaves.length], apex]),
    interior,
  );
  return roof ? { roof, gables: null } : null;
}

/* ------------------------------------------------------------------ class */

const TREE_LIMITS = { low: 6000, normal: 15000, high: 26000 };

export class Surroundings {
  constructor(sceneApi) {
    this.api = sceneApi;
    this.viewer = sceneApi.viewer;
    this.collection = this.viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    this.cache = new Map();
    this.currentKey = null;
    this.abort = null;
  }

  get visible() {
    return this.collection.show;
  }

  set visible(v) {
    this.collection.show = v;
    this.api.kick?.();
  }

  clear() {
    this.collection.removeAll();
    this.currentKey = null;
    this.api.kick?.();
  }

  /** Builds buildings + trees around a parcel. Resolves to counts. */
  async load(parcel, radius, { quality = 'normal' } = {}) {
    const maxTrees = TREE_LIMITS[quality] || TREE_LIMITS.normal;
    const key = `${parcel.id}:${radius}:${quality}:${this.api.hasTerrain ? 't' : 'e'}`;
    if (key === this.currentKey) return this.lastStats;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const signal = abort.signal;

    const dataKey = `${parcel.id}:${radius}:${quality}`;
    let scene = this.cache.get(dataKey);
    if (!scene) {
      const box = bufferBbox(parcel.bbox, radius);
      const [osm, imagery] = await Promise.all([
        fetchOverpass(box, { signal }).catch((err) => {
          if (err.name === 'AbortError') throw err;
          console.warn('Overpass failed', err);
          return null;
        }),
        loadImageryMosaic(box, { signal }).catch((err) => {
          if (err.name === 'AbortError') throw err;
          console.warn('Imagery for tree detection failed', err);
          return null;
        }),
      ]);
      if (!osm && !imagery) throw new Error('No data for surroundings');

      // With satellite canopy available, real tree positions replace OSM area guesses.
      const base = osmToScene(osm || { elements: [] }, {
        center: parcel.centroid,
        clip: box,
        exclude: parcel.polygons,
        maxBuildings: 4000,
        maxTrees,
        scatterAreas: !imagery,
      });
      let trees = base.trees;
      if (imagery) trees = trees.concat(this.treesFromImagery(imagery.mosaic, box, parcel, base, maxTrees));
      trees.sort((a, b) => a.dist - b.dist);
      scene = { buildings: base.buildings, trees: trees.slice(0, maxTrees) };
      this.cache.set(dataKey, scene);
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    const bCenters = scene.buildings.map((b) => ringCentroid(b.ring));
    const heights = await this.api.groundHeights([...bCenters, ...scene.trees.map((t) => t.pos), parcel.centroid]);
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    this.collection.removeAll();
    this.drawBuildings(scene.buildings, heights.slice(0, scene.buildings.length));
    this.drawTrees(scene.trees, heights.slice(scene.buildings.length, -1), parcel.centroid, heights[heights.length - 1] || 0);
    this.api.kick?.(4000);
    this.currentKey = key;
    this.lastStats = { buildings: scene.buildings.length, trees: scene.trees.length };
    return this.lastStats;
  }

  /** Turns satellite canopy detections into tree descriptions. */
  treesFromImagery(mosaic, box, parcel, base, maxTrees) {
    // Avoid doubling trees already mapped individually in OSM.
    const taken = new Set(base.trees.map((t) => `${Math.round(t.pos[0] * 30000)},${Math.round(t.pos[1] * 30000)}`));
    const detections = detectTrees(mosaic, {
      box,
      center: parcel.centroid,
      maxTrees,
      skip: (p) => base.index.contains(p, 1.2) || taken.has(`${Math.round(p[0] * 30000)},${Math.round(p[1] * 30000)}`),
    });
    return detections.map((d) => {
      const rnd = seededRandom(hashSeed(`${d.pos[0].toFixed(7)},${d.pos[1].toFixed(7)}`));
      const style = styleFromColor(d.color, d.rnd);
      const size = { broad: [6, 7], pine: [9, 6], conifer: [10, 8], olive: [3.5, 2.5] }[style] || [6, 6];
      const height = size[0] + rnd() * size[1];
      const crownFactor = { conifer: 0.42, olive: 0.5, pine: 0.66 }[style] || 0.6;
      const crown = d.cell * crownFactor * (0.85 + rnd() * 0.35) * (0.8 + d.density * 0.25);
      return { pos: d.pos, height, crown, style, shade: rnd(), tint: d.color, dist: distance(d.pos, parcel.centroid) };
    });
  }

  drawBuildings(buildings, heights) {
    const bodies = [];
    const glass = [];
    const roofs = [];
    const vf = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
    buildings.forEach((b, i) => {
      const ground = heights[i] || 0;
      const ring = openRing(b.ring);
      if (ring.length < 3) return;
      const wallColor = Cesium.Color.fromCssColorString(b.wallColor);
      const roofColor = Cesium.Color.fromCssColorString(b.roofColor);
      const canPitch = b.roofShape === 'pitched' && b.height <= 24 && !b.translucent;
      let wallTop = ground + b.height;
      let roof = null;
      if (canPitch) {
        const estimate = Math.min(3.4, Math.max(1.3, Math.sqrt(polygonArea([ring])) * 0.25));
        wallTop = ground + Math.max(b.height - estimate, 2.6);
        roof = pitchedRoof(ring, wallTop);
        if (!roof) wallTop = ground + b.height;
      }
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(ring.flat()),
        (b.holes || []).map((h) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(openRing(h).flat()))),
      );
      const body = new Cesium.GeometryInstance({
        id: b.id,
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: hierarchy,
          // Sink the base so buildings on slopes do not float.
          height: ground + b.minHeight - (b.minHeight > 0 ? 0 : 4),
          extrudedHeight: wallTop,
          vertexFormat: vf,
        }),
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(b.translucent ? wallColor.withAlpha(0.55) : wallColor) },
      });
      (b.translucent ? glass : bodies).push(body);

      if (roof) {
        roofs.push(new Cesium.GeometryInstance({ id: b.id, geometry: roof.roof, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(roofColor) } }));
        if (roof.gables)
          roofs.push(new Cesium.GeometryInstance({ id: b.id, geometry: roof.gables, attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(wallColor) } }));
      } else if (!b.translucent) {
        roofs.push(
          new Cesium.GeometryInstance({
            id: b.id,
            geometry: new Cesium.PolygonGeometry({ polygonHierarchy: hierarchy, height: wallTop, extrudedHeight: wallTop + 0.35, vertexFormat: vf }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(roofColor) },
          }),
        );
      }
    });

    const add = (instances, translucent, asynchronous = true) => {
      if (!instances.length) return;
      this.collection.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ translucent, closed: false }),
          shadows: Cesium.ShadowMode.ENABLED,
          releaseGeometryInstances: true,
          asynchronous,
        }),
      );
    };
    add(bodies, false);
    // Custom roof geometry cannot be sent to web workers, so roofs are batched synchronously.
    add(roofs, false, false);
    add(glass, true);
  }

  /**
   * Draws all trees as one GPU-instanced glTF model, in a local east-north-up frame around
   * the parcel. A few dozen draw calls in total, however many trees there are.
   */
  drawTrees(trees, heights, center, h0) {
    if (!trees.length) return;
    const [mLon, mLat] = metresPerDegree(center[1]);
    const R = 6371008.8;
    const batch = new TreeBatch();
    const rgb = (c) => [c.red, c.green, c.blue];
    const trunkRgb = rgb(TRUNK);
    const oliveTrunkRgb = rgb(TRUNK_OLIVE);

    trees.forEach((t, i) => {
      const e = (t.pos[0] - center[0]) * mLon;
      const n = (t.pos[1] - center[1]) * mLat;
      // Ground relative to the frame origin, corrected for Earth curvature.
      const up = (heights[i] || 0) - h0 - (e * e + n * n) / (2 * R);
      const rnd = seededRandom(hashSeed(`${t.pos[0].toFixed(7)}${t.pos[1].toFixed(7)}`));
      const near = t.dist < 350;
      const showTrunk = t.dist < 800;
      const yaw = rnd() * Math.PI * 2;
      const sphere = near ? 'sphere' : 'sphereFar';
      const lobe = (rx, ry, rz, x, y, z, variation = 0) =>
        batch.add(sphere, rgb(crownColor(t, variation)), [e + x, n + y, up + z], yaw, [rx, ry, rz]);
      const trunk = (len, r, color = trunkRgb) => {
        if (showTrunk) batch.add('trunk', color, [e, n, up - 0.5], yaw, [r, r, len + 0.5]);
      };
      const coneAt = (r, len, z, variation) => batch.add('cone', rgb(crownColor(t, variation)), [e, n, up + z], yaw, [r, r, len]);
      const c = t.crown;
      const h = t.height;
      const side = (k) => [Math.cos(yaw + k) * c * 0.48, Math.sin(yaw + k) * c * 0.48];

      switch (t.style) {
        case 'conifer': {
          trunk(h * 0.3, Math.max(0.15, h * 0.022));
          const tiers = near ? 3 : 2;
          for (let k = 0; k < tiers; k++) {
            const frac = k / tiers;
            coneAt(c * 1.25 * (1 - frac * 0.32), h * (0.55 - frac * 0.12), h * (0.25 + frac * 0.28), -0.06 + frac * 0.08);
          }
          break;
        }
        case 'cypress':
          trunk(h * 0.15, 0.18);
          lobe(c * 1.1, c * 1.1, h * 0.48, 0, 0, h * 0.52);
          break;
        case 'pine': {
          trunk(h * 0.78, Math.max(0.18, h * 0.024));
          lobe(c * 1.05, c, c * 0.42, 0, 0, h - c * 0.42);
          if (near) {
            const [x1, y1] = side(0);
            const [x2, y2] = side(2.4);
            lobe(c * 0.62, c * 0.6, c * 0.3, x1, y1, h - c * 0.55, -0.08);
            lobe(c * 0.58, c * 0.56, c * 0.28, x2, y2, h - c * 0.6, 0.06);
          }
          break;
        }
        case 'olive':
        case 'fruit': {
          trunk(h * 0.42, Math.max(0.16, h * 0.05), t.style === 'olive' ? oliveTrunkRgb : trunkRgb);
          lobe(c, c * 0.95, c * 0.62, 0, 0, h - c * 0.62);
          if (near) {
            const [x1, y1] = side(0.3);
            const [x2, y2] = side(3.4);
            lobe(c * 0.6, c * 0.58, c * 0.45, x1, y1, h - c * 0.85, -0.07);
            lobe(c * 0.55, c * 0.55, c * 0.42, x2, y2, h - c * 0.9, 0.07);
          }
          break;
        }
        default: {
          trunk(Math.max(1.2, h - c * 1.6), Math.max(0.14, h * 0.028));
          lobe(c, c * 0.95, c * 0.82, 0, 0, h - c * 0.82);
          if (near) {
            const [x1, y1] = side(0);
            const [x2, y2] = side(2.1);
            const [x3, y3] = side(4.2);
            lobe(c * 0.66, c * 0.64, c * 0.58, x1, y1, h - c * 1.15, -0.08);
            lobe(c * 0.62, c * 0.6, c * 0.55, x2, y2, h - c * 1.05, 0.05);
            lobe(c * 0.55, c * 0.55, c * 0.5, x3 * 0.6, y3 * 0.6, h - c * 0.45, 0.1);
          }
        }
      }
    });

    const url = URL.createObjectURL(new Blob([batch.toGlb()], { type: 'model/gltf-binary' }));
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(center[0], center[1], h0));
    const collection = this.collection;
    const api = this.api;
    Cesium.Model.fromGltfAsync({
      url,
      modelMatrix,
      upAxis: Cesium.Axis.Z,
      forwardAxis: Cesium.Axis.X,
      shadows: Cesium.ShadowMode.ENABLED,
      // Instances are spread over a wide area; never cull the whole model by screen size.
      minimumPixelSize: 0,
    })
      .then((model) => {
        if (collection.isDestroyed()) return;
        collection.add(model);
        model.readyEvent.addEventListener(() => {
          URL.revokeObjectURL(url);
          api.kick?.(1500);
        });
      })
      .catch((err) => {
        URL.revokeObjectURL(url);
        console.warn('Tree model failed', err);
      });
  }
}
