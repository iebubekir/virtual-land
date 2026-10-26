import 'leaflet/dist/leaflet.css';
import './site.css';
import './landing.css';
import L from 'leaflet';
import { PACKAGES, formatPrice } from './config.js';
import { applySiteConfig, ESRI_TILES } from './common.js';

applySiteConfig();

/* ---------- packages from config ---------- */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

document.getElementById('packages').innerHTML = PACKAGES.map(
  (p) => `
  <article class="pkg${p.highlighted ? ' featured' : ''}">
    <div class="pkg-top">
      <h3>${esc(p.name)}</h3>
      ${p.highlighted ? '<span class="pkg-badge">En çok tercih edilen</span>' : ''}
    </div>
    <p class="pkg-summary">${esc(p.summary)}</p>
    <p class="pkg-price">${esc(formatPrice(p.price))}<small>/ video</small></p>
    ${p.oldPrice ? `<p class="pkg-old">${esc(formatPrice(p.oldPrice))}</p>` : ''}
    <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
    <a class="btn ${p.highlighted ? 'btn-ghost' : 'btn-dark'}" href="siparis/?paket=${encodeURIComponent(p.id)}">${esc(p.name)} sipariş et</a>
  </article>`,
).join('');

/* ---------- hero: a still from the "video" ---------- */
// The sample parcel shipped with the 3D tool (fictional, for illustration).
const PARCEL = [
  [40.37182, 28.884705],
  [40.371784, 28.88533],
  [40.372198, 28.885365],
  [40.37227, 28.884941],
  [40.372108, 28.884682],
];

const phone = document.querySelector('.phone');
const map = L.map('heroMap', {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  scrollWheelZoom: false,
  doubleClickZoom: false,
  boxZoom: false,
  keyboard: false,
  touchZoom: false,
  zoomSnap: 0,
});
L.tileLayer(ESRI_TILES, { maxNativeZoom: 17, maxZoom: 20, crossOrigin: true }).addTo(map);
const poly = L.polygon(PARCEL, {
  color: '#f4c430',
  weight: 3,
  fillColor: '#f4c430',
  className: 'hero-parcel',
}).addTo(map);
map.fitBounds(poly.getBounds(), { padding: [70, 70] });
map.setZoom(Math.min(map.getZoom(), 18.2));

// Normalise the path length so the CSS draw animation works for any shape.
poly.getElement()?.setAttribute('pathLength', '1000');

let started = false;
const start = () => {
  if (started) return;
  started = true;
  phone.classList.add('ready');
};
map.once('load', start);
map.eachLayer((l) => l.once?.('load', start));
setTimeout(start, 1600);
