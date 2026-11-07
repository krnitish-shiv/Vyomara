// Release packager (`pnpm package:mac`): a standalone Vyomara.app and a .dmg
// in release/. With --install (`pnpm install:mac`), it also replaces
// /Applications/Vyomara.app and opens it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSources, createBundle, packageInfo, root, run } from './mac-bundle.mjs';

const install = process.argv.includes('--install');
const { version } = packageInfo;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch;
const releaseDirectory = resolve(root, 'release');
const appBundle = resolve(releaseDirectory, 'Vyomara.app');
const dmg = resolve(releaseDirectory, `Vyomara-${version}-${arch}.dmg`);

// A fresh build every time: electron-vite empties out/ itself, and release/ starts empty.
rmSync(releaseDirectory, { recursive: true, force: true });
mkdirSync(releaseDirectory, { recursive: true });
buildSources();
createBundle(appBundle, { embed: true });

// Disk image: the app and a shortcut to Applications, so it can be dragged across.
const staging = mkdtempSync(join(tmpdir(), 'vyomara-dmg-'));
try {
  run('/usr/bin/ditto', [appBundle, join(staging, 'Vyomara.app')]);
  symlinkSync('/Applications', join(staging, 'Applications'));
  run('/usr/bin/hdiutil', ['create', '-volname', `Vyomara ${version}`, '-srcfolder', staging, '-ov', '-format', 'UDZO', '-quiet', dmg]);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const megabytes = path => `${Math.round(statSync(path).size / 1e6)} MB`;
console.log(`\nVyomara ${version} (${arch})\n  app: ${appBundle}\n  dmg: ${dmg} (${megabytes(dmg)})`);

if (install) {
  const installed = '/Applications/Vyomara.app';
  // Quit a running copy first, so the files can be replaced.
  run('/usr/bin/osascript', ['-e', 'if application id "app.vyomara.desktop" is running then tell application id "app.vyomara.desktop" to quit']);
  for (let wait = 0; wait < 20 && spawnSync('/usr/bin/pgrep', ['-f', 'Vyomara.app/Contents/MacOS/Electron']).status === 0; wait += 1) {
    spawnSync('/bin/sleep', ['0.5']);
  }
  if (existsSync(installed)) rmSync(installed, { recursive: true, force: true });
  run('/usr/bin/ditto', [appBundle, installed]);
  console.log(`  installed: ${installed}`);
  run('/usr/bin/open', [installed]);
}
