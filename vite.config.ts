import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Forward API, auth, and admin routes to the Express server (which holds
      // FAL_KEY, the session, and the SQLite DB).
      proxy: {
        '/api': {
          target: `http://localhost:${process.env.FAL_PROXY_PORT || 3001}`,
          changeOrigin: true,
        },
        '/auth': {
          target: `http://localhost:${process.env.FAL_PROXY_PORT || 3001}`,
          changeOrigin: true,
        },
        '/admin': {
          target: `http://localhost:${process.env.FAL_PROXY_PORT || 3001}`,
          changeOrigin: true,
        },
      },
    },
  };
});
