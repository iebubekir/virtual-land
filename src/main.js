// Cesium fetches its workers and assets from CESIUM_BASE_URL at runtime. Set it before
// the library is evaluated, relative to the page so the site works under any sub-path.
window.CESIUM_BASE_URL = new URL('cesium/', document.baseURI).href;

import('./app.js');
