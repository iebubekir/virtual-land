// User settings persisted in localStorage. Build-time env vars give optional defaults
// (VITE_GOOGLE_MAPS_API_KEY / VITE_CESIUM_ION_TOKEN), so a deployment can ship keys.

const KEY = 'vl.settings.v1';
const isMobile = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 760px), (pointer: coarse)').matches;

const DEFAULTS = {
  lang: 'tr',
  googleKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '',
  ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN || '',
  viewMode: 'auto', // 'auto' | 'osm' | 'photo'
  basemap: 'satelliteLabels',
  surroundings: true,
  radius: 300,
  edgeLabels: true,
  fence: true,
  shadows: !isMobile,
  quality: isMobile ? 'low' : 'normal',
};

function safeGet() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}

const state = { ...DEFAULTS, ...safeGet() };
const listeners = new Set();

export const settings = new Proxy(state, {
  set(target, prop, value) {
    target[prop] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(target));
    } catch {
      /* storage unavailable (private mode) — keep in memory */
    }
    listeners.forEach((fn) => fn(prop, value));
    return true;
  },
});

export const onSettingsChange = (fn) => listeners.add(fn);

/** True when a photorealistic 3D source is configured. */
export const canUsePhoto = () => Boolean(settings.googleKey || settings.ionToken);

/** The 3D mode actually in effect. */
export function effectiveViewMode() {
  if (settings.viewMode === 'osm') return 'osm';
  if (canUsePhoto()) return 'photo';
  return 'osm';
}

export const IS_MOBILE = isMobile;
