// Finds tree canopy in satellite imagery so 3D trees can be placed where real trees stand.
// Pure module: works on RGBA pixel arrays, so it can be unit tested in Node.
//
// A sample point counts as canopy when it is greenish and clearly darker than the area
// around it (foliage casts self-shadow; crops, grass, soil and roads are brighter). A cell
// becomes a tree when most of its samples are canopy and the samples are textured
// (smooth dark surfaces such as water or asphalt are rejected).

import { distance, hashSeed, metresPerDegree, seededRandom } from './geo.js';

export const TILE_SIZE = 256;

/** Fractional Web-Mercator pixel coordinates of [lon, lat] at zoom z. */
export function lonLatToPixel(lon, lat, z) {
  const n = TILE_SIZE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

/** Tile index range covering [w, s, e, n] at zoom z. */
export function tileRange([w, s, e, n], z) {
  const a = lonLatToPixel(w, n, z);
  const b = lonLatToPixel(e, s, z);
  return {
    x0: Math.floor(a.x / TILE_SIZE),
    y0: Math.floor(a.y / TILE_SIZE),
    x1: Math.floor(b.x / TILE_SIZE),
    y1: Math.floor(b.y / TILE_SIZE),
  };
}

/** Ground resolution (m/pixel) at a latitude and zoom. */
export const metresPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * Esri answers missing high-zoom tiles with a light grey "Map data not yet available" image.
 * Detect it: mostly bright, unsaturated pixels.
 */
export function isPlaceholderTile(data) {
  let grey = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4 * 37) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    count++;
    if (r > 185 && g > 185 && b > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 18) grey++;
  }
  return grey / count > 0.55;
}

/** Mean luminance of a tile, used as the local reference brightness. */
export function meanLuminance(data) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * 7) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    n++;
  }
  return n ? sum / n : 128;
}

/** Is this pixel tree canopy, given the surrounding mean luminance? */
export function isCanopyPixel(r, g, b, localMean) {
  const lum = (r + g + b) / 3;
  const greenish = g >= r - 3 && g >= b + 3;
  const darkLimit = Math.min(105, Math.max(45, localMean * 0.8));
  return greenish && lum < darkLimit && lum > 8;
}

/**
 * Mosaic of loaded tiles. `tiles` maps "z/x/y" → { data: Uint8ClampedArray (RGBA 256x256), mean }.
 * Pixels are looked up at zoom `z`, falling back to the parent tile when a tile is missing.
 */
export class TileMosaic {
  constructor(z, tiles) {
    this.z = z;
    this.tiles = tiles;
  }

  pixel(lon, lat) {
    for (let z = this.z; z >= this.z - 2; z--) {
      const p = lonLatToPixel(lon, lat, z);
      const tx = Math.floor(p.x / TILE_SIZE);
      const ty = Math.floor(p.y / TILE_SIZE);
      const tile = this.tiles.get(`${z}/${tx}/${ty}`);
      if (!tile) continue;
      const px = Math.min(TILE_SIZE - 1, Math.floor(p.x - tx * TILE_SIZE));
      const py = Math.min(TILE_SIZE - 1, Math.floor(p.y - ty * TILE_SIZE));
      const i = (py * TILE_SIZE + px) * 4;
      return [tile.data[i], tile.data[i + 1], tile.data[i + 2], tile.mean];
    }
    return null;
  }
}

/**
 * Scans the area and returns detected trees.
 * @param mosaic object with pixel(lon, lat) → [r, g, b, localMean] | null
 * @param options.box [w, s, e, n] area to scan
 * @param options.center [lon, lat]; cells near it use a finer grid
 * @param options.nearRadius metres around the center scanned with `nearCell` spacing
 * @param options.skip (p) => boolean, e.g. inside a building footprint
 */
export function detectTrees(mosaic, { box, center, nearRadius = 450, nearCell = 4.2, farCell = 7, maxTrees = 20000, skip } = {}) {
  const [w, s, e, n] = box;
  const [mLon, mLat] = metresPerDegree((s + n) / 2);
  const rnd = seededRandom(hashSeed(box.map((v) => v.toFixed(5)).join(',')));
  const trees = [];

  const scan = (cell, accept) => {
    const dx = cell / mLon;
    const dy = cell / mLat;
    const sub = [-0.33, 0, 0.33];
    for (let y = s + dy / 2; y < n; y += dy) {
      for (let x = w + dx / 2; x < e; x += dx) {
        const p = [x, y];
        const d = distance(p, center);
        if (!accept(d)) continue;
        let hits = 0;
        let total = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let sumL = 0;
        let sumL2 = 0;
        for (const oy of sub)
          for (const ox of sub) {
            const px = mosaic.pixel(x + ox * dx, y + oy * dy);
            if (!px) continue;
            const [r, g, b, mean] = px;
            total++;
            if (isCanopyPixel(r, g, b, mean)) {
              const lum = (r + g + b) / 3;
              sumL += lum;
              sumL2 += lum * lum;
              hits++;
              sr += r;
              sg += g;
              sb += b;
            }
          }
        if (total < 6 || hits < 5) continue;
        // Texture of the canopy samples themselves: foliage is uneven, water is smooth.
        const mean = sumL / hits;
        const std = Math.sqrt(Math.max(0, sumL2 / hits - mean * mean));
        if (std < 2.5) continue;
        const jx = (rnd() - 0.5) * dx * 0.7;
        const jy = (rnd() - 0.5) * dy * 0.7;
        const pos = [x + jx, y + jy];
        if (skip?.(pos)) continue;
        trees.push({
          pos,
          cell,
          density: hits / total,
          color: [sr / hits, sg / hits, sb / hits],
          dist: d,
          rnd: rnd(),
        });
      }
    }
  };

  scan(nearCell, (d) => d <= nearRadius);
  scan(farCell, (d) => d > nearRadius);
  trees.sort((a, b) => a.dist - b.dist);
  return trees.slice(0, maxTrees);
}

/**
 * Picks a 3D tree style for a detected tree from its satellite colour.
 * Very dark blue-green → pine/fir; light grey-green → olive; otherwise a broadleaf / umbrella pine.
 */
export function styleFromColor([r, g, b], rnd) {
  const lum = (r + g + b) / 3;
  if (lum < 42 && b >= r - 4) return rnd < 0.5 ? 'conifer' : 'pine';
  if (lum > 70 && b > r - 12 && g - r < 14) return 'olive';
  if (lum < 55) return rnd < 0.35 ? 'pine' : 'broad';
  return 'broad';
}
