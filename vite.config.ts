import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Deploy base. Default '/' (Cloudflare Pages / custom domain at the root).
// GitHub Pages project sites live at a sub-path, so CI sets VITE_BASE=/offbook/.
// See PLAN.md §0.0 A7 — switching hosts is this env var, not a refactor.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        id: base,
        name: 'Offbook — learn lines, lyrics and speeches by heart',
        short_name: 'Offbook',
        description:
          'Learn any text by heart by progressively hiding it. Works offline, no account, no limits.',
        start_url: `${base}?src=pwa`,
        scope: base,
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        background_color: '#121417',
        theme_color: '#121417',
        categories: ['education', 'productivity'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,txt}'],
        globIgnores: ['**/pdf.worker*.js', '**/pdfjs-*.js'],
        navigateFallback: `${base}index.html`,
        navigateFallbackDenylist: [/^\/_/],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
        maximumFileSizeToCacheInBytes: 3_000_000,
        runtimeCaching: [
          {
            // The pdf.js chunk is kept out of precache so a first install stays small,
            // but becomes available offline after one use. Named trade-off: a user's
            // *first ever* PDF import must be online.
            urlPattern: ({ url, request }) =>
              url.origin === self.location.origin &&
              url.pathname.includes('/assets/') &&
              request.destination === 'script',
            handler: 'CacheFirst',
            options: { cacheName: 'lazy-chunks', expiration: { maxEntries: 30 } },
          },
        ],
      },
    }),
  ],
});
