import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve('dist');
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

const sharedOptions = {
  bundle: true,
  sourcemap: false,
  target: ['chrome120', 'edge120'],
  logLevel: 'info',
};

await Promise.all([
  // MAIN world bridge (IIFE — content scripts cannot use ESM imports directly)
  esbuild.build({
    ...sharedOptions,
    entryPoints: ['src/content/main-world-bridge.ts'],
    outfile: 'dist/content/main-world-bridge.js',
    format: 'iife',
  }),
  // ISOLATED world overlay app (IIFE)
  esbuild.build({
    ...sharedOptions,
    entryPoints: ['src/content/overlay-app.ts'],
    outfile: 'dist/content/overlay-app.js',
    format: 'iife',
  }),
  // MV3 Service Worker (ESM)
  esbuild.build({
    ...sharedOptions,
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/background/service-worker.js',
    format: 'esm',
  }),
  // Popup script (IIFE)
  esbuild.build({
    ...sharedOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup/popup.js',
    format: 'iife',
  }),
]);

// Copy static assets
fs.copyFileSync('manifest.json', path.join(distDir, 'manifest.json'));
fs.cpSync('icons', path.join(distDir, 'icons'), { recursive: true });
fs.mkdirSync(path.join(distDir, 'popup'), { recursive: true });
fs.copyFileSync('src/popup/popup.html', path.join(distDir, 'popup/popup.html'));
fs.copyFileSync('src/popup/popup.css', path.join(distDir, 'popup/popup.css'));

console.log('Build complete -> dist/');
