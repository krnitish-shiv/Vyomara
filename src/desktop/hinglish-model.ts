/**
 * The Hinglish speech model: Oriserve's Whisper-Hindi2Hinglish-Apex
 * (Apache-2.0, a whisper-large-v3-turbo fine-tune that writes Hindi and
 * Hinglish speech in Roman letters), converted on this Mac to whisper.cpp's
 * ggml format and quantized to q5_0.
 *
 * Every source file comes from a pinned revision and is checked against its
 * SHA-256 before use. The conversion is a dependency-free port of whisper.cpp's
 * models/convert-h5-to-ggml.py that reads safetensors directly. On the
 * owner's sample clips it heard conversational Hinglish correctly where
 * large-v3-turbo produced Spanish, French, or English, at ~0.35 s per phrase
 * instead of 1.6–2 s (docs/research/voice-and-local-models-2026-11.md).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { closeSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { inflateRawSync } from 'node:zlib';

export const HINGLISH_MODEL_FILE = 'ggml-hinglish-apex-q5_0.bin';
/** Written next to the model after a successful build: { source, sha1, bytes }. */
export const HINGLISH_MODEL_MANIFEST = `${HINGLISH_MODEL_FILE}.json`;

const REVISION = 'f3214eed20b4e4d4144e739982d911f87b9cb223';
const BASE = `https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Apex/resolve/${REVISION}`;
interface Source { readonly url: string; readonly name: string; readonly sha256: string; readonly maxBytes: number }
const SOURCES: readonly Source[] = [
  { url: `${BASE}/config.json`, name: 'config.json', sha256: '14209b98fb68fc127201bbfebd57cc9f834b0f1a0d0d463a561c8051800af9f4', maxBytes: 100_000 },
  { url: `${BASE}/vocab.json`, name: 'vocab.json', sha256: '6788c80b082e9b0d1393147d3a3e62ba19285ac0c82ace8e5ef00f37ead58971', maxBytes: 2_000_000 },
  // Mel filter bank shipped with OpenAI's whisper (pinned commit).
  { url: 'https://raw.githubusercontent.com/openai/whisper/86098128c0b4f24f0e2aa2994de830614b474227/whisper/assets/mel_filters.npz', name: 'mel_filters.npz', sha256: '7450ae70723a5ef9d341e3cee628c7cb0177f36ce42c44b7ed2bf3325f0f6d4c', maxBytes: 100_000 },
  { url: `${BASE}/model.safetensors`, name: 'model.safetensors', sha256: '5560830fe8fa09b8cdf1b5926d0cc39a2586eadaad685d809e156432c4ebca80', maxBytes: 1_700_000_000 },
];
/** Bytes downloaded in total, for progress (the model dominates). */
export const HINGLISH_DOWNLOAD_BYTES = 1_617_825_448 + 1_194 + 835_528 + 4_271;

const CONV_MAP: Readonly<Record<string, string>> = {
  'self_attn.k_proj': 'attn.key',
  'self_attn.q_proj': 'attn.query',
  'self_attn.v_proj': 'attn.value',
  'self_attn.out_proj': 'attn.out',
  self_attn_layer_norm: 'attn_ln',
  'encoder_attn.q_proj': 'cross_attn.query',
  'encoder_attn.v_proj': 'cross_attn.value',
  'encoder_attn.out_proj': 'cross_attn.out',
  encoder_attn_layer_norm: 'cross_attn_ln',
  fc1: 'mlp.0',
  fc2: 'mlp.2',
  final_layer_norm: 'mlp_ln',
  'encoder.layer_norm.bias': 'encoder.ln_post.bias',
  'encoder.layer_norm.weight': 'encoder.ln_post.weight',
  'encoder.embed_positions.weight': 'encoder.positional_embedding',
  'decoder.layer_norm.bias': 'decoder.ln.bias',
  'decoder.layer_norm.weight': 'decoder.ln.weight',
  'decoder.embed_positions.weight': 'decoder.positional_embedding',
  'decoder.embed_tokens.weight': 'decoder.token_embedding.weight',
};

/** Map a Hugging Face Whisper tensor name to whisper.cpp's name (undefined = skip). */
export function ggmlName(hfName: string): string | undefined {
  if (hfName === 'proj_out.weight') return undefined; // tied to the token embedding
  const parts = hfName.split('.').slice(1); // drop the leading "model."
  if (parts[1] === 'layers') {
    parts[1] = 'blocks';
    const inner = parts.slice(3, -1).join('.');
    const mapped = inner === 'encoder_attn.k_proj'
      ? (parts[0] === 'encoder' ? 'attn.key' : 'cross_attn.key')
      : CONV_MAP[inner];
    if (mapped === undefined) throw new Error(`Unknown tensor ${hfName}.`);
    return [...parts.slice(0, 3), mapped, parts.at(-1)].join('.');
  }
  const joined = parts.join('.');
  return CONV_MAP[joined] ?? joined;
}

/** GPT-2 byte ↔ unicode table (reversible BPE): character → byte. */
function byteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 0x21; b <= 0x7e; b += 1) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b += 1) bs.push(b);
  for (let b = 0xae; b <= 0xff; b += 1) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n += 1; }
  }
  return new Map(bs.map((b, index) => [String.fromCodePoint(cs[index] ?? 0), b]));
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE float32 → float16 bits, rounded to nearest even (as numpy does). */
export function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0] ?? 0;
  const sign = (x >>> 16) & 0x8000;
  let exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - exponent;
    let half = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    if (remainder > midpoint || (remainder === midpoint && (half & 1))) half += 1;
    return sign | half;
  }
  let half = sign | (exponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1))) half += 1;
  return half;
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export interface FloatMatrix { readonly rows: number; readonly cols: number; readonly values: Float32Array }

/** Read a 2-D float32 array out of an .npz (a zip of .npy files) without numpy. */
export function readNpzArray(buffer: Buffer, key: string): FloatMatrix {
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    if (compressedSize === 0xffffffff) throw new Error('zip64 entries are not supported.');
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (name === `${key}.npy`) {
      const npy = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : undefined;
      if (!npy) throw new Error(`Unsupported zip method ${method}.`);
      if (npy.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('Not an .npy file.');
      const major = npy[6];
      const headerLength = major === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8);
      const headerStart = major === 1 ? 10 : 12;
      const header = npy.toString('latin1', headerStart, headerStart + headerLength);
      if (!/'descr':\s*'<f4'/u.test(header) || /'fortran_order':\s*True/u.test(header)) throw new Error(`Unexpected array layout: ${header}`);
      const shape = /'shape':\s*\((\d+),\s*(\d+)\)/u.exec(header);
      if (!shape) throw new Error(`Unexpected array shape: ${header}`);
      const rows = Number(shape[1]);
      const cols = Number(shape[2]);
      const start = headerStart + headerLength;
      const values = new Float32Array(rows * cols);
      for (let index = 0; index < values.length; index += 1) values[index] = npy.readFloatLE(start + index * 4);
      return { rows, cols, values };
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`${key} not found in the .npz file.`);
}

interface TensorInfo { readonly dtype: string; readonly shape: readonly number[]; readonly start: number; readonly end: number }

/** Read the safetensors header: tensor name → dtype, shape, and absolute byte range. */
export function readSafetensorsHeader(path: string): Map<string, TensorInfo> {
  const fd = openSync(path, 'r');
  try {
    const lengthBytes = Buffer.alloc(8);
    readSync(fd, lengthBytes, 0, 8, 0);
    const headerLength = Number(lengthBytes.readBigUInt64LE(0));
    if (headerLength <= 0 || headerLength > 100_000_000) throw new Error('Invalid safetensors header.');
    const header = Buffer.alloc(headerLength);
    readSync(fd, header, 0, headerLength, 8);
    const parsed = JSON.parse(header.toString('utf8')) as Record<string, unknown>;
    const tensors = new Map<string, TensorInfo>();
    for (const [name, value] of Object.entries(parsed)) {
      if (name === '__metadata__') continue;
      const info = value as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
      const offsets = info.data_offsets;
      if (typeof info.dtype !== 'string' || !Array.isArray(info.shape) || !Array.isArray(offsets) || offsets.length !== 2) throw new Error(`Invalid tensor entry ${name}.`);
      tensors.set(name, { dtype: info.dtype, shape: info.shape.map(Number), start: 8 + headerLength + Number(offsets[0]), end: 8 + headerLength + Number(offsets[1]) });
    }
    return tensors;
  } finally {
    closeSync(fd);
  }
}

function writeInt(fd: number, value: number): void {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  writeSync(fd, buffer);
}

/** Convert one tensor's raw bytes to the f16 or f32 bytes whisper.cpp expects. */
function convertTensor(raw: Buffer, dtype: string, toF32: boolean): Buffer {
  if (dtype === 'F16' && !toF32) return raw;
  const count = dtype === 'F32' ? raw.length / 4 : raw.length / 2;
  const out = Buffer.alloc(count * (toF32 ? 4 : 2));
  for (let index = 0; index < count; index += 1) {
    let value: number;
    if (dtype === 'F32') value = raw.readFloatLE(index * 4);
    else if (dtype === 'BF16') { u32[0] = raw.readUInt16LE(index * 2) << 16; value = f32[0] ?? 0; }
    else if (dtype === 'F16') value = halfToFloat(raw.readUInt16LE(index * 2));
    else throw new Error(`Unsupported dtype ${dtype}.`);
    if (toF32) out.writeFloatLE(value, index * 4);
    else out.writeUInt16LE(toHalf(value), index * 2);
  }
  return out;
}

const F32_TENSORS = new Set(['encoder.conv1.bias', 'encoder.conv2.bias', 'encoder.positional_embedding', 'decoder.positional_embedding']);

/** Write a whisper.cpp ggml (f16) model from a Hugging Face Whisper folder. Returns the tensor count. */
export function convertToGgml(sourceDirectory: string, melPath: string, outputPath: string): number {
  const hparams = JSON.parse(readFileSync(join(sourceDirectory, 'config.json'), 'utf8')) as Record<string, number | undefined>;
  const vocab = JSON.parse(readFileSync(join(sourceDirectory, 'vocab.json'), 'utf8')) as Record<string, number>;
  const need = (key: string): number => {
    const value = hparams[key];
    if (typeof value !== 'number') throw new Error(`config.json lacks ${key}.`);
    return value;
  };
  const maxLength = Number.isInteger(hparams.max_length) ? need('max_length') : (hparams.max_target_positions ?? 448);
  const mel = readNpzArray(readFileSync(melPath), `mel_${need('num_mel_bins')}`);
  const modelPath = join(sourceDirectory, 'model.safetensors');
  const tensors = readSafetensorsHeader(modelPath);
  const source = openSync(modelPath, 'r');
  const temporary = `${outputPath}.partial`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    for (const value of [0x67676d6c, need('vocab_size'), need('max_source_positions'), need('d_model'), need('encoder_attention_heads'), need('encoder_layers'), maxLength, need('d_model'), need('decoder_attention_heads'), need('decoder_layers'), need('num_mel_bins'), 1]) writeInt(fd, value);
    writeInt(fd, mel.rows);
    writeInt(fd, mel.cols);
    const melBytes = Buffer.alloc(mel.values.length * 4);
    mel.values.forEach((value, index) => melBytes.writeFloatLE(value, index * 4));
    writeSync(fd, melBytes);

    const decoder = byteDecoder();
    const tokens = Object.entries(vocab).sort((a, b) => a[1] - b[1]);
    writeInt(fd, tokens.length);
    for (const [token] of tokens) {
      const bytes = Buffer.from([...token].map(character => {
        const byte = decoder.get(character);
        if (byte === undefined) throw new Error(`Token ${token} is not byte-level BPE.`);
        return byte;
      }));
      writeInt(fd, bytes.length);
      writeSync(fd, bytes);
    }

    let written = 0;
    for (const [hfName, info] of tensors) {
      const name = ggmlName(hfName);
      if (name === undefined) continue;
      // numpy squeeze(): drop size-1 dimensions, then conv biases become [n, 1].
      let shape = info.shape.length === 1 ? [...info.shape] : info.shape.filter(dimension => dimension !== 1);
      if (name === 'encoder.conv1.bias' || name === 'encoder.conv2.bias') shape = [shape[0] ?? 0, 1];
      const toF32 = shape.length < 2 || F32_TENSORS.has(name);
      const raw = Buffer.alloc(info.end - info.start);
      readSync(source, raw, 0, raw.length, info.start);
      const nameBytes = Buffer.from(name, 'utf8');
      writeInt(fd, shape.length);
      writeInt(fd, nameBytes.length);
      writeInt(fd, toF32 ? 0 : 1);
      for (let index = shape.length - 1; index >= 0; index -= 1) writeInt(fd, shape[index] ?? 0);
      writeSync(fd, nameBytes);
      writeSync(fd, convertTensor(raw, info.dtype, toF32));
      written += 1;
    }
    closeSync(fd);
    renameSync(temporary, outputPath);
    return written;
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(temporary, { force: true });
    throw error;
  } finally {
    closeSync(source);
  }
}

async function hashFile(path: string, algorithm: 'sha1' | 'sha256'): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** True when the built model is present and matches the checksum recorded when it was built. */
export async function hinglishModelReady(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, HINGLISH_MODEL_MANIFEST), 'utf8')) as { sha1?: unknown; bytes?: unknown };
    const metadata = await stat(join(directory, HINGLISH_MODEL_FILE));
    return typeof manifest.sha1 === 'string' && metadata.size === manifest.bytes && await hashFile(join(directory, HINGLISH_MODEL_FILE), 'sha1') === manifest.sha1;
  } catch {
    return false;
  }
}

export interface HinglishInstallOptions {
  /** Bytes downloaded so far and the total, for a progress bar. */
  readonly onProgress?: (received: number, total: number) => void;
  /** Status lines ("Converting…"). */
  readonly onStatus?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly quantizer?: string;
}

export function findWhisperQuantizer(): string | undefined {
  return ['/opt/homebrew/bin/whisper-quantize', '/usr/local/bin/whisper-quantize'].find(candidate => existsSync(candidate));
}

/**
 * Download (resuming interrupted downloads), verify, convert, and quantize the
 * Hinglish model into `directory`. Safe to run again: verified files are reused.
 */
export async function installHinglishModel(directory: string, options: HinglishInstallOptions = {}): Promise<string> {
  const quantizer = options.quantizer ?? findWhisperQuantizer();
  if (!quantizer) throw new Error('whisper-quantize was not found. Install it with `brew install whisper-cpp`.');
  const work = join(directory, 'hinglish-source');
  await mkdir(work, { recursive: true, mode: 0o700 });
  let done = 0;
  for (const source of SOURCES) {
    await download(source, join(work, source.name), received => options.onProgress?.(done + received, HINGLISH_DOWNLOAD_BYTES), options.signal);
    done += (await stat(join(work, source.name))).size;
  }
  options.signal?.throwIfAborted();
  options.onStatus?.('Converting the Hinglish model…');
  const f16 = join(work, 'ggml-model-f16.bin');
  convertToGgml(work, join(work, 'mel_filters.npz'), f16);
  options.onStatus?.('Compressing the Hinglish model…');
  const output = join(directory, HINGLISH_MODEL_FILE);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(quantizer, [f16, `${output}.partial`, 'q5_0'], { stdio: 'ignore', shell: false });
    const abort = (): void => { child.kill('SIGTERM'); };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', code => {
      options.signal?.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(new Error(options.signal?.aborted ? 'The Hinglish model setup was cancelled.' : `whisper-quantize failed with exit code ${code}.`));
    });
  });
  await rename(`${output}.partial`, output);
  await writeFile(join(directory, HINGLISH_MODEL_MANIFEST), `${JSON.stringify({ source: `Oriserve/Whisper-Hindi2Hinglish-Apex@${REVISION}`, sha1: await hashFile(output, 'sha1'), bytes: (await stat(output)).size, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  await rm(work, { recursive: true, force: true });
  return output;
}

async function download(source: Source, target: string, onProgress: (received: number) => void, signal?: AbortSignal): Promise<void> {
  if (existsSync(target) && await hashFile(target, 'sha256') === source.sha256) {
    onProgress((await stat(target)).size);
    return;
  }
  const temporary = `${target}.download`;
  for (let attempt = 1; ; attempt += 1) {
    const have = existsSync(temporary) ? (await stat(temporary)).size : 0;
    try {
      const response = await fetch(source.url, { redirect: 'follow', headers: have > 0 ? { Range: `bytes=${have}-` } : {}, ...(signal ? { signal } : {}) });
      if (!response.body || (response.status !== 200 && response.status !== 206)) throw new Error(`${source.name}: HTTP ${response.status}.`);
      const append = response.status === 206;
      const declared = Number(response.headers.get('content-length')) + (append ? have : 0);
      if (declared > source.maxBytes) throw new Error(`${source.name} is larger than expected.`);
      let received = append ? have : 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > source.maxBytes) { callback(new Error(`${source.name} is larger than expected.`)); return; }
          onProgress(received);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), meter, createWriteStream(temporary, { flags: append ? 'a' : 'w', mode: 0o600 }));
      break;
    } catch (error) {
      if (signal?.aborted || attempt >= 5 || /larger than expected|HTTP 4/u.test(String(error))) throw error;
    }
  }
  const actual = await hashFile(temporary, 'sha256');
  if (actual !== source.sha256) {
    await rm(temporary, { force: true });
    throw new Error(`${source.name} failed its integrity check.`);
  }
  await rename(temporary, target);
}
