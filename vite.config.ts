import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const isElectron = env.VITE_APP_TARGET === 'electron';
  const hmrHost = env.VITE_HMR_HOST ? env.VITE_HMR_HOST.trim() : '';
  // Solo desarrollo: permite apuntar a otro puerto si el 3000 esta ocupado por otra app de la PC.
  const apiTarget = (env.VITE_DEV_API_TARGET || 'http://localhost:3000').trim();
  return {
    base: isElectron ? './' : '/',
    server: {
      port: 5173,
      host: '0.0.0.0',
      strictPort: true,
      hmr: hmrHost ? { host: hmrHost } : undefined,
      watch: {
        ignored: ['**/backend/**', '**/.packaging/**', '**/release/**', '**/release-build/**', '**/backups/**', '**/dist/**'],
      },
      proxy: {
        // Dev: keep browser on :5173 and proxy API calls to backend (:3000)
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        // WebSockets (Socket.IO) for real-time updates in dev
        '/socket.io': {
          target: apiTarget,
          ws: true,
          changeOrigin: true,
        },
        // Serve uploaded proofs through the same origin in dev
        '/uploads': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    plugins: [
      react(),
      VitePWA({
        // La activación se ofrece al usuario: una recarga automática perdería borradores o archivos sin enviar.
        registerType: 'prompt',
        injectRegister: null,
        includeAssets: ['favicon.png', 'icons/icon-192.png', 'icons/icon-512.png'],
        manifest: {
          name: "BankApi — Verificación de Cobranzas",
          short_name: "BankApi",
          description: "Plataforma empresarial de verificación de cobranzas y transferencias bancarias",
          theme_color: "#0f172a",
          background_color: "#0f172a",
          display: "standalone",
          orientation: "portrait-primary",
          icons: [
              {
                  src: "/icons/icon-192.png",
                  sizes: "192x192",
                  type: "image/png",
                  purpose: "any maskable"
              },
              {
                  src: "/icons/icon-512.png",
                  sizes: "512x512",
                  type: "image/png",
                  purpose: "any maskable"
              }
          ],
          categories: ["business", "finance"],
          lang: "es-PY"
        },
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/, /^\/uploads/],
          globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        }
      })
    ],
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'axios',
        'lucide-react',
        'socket.io-client'
      ],
      force: false, // Only rebuild cache when dependencies change
    },
    cacheDir: '.vite_cache',
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            vendor: ['axios', 'socket.io-client', 'lucide-react'],
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
