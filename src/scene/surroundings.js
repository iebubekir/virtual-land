import * as Cesium from 'cesium';
import { bufferBbox, openRing, polygonArea, ringCentroid } from '../lib/geo.js';
import { fetchOverpass, osmToScene } from '../lib/osm.js';

const TREE_COLORS = {
  broad: ['#3f6b2a', '#4a7a2f', '#567f34', '#3b6326', '#5d8a3a'],
  conifer: ['#24452a', '#2b5131', '#1f3d27', '#30563a'],
  olive: ['#7d8f5c', '#6f8455', '#889868', '#76875a'],
  fruit: ['#4f7d33', '#5b8a3a', '#467230', '#61903f'],
};
const TRUNK = Cesium.Color.fromCssColorString('#5b4330');

const pick = (list, v) => list[Math.min(list.length - 1, Math.floor(v * list.length))];

/**
 * Builds an un-indexed hip roof: every footprint edge rises to an apex above the centroid.
 * Positions are in ECEF; normals computed per face for flat shading.
 */
function hipRoofGeometry(ring, base, rise) {
  const [cLon, cLat] = ringCentroid(ring);
  const apex = Cesium.Cartesian3.fromDegrees(cLon, cLat, base + rise);
  const pts = ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, base));
  const positions = [];
  const normals = [];
  const n = new Cesium.Cartesian3();
  const e1 = new Cesium.Cartesian3();
  const e2 = new Cesium.Cartesian3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    Cesium.Cartesian3.subtract(b, a, e1);
    Cesium.Cartesian3.subtract(apex, a, e2);
    Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(e1, e2, n), n);
    // Make sure the face points away from the centroid's up axis inwards (consistent winding).
    const up = Cesium.Cartesian3.normalize(apex, new Cesium.Cartesian3());
    if (Cesium.Cartesian3.dot(n, up) < 0) Cesium.Cartesian3.negate(n, n);
    for (const p of [a, b, apex]) {
      positions.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    }
  }
  const count = positions.length / 3;
  const indices = Cesium.IndexDatatype.createTypedArray(count, count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return new Cesium.Geometry({
    indices,
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: new Float64Array(positions),
      }),
      normal: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: new Float32Array(normals),
      }),
    },
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(positions),
  });
}

function isRoughlyConvex(ring) {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const [x2, y2] = ring[(i + 2) % ring.length];
    const cross = (x1 - x0) * (y2 - y1) - (y1 - y0) * (x2 - x1);
    if (Math.abs(cross) < 1e-14) continue;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export class Surroundings {
  constructor(sceneApi) {
    this.api = sceneApi;
    this.viewer = sceneApi.viewer;
    this.collection = this.viewer.scene.primitives.add(new Cesium.PrimitiveCollection());
    this.cache = new Map(); // key -> osm scene
    this.currentKey = null;
    this.abort = null;
  }

  get visible() {
    return this.collection.show;
  }

  set visible(v) {
    this.collection.show = v;
  }

  clear() {
    this.collection.removeAll();
    this.currentKey = null;
  }

  /**
   * Loads OSM buildings + vegetation around a parcel and draws them.
   * Resolves to { buildings, trees } counts.
   */
  async load(parcel, radius) {
    const key = `${parcel.id}:${radius}:${this.api.hasTerrain ? 't' : 'e'}`;
    if (key === this.currentKey) return this.lastStats;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());

    let scene = this.cache.get(`${parcel.id}:${radius}`);
    if (!scene) {
      const box = bufferBbox(parcel.bbox, radius);
      const data = await fetchOverpass(box, { signal: abort.signal });
      scene = osmToScene(data, {
        center: parcel.centroid,
        clip: box,
        exclude: parcel.polygons,
        maxBuildings: 2500,
        maxTrees: radius > 400 ? 9000 : 7000,
      });
      this.cache.set(`${parcel.id}:${radius}`, scene);
    }
    if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');

    // Ground heights: one per building (centroid) and one per tree.
    const bCenters = scene.buildings.map((b) => ringCentroid(b.ring));
    const heights = await this.api.groundHeights([...bCenters, ...scene.trees.map((t) => t.pos)]);
    if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');

    this.collection.removeAll();
    this.drawBuildings(scene.buildings, heights.slice(0, scene.buildings.length));
    this.drawTrees(scene.trees, heights.slice(scene.buildings.length));
    this.currentKey = key;
    this.lastStats = { buildings: scene.buildings.length, trees: scene.trees.length };
    return this.lastStats;
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
      const area = polygonArea([ring]);
      const pitched = b.roofShape === 'pitched' && ring.length <= 14 && area < 600 && isRoughlyConvex(ring);
      const rise = pitched ? Math.min(3.2, Math.max(1.2, Math.sqrt(area) * 0.32)) : 0;
      const top = ground + Math.max(b.height - rise, 2.2);
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(ring.flat()),
        (b.holes || []).map((h) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(openRing(h).flat()))),
      );
      const color = Cesium.Color.fromCssColorString(b.wallColor);
      const instance = new Cesium.GeometryInstance({
        id: b.id,
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: hierarchy,
          // Sink the base a few metres so buildings on slopes do not float.
          height: ground + b.minHeight - (b.minHeight > 0 ? 0 : 4),
          extrudedHeight: top,
          vertexFormat: vf,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(b.translucent ? color.withAlpha(0.55) : color),
        },
      });
      (b.translucent ? glass : bodies).push(instance);

      const roofColor = Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(b.roofColor));
      if (pitched) {
        roofs.push(new Cesium.GeometryInstance({ id: b.id, geometry: hipRoofGeometry(ring, top, rise), attributes: { color: roofColor } }));
      } else if (!b.translucent) {
        roofs.push(
          new Cesium.GeometryInstance({
            id: b.id,
            geometry: new Cesium.PolygonGeometry({ polygonHierarchy: hierarchy, height: top, extrudedHeight: top + 0.35, vertexFormat: vf }),
            attributes: { color: roofColor },
          }),
        );
      }
    });

    const add = (instances, translucent) => {
      if (!instances.length) return;
      this.collection.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ translucent, closed: !translucent }),
          shadows: Cesium.ShadowMode.ENABLED,
          releaseGeometryInstances: true,
          asynchronous: true,
        }),
      );
    };
    add(bodies, false);
    // Custom roof geometry cannot be built in a web worker, so roofs are batched synchronously.
    if (roofs.length) {
      this.collection.add(
        new Cesium.Primitive({
          geometryInstances: roofs,
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: false }),
          shadows: Cesium.ShadowMode.ENABLED,
          asynchronous: false,
        }),
      );
    }
    add(glass, true);
  }

  drawTrees(trees, heights) {
    const trunks = [];
    const crowns = [];
    const vf = Cesium.PerInstanceColorAppearance.VERTEX_FORMAT;
    const trunkGeom = (len, r) => new Cesium.CylinderGeometry({ length: len, topRadius: r * 0.75, bottomRadius: r, slices: 6, vertexFormat: vf });

    trees.forEach((t, i) => {
      const g = heights[i] || 0;
      const [lon, lat] = t.pos;
      const at = (z) => Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon, lat, z));
      const trunkR = Math.max(0.12, t.height * 0.025);
      const colors = TREE_COLORS[t.style] || TREE_COLORS.broad;
      const crownColor = Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.fromCssColorString(pick(colors, t.shade)));

      if (t.style === 'conifer') {
        const trunkLen = t.height * 0.3;
        trunks.push(new Cesium.GeometryInstance({ geometry: trunkGeom(trunkLen + 0.5, trunkR), modelMatrix: at(g - 0.5 + (trunkLen + 0.5) / 2), attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TRUNK) } }));
        const coneLen = t.height * 0.78;
        crowns.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({ length: coneLen, topRadius: 0, bottomRadius: t.crown * 1.25, slices: 8, vertexFormat: vf }),
            modelMatrix: at(g + t.height - coneLen / 2),
            attributes: { color: crownColor },
          }),
        );
      } else {
        const flat = t.style === 'olive' || t.style === 'fruit' ? 0.62 : 0.85;
        const crownH = t.crown * flat;
        const trunkLen = Math.max(0.8, t.height - crownH * 1.6);
        trunks.push(new Cesium.GeometryInstance({ geometry: trunkGeom(trunkLen + 0.5, trunkR), modelMatrix: at(g - 0.5 + (trunkLen + 0.5) / 2), attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TRUNK) } }));
        crowns.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.EllipsoidGeometry({ radii: new Cesium.Cartesian3(t.crown, t.crown * (0.9 + t.shade * 0.2), crownH), stackPartitions: 7, slicePartitions: 9, vertexFormat: vf }),
            modelMatrix: at(g + t.height - crownH),
            attributes: { color: crownColor },
          }),
        );
      }
    });

    for (const instances of [trunks, crowns]) {
      if (!instances.length) continue;
      this.collection.add(
        new Cesium.Primitive({
          geometryInstances: instances,
          appearance: new Cesium.PerInstanceColorAppearance({ closed: true }),
          shadows: Cesium.ShadowMode.ENABLED,
          releaseGeometryInstances: true,
          asynchronous: true,
        }),
      );
    }
  }
}

