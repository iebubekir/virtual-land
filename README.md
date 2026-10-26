# Virtual Land

TKGM’den (Parsel Sorgu) alınan **KML / KMZ / GeoJSON** dosyalarını 3B dünya üzerinde gösteren web sitesi. Parsel sınırları haritaya çizilir, arsanın çevresindeki **evler ve ağaçlar 3B** olarak oluşturulur.

## Özellikler

- 🌍 CesiumJS ile 3B dünya, uydu görüntüsü (Esri) ve sokak haritası (OpenStreetMap)
- 📄 KML, KMZ ve GeoJSON yükleme (sürükle-bırak veya düğme), birden çok parsel
- 🧾 TKGM bilgilerini okur: İl, İlçe, Mahalle, Ada, Parsel, Alan, Nitelik, Mevkii, Pafta
- 📐 Hesaplanan alan (m² ve dönüm), tapu alanıyla fark, çevre, kenar uzunlukları, köşe koordinatları
- 🧱 Sınırda 3B çit, köşe numaraları, döndürme / üstten / 3B bakış
- 🏠🌳 Arsa çevresinde 3B binalar (kiremit çatılı evler) ve ağaçlar — OpenStreetMap verisinden (ücretsiz, anahtar gerekmez)
- 📸 **Fotogerçekçi mod:** Google Photorealistic 3D Tiles ile gerçek evler ve gerçek ağaçlar (Google Maps veya Cesium ion anahtarı gerekir)
- ⛰️ Cesium ion jetonu girilirse dünya arazisi (dağlar, vadiler)
- 🔎 Yer arama (Nominatim) veya koordinat ile gitme
- 💾 Yüklenen parseller tarayıcıda saklanır
- 🇹🇷 Türkçe arayüz (Ayarlar’dan Arapça da seçilebilir), mobil uyumlu

## TKGM’den KML nasıl alınır?

1. <https://parselsorgu.tkgm.gov.tr/> adresini açın
2. İl, ilçe, mahalle ve Ada / Parsel numarasını seçin
3. Paylaş / indir düğmesinden **KML**’i seçin
4. Dosyayı siteye sürükleyin veya «KML yükle»ye basın

## Gerçek ev ve ağaçlar (fotogerçekçi mod)

Sitede **Ayarlar** (⚙️) bölümüne şunlardan birini girin:

- **Google Maps API anahtarı** — Google Cloud’da *Map Tiles API*’yi etkinleştirip anahtar oluşturun ([rehber](https://developers.google.com/maps/documentation/tile/get-api-key)). Anahtarı site adresinize (HTTP referrer) kısıtlayın.
- **Cesium ion jetonu** — <https://ion.cesium.com/tokens> (ücretsiz hesap). Arazi ve fotogerçekçi modeli birlikte açar.

Anahtarlar sadece tarayıcınızda (localStorage) saklanır. Siteyi yayınlarken herkes için açmak isterseniz GitHub deposunda **Settings → Secrets and variables → Actions** altına `GOOGLE_MAPS_API_KEY` veya `CESIUM_ION_TOKEN` ekleyin; derleme bunları otomatik kullanır.

## Geliştirme

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # birim testleri
npm run build    # dist/ klasörüne derler
```

`main` dalına her gönderimde GitHub Actions siteyi GitHub Pages’e yayınlar.

## Kod yapısı

| Dosya | Görev |
|---|---|
| `src/lib/parcels.js` | KML/KMZ/GeoJSON okuma, TKGM alanlarını eşleme |
| `src/lib/geo.js` | Alan, çevre, kenar uzunluğu hesapları |
| `src/lib/osm.js` | OpenStreetMap’ten bina ve ağaç verisi (Overpass) |
| `src/scene/viewer.js` | Cesium görüntüleyici, altlık haritalar, fotogerçekçi mod, arazi |
| `src/scene/parcelLayer.js` | Parsel çizimi, çit, etiketler, kamera |
| `src/scene/surroundings.js` | 3B binalar ve ağaçlar |
| `src/app.js` | Arayüz |
| `src/i18n.js` | Türkçe / Arapça metinler |

Harita verileri: © OpenStreetMap katkıcıları, Esri, Google. `public/samples/ornek-parsel.kml` temsili bir örnektir, gerçek tapu kaydı değildir.
