import * as Cesium from 'cesium';
import { settings } from '../settings.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

function esri(service, maximumLevel = 19) {
  return new Cesium.UrlTemplateImageryProvider({
    url: `${ESRI}/${service}/MapServer/tile/{z}/{y}/{x}`,
    maximumLevel,
    credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics', false),
  });
}

const BASEMAPS = {
  satellite: () => [esri('World_Imagery')],
  satelliteLabels: () => [
    esri('World_Imagery'),
    esri('Reference/World_Transportation', 18),
    esri('Reference/World_Boundaries_and_Places', 18),
  ],
  streets: () => [
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
      credit: new Cesium.Credit('© OpenStreetMap contributors', false),
    }),
  ],
};

const QUALITY = { high: 1, normal: 0.85, low: 0.6 };

/**
 * Creates the Cesium viewer with free imagery and no Cesium ion dependency.
 * Optional extras (world terrain, Google photorealistic tiles) are switched on by setMode().
 */
export function createViewer(container) {
  const viewer = new Cesium.Viewer(container, {
    baseLayer: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shadows: false,
    msaaSamples: 4,
  });

  const { scene } = viewer;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.showGroundAtmosphere = true;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1a2a');
  scene.fog.enabled = true;
  scene.highDynamicRange = false;
  scene.postProcessStages.fxaa.enabled = true;
  scene.screenSpaceCameraController.minimumZoomDistance = 8;
  // Keep a pleasant midday sun over Turkey whatever the visitor's clock says (UTC+3 → 12:00 local).
  const noon = new Date();
  noon.setUTCHours(9, 0, 0, 0);
  viewer.clock.currentTime = Cesium.JulianDate.fromDate(noon);
  viewer.clock.shouldAnimate = false;
  viewer.shadowMap.softShadows = true;
  viewer.shadowMap.size = 2048;
  viewer.shadowMap.maximumDistance = 1500;
  viewer.shadowMap.darkness = 0.55;

  // OSM / Esri attribution is shown through the credit display.
  viewer.creditDisplay.addStaticCredit(
    new Cesium.Credit('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>', false),
  );

  // Start above Turkey.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(35.2, 38.9, 2600000),
  });

  const api = {
    viewer,
    Cesium,
    photoTileset: null,
    mode: 'osm',
    hasTerrain: false,

    setBasemap(name) {
      const layers = viewer.imageryLayers;
      layers.removeAll();
      (BASEMAPS[name] || BASEMAPS.satelliteLabels)().forEach((p) => layers.addImageryProvider(p));
    },

    setShadows(on) {
      viewer.shadows = on;
      viewer.terrainShadows = on ? Cesium.ShadowMode.RECEIVE_ONLY : Cesium.ShadowMode.DISABLED;
    },

    setQuality(q) {
      viewer.resolutionScale = (QUALITY[q] || 0.85) * Math.min(window.devicePixelRatio || 1, 2);
      scene.globe.maximumScreenSpaceError = q === 'low' ? 3 : q === 'high' ? 1.5 : 2;
      if (api.photoTileset) api.photoTileset.maximumScreenSpaceError = q === 'low' ? 24 : q === 'high' ? 8 : 16;
    },

    /** Turns on Cesium World Terrain when an ion token is configured. */
    async setTerrain(enabled) {
      if (enabled && settings.ionToken) {
        Cesium.Ion.defaultAccessToken = settings.ionToken;
        try {
          viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, { requestVertexNormals: true });
          api.hasTerrain = true;
          return true;
        } catch (err) {
          console.warn('World terrain unavailable', err);
        }
      }
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
      api.hasTerrain = false;
      return false;
    },

    /**
     * 'photo' → Google Photorealistic 3D Tiles (real buildings and trees), globe hidden.
     * 'osm'   → imagery globe; buildings and trees are generated from OpenStreetMap.
     * Resolves to the mode that is actually active.
     */
    async setMode(mode) {
      if (mode === 'photo') {
        try {
          if (!api.photoTileset) {
            const tilesetOptions = { maximumScreenSpaceError: 16, shadows: Cesium.ShadowMode.ENABLED };
            if (settings.googleKey) {
              api.photoTileset = await Cesium.createGooglePhotorealistic3DTileset({ key: settings.googleKey }, tilesetOptions);
            } else {
              Cesium.Ion.defaultAccessToken = settings.ionToken;
              api.photoTileset = await Cesium.createGooglePhotorealistic3DTileset(undefined, tilesetOptions);
            }
            scene.primitives.add(api.photoTileset);
            api.setQuality(settings.quality);
          }
          api.photoTileset.show = true;
          scene.globe.show = false;
          api.mode = 'photo';
          return 'photo';
        } catch (err) {
          console.warn('Photorealistic tiles failed', err);
          api.disposePhoto();
          scene.globe.show = true;
          api.mode = 'osm';
          throw err;
        }
      }
      if (api.photoTileset) api.photoTileset.show = false;
      scene.globe.show = true;
      api.mode = 'osm';
      return 'osm';
    },

    disposePhoto() {
      if (api.photoTileset) {
        scene.primitives.remove(api.photoTileset);
        api.photoTileset = null;
      }
    },

    /**
     * Ground heights (ellipsoidal metres) for [lon, lat] points, using whatever surface is shown.
     * Falls back to 0 on the plain ellipsoid.
     */
    async groundHeights(points, { exclude = [] } = {}) {
      const cartos = points.map(([lon, lat]) => Cesium.Cartographic.fromDegrees(lon, lat));
      if (api.mode === 'photo' && api.photoTileset) {
        try {
          const res = await withTimeout(scene.sampleHeightMostDetailed(cartos, exclude), 15000);
          const ok = res.filter((c) => c && Number.isFinite(c.height)).map((c) => c.height);
          if (ok.length) {
            // Use the lowest values seen so tree / roof tops do not lift the result.
            const fallback = ok.sort((a, b) => a - b)[Math.floor(ok.length * 0.2)];
            return res.map((c) => (c && Number.isFinite(c.height) ? c.height : fallback));
          }
        } catch (err) {
          console.warn('sampleHeightMostDetailed failed', err);
        }
      }
      if (api.hasTerrain) {
        try {
          const res = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos);
          return res.map((c) => (Number.isFinite(c.height) ? c.height : 0));
        } catch (err) {
          console.warn('sampleTerrain failed', err);
        }
      }
      return points.map(() => 0);
    },
  };

  api.setBasemap(settings.basemap);
  api.setShadows(settings.shadows);
  api.setQuality(settings.quality);
  return api;
}

export function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}
