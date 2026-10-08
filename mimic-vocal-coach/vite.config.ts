import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { pwaPrecache } from './scripts/pwa-plugin.ts';

// `vite build --mode single` produces one self-contained index.html (all JS/CSS inlined),
// handy for sharing the app as a single file. The default build is a normal multi-file site
// suitable for GitHub Pages; `base: './'` keeps asset paths relative so it works from a subpath.
// The default build also writes dist/sw.js (offline precache); the single-file build has no service worker.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react(), pwaPrecache()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  worker: { format: 'es' },
}));
