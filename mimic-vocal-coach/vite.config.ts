import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { pwaPrecache } from './scripts/pwa-plugin.ts';

// `vite build --mode single` produces one self-contained index.html (all JS/CSS inlined),
// handy for sharing the app as a single file. The default build is a normal multi-file site
// suitable for GitHub Pages; `base: './'` keeps asset paths relative so it works from a subpath.
// The default build also writes dist/sw.js (offline precache); the single-file build has no service worker.
//
// Vocal isolation (src/audio/separation) runs onnxruntime-web in a module worker. The worker, the runtime's .wasm and its loader are
// emitted as same-origin hashed files under assets/ (nothing comes from a CDN); the pwa plugin keeps them out of the offline precache
// so an install stays small. The single-file build cannot carry a worker file or a .wasm, so `__MIMIC_SINGLE_FILE__` is true there and
// the feature reports itself unavailable instead of loading them.
/**
 * The single-file build has no room for the separation worker, the runtime's .wasm or the 20 MB model: link a stub where the worker is
 * created (so none of it is bundled or emitted) and leave public/models out of the output. client.ts reports "unavailable" there.
 */
function singleFileWithoutSeparation(): Plugin {
  let outDir = '';
  let stub = '';
  return {
    name: 'mimic-single-file-without-separation',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      stub = resolve(config.root, 'src/audio/separation/workerFactory.single.ts');
    },
    resolveId(source, importer) {
      if (source === './workerFactory' && importer && /audio[\\/]separation[\\/]client\.ts$/.test(importer)) {
        return stub;
      }
      return null;
    },
    closeBundle() {
      rmSync(join(outDir, 'models'), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  define: { __MIMIC_SINGLE_FILE__: JSON.stringify(mode === 'single') },
  // The runtime loads its own .wasm and loader at run time; pre-bundling it for the dev server would break those paths.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  plugins: mode === 'single' ? [singleFileWithoutSeparation(), react(), viteSingleFile()] : [react(), pwaPrecache()],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
  },
  worker: { format: 'es' },
}));
