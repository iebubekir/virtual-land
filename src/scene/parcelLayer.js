import * as Cesium from 'cesium';
import { distance, ringEdges } from '../lib/geo.js';

export const PARCEL_COLORS = ['#ffd43b', '#ff6b6b', '#4dabf7', '#69db7c', '#f783ac', '#ffa94d', '#b197fc', '#3bc9db'];

const FENCE_HEIGHT = 2.4;
const LABEL_FONT = '600 14px "IBM Plex Sans", "Segoe UI", sans-serif';
const BIG_LABEL_FONT = '700 17px "IBM Plex Sans", "Segoe UI", sans-serif';

/** Vertical gradient used for the translucent boundary fence. */
function fenceTexture(css) {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d');
  const color = Cesium.Color.fromCssColorString(css);
  const rgba = (a) => `rgba(${color.red * 255 | 0},${color.green * 255 | 0},${color.blue * 255 | 0},${a})`;
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, rgba(0.95)); // top rail
  grad.addColorStop(0.06, rgba(0.95));
  grad.addColorStop(0.08, rgba(0.18));
  grad.addColorStop(1, rgba(0.5));
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return c;
}

function pinImage(css) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="48" viewBox="0 0 36 48">
  <path d="M18 2C9.2 2 2 9 2 17.6 2 29 18 46 18 46s16-17 16-28.4C34 9 26.8 2 18 2z" fill="${css}" stroke="#14202e" stroke-width="2.5"/>
  <circle cx="18" cy="17.5" r="6" fill="#14202e"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Points along a ring every `step` metres so the fence follows the ground between corners. */
function densifyRing(ring, step = 8) {
  const out = [];
  for (const e of ringEdges(ring)) {
    const n = Math.max(1, Math.ceil(e.length / step));
    for (let k = 0; k < n; k++) out.push([e.from[0] + ((e.to[0] - e.from[0]) * k) / n, e.from[1] + ((e.to[1] - e.from[1]) * k) / n]);
  }
  out.push(out[0]);
  return out;
}

export class ParcelLayer {
  constructor(sceneApi, { onSelect } = {}) {
    this.api = sceneApi;
    this.viewer = sceneApi.viewer;
    this.ds = new Cesium.CustomDataSource('parcels');
    this.viewer.dataSources.add(this.ds);
    this.items = new Map(); // id -> { parcel, entities, fence, edgeLabels }
    this.selectedId = null;
    this.options = { edgeLabels: true, fence: true };
    this.onSelect = onSelect;
    this.orbitRemover = null;

    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    handler.setInputAction((ev) => {
      const picked = this.viewer.scene.pick(ev.position);
      const id = picked?.id?.parcelId;
      if (id) this.onSelect?.(id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    // Any manual camera interaction stops the orbit animation.
    this.viewer.scene.canvas.addEventListener('pointerdown', () => this.stopOrbit());
    this.viewer.scene.canvas.addEventListener('wheel', () => this.stopOrbit(), { passive: true });
  }

  add(parcel) {
    if (this.items.has(parcel.id)) this.remove(parcel.id);
    const color = Cesium.Color.fromCssColorString(parcel.color);
    const entities = [];
    const isSelected = () => this.selectedId === parcel.id;
    const add = (opts) => {
      const e = this.ds.entities.add(opts);
      e.parcelId = parcel.id;
      entities.push(e);
      return e;
    };

    for (const rings of parcel.polygons) {
      const [outer, ...holes] = rings;
      const toCart = (r) => Cesium.Cartesian3.fromDegreesArray(r.flat());
      add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(toCart(outer), holes.map((h) => new Cesium.PolygonHierarchy(toCart(h)))),
          material: new Cesium.ColorMaterialProperty(color.withAlpha(isSelected() ? 0.34 : 0.22)),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      for (const r of rings) {
        add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray([...r, r[0]].flat()),
            clampToGround: true,
            width: isSelected() ? 5 : 3.5,
            material: color,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
      }
      // Corner markers
      outer.forEach(([lon, lat], i) =>
        add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          point: {
            pixelSize: 9,
            color: Cesium.Color.WHITE,
            outlineColor: color,
            outlineWidth: 3,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2500),
          },
          label: {
            text: String(i + 1),
            font: '700 11px sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#14202e'),
            showBackground: true,
            backgroundColor: Cesium.Color.WHITE.withAlpha(0.9),
            backgroundPadding: new Cesium.Cartesian2(4, 2),
            pixelOffset: new Cesium.Cartesian2(0, -16),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 700),
          },
        }),
      );
    }

    // Title label + far-away pin at the centroid
    const [clon, clat] = parcel.centroid;
    add({
      position: Cesium.Cartesian3.fromDegrees(clon, clat),
      label: {
        text: parcel.label,
        font: BIG_LABEL_FONT,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#14202e').withAlpha(0.72),
        backgroundPadding: new Cesium.Cartesian2(9, 6),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -30),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 60000),
        scaleByDistance: new Cesium.NearFarScalar(500, 1, 60000, 0.75),
      },
      billboard: {
        image: pinImage(parcel.color),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: 0.8,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(1800, 3e7),
      },
    });

    const item = { parcel, entities, fence: [], edgeLabels: [], color };
    this.items.set(parcel.id, item);
    this.buildEdgeLabels(item, null);
    this.refreshHeights(parcel.id);
    this.api.kick();
    return item;
  }

  buildEdgeLabels(item, heightsByRing) {
    item.edgeLabels.forEach((e) => this.ds.entities.remove(e));
    item.edgeLabels = [];
    const { parcel } = item;
    parcel.polygons.forEach((rings, pi) => {
      ringEdges(rings[0]).forEach((edge, i) => {
        if (edge.length < 0.5) return;
        const h = heightsByRing?.[pi]?.[i];
        const position = Number.isFinite(h)
          ? Cesium.Cartesian3.fromDegrees(edge.mid[0], edge.mid[1], h + FENCE_HEIGHT + 0.6)
          : Cesium.Cartesian3.fromDegrees(edge.mid[0], edge.mid[1]);
        const e = this.ds.entities.add({
          position,
          show: this.options.edgeLabels,
          label: {
            text: `${edge.length.toFixed(2)} m`,
            font: LABEL_FONT,
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#14202e').withAlpha(0.78),
            backgroundPadding: new Cesium.Cartesian2(6, 4),
            heightReference: Number.isFinite(h) ? Cesium.HeightReference.NONE : Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, Math.max(450, edge.length * 9)),
          },
        });
        e.parcelId = parcel.id;
        item.edgeLabels.push(e);
      });
    });
  }

  /** Samples ground heights along the boundary and rebuilds the 3D fence + edge labels. */
  async refreshHeights(id) {
    const item = this.items.get(id);
    if (!item) return;
    const { parcel } = item;
    const token = (item.heightToken = Symbol('h'));
    const dense = parcel.polygons.map((rings) => densifyRing(rings[0]));
    const corners = parcel.polygons.map((rings) => rings[0]);
    const flat = [...dense.flat(), ...corners.flat(), parcel.centroid];
    const heights = await this.api.groundHeights(flat, { exclude: this.ds.entities.values });
    if (item.heightToken !== token || !this.items.has(id)) return;

    let k = 0;
    const denseH = dense.map((r) => r.map(() => heights[k++]));
    const cornerH = corners.map((r) => r.map(() => heights[k++]));
    parcel.groundHeight = heights[k];

    item.fence.forEach((e) => this.ds.entities.remove(e));
    item.fence = [];
    if (this.options.fence) {
      const material = new Cesium.ImageMaterialProperty({ image: fenceTexture(parcel.color), transparent: true });
      dense.forEach((ring, ri) => {
        const hs = denseH[ri];
        const positions = Cesium.Cartesian3.fromDegreesArray(ring.flat());
        const wall = this.ds.entities.add({
          wall: {
            positions,
            minimumHeights: hs.map((h) => h - 0.3),
            maximumHeights: hs.map((h) => h + FENCE_HEIGHT),
            material,
            shadows: Cesium.ShadowMode.DISABLED,
          },
        });
        const rail = this.ds.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring.flatMap((p, i) => [p[0], p[1], hs[i] + FENCE_HEIGHT])),
            width: 6,
            material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.fromCssColorString(parcel.color), glowPower: 0.22 }),
          },
        });
        wall.parcelId = rail.parcelId = parcel.id;
        item.fence.push(wall, rail);
      });
    }
    // Edge midpoints: average the two corner heights
    const midH = corners.map((r, ri) => r.map((_, i) => (cornerH[ri][i] + cornerH[ri][(i + 1) % r.length]) / 2));
    this.buildEdgeLabels(item, this.options.fence ? midH : null);
    this.api.kick();
  }

  refreshAllHeights() {
    for (const id of this.items.keys()) this.refreshHeights(id);
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    [...item.entities, ...item.fence, ...item.edgeLabels].forEach((e) => this.ds.entities.remove(e));
    this.items.delete(id);
    this.api.kick();
    if (this.selectedId === id) this.selectedId = null;
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  /** Highlights the selected parcel. Plain values (not per-frame callbacks) keep rendering cheap. */
  select(id) {
    this.selectedId = id;
    for (const [pid, item] of this.items) {
      const on = pid === id;
      for (const e of item.entities) {
        if (e.polygon) e.polygon.material = new Cesium.ColorMaterialProperty(item.color.withAlpha(on ? 0.34 : 0.22));
        if (e.polyline) e.polyline.width = on ? 5 : 3.5;
      }
    }
    this.api.kick();
  }

  setOptions(opts) {
    const fenceChanged = 'fence' in opts && opts.fence !== this.options.fence;
    Object.assign(this.options, opts);
    for (const item of this.items.values()) item.edgeLabels.forEach((e) => (e.show = this.options.edgeLabels));
    this.api.kick();
    if (fenceChanged) this.refreshAllHeights();
  }

  radiusOf(parcel) {
    return Math.max(...parcel.polygons.flatMap((p) => p[0]).map((pt) => distance(pt, parcel.centroid)), 10);
  }

  /** Flies to a parcel. view: '3d' (oblique) or 'top'. */
  async flyTo(parcel, view = '3d') {
    this.stopOrbit();
    const { viewer } = this;
    const [lon, lat] = parcel.centroid;
    const radius = this.radiusOf(parcel);

    if (!Number.isFinite(parcel.groundHeight) && this.api.mode === 'photo') {
      // Photorealistic tiles only load once the camera is near: go overhead first, then sample.
      await new Promise((resolve) =>
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 2600 + radius * 4),
          duration: 2.2,
          complete: resolve,
          cancel: resolve,
        }),
      );
      await this.refreshHeights(parcel.id);
    } else if (!Number.isFinite(parcel.groundHeight)) {
      await this.refreshHeights(parcel.id);
    }
    const h = Number.isFinite(parcel.groundHeight) ? parcel.groundHeight : 0;
    const sphere = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, h), radius);
    const offset =
      view === 'top'
        ? new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), Math.max(radius * 4.6, 160))
        : new Cesium.HeadingPitchRange(Cesium.Math.toRadians(25), Cesium.Math.toRadians(-35), Math.max(radius * 4.2, 150));
    await new Promise((resolve) =>
      viewer.camera.flyToBoundingSphere(sphere, { offset, duration: 2.4, complete: resolve, cancel: resolve }),
    );
  }

  get orbiting() {
    return Boolean(this.orbitRemover);
  }

  startOrbit(parcel) {
    this.stopOrbit();
    const { camera } = this.viewer;
    const h = Number.isFinite(parcel.groundHeight) ? parcel.groundHeight : 0;
    const center = Cesium.Cartesian3.fromDegrees(parcel.centroid[0], parcel.centroid[1], h);
    let heading = camera.heading;
    const pitch = Cesium.Math.clamp(camera.pitch, Cesium.Math.toRadians(-70), Cesium.Math.toRadians(-18));
    const range = Math.min(Cesium.Cartesian3.distance(camera.positionWC, center), this.radiusOf(parcel) * 6 + 300);
    this.orbitRemover = this.viewer.clock.onTick.addEventListener(() => {
      heading += 0.0032;
      camera.lookAt(center, new Cesium.HeadingPitchRange(heading, pitch, range));
    });
    this.onOrbitChange?.(true);
  }

  stopOrbit() {
    if (!this.orbitRemover) return;
    this.orbitRemover();
    this.orbitRemover = null;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this.onOrbitChange?.(false);
  }
}
