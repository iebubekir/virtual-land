import 'leaflet/dist/leaflet.css';
import './site.css';
import './order.css';
import L from 'leaflet';
import JSZip from 'jszip';
import { parseParcelFile } from '../lib/parcels.js';
import { formatArea } from '../lib/geo.js';
import { SITE, PACKAGES, EXTRAS, NEARBY, VOICES, formatPrice, whatsappLink } from './config.js';
import { applySiteConfig, ESRI_TILES, ESRI_LABELS, ESRI_ATTRIBUTION } from './common.js';

applySiteConfig();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const form = $('#orderForm');
const DRAFT_KEY = 'vl.orderDraft.v1';

const state = {
  step: 1,
  mode: 'kml',
  parcels: [], // from KML
  kmlFile: null,
  pin: null, // [lat, lon] when entered manually
  packageId: new URLSearchParams(location.search).get('paket') || PACKAGES.find((p) => p.highlighted)?.id || PACKAGES[0].id,
  extras: new Set(),
  nearby: new Set(['Şehir merkezi', 'Otoyol / ana yol']),
  voice: VOICES[0].id,
  logoFile: null,
};
if (!PACKAGES.some((p) => p.id === state.packageId)) state.packageId = PACKAGES[0].id;

/* ---------------- map ---------------- */
const map = L.map('orderMap', { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([39.2, 35.2], 5);
map.attributionControl.setPrefix(false);
L.tileLayer(ESRI_TILES, { maxNativeZoom: 17, maxZoom: 19, attribution: ESRI_ATTRIBUTION }).addTo(map);
L.tileLayer(ESRI_LABELS, { maxNativeZoom: 17, maxZoom: 19, opacity: 0.85 }).addTo(map);
const parcelLayer = L.featureGroup().addTo(map);
let pinMarker = null;

function drawParcels() {
  parcelLayer.clearLayers();
  for (const p of state.parcels) {
    for (const rings of p.polygons) {
      L.polygon(
        rings.map((r) => r.map(([lon, lat]) => [lat, lon])),
        { color: '#f4c430', weight: 3, fillOpacity: 0.25 },
      ).addTo(parcelLayer);
    }
  }
  if (state.parcels.length) map.fitBounds(parcelLayer.getBounds(), { padding: [30, 30], maxZoom: 18 });
  updateMapEmpty();
}

function updateMapEmpty() {
  const has = state.parcels.length || state.pin;
  const el = $('#mapEmpty');
  el.hidden = Boolean(has) && state.mode === 'kml';
  el.textContent =
    state.mode === 'manual'
      ? state.pin
        ? 'Konum işaretlendi. Değiştirmek için haritaya tıklayın.'
        : 'Arsanın yerini işaretlemek için haritaya tıklayın'
      : 'Arsanız burada görünecek';
  el.hidden = state.mode === 'kml' ? Boolean(state.parcels.length) : false;
}

map.on('click', (e) => {
  if (state.mode !== 'manual') return;
  state.pin = [e.latlng.lat, e.latlng.lng];
  if (!pinMarker) pinMarker = L.marker(e.latlng, { icon: L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [18, 18] }) }).addTo(map);
  else pinMarker.setLatLng(e.latlng);
  updateMapEmpty();
  renderSummary();
  saveDraft();
});

/* ---------------- step 1: land ---------------- */
document.querySelectorAll('.seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('.seg-btn').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('[data-mode-panel]').forEach((p) => (p.hidden = p.dataset.modePanel !== state.mode));
    if (state.mode === 'manual' && !state.pin) map.setView([39.2, 35.2], 6);
    updateMapEmpty();
    renderSummary();
    saveDraft();
  }),
);

const drop = $('#kmlDrop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) loadKml(e.dataTransfer.files[0]);
});
$('#kmlInput').addEventListener('change', (e) => e.target.files[0] && loadKml(e.target.files[0]));

const ERRORS = {
  PROJECTED_COORDINATES: 'Dosyadaki koordinatlar enlem/boylam değil. TKGM Parsel Sorgu’dan KML olarak indirip tekrar deneyin.',
  NO_KML_IN_KMZ: 'KMZ dosyasının içinde KML bulunamadı.',
  UNSUPPORTED_FILE: 'Bu dosya biçimi okunamadı. KML, KMZ veya GeoJSON yükleyin.',
};

async function loadKml(file) {
  showError('');
  try {
    const parcels = await parseParcelFile(file, { DOMParser, JSZip });
    if (!parcels.length) throw Object.assign(new Error('empty'), { code: 'EMPTY' });
    state.parcels = parcels;
    state.kmlFile = file;
    renderParcelFound();
    drawParcels();
    renderSummary();
    saveDraft();
  } catch (err) {
    console.warn(err);
    showError(ERRORS[err.code] || `“${file.name}” içinde parsel sınırı bulunamadı. TKGM’den indirdiğiniz KML dosyasını yükleyin.`);
  }
}

const markSvg = '<svg viewBox="0 0 40 40"><path d="M10 27 17 11l14 5 -2 13 -12 3z" fill="#f4c430" fill-opacity=".3" stroke="#f4c430" stroke-width="3" stroke-linejoin="round"/></svg>';

function renderParcelFound() {
  const box = $('#parcelFound');
  box.hidden = !state.parcels.length;
  $('#kmlDrop').hidden = Boolean(state.parcels.length);
  box.innerHTML = state.parcels
    .map((p, i) => {
      const a = p.attrs;
      const title = a.ada && a.parsel ? `Ada ${a.ada} / Parsel ${a.parsel}` : p.label;
      const place = [a.mahalle, a.ilce, a.il].filter(Boolean).join(', ') || state.kmlFile?.name || '';
      const area = Number.isFinite(p.declaredArea) ? p.declaredArea : p.computedArea;
      return `<div class="pf"><span class="pf-mark">${markSvg}</span><div><b>${esc(title)}</b><small>${esc(place)}</small></div>
        <span class="pf-area">${esc(formatArea(area).m2)} m²</span>${i === 0 ? '<button type="button" class="pf-remove" id="pfRemove">Değiştir</button>' : ''}</div>`;
    })
    .join('');
  $('#pfRemove')?.addEventListener('click', () => {
    state.parcels = [];
    state.kmlFile = null;
    $('#kmlInput').value = '';
    renderParcelFound();
    drawParcels();
    renderSummary();
  });
}

/* ---------------- step 2: package ---------------- */
function renderPackages() {
  $('#packageList').innerHTML = PACKAGES.map(
    (p) => `<label class="choice">
      <input type="radio" name="package" value="${esc(p.id)}" ${p.id === state.packageId ? 'checked' : ''} />
      <b>${esc(p.name)}</b>
      <span class="price">${esc(formatPrice(p.price))}</span>
      <p>${esc(p.summary)}</p>
      <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    </label>`,
  ).join('');
  renderExtras();
}

function renderExtras() {
  const list = EXTRAS.filter((x) => !x.notIn?.includes(state.packageId));
  for (const id of [...state.extras]) if (!list.some((x) => x.id === id)) state.extras.delete(id);
  $('#extraList').innerHTML = list
    .map(
      (x) => `<label class="check"><input type="checkbox" name="extra" value="${esc(x.id)}" ${state.extras.has(x.id) ? 'checked' : ''} />
      <span>${esc(x.name)}</span><span class="price">+${esc(formatPrice(x.price))}</span></label>`,
    )
    .join('');
}

$('#packageList').addEventListener('change', (e) => {
  if (e.target.name !== 'package') return;
  state.packageId = e.target.value;
  renderExtras();
  renderSummary();
  saveDraft();
});
$('#extraList').addEventListener('change', (e) => {
  if (e.target.name !== 'extra') return;
  e.target.checked ? state.extras.add(e.target.value) : state.extras.delete(e.target.value);
  renderSummary();
  saveDraft();
});

/* ---------------- step 3: content ---------------- */
function renderChips() {
  $('#nearbyChips').innerHTML = NEARBY.map((n) => `<button type="button" class="chip" aria-pressed="${state.nearby.has(n)}" data-value="${esc(n)}">${esc(n)}</button>`).join('');
  $('#voiceList').innerHTML = VOICES.map((v) => `<label><input type="radio" name="voice" value="${esc(v.id)}" ${v.id === state.voice ? 'checked' : ''} />${esc(v.name)}</label>`).join('');
}
$('#nearbyChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const v = chip.dataset.value;
  state.nearby.has(v) ? state.nearby.delete(v) : state.nearby.add(v);
  chip.setAttribute('aria-pressed', String(state.nearby.has(v)));
  saveDraft();
});
$('#voiceList').addEventListener('change', (e) => {
  state.voice = e.target.value;
  saveDraft();
});
$('#logoInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    showError('Logo dosyası 8 MB’tan küçük olmalı.');
    return;
  }
  state.logoFile = file;
  const img = $('#logoPreview');
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  $('#logoText').hidden = true;
});

/* ---------------- summary ---------------- */
const total = () => {
  const pkg = PACKAGES.find((p) => p.id === state.packageId);
  return pkg.price + EXTRAS.filter((x) => state.extras.has(x.id)).reduce((s, x) => s + x.price, 0);
};

function landSummary() {
  if (state.mode === 'kml' && state.parcels.length) {
    const p = state.parcels[0];
    const a = p.attrs;
    const title = a.ada && a.parsel ? `${a.ada} / ${a.parsel}` : p.label;
    return state.parcels.length > 1 ? `${title} +${state.parcels.length - 1}` : title;
  }
  const v = (n) => form.elements[n].value.trim();
  if (state.mode === 'manual' && v('ada') && v('parsel')) return `${v('ada')} / ${v('parsel')}`;
  return '—';
}

function renderSummary() {
  const pkg = PACKAGES.find((p) => p.id === state.packageId);
  const rows = [
    ['Ada / Parsel', landSummary()],
    ['Paket', pkg.name],
    ...EXTRAS.filter((x) => state.extras.has(x.id)).map((x) => [x.name, `+${formatPrice(x.price)}`]),
    ['Teslim', state.extras.has('acil') ? 'Aynı gün' : SITE.deliveryText],
  ];
  $('#sumList').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#sumTotal').textContent = formatPrice(total());
}
form.addEventListener('input', (e) => {
  e.target.closest('.field')?.classList.remove('invalid');
  if (['ada', 'parsel'].includes(e.target.name)) renderSummary();
  saveDraft();
});

/* ---------------- steps & validation ---------------- */
function showError(msg) {
  const el = $('#formError');
  el.textContent = msg;
  el.hidden = !msg;
}

function invalid(names) {
  let first = null;
  for (const n of names) {
    const el = form.elements[n];
    const bad = el.type === 'checkbox' ? !el.checked : !el.value.trim() || (el.type === 'email' && el.value && !el.checkValidity());
    el.closest('.field')?.classList.toggle('invalid', bad);
    if (bad && !first) first = el;
  }
  return first;
}

const phoneOk = (v) => v.replace(/\D/g, '').replace(/^90/, '').replace(/^0/, '').length === 10;

function validate(step) {
  if (step === 1) {
    if (state.mode === 'kml') return state.parcels.length ? '' : 'KML dosyanızı yükleyin ya da “Ada / Parsel numarası” sekmesinden bilgileri yazın.';
    const bad = invalid(['il', 'ilce', 'ada', 'parsel']);
    if (bad) {
      bad.focus();
      return 'İl, ilçe, Ada ve Parsel bilgilerini doldurun.';
    }
  }
  if (step === 4) {
    const bad = invalid(['name', 'phone']);
    if (bad) {
      bad.focus();
      return 'Ad soyad ve telefon numaranızı yazın.';
    }
    if (!phoneOk(form.elements.phone.value)) {
      form.elements.phone.closest('.field').classList.add('invalid');
      form.elements.phone.focus();
      return 'Telefon numarasını 05xx xxx xx xx biçiminde yazın.';
    }
    if (form.elements.email.value && !form.elements.email.checkValidity()) return 'E-posta adresini kontrol edin.';
    if (!form.elements.kvkk.checked) return 'Devam etmek için KVKK aydınlatma metnini onaylayın.';
  }
  return '';
}

function goTo(step) {
  state.step = step;
  document.querySelectorAll('.step').forEach((s) => (s.hidden = Number(s.dataset.step) !== step));
  document.querySelectorAll('.progress li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('current', n === step);
    li.classList.toggle('done', n < step);
  });
  $('#backBtn').hidden = step === 1;
  $('#nextBtn').textContent = step === 4 ? 'Siparişi tamamla' : 'Devam';
  showError('');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => map.invalidateSize(), 50);
}

$('#backBtn').addEventListener('click', () => goTo(state.step - 1));
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const err = validate(state.step);
  if (err) {
    showError(err);
    return;
  }
  if (state.step < 4) goTo(state.step + 1);
  else finish();
});

/* ---------------- finish ---------------- */
function orderCode() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => 'ABCDEFGHJKLMNPRSTUVYZ23456789'[b % 29]).join('');
  return `VL-${ymd}-${rnd}`;
}

function buildOrder(code) {
  const v = (n) => form.elements[n]?.value.trim() || '';
  const pkg = PACKAGES.find((p) => p.id === state.packageId);
  const lines = [`*Yeni sipariş: ${code}*`, ''];
  lines.push('*Arsa*');
  if (state.mode === 'kml' && state.parcels.length) {
    for (const p of state.parcels) {
      const a = p.attrs;
      lines.push(
        `• ${a.ada && a.parsel ? `Ada ${a.ada} / Parsel ${a.parsel}` : p.label}` +
          `${[a.mahalle, a.ilce, a.il].filter(Boolean).length ? ` (${[a.mahalle, a.ilce, a.il].filter(Boolean).join(', ')})` : ''}`,
      );
      lines.push(`  Alan: ${formatArea(Number.isFinite(p.declaredArea) ? p.declaredArea : p.computedArea).m2} m²${a.nitelik ? `, ${a.nitelik}` : ''}`);
      lines.push(`  Konum: https://www.google.com/maps?q=${p.centroid[1].toFixed(6)},${p.centroid[0].toFixed(6)}`);
    }
    lines.push(`  KML dosyası: ${state.kmlFile?.name || ''} (sohbete eklenecek)`);
  } else {
    lines.push(`• ${v('il')} / ${v('ilce')}${v('mahalle') ? ` / ${v('mahalle')}` : ''}`);
    lines.push(`  Ada ${v('ada')} / Parsel ${v('parsel')}`);
    if (state.pin) lines.push(`  İşaretlenen konum: https://www.google.com/maps?q=${state.pin[0].toFixed(6)},${state.pin[1].toFixed(6)}`);
  }
  lines.push('', '*Paket*', `• ${pkg.name}: ${formatPrice(pkg.price)}`);
  for (const x of EXTRAS.filter((e) => state.extras.has(e.id))) lines.push(`• ${x.name}: +${formatPrice(x.price)}`);
  lines.push(`Toplam: ${formatPrice(total())}`);
  lines.push('', '*Video içeriği*');
  if (state.nearby.size) lines.push(`Yakın yerler: ${[...state.nearby].join(', ')}`);
  if (v('nearbyExtra')) lines.push(`Diğer yerler: ${v('nearbyExtra')}`);
  lines.push(`Ses: ${VOICES.find((x) => x.id === state.voice)?.name}`);
  const sign = [
    ['Ofis', v('office')],
    ['Danışman', v('agent')],
    ['Videodaki telefon', v('videoPhone')],
    ['Web / Instagram', v('web')],
    ['Satış fiyatı', v('askingPrice')],
  ].filter(([, x]) => x);
  sign.forEach(([k, x]) => lines.push(`${k}: ${x}`));
  if (state.logoFile) lines.push(`Logo: ${state.logoFile.name} (sohbete eklenecek)`);
  if (v('notes')) lines.push(`Not: ${v('notes')}`);
  lines.push('', '*Müşteri*', `${v('name')}`, `${v('phone')}${v('email') ? `, ${v('email')}` : ''}`);
  return lines.join('\n');
}

let lastOrder = null;

function finish() {
  const code = orderCode();
  const text = buildOrder(code);
  lastOrder = { code, text };
  $('#orderCode').textContent = code;
  $('#orderText').textContent = text.replace(/\*/g, '');
  const wa = whatsappLink(text);
  const waBtn = $('#waSend');
  waBtn.hidden = !wa;
  if (wa) waBtn.href = wa;
  $('#doneLead').textContent = wa
    ? 'WhatsApp’ta açılan mesajı gönderin; KML ve logo dosyanızı da aynı sohbete ekleyin. Onayladığımızda ödeme bilgilerini iletiyoruz.'
    : 'Sipariş metnini kopyalayıp bize iletin; KML ve logo dosyanızı da ekleyin.';
  $('#orderMain').hidden = true;
  $('#done').hidden = false;
  document.querySelectorAll('.progress li').forEach((li) => {
    li.classList.remove('current');
    li.classList.add('done');
  });
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
  window.scrollTo({ top: 0 });
  if (wa) window.open(wa, '_blank', 'noopener');
}

$('#copyBtn').addEventListener('click', async () => {
  if (!lastOrder) return;
  try {
    await navigator.clipboard.writeText(lastOrder.text);
    $('#copyBtn').textContent = 'Kopyalandı';
  } catch {
    window.prompt('', lastOrder.text);
  }
});

$('#filesBtn').addEventListener('click', async () => {
  if (!lastOrder) return;
  const zip = new JSZip();
  zip.file(`${lastOrder.code}.txt`, lastOrder.text.replace(/\*/g, ''));
  if (state.kmlFile) zip.file(state.kmlFile.name, state.kmlFile);
  if (state.logoFile) zip.file(`logo-${state.logoFile.name}`, state.logoFile);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${lastOrder.code}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

/* ---------------- draft (text fields and choices; files are not stored) ---------------- */
const DRAFT_FIELDS = ['il', 'ilce', 'mahalle', 'ada', 'parsel', 'nearbyExtra', 'office', 'agent', 'videoPhone', 'web', 'askingPrice', 'notes', 'name', 'phone', 'email'];

function saveDraft() {
  try {
    const data = Object.fromEntries(DRAFT_FIELDS.map((n) => [n, form.elements[n].value]));
    Object.assign(data, { mode: state.mode, pin: state.pin, packageId: state.packageId, extras: [...state.extras], nearby: [...state.nearby], voice: state.voice });
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  } catch {
    /* storage blocked */
  }
}

function loadDraft() {
  let d;
  try {
    d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    d = null;
  }
  if (!d) return;
  DRAFT_FIELDS.forEach((n) => d[n] && (form.elements[n].value = d[n]));
  if (!new URLSearchParams(location.search).get('paket') && PACKAGES.some((p) => p.id === d.packageId)) state.packageId = d.packageId;
  state.extras = new Set(d.extras || []);
  state.nearby = new Set(d.nearby || []);
  if (VOICES.some((v) => v.id === d.voice)) state.voice = d.voice;
  if (d.mode === 'manual') {
    document.querySelector('.seg-btn[data-mode="manual"]').click();
    if (d.pin) {
      map.setView(d.pin, 16);
      map.fire('click', { latlng: L.latLng(d.pin) });
    }
  }
}

/* ---------------- boot ---------------- */
loadDraft();
renderPackages();
renderChips();
renderSummary();
updateMapEmpty();
goTo(1);
window.vlOrder = { state, map };
