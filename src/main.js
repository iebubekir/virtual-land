// Cesium fetches its workers and assets from CESIUM_BASE_URL at runtime. Set it before
// the library is evaluated, relative to the page so the site works under any sub-path.
// Resolved from this script (src/ in dev, assets/ in the build), so it works from any page folder.
window.CESIUM_BASE_URL = new URL(/* @vite-ignore */ '../cesium/', import.meta.url).href;

import('./app.js');
