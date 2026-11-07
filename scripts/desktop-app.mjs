// Development launcher (`pnpm desktop`): builds the code and opens
// out/Vyomara.app, which runs this project's out/ folder. Opening it through
// LaunchServices makes macOS attribute microphone and speech permissions to
// Vyomara rather than to the terminal.
import { resolve } from 'node:path';
import { buildSources, createBundle, root, run } from './mac-bundle.mjs';

const appBundle = resolve(root, 'out/Vyomara.app');
buildSources();
createBundle(appBundle, { embed: false });
run('/usr/bin/open', ['-a', appBundle, '--args', root]);
