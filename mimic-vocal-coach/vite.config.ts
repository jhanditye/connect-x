import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode single` produces one self-contained index.html (all JS/CSS inlined),
// handy for sharing the app as a single file. The default build is a normal multi-file site
// suitable for GitHub Pages; `base: './'` keeps asset paths relative so it works from a subpath.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  worker: { format: 'es' },
}));
