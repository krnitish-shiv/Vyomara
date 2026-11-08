// Make sure Electron's app is downloaded. Newer pnpm versions do not run
// dependency install scripts by default (and may restore electron from a cache
// without its binary), so a fresh clone can have the electron package but no
// Electron.app. Run before anything that launches or bundles Electron.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const electron = resolve(root, 'node_modules/electron');
const binary = resolve(electron, 'dist/Electron.app/Contents/MacOS/Electron');

export function ensureElectron() {
  if (existsSync(binary)) return;
  if (!existsSync(resolve(electron, 'install.js'))) throw new Error('Electron is not installed. Run pnpm install first.');
  console.log('Downloading Electron (first run after a fresh install)…');
  const result = spawnSync(process.execPath, [resolve(electron, 'install.js')], { cwd: electron, stdio: 'inherit' });
  if (result.status !== 0 || !existsSync(binary)) throw new Error('Electron could not be downloaded. Check the internet connection and run pnpm install again.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) ensureElectron();
