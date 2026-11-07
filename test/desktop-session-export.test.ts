import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportToSelectedFile, writePrivateExportFile } from '../src/desktop/session-export.ts';

test('conversation export files are owner-only and never overwrite an existing file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vyomara-session-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'conversation.json');
  const contents = '{"format":"vyomara-session"}\n';

  await writePrivateExportFile(destination, contents);
  assert.equal(readFileSync(destination, 'utf8'), contents);
  assert.equal(statSync(destination).mode & 0o777, 0o600);

  writeFileSync(destination, 'existing user data');
  await assert.rejects(writePrivateExportFile(destination, 'replacement'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST');
  assert.equal(readFileSync(destination, 'utf8'), 'existing user data');
});

test('cancelled export does not create a file and selected export writes the exact JSON', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vyomara-selected-export-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, 'selected.json');
  const contents = '{"format":"vyomara-memory","content":"private fixture"}\n';
  let destinationCalls = 0;
  const cancelled = async (): Promise<string | undefined> => {
    destinationCalls++;
    return undefined;
  };

  assert.equal(await exportToSelectedFile(contents, cancelled), 'cancelled');
  assert.equal(destinationCalls, 1);

  assert.equal(
    await exportToSelectedFile(contents, async () => {
      destinationCalls++;
      return destination;
    }),
    'exported',
  );
  assert.equal(destinationCalls, 2);
  assert.equal(readFileSync(destination, 'utf8'), contents);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
});
