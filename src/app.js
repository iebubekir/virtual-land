import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';
import JSZip from 'jszip';
import { createViewer } from './scene/viewer.js';
import { ParcelLayer, PARCEL_COLORS } from './scene/parcelLayer.js';
import { Surroundings } from './scene/surroundings.js';
import { parseParcelFile, serializeParcel, deserializeParcel } from './lib/parcels.js';
import { formatArea } from './lib/geo.js';
import { settings, canUsePhoto, effectiveViewMode, IS_MOBILE } from './settings.js';
import { setLang, t, LANGS, getLang, numberLocale } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STORE_KEY = 'vl.parcels.v1';
const SELECTED_KEY = 'vl.selected.v1';
const SAMPLE_FILE = 'ornek-parsel.kml';

const parcels = new Map();
let selectedId = null;

setLang(settings.lang);

const sceneApi = createViewer($('#globe'));
const layer = new ParcelLayer(sceneApi, { onSelect: (id) => select(id, false) });
const surroundings = new Surroundings(sceneApi);
layer.setOptions({ edgeLabels: settings.edgeLabels, fence: settings.fence });
layer.onOrbitChange = (on) => {
  $('#toolOrbit').classList.toggle('on', on);
  $('#orbitLabel').textContent = t(on ? 'stopOrbit' : 'orbit');
};

// expose for debugging / automated checks
window.vl = { sceneApi, layer, surroundings, parcels };

/* ---------------- helpers ---------------- */

function toast(message, type = 'ok', ms = 4200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

let statusTimer;
function status(text, { loading = false, action = null, autoHide = 0 } = {}) {
  clearTimeout(statusTimer);
  const box = $('#status');
  if (!text) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.classList.toggle('done', !loading);
  $('#statusText').textContent = text;
  const btn = $('#statusAction');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.run;
  }
  if (autoHide) statusTimer = setTimeout(() => (box.hidden = true), autoHide);
}

const nf = (v, digits = 2) => new Intl.NumberFormat(numberLocale(), { maximumFractionDigits: digits }).format(v);

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...parcels.values()].map(serializeParcel)));
    localStorage.setItem(SELECTED_KEY, selectedId || '');
  } catch {
    /* storage full or blocked */
  }
}

function errorMessage(err, fileName) {
  switch (err?.code) {
    case 'PROJECTED_COORDINATES':
      return t('errProjected');
    case 'NO_KML_IN_KMZ':
      return t('errNoKml');
    case 'UNSUPPORTED_FILE':
      return t('errUnsupported');
    default:
      return t('loadFailed', { f: fileName });
  }
}

/* ---------------- 3D mode ---------------- */

async function applyMode() {
  const wanted = effectiveViewMode();
  await sceneApi.setTerrain(Boolean(settings.ionToken));
  let mode = 'osm';
  try {
    mode = await sceneApi.setMode(wanted);
  } catch {
    toast(t('photoFailed'), 'error', 6000);
    mode = await sceneApi.setMode('osm');
  }
  $('#viewModeSelect').value = mode;
  $('#osmOptions').hidden = mode !== 'osm';
  surroundings.visible = mode === 'osm' && settings.surroundings;
  surroundings.clear();
  for (const p of parcels.values()) delete p.groundHeight;
  layer.refreshAllHeights();
  const sel = parcels.get(selectedId);
  if (sel) loadSurroundings(sel);
}

async function loadSurroundings(parcel) {
  if (sceneApi.mode !== 'osm' || !settings.surroundings) {
    status(null);
    return;
  }
  status(t('loadingSurroundings'), { loading: true });
  try {
    const { buildings, trees } = await surroundings.load(parcel, Number(settings.radius));
    if (selectedId !== parcel.id) return;
    if (!buildings && !trees) status(t('surroundingsNone'), { autoHide: 6000 });
    else status(t('surroundingsDone', { b: nf(buildings, 0), t: nf(trees, 0) }), { autoHide: 5000 });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.warn(err);
    status(t('surroundingsFailed'), { action: { label: t('retry'), run: () => loadSurroundings(parcel) } });
  }
}

/* ---------------- parcels ---------------- */

function addParcels(list, { fly = true } = {}) {
  for (const p of list) {
    if (!p.color) p.color = PARCEL_COLORS[parcels.size % PARCEL_COLORS.length];
    parcels.set(p.id, p);
    layer.add(p);
  }
  renderList();
  persist();
  if (list.length) select(list[list.length - 1].id, fly);
}

function removeParcel(id) {
  layer.remove(id);
  parcels.delete(id);
  if (selectedId === id) {
    selectedId = null;
    surroundings.clear();
    layer.stopOrbit();
    status(null);
  }
  renderList();
  renderDetails();
  persist();
}

async function select(id, fly = true) {
  const p = parcels.get(id);
  if (!p) return;
  const changed = selectedId !== id;
  selectedId = id;
  layer.select(id);
  renderList();
  renderDetails();
  persist();
  // On phones the bottom sheet would hide the parcel: close it while flying there,
  // and open it when the parcel was tapped on the map (details wanted).
  if (IS_MOBILE) $('#panel').classList.toggle('open', !fly && changed);
  if (fly) await layer.flyTo(p, '3d');
  if (selectedId === id) loadSurroundings(p);
}

async function handleFiles(files) {
  const added = [];
  for (const file of files) {
    try {
      const list = await parseParcelFile(file, { DOMParser, JSZip });
      if (!list.length) toast(t('noParcels', { f: file.name }), 'error', 6000);
      added.push(...list);
    } catch (err) {
      console.warn(err);
      toast(errorMessage(err, file.name), 'error', 7000);
    }
  }
  if (added.length) {
    addParcels(added);
    toast(t('loaded', { n: added.length }));
  }
}

async function loadSample() {
  const res = await fetch(`samples/${SAMPLE_FILE}`);
  const buf = await res.arrayBuffer();
  await handleFiles([{ name: SAMPLE_FILE, arrayBuffer: async () => buf }]);
}

/* ---------------- rendering ---------------- */

function areaText(m2) {
  const f = formatArea(m2, numberLocale());
  return { main: `${f.m2} ${t('m2')}`, sub: `${f.donum} ${t('donum')}` };
}

function renderList() {
  const has = parcels.size > 0;
  $('#emptyState').hidden = has;
  $('#parcelsCard').hidden = !has;
  $('#mapToolbar').hidden = !selectedId;
  const ul = $('#parcelList');
  ul.innerHTML = '';
  for (const p of parcels.values()) {
    const li = document.createElement('li');
    li.className = `parcel-item${p.id === selectedId ? ' active' : ''}`;
    const place = [p.attrs.mahalle, p.attrs.ilce, p.attrs.il].filter(Boolean).join(' · ') || p.sourceFile;
    li.innerHTML = `
      <button class="swatch" style="background:${esc(p.color)}" title="${esc(t('color'))}"></button>
      <div class="meta"><strong dir="auto">${esc(p.label)}</strong><small dir="auto">${esc(place)}</small></div>
      <span class="area">${esc(areaText(p.computedArea).main)}</span>`;
    li.addEventListener('click', () => select(p.id, true));
    li.querySelector('.swatch').addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = PARCEL_COLORS.indexOf(p.color);
      p.color = PARCEL_COLORS[(i + 1) % PARCEL_COLORS.length];
      layer.add(p);
      renderList();
      persist();
    });
    ul.append(li);
  }
}

function renderDetails() {
  const p = parcels.get(selectedId);
  $('#detailsCard').hidden = !p;
  $('#mapToolbar').hidden = !p;
  if (!p) return;

  $('#detailsTitle').textContent = p.attrs.ada && p.attrs.parsel ? `Ada ${p.attrs.ada} / Parsel ${p.attrs.parsel}` : p.label;
  $('#detailsSource').textContent = p.sourceFile;
  $('#detailsNote').hidden = p.sourceFile !== SAMPLE_FILE;
  $('#detailsNote').textContent = t('sampleNote');

  const computed = areaText(p.computedArea);
  const corners = p.polygons.reduce((n, poly) => n + poly[0].length, 0);
  let stats = `
    <div class="stat"><span>${esc(t('computedArea'))}</span><b>${esc(computed.main)}</b><small>${esc(computed.sub)}</small></div>`;
  if (Number.isFinite(p.declaredArea)) {
    const declared = areaText(p.declaredArea);
    const diff = ((p.computedArea - p.declaredArea) / p.declaredArea) * 100;
    stats += `<div class="stat"><span>${esc(t('alan'))}</span><b>${esc(declared.main)}</b><small>${esc(t('declaredVsComputed'))}: ${diff >= 0 ? '+' : ''}${esc(nf(diff, 1))}%</small></div>`;
  } else {
    stats += `<div class="stat"><span>${esc(t('corners'))}</span><b>${corners}</b></div>`;
  }
  stats += `<div class="stat"><span>${esc(t('perimeter'))}</span><b>${esc(nf(p.perimeter))} ${esc(t('m'))}</b></div>
    <div class="stat"><span>${esc(t('center'))}</span><b style="font-size:13px">${p.centroid[1].toFixed(6)}, ${p.centroid[0].toFixed(6)}</b></div>`;
  $('#detailsStats').innerHTML = stats;

  const keys = ['il', 'ilce', 'mahalle', 'ada', 'parsel', 'nitelik', 'mevkii', 'pafta'];
  $('#detailsAttrs').innerHTML = keys
    .filter((k) => p.attrs[k])
    .map((k) => `<dt>${esc(t(k))}</dt><dd dir="auto">${esc(p.attrs[k])}</dd>`)
    .join('');

  $('#cornerList').textContent = p.polygons
    .flatMap((poly) => poly[0])
    .map(([lon, lat], i) => `${String(i + 1).padStart(2, ' ')}  ${lat.toFixed(7)}, ${lon.toFixed(7)}`)
    .join('\n');
  $('#gmapsLink').href = `https://www.google.com/maps?q=${p.centroid[1].toFixed(7)},${p.centroid[0].toFixed(7)}&t=k`;
}

/* ---------------- search ---------------- */

const COORD_RE = /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/;

async function runSearch(q) {
  const box = $('#searchResults');
  const m = q.match(COORD_RE);
  if (m) {
    let [a, b] = [parseFloat(m[1].replace(',', '.')), parseFloat(m[2].replace(',', '.'))];
    // Accept both "lat, lon" and "lon, lat" for Turkey.
    if (a > 25 && a < 45.5 && b > 35 && b < 42.5) [a, b] = [b, a];
    box.hidden = true;
    layer.stopOrbit();
    sceneApi.viewer.camera.flyTo({ destination: sceneApi.Cesium.Cartesian3.fromDegrees(b, a, 900), duration: 2 });
    return;
  }
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=tr&accept-language=${getLang()},tr&q=${encodeURIComponent(q)}`;
  let results = [];
  try {
    results = await (await fetch(url)).json();
  } catch (err) {
    console.warn(err);
  }
  box.innerHTML = '';
  if (!results.length) {
    box.innerHTML = `<li>${esc(t('searchNoResults'))}</li>`;
  }
  for (const r of results) {
    const li = document.createElement('li');
    const [first, ...rest] = r.display_name.split(',');
    li.innerHTML = `${esc(first)}<small>${esc(rest.join(',').trim())}</small>`;
    li.addEventListener('click', () => {
      box.hidden = true;
      layer.stopOrbit();
      const [s, n, w, e] = r.boundingbox.map(Number);
      const { Cesium } = sceneApi;
      sceneApi.viewer.camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n), duration: 2.2 });
    });
    box.append(li);
  }
  box.hidden = false;
}

/* ---------------- UI wiring ---------------- */

function syncControls() {
  $('#basemapSelect').value = settings.basemap;
  $('#surroundingsToggle').checked = settings.surroundings;
  $('#radiusSelect').value = String(settings.radius);
  $('#fenceToggle').checked = settings.fence;
  $('#edgeToggle').checked = settings.edgeLabels;
  $('#shadowToggle').checked = settings.shadows;
  $('#viewModeSelect').value = sceneApi.mode;
  $('#photoHint').hidden = canUsePhoto();
}

function bindUI() {
  const fileInput = $('#fileInput');
  const openPicker = () => fileInput.click();
  $('#uploadBtn').addEventListener('click', openPicker);
  document.querySelectorAll('[data-action="upload"]').forEach((b) => b.addEventListener('click', openPicker));
  fileInput.addEventListener('change', () => {
    handleFiles([...fileInput.files]);
    fileInput.value = '';
  });
  $('#sampleBtn').addEventListener('click', loadSample);

  // drag & drop anywhere
  let depth = 0;
  const dz = $('#dropzone');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    dz.hidden = false;
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dz.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    handleFiles([...e.dataTransfer.files]);
  });

  // search
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (q) runSearch(q);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#searchForm')) $('#searchResults').hidden = true;
  });

  // layers
  $('#basemapSelect').addEventListener('change', (e) => {
    settings.basemap = e.target.value;
    sceneApi.setBasemap(settings.basemap);
  });
  $('#surroundingsToggle').addEventListener('change', (e) => {
    settings.surroundings = e.target.checked;
    surroundings.visible = e.target.checked && sceneApi.mode === 'osm';
    const p = parcels.get(selectedId);
    if (e.target.checked && p) loadSurroundings(p);
    else status(null);
  });
  $('#radiusSelect').addEventListener('change', (e) => {
    settings.radius = Number(e.target.value);
    const p = parcels.get(selectedId);
    if (p) loadSurroundings(p);
  });
  $('#fenceToggle').addEventListener('change', (e) => {
    settings.fence = e.target.checked;
    layer.setOptions({ fence: settings.fence });
  });
  $('#edgeToggle').addEventListener('change', (e) => {
    settings.edgeLabels = e.target.checked;
    layer.setOptions({ edgeLabels: settings.edgeLabels });
  });
  $('#shadowToggle').addEventListener('change', (e) => {
    settings.shadows = e.target.checked;
    sceneApi.setShadows(settings.shadows);
  });
  $('#viewModeSelect').addEventListener('change', async (e) => {
    if (e.target.value === 'photo' && !canUsePhoto()) {
      e.target.value = 'osm';
      $('#photoHint').hidden = false;
      openSettings();
      return;
    }
    settings.viewMode = e.target.value;
    await applyMode();
    syncControls();
  });

  // details actions
  $('#removeParcel').addEventListener('click', () => selectedId && removeParcel(selectedId));
  $('#clearAllBtn').addEventListener('click', () => {
    if (!confirm(t('confirmClear'))) return;
    for (const id of [...parcels.keys()]) removeParcel(id);
  });
  $('#copyCoords').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#cornerList').textContent);
      toast(t('copied'));
    } catch {
      /* clipboard blocked */
    }
  });

  // map toolbar
  $('#tool3d').addEventListener('click', () => parcels.get(selectedId) && layer.flyTo(parcels.get(selectedId), '3d'));
  $('#toolTop').addEventListener('click', () => parcels.get(selectedId) && layer.flyTo(parcels.get(selectedId), 'top'));
  $('#toolOrbit').addEventListener('click', () => {
    const p = parcels.get(selectedId);
    if (!p) return;
    if (layer.orbiting) layer.stopOrbit();
    else layer.startOrbit(p);
  });

  // settings dialog
  $('#settingsBtn').addEventListener('click', openSettings);
  const dialog = $('#settingsDialog');
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return;
    const form = $('#settingsForm');
    const googleKey = form.googleKey.value.trim();
    const ionToken = form.ionToken.value.trim();
    const keysChanged = googleKey !== settings.googleKey || ionToken !== settings.ionToken;
    settings.googleKey = googleKey;
    settings.ionToken = ionToken;
    settings.quality = form.quality.value;
    sceneApi.setQuality(settings.quality);
    if (form.lang.value !== getLang()) changeLang(form.lang.value);
    if (keysChanged) {
      sceneApi.disposePhoto();
      // A freshly added key means the user wants the photorealistic view.
      if (canUsePhoto()) settings.viewMode = 'auto';
      await applyMode();
    }
    syncControls();
    toast(t('settingsSaved'));
  });

  // mobile panel
  $('#panelToggle').addEventListener('click', () => $('#panel').classList.toggle('open'));
}

function openSettings() {
  const form = $('#settingsForm');
  form.lang.innerHTML = Object.entries(LANGS)
    .map(([k, v]) => `<option value="${k}"${k === getLang() ? ' selected' : ''}>${v}</option>`)
    .join('');
  form.googleKey.value = settings.googleKey;
  form.ionToken.value = settings.ionToken;
  form.quality.value = settings.quality;
  $('#settingsDialog').showModal();
}

function changeLang(l) {
  settings.lang = l;
  setLang(l);
  syncControls();
  renderList();
  renderDetails();
  if (layer.orbiting) $('#orbitLabel').textContent = t('stopOrbit');
}

/* ---------------- boot ---------------- */

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    const list = saved.map(deserializeParcel).filter(Boolean);
    if (!list.length) return false;
    for (const p of list) {
      parcels.set(p.id, p);
      layer.add(p);
    }
    renderList();
    const last = list[list.length - 1];
    select(last.id, true);
    return true;
  } catch (err) {
    console.warn('restore failed', err);
    return false;
  }
}

bindUI();
syncControls();
await applyMode();
syncControls();
const restored = restore();
if (!restored && IS_MOBILE) $('#panel').classList.add('open');

// Allow deep links like ?sample=1 to open the demo parcel directly.
if (!restored && new URLSearchParams(location.search).has('sample')) loadSample();
