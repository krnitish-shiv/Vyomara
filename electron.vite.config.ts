import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const developmentContentSecurityPolicy: Plugin = {
  name: 'vyomara-development-csp',
  transformIndexHtml: {
    order: 'pre',
    handler(html, context) {
      return context.server
        ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        : html;
    },
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react(), developmentContentSecurityPolicy],
  },
});
