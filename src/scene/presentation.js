// Presentation tools: a clean top-down capture of a parcel (to enhance in an AI image tool),
// draping an enhanced image back onto the exact same ground area, and recording a cinematic
// fly-around video of the parcel.
import * as Cesium from 'cesium';
import { TILE_PX } from '../lib/mosaic.js';


/** Stable key for a parcel across reloads (ids are regenerated on load). */
export const parcelKey = (p) => `${p.label}|${p.polygons[0][0][0].map((v) => v.toFixed(6)).join(',')}`;

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Renders until the globe imagery for the current view has finished loading. */
async function waitForTiles(viewer, timeout = 25000) {
  const t0 = performance.now();
  let stable = 0;
  while (performance.now() - t0 < timeout) {
    viewer.scene.requestRender();
    await nextFrame();
    stable = viewer.scene.globe.tilesLoaded ? stable + 1 : 0;
    if (stable > 8) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ top-down capture */

/**
 * Captures clean, north-up, orthographic top-down tiles (satellite only — no labels,
 * boundary or 3D objects), one per entry of `tiles` ({rect, sizeM, center}), each TILE_PX².
 * @returns {Promise<Blob[]>}
 */
export async function captureTiles({ sceneApi, layer, surroundings, overlays, parcel, tiles, onProgress }) {
  const { viewer } = sceneApi;
  const { scene } = viewer;
  const camera = scene.camera;
  layer.stopOrbit();

  const saved = {
    frustum: camera.frustum.clone(),
    position: camera.position.clone(),
    direction: camera.direction.clone(),
    up: camera.up.clone(),
    resolutionScale: viewer.resolutionScale,
    surroundings: surroundings.visible,
    parcels: layer.ds.show,
    layers: [],
    photo: sceneApi.photoTileset?.show,
    globe: scene.globe.show,
  };
  try {
    surroundings.visible = false;
    layer.ds.show = false;
    if (sceneApi.photoTileset) sceneApi.photoTileset.show = false;
    scene.globe.show = true;
    const imagery = viewer.imageryLayers;
    for (let i = 0; i < imagery.length; i++) {
      const l = imagery.get(i);
      saved.layers.push([l, l.show]);
      l.show = i === 0;
    }
    overlays?.hideAll();

    // Render larger than the screen so each crop has enough pixels.
    const canvas = scene.canvas;
    const dpr = window.devicePixelRatio || 1;
    viewer.resolutionScale = Math.max(saved.resolutionScale, (TILE_PX * 1.12) / (Math.min(canvas.clientWidth, canvas.clientHeight) * dpr));
    viewer.resize();
    await nextFrame();
    const cropPx = Math.min(canvas.width, canvas.height) * 0.94;

    const blobs = [];
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      onProgress?.(i / tiles.length);
      const metresPerPixel = tile.sizeM / cropPx;
      const frustum = new Cesium.OrthographicFrustum();
      frustum.width = metresPerPixel * canvas.width;
      frustum.aspectRatio = canvas.width / canvas.height;
      frustum.near = 1;
      frustum.far = 20000;
      camera.frustum = frustum;
      camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(tile.center[0], tile.center[1], (parcel.groundHeight || 0) + 4000),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      await waitForTiles(viewer);
      // Draw straight after rendering, while the WebGL drawing buffer is still valid.
      scene.render();
      const out = document.createElement('canvas');
      out.width = TILE_PX;
      out.height = TILE_PX;
      out.getContext('2d').drawImage(canvas, (canvas.width - cropPx) / 2, (canvas.height - cropPx) / 2, cropPx, cropPx, 0, 0, TILE_PX, TILE_PX);
      blobs.push(await new Promise((r) => out.toBlob(r, 'image/png')));
    }
    onProgress?.(1);
    return blobs;
  } finally {
    camera.frustum = saved.frustum;
    camera.setView({ destination: saved.position, orientation: { direction: saved.direction, up: saved.up } });
    viewer.resolutionScale = saved.resolutionScale;
    viewer.resize();
    surroundings.visible = saved.surroundings;
    layer.ds.show = saved.parcels;
    if (sceneApi.photoTileset) sceneApi.photoTileset.show = saved.photo;
    scene.globe.show = saved.globe;
    saved.layers.forEach(([l, show]) => (l.show = show));
    overlays?.showAll();
    sceneApi.kick(1500);
  }
}

/** Packs captured tiles + layout + instructions into one ZIP. */
export async function packTiles(JSZip, layout, blobs, readme) {
  const zip = new JSZip();
  layout.tiles.forEach((t, i) => zip.file(`${t.name}.png`, blobs[i]));
  zip.file('OKU-BENI.txt', readme);
  return zip.generateAsync({ type: 'blob' });
}

/**
 * Fades the image edges to transparent so overlapping tiles blend into each other and
 * the outer edge blends into the satellite map. Returns a PNG blob.
 */
export async function featherImage(file, fraction, maxSize = 2048) {
  const bmp = await createImageBitmap(file);
  // Upscalers output 4096 px+; 9 such textures would need ~600 MB of GPU memory.
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const fx = Math.max(1, w * fraction);
  const fy = Math.max(1, h * fraction);
  g.globalCompositeOperation = 'destination-in';
  // Multiply alpha by a horizontal and a vertical ramp.
  const ramp = (x0, y0, x1, y1, len, total) => {
    const grad = g.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(len / total, 'rgba(0,0,0,1)');
    grad.addColorStop(1 - len / total, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    return grad;
  };
  g.fillStyle = ramp(0, 0, w, 0, fx, w);
  g.fillRect(0, 0, w, h);
  g.fillStyle = ramp(0, 0, 0, h, fy, h);
  g.fillRect(0, 0, w, h);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

/* ------------------------------------------------------------------ overlays (IndexedDB) */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('virtual-land', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('overlays', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('overlays', mode);
    const req = fn(tx.objectStore('overlays'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Enhanced images draped on the globe, persisted in IndexedDB.
 * Keys are "<parcelKey>#<tileName>", so one parcel can have a whole grid of tiles.
 */
export class OverlayManager {
  constructor(sceneApi) {
    this.api = sceneApi;
    this.layers = new Map(); // key -> { layer, url, visible }
  }

  keysOf(prefix) {
    return [...this.layers.keys()].filter((k) => k.startsWith(`${prefix}#`));
  }

  has(prefix) {
    return this.keysOf(prefix).length > 0;
  }

  hasTile(prefix, name) {
    return this.layers.has(`${prefix}#${name}`);
  }

  isVisible(prefix) {
    return this.keysOf(prefix).some((k) => this.layers.get(k).visible);
  }

  async add(key, blob, rect, { persist = true } = {}) {
    this.remove(key, { persist: false, exact: true });
    const url = URL.createObjectURL(blob);
    const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
      rectangle: Cesium.Rectangle.fromDegrees(...rect),
      credit: new Cesium.Credit('Yapay zekâ ile iyileştirilmiş görüntü', false),
    });
    const layer = this.api.viewer.imageryLayers.addImageryProvider(provider);
    this.layers.set(key, { layer, url, visible: true });
    if (persist) await dbOp('readwrite', (store) => store.put({ key, blob, rect, savedAt: Date.now() })).catch(() => {});
    this.api.kick(1500);
  }

  setVisible(prefix, visible) {
    for (const k of this.keysOf(prefix)) {
      const o = this.layers.get(k);
      o.visible = visible;
      o.layer.show = visible;
    }
    this.api.kick();
  }

  /** Removes one tile (exact key) or every tile of a parcel (prefix). */
  remove(keyOrPrefix, { persist = true, exact = false } = {}) {
    const keys = exact || keyOrPrefix.includes('#') ? [keyOrPrefix] : this.keysOf(keyOrPrefix);
    for (const k of keys) {
      const o = this.layers.get(k);
      if (o) {
        this.api.viewer.imageryLayers.remove(o.layer, true);
        URL.revokeObjectURL(o.url);
        this.layers.delete(k);
      }
      if (persist) dbOp('readwrite', (store) => store.delete(k)).catch(() => {});
    }
    if (!exact && !keyOrPrefix.includes('#') && persist) {
      // Also clear tiles stored but not currently loaded.
      dbOp('readonly', (store) => store.getAllKeys())
        .then((all) => all.filter((k) => String(k).startsWith(`${keyOrPrefix}#`)).forEach((k) => dbOp('readwrite', (store) => store.delete(k))))
        .catch(() => {});
    }
    this.api.kick();
  }

  hideAll() {
    for (const o of this.layers.values()) o.layer.show = false;
  }

  showAll() {
    for (const o of this.layers.values()) o.layer.show = o.visible;
  }

  /** Re-adds saved overlays belonging to the given parcel keys. */
  async restore(prefixes) {
    let records = [];
    try {
      records = await dbOp('readonly', (store) => store.getAll());
    } catch {
      return;
    }
    for (const r of records || []) {
      if (prefixes.some((p) => r.key.startsWith(`${p}#`))) await this.add(r.key, r.blob, r.rect, { persist: false }).catch(() => {});
    }
  }
}

/* ------------------------------------------------------------------ video */

const VIDEO_SIZES = { portrait: [720, 1280], landscape: [1280, 720] };

function pickMime() {
  const candidates = ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Brand + parcel info card drawn over each video frame. */
function drawOverlay(ctx, w, h, info, alpha) {
  const s = w / 720; // scale relative to 720 px width
  ctx.save();
  ctx.globalAlpha = alpha;
  const font = (weight, px) => `${weight} ${Math.round(px * s)}px "IBM Plex Sans", "Segoe UI", sans-serif`;

  // brand
  ctx.font = font(700, 26);
  ctx.fillStyle = 'rgba(13,23,36,0.6)';
  const brand = 'Virtual Land';
  const bw = ctx.measureText(brand).width + 36 * s;
  roundRect(ctx, 28 * s, 30 * s, bw, 50 * s, 14 * s);
  ctx.fill();
  ctx.fillStyle = '#ffd43b';
  ctx.fillText(brand, 46 * s, 64 * s);

  // info card
  const pad = 26 * s;
  const cardH = (info.place ? 150 : 118) * s;
  const cardY = h - cardH - (info.disclaimer ? 70 : 42) * s;
  ctx.fillStyle = 'rgba(13,23,36,0.78)';
  roundRect(ctx, 28 * s, cardY, w - 56 * s, cardH, 20 * s);
  ctx.fill();
  ctx.fillStyle = '#ffd43b';
  ctx.fillRect(28 * s, cardY + 20 * s, 6 * s, cardH - 40 * s);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, 38);
  ctx.fillText(info.title, 28 * s + pad, cardY + 58 * s);
  ctx.font = font(600, 30);
  ctx.fillStyle = '#ffd43b';
  ctx.fillText(info.area, 28 * s + pad, cardY + 100 * s);
  if (info.place) {
    ctx.font = font(400, 24);
    ctx.fillStyle = '#c9d4e0';
    ctx.fillText(info.place, 28 * s + pad, cardY + 136 * s);
  }
  if (info.disclaimer) {
    // Shrink the note until it fits the frame width.
    let px = 19;
    ctx.font = font(400, px);
    while (px > 11 && ctx.measureText(info.disclaimer).width > w - 68 * s) ctx.font = font(400, --px);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(info.disclaimer, 34 * s, h - 28 * s);
  }
  ctx.restore();
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Records a cinematic video: wide establishing view → approach → 360° orbit → hold.
 * @param opts.format 'portrait' (9:16) | 'landscape' (16:9)
 * @param opts.info { title, area, place, disclaimer }
 * @param opts.onProgress (0..1)
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function recordVideo({ sceneApi, layer, parcel, format = 'portrait', info, onProgress, durationOrbit = 14 }) {
  if (!window.MediaRecorder) throw new Error('MediaRecorder unsupported');
  const { viewer } = sceneApi;
  const { scene } = viewer;
  const camera = scene.camera;
  const container = viewer.container;
  layer.stopOrbit();

  const [vw, vh] = VIDEO_SIZES[format] || VIDEO_SIZES.portrait;
  const saved = {
    style: container.getAttribute('style') || '',
    resolutionScale: viewer.resolutionScale,
    requestRenderMode: scene.requestRenderMode,
    position: camera.position.clone(),
    direction: camera.direction.clone(),
    up: camera.up.clone(),
  };

  // Fixed-size render target; scaled down with CSS to fit the screen while recording.
  const fit = Math.min((window.innerWidth * 0.9) / vw, (window.innerHeight * 0.82) / vh, 1);
  container.style.cssText = `position:fixed;left:50%;top:50%;width:${vw}px;height:${vh}px;transform:translate(-50%,-50%) scale(${fit});transform-origin:center;z-index:40;box-shadow:0 20px 60px rgba(0,0,0,.6);border-radius:12px;overflow:hidden;`;
  viewer.resolutionScale = 1 / (window.devicePixelRatio || 1);
  viewer.resize();
  scene.requestRenderMode = false;

  const comp = document.createElement('canvas');
  comp.width = vw;
  comp.height = vh;
  const ctx = comp.getContext('2d');
  let overlayAlpha = 0;
  const removePostRender = scene.postRender.addEventListener(() => {
    ctx.drawImage(scene.canvas, 0, 0, vw, vh);
    drawOverlay(ctx, vw, vh, info, overlayAlpha);
  });

  const [lon, lat] = parcel.centroid;
  const h0 = parcel.groundHeight || 0;
  const center = Cesium.Cartesian3.fromDegrees(lon, lat, h0);
  const radius = layer.radiusOf(parcel);
  const close = Math.max(radius * (format === 'portrait' ? 3.6 : 3), 120);
  const far = close * 7 + 600;
  const startHPR = new Cesium.HeadingPitchRange(Cesium.Math.toRadians(-20), Cesium.Math.toRadians(-55), far);
  const endPitch = Cesium.Math.toRadians(-32);

  const lookAt = (heading, pitch, range) => camera.lookAt(center, new Cesium.HeadingPitchRange(heading, pitch, range));

  let recorder;
  try {
    // Pre-load imagery for the start and end views so the video does not show blurry tiles.
    lookAt(startHPR.heading + Math.PI / 4, endPitch, close);
    await waitForTiles(viewer, 15000);
    lookAt(startHPR.heading, startHPR.pitch, startHPR.range);
    await waitForTiles(viewer, 15000);

    const mimeType = pickMime();
    const stream = comp.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (recorder.onstop = r));
    recorder.start(250);

    const approach = 5.5;
    const hold = 1.5;
    const total = hold + approach + durationOrbit + hold;
    const t0 = performance.now();
    // One continuous, time-based camera path.
    for (;;) {
      const t = (performance.now() - t0) / 1000;
      if (t >= total) break;
      onProgress?.(t / total);
      let heading;
      let pitch;
      let range;
      if (t < hold) {
        heading = startHPR.heading;
        pitch = startHPR.pitch;
        range = startHPR.range;
      } else if (t < hold + approach) {
        const k = ease((t - hold) / approach);
        heading = startHPR.heading + (Math.PI / 4) * k;
        pitch = startHPR.pitch + (endPitch - startHPR.pitch) * k;
        range = startHPR.range * (close / startHPR.range) ** k; // exponential zoom feels natural
      } else {
        const k = Math.min(1, (t - hold - approach) / durationOrbit);
        heading = startHPR.heading + Math.PI / 4 + Math.PI * 2 * ease(k);
        pitch = endPitch;
        range = close;
      }
      overlayAlpha = Math.min(1, Math.max(0, (t - 0.6) / 0.8));
      lookAt(heading, pitch, range);
      await nextFrame();
    }
    onProgress?.(1);
    recorder.stop();
    await stopped;
    await sleep(50);
    const type = recorder.mimeType || mimeType || 'video/webm';
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  } finally {
    if (recorder && recorder.state === 'recording') recorder.stop();
    removePostRender();
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    container.setAttribute('style', saved.style);
    viewer.resolutionScale = saved.resolutionScale;
    viewer.resize();
    scene.requestRenderMode = saved.requestRenderMode;
    camera.setView({ destination: saved.position, orientation: { direction: saved.direction, up: saved.up } });
    sceneApi.kick(1500);
  }
}

/** Starts a file download for a Blob. */
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Prompt to paste into ChatGPT together with the captured image. */
export const ENHANCE_PROMPT_TR =
  'Bu uydu görüntüsünü fotoğraf kalitesinde, net ve canlı bir drone görüntüsüne dönüştür. ' +
  'Kompozisyonu, kadrajı ve kare en-boy oranını (1024x1024) AYNEN koru: yolların, tarla sınırlarının, ' +
  'binaların ve ağaçların konumunu, şeklini ve boyutunu değiştirme, yeni bina, havuz veya yol ekleme, ' +
  'hiçbir şeyi kaldırma. Sadece netliği, renkleri, ışığı ve dokuları iyileştir. Görüntü tam tepeden (90°) bakan, kuzey yukarıda olsun.';
