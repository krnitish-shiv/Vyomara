import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { ggmlName, readNpzArray, toHalf } from '../src/desktop/hinglish-model.ts';

test('Hugging Face Whisper tensor names map to whisper.cpp names', () => {
  assert.equal(ggmlName('model.encoder.layers.3.self_attn.q_proj.weight'), 'encoder.blocks.3.attn.query.weight');
  assert.equal(ggmlName('model.encoder.layers.0.encoder_attn.k_proj.weight'), 'encoder.blocks.0.attn.key.weight');
  assert.equal(ggmlName('model.decoder.layers.1.encoder_attn.k_proj.weight'), 'decoder.blocks.1.cross_attn.key.weight');
  assert.equal(ggmlName('model.decoder.layers.2.fc2.bias'), 'decoder.blocks.2.mlp.2.bias');
  assert.equal(ggmlName('model.decoder.embed_tokens.weight'), 'decoder.token_embedding.weight');
  assert.equal(ggmlName('model.encoder.conv1.weight'), 'encoder.conv1.weight');
  assert.equal(ggmlName('model.encoder.layer_norm.bias'), 'encoder.ln_post.bias');
  assert.equal(ggmlName('proj_out.weight'), undefined);
  assert.throws(() => ggmlName('model.encoder.layers.0.mystery.weight'), /Unknown tensor/u);
});

test('float32 → float16 conversion rounds like numpy', () => {
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(-0), 0x8000);
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(0.5), 0x3800);
  assert.equal(toHalf(65504), 0x7bff);
  assert.equal(toHalf(1e6), 0x7c00, 'overflow → infinity');
  assert.equal(toHalf(Number.NaN) & 0x7c00, 0x7c00);
  assert.equal(toHalf(5.960464477539063e-8), 0x0001, 'smallest subnormal');
  assert.equal(toHalf(1 + 2 ** -11), 0x3c00, 'tie rounds to even');
  assert.equal(toHalf(1 + 3 * 2 ** -11), 0x3c02, 'tie rounds to even (up)');
});

test('a float32 array is read from an .npz (stored and deflated)', () => {
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 3), }";
  const padded = header.padEnd(118, ' ') + '\n';
  const npyHeader = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY'), Buffer.from([1, 0]), Buffer.alloc(2)]);
  npyHeader.writeUInt16LE(padded.length, 8);
  const data = Buffer.alloc(24);
  [1, 2, 3, 4, 5, 6].forEach((value, index) => data.writeFloatLE(value, index * 4));
  const npy = Buffer.concat([npyHeader, Buffer.from(padded, 'latin1'), data]);
  for (const [method, payload] of [[0, npy], [8, deflateRawSync(npy)]] as const) {
    const name = Buffer.from('mel_128.npy');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(npy.length, 22);
    local.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([local, name, payload]);
    const array = readNpzArray(zip, 'mel_128');
    assert.equal(array.rows, 2);
    assert.equal(array.cols, 3);
    assert.deepEqual([...array.values], [1, 2, 3, 4, 5, 6]);
    assert.throws(() => readNpzArray(zip, 'mel_80'), /not found/u);
  }
});

test('a tiny Whisper folder converts to the ggml layout whisper.cpp reads', async t => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { convertToGgml } = await import('../src/desktop/hinglish-model.ts');
  const dir = mkdtempSync(join(tmpdir(), 'ggml-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ vocab_size: 3, max_source_positions: 4, d_model: 2, encoder_attention_heads: 1, encoder_layers: 1, max_target_positions: 5, decoder_attention_heads: 1, decoder_layers: 1, num_mel_bins: 2 }));
  writeFileSync(join(dir, 'vocab.json'), JSON.stringify({ 'Ġa': 1, '!': 0, 'b': 2 }));
  // mel npz: 2x2 float32, stored.
  const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (2, 2), }".padEnd(118, ' ') + '\n';
  const npyHead = Buffer.concat([Buffer.from([0x93]), Buffer.from('NUMPY'), Buffer.from([1, 0, header.length & 0xff, header.length >> 8])]);
  const melData = Buffer.alloc(16); [0.5, 1, 1.5, 2].forEach((v, i) => melData.writeFloatLE(v, i * 4));
  const npy = Buffer.concat([npyHead, Buffer.from(header, 'latin1'), melData]);
  const name = Buffer.from('mel_2.npy');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(npy.length, 18); local.writeUInt16LE(name.length, 26);
  writeFileSync(join(dir, 'mel.npz'), Buffer.concat([local, name, npy]));
  // safetensors: an F32 2x2 weight (→ f16), an F32 bias of 2 (→ f32), and the skipped proj_out.
  const weight = Buffer.alloc(16); [1, 2, 3, 4].forEach((v, i) => weight.writeFloatLE(v, i * 4));
  const bias = Buffer.alloc(8); [5, 6].forEach((v, i) => bias.writeFloatLE(v, i * 4));
  const meta = JSON.stringify({
    'model.encoder.layers.0.fc1.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
    'model.encoder.conv1.bias': { dtype: 'F32', shape: [2], data_offsets: [16, 24] },
    'proj_out.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
  });
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(meta.length));
  writeFileSync(join(dir, 'model.safetensors'), Buffer.concat([length, Buffer.from(meta), weight, bias]));

  const out = join(dir, 'out.bin');
  assert.equal(convertToGgml(dir, join(dir, 'mel.npz'), out), 2);
  const bin = readFileSync(out);
  let at = 0;
  const int = (): number => { const v = bin.readInt32LE(at); at += 4; return v; };
  assert.deepEqual(Array.from({ length: 12 }, int), [0x67676d6c, 3, 4, 2, 1, 1, 5, 2, 1, 1, 2, 1]);
  assert.deepEqual([int(), int()], [2, 2]);
  assert.deepEqual([0, 1, 2, 3].map(() => { const v = bin.readFloatLE(at); at += 4; return v; }), [0.5, 1, 1.5, 2]);
  assert.equal(int(), 3);
  const tokens = [0, 1, 2].map(() => { const n = int(); const s = bin.toString('latin1', at, at + n); at += n; return s; });
  assert.deepEqual(tokens, ['!', ' a', 'b'], 'byte-level BPE decoded, sorted by id');
  // fc1 weight: 2 dims, f16, dims reversed, name, then four halves.
  assert.deepEqual([int(), int(), int(), int(), int()], [2, 'encoder.blocks.0.mlp.0.weight'.length, 1, 2, 2]);
  assert.equal(bin.toString('utf8', at, at + 29), 'encoder.blocks.0.mlp.0.weight'); at += 29;
  assert.deepEqual([0, 1, 2, 3].map(() => { const v = bin.readUInt16LE(at); at += 2; return v; }), [0x3c00, 0x4000, 0x4200, 0x4400]);
  // conv1 bias becomes [2, 1] and stays f32.
  assert.deepEqual([int(), int(), int(), int(), int()], [2, 'encoder.conv1.bias'.length, 0, 1, 2]);
  at += 'encoder.conv1.bias'.length;
  assert.deepEqual([bin.readFloatLE(at), bin.readFloatLE(at + 4)], [5, 6]);
  assert.equal(at + 8, bin.length);
});
