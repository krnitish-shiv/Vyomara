// `pnpm setup:hinglish`: builds the Hinglish speech model (see src/desktop/hinglish-model.ts)
// into ~/Library/Application Support/vyomara/speech-models. The app's Models panel does the same.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installHinglishModel } from '../src/desktop/hinglish-model.ts';

if (process.platform !== 'darwin') throw new Error('The Hinglish speech model is set up on macOS only.');
const directory = join(homedir(), 'Library', 'Application Support', 'vyomara', 'speech-models');
let shown = -1;
const output = await installHinglishModel(directory, {
  onProgress(received, total) {
    const percent = Math.floor((received / total) * 100);
    if (percent !== shown) { shown = percent; process.stdout.write(`\rdownload ${percent}%`); }
  },
  onStatus(message) { process.stdout.write(`\n${message}`); },
});
console.log(`\nHinglish speech model installed: ${output}`);
