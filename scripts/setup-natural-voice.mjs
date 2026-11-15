// Installs the natural voice (`pnpm setup:voice`): a Python environment with
// kokoro-onnx, plus the Kokoro-82M model and two voices from the official
// onnx-community Hugging Face repo, each checked against its SHA-256 before use.
// Everything lives in ~/Library/Application Support/vyomara/natural-voice.
// Voices are raw float files joined into an .npz without pickle.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('The natural voice is set up on macOS only.');

const directory = join(homedir(), 'Library', 'Application Support', 'vyomara', 'natural-voice');
const base = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const files = [
  { url: `${base}/onnx/model_quantized.onnx`, name: 'model_quantized.onnx', sha256: 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478', maxBytes: 100_000_000 },
  { url: `${base}/voices/hf_beta.bin`, name: 'voices/hf_beta.bin', sha256: 'cd83ae0bb9b2e4e4fb92b4973bd8d1822ca0036d3c498bf4fc89aa8e33917cc7', maxBytes: 1_000_000 },
  { url: `${base}/voices/hm_omega.bin`, name: 'voices/hm_omega.bin', sha256: 'b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137', maxBytes: 1_000_000 },
];
const packages = ['kokoro-onnx==0.6.1', 'soundfile==0.14.0'];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
}

function findPython() {
  for (const candidate of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (!existsSync(candidate)) continue;
    const version = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0]*100+sys.version_info[1])'], { encoding: 'utf8' });
    if (version.status === 0 && Number(version.stdout) >= 310) return candidate;
  }
  throw new Error('Python 3.10 or newer was not found. Install it with `brew install python`.');
}

async function download({ url, name, sha256, maxBytes }) {
  const target = join(directory, name);
  if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') === sha256) {
    console.log(`ok      ${name}`);
    return;
  }
  console.log(`fetch   ${name}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`${name} is larger than expected.`);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== sha256) throw new Error(`${name} failed its integrity check (${actual}).`);
  const temporary = `${target}.download`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, target);
}

mkdirSync(join(directory, 'voices'), { recursive: true, mode: 0o700 });
const python = findPython();
const venv = join(directory, 'venv');
if (!existsSync(join(venv, 'bin', 'python3'))) run(python, ['-m', 'venv', venv]);
run(join(venv, 'bin', 'python3'), ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...packages]);
for (const file of files) await download(file);

run(join(venv, 'bin', 'python3'), ['-I', '-c', `
import numpy as np
d = ${JSON.stringify(directory)}
np.savez(d + "/voices.npz", **{n: np.fromfile(f"{d}/voices/{n}.bin", dtype=np.float32).reshape(-1, 1, 256) for n in ("hf_beta", "hm_omega")})
`]);
rmSync(join(directory, 'ready.json'), { force: true });
writeFileSync(join(directory, 'ready.json'), `${JSON.stringify({ engine: 'kokoro-82m-v1.0-quantized', voices: ['hf_beta', 'hm_omega'], at: new Date().toISOString() })}\n`, { mode: 0o600 });
console.log(`\nNatural voice installed in ${directory}`);
