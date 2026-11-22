// Installs the Maya 2 Native voice (`pnpm setup:maya`): a Python environment
// with mlx-audio (Apple Silicon), plus the MLX 8-bit conversion of
// maya-research/maya2-native (Apache-2.0), every file checked against its
// SHA-256. Optional: --male <Voice> --female <Voice> picks the twins' voices
// (defaults Ritvik and Charvi). Everything lives in
// ~/Library/Application Support/vyomara/maya-voice; the app uses it after a restart.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The Maya voice runs on Apple Silicon Macs only.');

const directory = join(homedir(), 'Library', 'Application Support', 'vyomara', 'maya-voice');
const base = 'https://huggingface.co/aruntemme/maya2-native-mlx-8bit/resolve/ee18411e5f4f69dcd526b66d2b18dbb8e2f21c8e';
const files = [
  ['model.safetensors', '22a0b2b34617cb09fe95d6fb5cbeed55269845a35eb5a6692230ea08dfa1c99f', 3_400_000_000],
  ['config.json', 'a6c4963a3d8252d8eaa35074a2dfbcffb3d27a38ac7d68ff8be1b5307bce7a07', 1_000_000],
  ['model.safetensors.index.json', '57a2e4c350bdb1fd640e6d91a71505f4cdd51a22b10c1d56f5725ee14687590c', 1_000_000],
  ['backbone/config.json', '104821897c76516d4a98b9849481fc50d474615fe9d14bd0a99626fb5e694633', 1_000_000],
  ['backbone/generation_config.json', '6174fe0d3a484e4f840d038b58d65c6b5808f55c5615ffe24721ec10f0e2e215', 1_000_000],
  ['backbone/tokenizer.json', '26c51f9b772f9084ed6bdeabc44b7c15397c12966bfa3e1c09b025e82f4fdbaf', 50_000_000],
  ['backbone/tokenizer_config.json', 'b531fa1efcc8785538d9f20d40a4510b58632a35df594af1a7c96c5fe2606a3a', 5_000_000],
  ['voices/voices.json', 'cf6a751c7a80076f872f16636860ff2756e8cad42face77256c78b3ade5316ac', 1_000_000],
];
const VOICES = new Set(['Ahana', 'Vaidehi', 'Malini', 'Charvi', 'Jahnavi', 'Anirban', 'Nakul', 'Vasant', 'Siddhant', 'Satvik', 'Abhay', 'Nivedita', 'Ishwari', 'Ritvik', 'Vrinda', 'Sreekar', 'Shaunak', 'Akshat', 'Tanushree']);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) return fallback;
  const voice = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  if (!VOICES.has(voice)) throw new Error(`Unknown Maya voice "${value}". Choose one of: ${[...VOICES].join(', ')}.`);
  return voice;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download([name, expected, maxBytes]) {
  const target = join(directory, 'model', name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target) && await sha256(target) === expected) { console.log(`ok      ${name}`); return; }
  const temporary = `${target}.download`;
  for (let attempt = 1; ; attempt += 1) {
    const have = existsSync(temporary) ? statSync(temporary).size : 0;
    console.log(`fetch   ${name}${have ? ` (resuming at ${Math.round(have / 1_048_576)} MiB)` : ''}`);
    try {
      const response = await fetch(`${base}/${name}`, { redirect: 'follow', headers: have ? { Range: `bytes=${have}-` } : {} });
      if (!response.body || (response.status !== 200 && response.status !== 206)) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length')) + (response.status === 206 ? have : 0) > maxBytes) throw new Error(`${name} is larger than expected`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 }));
      break;
    } catch (error) {
      if (attempt >= 8 || /larger than expected|HTTP 4/u.test(String(error))) throw error;
    }
  }
  if (await sha256(temporary) !== expected) { rmSync(temporary); throw new Error(`${name} failed its integrity check.`); }
  renameSync(temporary, target);
}

const male = option('--male', 'Ritvik');
const female = option('--female', 'Charvi');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const venv = join(directory, 'venv');
if (!existsSync(join(venv, 'bin', 'python3'))) run('/opt/homebrew/bin/python3', ['-m', 'venv', venv]);
run(join(venv, 'bin', 'python3'), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'mlx-audio==0.6.7', 'soundfile']);
for (const file of files) await download(file);
writeFileSync(join(directory, 'voices.json'), `${JSON.stringify({ male, female })}\n`, { mode: 0o600 });
writeFileSync(join(directory, 'ready.json'), `${JSON.stringify({ engine: 'maya2-native-mlx-8bit', voices: { male, female }, at: new Date().toISOString() })}\n`, { mode: 0o600 });
console.log(`\nMaya voice installed (${male} for Vyom, ${female} for Vyomara). Restart Vyomara to use it.`);
