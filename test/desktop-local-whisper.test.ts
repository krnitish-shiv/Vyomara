import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractWhisperTranscriptions, LocalWhisperRunner } from '../src/desktop/local-whisper.ts';

test('Whisper transcription parser extracts clean lines from VAD output', () => {
  const output = [
    'noise',
    '### Transcription 0 START',
    '[00:00:00.000 --> 00:00:01.200]  Hello Vyomara, open VS Code.',
    '### Transcription 0 END',
    '### Transcription 1 START',
    '[00:00:02.000 --> 00:00:02.500] Search for weather.',
    '### Transcription 1 END',
    '### Transcription 2 START',
    '[00:00:03.000 --> 00:00:03.500] [BLANK_AUDIO]',
    '### Transcription 2 END',
    '### Transcription 3 START',
    '[00:00:04.000 --> 00:00:05.000] Tell [BLANK_AUDIO] me more.',
    '### Transcription 3 END',
  ].join('\n');

  assert.deepEqual(extractWhisperTranscriptions(output), [
    'Hello Vyomara, open VS Code.',
    'Search for weather.',
    'Tell me more.',
  ]);
});

test('local voice sends an arbitrary first transcription without requiring a wake phrase', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyomara-whisper-test-'));
  const transcript = 'Can you help me?';
  const output = `### Transcription 0 START\n${transcript}\n### Transcription 0 END\n`;
  const binaryPath = join(directory, 'fake-whisper');
  await writeFile(binaryPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`);
  await chmod(binaryPath, 0o700);
  const runner = new LocalWhisperRunner({
    modelDirectory: directory,
    binaryPath,
  });
  const events: string[] = [];

  try {
    runner.start(event => {
      if (event.type === 'command') events.push(event.transcript);
    });
    // Starting the fake binary (a Node process) can take over a second on a busy machine.
    for (let attempt = 0; attempt < 250 && events.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(events, [transcript]);
  } finally {
    await runner.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('silent voice pause suppresses stop events before speech playback resumes listening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vyomara-whisper-pause-test-'));
  const binaryPath = join(directory, 'fake-whisper');
  await writeFile(binaryPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'\n`);
  await chmod(binaryPath, 0o700);
  const runner = new LocalWhisperRunner({
    modelDirectory: directory,
    binaryPath,
  });
  const events: string[] = [];

  try {
    runner.start(event => events.push(event.type));
    assert.equal(await runner.stop({ silent: true }), true);
    assert.equal(events.length, 0);

    runner.start(event => events.push(event.type));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await runner.stop(), true);
    assert.deepEqual(events, ['stopped']);
  } finally {
    await runner.stop({ silent: true });
    await rm(directory, { recursive: true, force: true });
  }
});
