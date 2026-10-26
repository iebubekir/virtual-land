import { SITE, whatsappLink } from './config.js';

/** Fills contact links, delivery time and year from config on any public page. */
export function applySiteConfig(waText = 'Merhaba, arsa tanıtım videosu hakkında bilgi almak istiyorum.') {
  document.querySelectorAll('[data-delivery]').forEach((el) => (el.textContent = SITE.deliveryText));
  document.querySelectorAll('[data-year]').forEach((el) => (el.textContent = new Date().getFullYear()));
  const wa = whatsappLink(waText);
  document.querySelectorAll('[data-wa]').forEach((a) => {
    if (!wa) return;
    a.href = wa;
    a.target = '_blank';
    a.rel = 'noopener';
    a.hidden = false;
  });
  document.querySelectorAll('[data-wa-item]').forEach((li) => (li.hidden = !wa));
  document.querySelectorAll('[data-mail]').forEach((a) => {
    if (!SITE.email) return;
    a.href = `mailto:${SITE.email}`;
    a.textContent = SITE.email;
  });
  document.querySelectorAll('[data-mail-item]').forEach((li) => (li.hidden = !SITE.email));
}

/** Esri World Imagery for Leaflet. Above zoom 17 rural Turkey often has no imagery, so tiles are upscaled instead. */
export const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_LABELS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
export const ESRI_ATTRIBUTION = 'Görüntü © Esri, Maxar, Earthstar Geographics';
