import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// VITE_BASE: the folder the app is served from, e.g. /head-tremor/ on GitHub Pages (default: the site root)
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Head Tremor Monitor',
        short_name: 'Tremor',
        description: 'Prototype head-tremor self-tracking. Not a medical device.',
        theme_color: '#F2F1EE',
        background_color: '#F2F1EE',
        display: 'standalone',
        orientation: 'portrait',
        id: base,
        start_url: base,
        scope: base,
        categories: ['health', 'medical'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2,gz}'] },
    }),
  ],
  build: {
    target: 'es2022',
    // no manual chunks: three.js and React Three Fiber stay in the lazily loaded 3D chunk
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
