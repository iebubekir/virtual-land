import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const cesiumSource = 'node_modules/cesium/Build/Cesium';
// Cesium loads its workers and assets at runtime from this folder.
const cesiumBaseUrl = 'cesium';

export default defineConfig({
  // Relative base so the build works on GitHub Pages (/virtual-land/) or any sub-path.
  base: './',
  // CESIUM_BASE_URL is set at runtime in src/main.js.
  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl, rename: { stripBase: 4 } },
      ],
    }),
  ],
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      input: {
        home: resolve(root, 'index.html'),
        harita: resolve(root, 'harita/index.html'),
        siparis: resolve(root, 'siparis/index.html'),
        kvkk: resolve(root, 'kvkk/index.html'),
      },
    },
  },
});
