// ─────────────────────────────────────────────────────────────────────────────
// Business settings — edit this file to change prices, contact details and brand.
// ─────────────────────────────────────────────────────────────────────────────

export const SITE = {
  brand: 'Virtual Land',
  // WhatsApp number orders are sent to: country code + number, digits only (e.g. 905321234567).
  // Leave empty until set: the order page then offers "copy order text" instead.
  whatsapp: '',
  email: '',
  // Shown on the site; keep it true to how long you actually need.
  deliveryText: '24 saat içinde',
  currency: 'TL',
};

/** Packages offered. Prices are in TL. `features` are shown as a checklist. */
export const PACKAGES = [
  {
    id: 'harita',
    name: 'Harita Sunumu',
    price: 250,
    oldPrice: null,
    summary: 'Arsanızın uydu haritası üzerinde 3B tanıtım videosu.',
    features: [
      'Parsel sınırı, alan ve tapu bilgileri',
      'Yakın yerler ve ulaşım yolları',
      'Logonuz ve iletişim bilgileriniz',
      'Dikey 1080×1920 video (Reels, TikTok, Shorts)',
    ],
  },
  {
    id: 'sinematik',
    name: 'Sinematik',
    price: 600,
    oldPrice: null,
    highlighted: true,
    summary: 'Yapay zekâ ile iyileştirilmiş görüntüler ve sinematik kamera hareketleri.',
    features: [
      'Harita Sunumu’ndaki her şey',
      'Yapay zekâ ile netleştirilmiş arsa çevresi',
      'Sinematik yaklaşma ve 360° dönüş',
      'Seslendirme ve müzik',
    ],
  },
  {
    id: 'tam',
    name: 'Tam Paket',
    price: 950,
    oldPrice: null,
    summary: 'Tüm platformlar için video ve görsel seti.',
    features: [
      'Sinematik’teki her şey',
      'Dikey ve yatay (16:9) iki video',
      '3 adet sosyal medya görseli',
      '1 ücretsiz revizyon',
    ],
  },
];

/** Optional extras on the order page. */
export const EXTRAS = [
  { id: 'yatay', name: 'Ek yatay (16:9) video', price: 150, notIn: ['tam'] },
  { id: 'acil', name: 'Acil teslim (aynı gün)', price: 200 },
  { id: 'revizyon', name: 'Ek revizyon hakkı', price: 100 },
];

/** Nearby place types the customer can ask to be shown in the video. */
export const NEARBY = ['Şehir merkezi', 'Otoyol / ana yol', 'Okul', 'Hastane', 'Market', 'Deniz / göl', 'Havalimanı', 'Sanayi bölgesi', 'Turistik yer', 'Toplu taşıma'];

export const VOICES = [
  { id: 'kadin', name: 'Kadın seslendirme' },
  { id: 'erkek', name: 'Erkek seslendirme' },
  { id: 'muzik', name: 'Sadece müzik' },
];

export const formatPrice = (v) => `${new Intl.NumberFormat('tr-TR').format(v)} ${SITE.currency}`;

export const whatsappLink = (text) => (SITE.whatsapp ? `https://wa.me/${SITE.whatsapp}?text=${encodeURIComponent(text)}` : '');
