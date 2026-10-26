// Loads Esri World Imagery tiles as RGBA pixel arrays for canopy detection.
import { TileMosaic, TILE_SIZE, isPlaceholderTile, meanLuminance, tileRange } from '../lib/canopy.js';
import { ESRI_IMAGERY_TILE } from './viewer.js';

const MAX_TILES = 230;

let canvas;
function decode(bitmap) {
  canvas ??= typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE) : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  ctx.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

async function fetchTile(z, x, y, signal) {
  const res = await fetch(ESRI_IMAGERY_TILE(z, y, x), { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const data = decode(bitmap);
  bitmap.close?.();
  return data;
}

/** Runs async jobs with limited concurrency. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Loads all imagery tiles covering `box` at zoom 17 (or 16 for very large areas).
 * Missing (placeholder) tiles are replaced by their parent tile.
 * @returns {Promise<{mosaic: TileMosaic, loaded: number, missing: number}>}
 */
export async function loadImageryMosaic(box, { signal, zoom = 17 } = {}) {
  let z = zoom;
  let range = tileRange(box, z);
  const count = (r) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  while (count(range) > MAX_TILES && z > 14) range = tileRange(box, --z);

  const tiles = new Map();
  const jobs = [];
  for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) jobs.push([x, y]);

  let loaded = 0;
  let missing = 0;
  const parents = new Map();
  const loadParent = (x, y) => {
    const key = `${z - 1}/${x >> 1}/${y >> 1}`;
    if (!parents.has(key)) {
      parents.set(
        key,
        fetchTile(z - 1, x >> 1, y >> 1, signal)
          .then((data) => {
            if (!isPlaceholderTile(data)) tiles.set(key, { data, mean: meanLuminance(data) });
          })
          .catch(() => {}),
      );
    }
    return parents.get(key);
  };

  await pool(jobs, 8, async ([x, y]) => {
    try {
      const data = await fetchTile(z, x, y, signal);
      if (isPlaceholderTile(data)) {
        missing++;
        await loadParent(x, y);
      } else {
        tiles.set(`${z}/${x}/${y}`, { data, mean: meanLuminance(data) });
        loaded++;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      missing++;
      await loadParent(x, y);
    }
  });

  if (!tiles.size) throw new Error('No imagery tiles could be read');
  return { mosaic: new TileMosaic(z, tiles), loaded, missing };
}
