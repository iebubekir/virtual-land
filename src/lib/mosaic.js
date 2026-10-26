// Grid of overlapping top-down tiles around a parcel. Each tile is captured, enhanced
// (Upscayl / ChatGPT / any AI tool) and draped back on exactly the same ground rectangle.
import { metresPerDegree } from './geo.js';

export const TILE_PX = 1024; // square tiles: accepted by ChatGPT and upscalers
export const OVERLAP = 0.18; // each tile extends 18 % beyond its grid cell, for seamless blending

/** Ground side length (m) covered by the whole grid. */
export function mosaicSide(parcelRadius) {
  return Math.max(parcelRadius * 2 * 3.4, 200);
}

/**
 * @param center [lon, lat]
 * @param parcelRadius metres from centroid to the farthest corner
 * @param k grid size (1 → single image, 3 → 3×3)
 * @returns {{ side: number, tiles: {row, col, name, rect: [w,s,e,n], sizeM}[] }}
 */
export function mosaicLayout(center, parcelRadius, k = 3) {
  const [lon, lat] = center;
  const side = mosaicSide(parcelRadius);
  const step = side / k;
  const sizeM = k === 1 ? side : step * (1 + OVERLAP);
  const [mLon, mLat] = metresPerDegree(lat);
  const tiles = [];
  for (let row = 0; row < k; row++) {
    for (let col = 0; col < k; col++) {
      const east = -side / 2 + step * (col + 0.5);
      const north = side / 2 - step * (row + 0.5); // row 0 = northernmost
      const cLon = lon + east / mLon;
      const cLat = lat + north / mLat;
      const h = sizeM / 2;
      tiles.push({
        row,
        col,
        name: tileName(row, col),
        center: [cLon, cLat],
        sizeM,
        rect: [cLon - h / mLon, cLat - h / mLat, cLon + h / mLon, cLat + h / mLat],
      });
    }
  }
  return { k, side, tiles };
}

export const tileName = (row, col) => `vl_r${row}_c${col}`;

/** Finds the tile a file belongs to from its name (also matches Upscayl output like "vl_r0_c2_upscayl_4x.png"). */
export function matchTileName(fileName) {
  const m = String(fileName).match(/vl_r(\d+)_c(\d+)/i);
  return m ? { row: Number(m[1]), col: Number(m[2]) } : null;
}

/** Edge fade width as a fraction of the tile size, so neighbours cross-fade in the overlap. */
export const featherFraction = (k) => (k === 1 ? 0.06 : OVERLAP / (2 * (1 + OVERLAP)) * 1.6);
