// Builds a Vyomara.app bundle from Electron's own app: icon, name, version,
// and permissions text, then an ad-hoc signature. Used by the development
// launcher (desktop-app.mjs) and the release packager (package-mac.mjs).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from './ensure-electron.mjs';

if (process.platform !== 'darwin') {
  throw new Error('Building the Vyomara app requires macOS.');
}

export const root = fileURLToPath(new URL('../', import.meta.url));
export const packageInfo = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const electronApp = resolve(root, 'node_modules/electron/dist/Electron.app');
const iconSource = resolve(root, 'src/renderer/src/ui/assets/vyomara-app-icon.svg');

// VS Code terminals set ELECTRON_RUN_AS_NODE=1; `open` passes it on, and the
// app would then start as plain Node and quit at once.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE'));

export function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

/** Compile main, preload, and renderer into out/. */
export function buildSources() {
  ensureElectron();
  run(process.execPath, [resolve(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build']);
}

/**
 * Create the bundle at `appBundle`.
 * - `embed: false` (development): the app runs the code in this project's out/ folder.
 * - `embed: true` (release): the compiled code is copied inside the app, so it
 *   runs without this project and can be installed in /Applications.
 */
export function createBundle(appBundle, { embed }) {
  rmSync(appBundle, { recursive: true, force: true });
  run('/bin/cp', ['-cR', electronApp, appBundle]);
  const resources = resolve(appBundle, 'Contents/Resources');
  writeIcon(resolve(resources, 'vyomara.icns'));

  if (embed) {
    // Electron runs Resources/app when it exists; the default app is not needed.
    rmSync(resolve(resources, 'default_app.asar'), { force: true });
    const app = resolve(resources, 'app');
    for (const part of ['main', 'preload', 'renderer']) {
      cpSync(resolve(root, 'out', part), resolve(app, 'out', part), { recursive: true });
    }
    // Only what Electron needs at run time; the name keeps the same data folder
    // (~/Library/Application Support/vyomara) as development builds.
    const { name, version, description, type, main } = packageInfo;
    writeFileSync(resolve(app, 'package.json'), `${JSON.stringify({ name, productName: 'Vyomara', version, description, type, main }, null, 2)}\n`);
  }

  const { version } = packageInfo;
  const plist = resolve(appBundle, 'Contents/Info.plist');
  for (const [key, value] of [
    ['CFBundleIdentifier', 'app.vyomara.desktop'],
    ['CFBundleName', 'Vyomara'],
    ['CFBundleDisplayName', 'Vyomara'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    ['CFBundleIconFile', 'vyomara.icns'],
    ['NSMicrophoneUsageDescription', 'Vyomara uses the microphone only while local voice listening is enabled.'],
    ['NSAppleEventsUsageDescription', 'Vyomara controls apps such as Chrome and VS Code only after you approve it.'],
    ['LSApplicationCategoryType', 'public.app-category.productivity'],
  ]) {
    // Set the key when Electron's plist has it, add it otherwise.
    const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    if (set.status !== 0) run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
  }
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'app.vyomara.desktop', appBundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundle]);
}

/** Render the SVG icon at every macOS size and pack it as .icns. */
function writeIcon(output) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vyomara-app-icon-'));
  const iconset = resolve(temporaryDirectory, 'Vyomara.iconset');
  mkdirSync(iconset);
  try {
    for (const [size, filename] of [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ]) {
      run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), iconSource, '--out', resolve(iconset, filename)], { quiet: true });
    }
    run('/usr/bin/iconutil', ['--convert', 'icns', '--output', output, iconset]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
