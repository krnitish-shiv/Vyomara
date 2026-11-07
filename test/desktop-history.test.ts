import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteDesktopSession, exportDesktopSession, readDesktopSession, readDesktopSessions } from '../src/app/application.ts';
import { loadConfig } from '../src/config/config.ts';
import { SqliteStore } from '../src/storage/sqlite-store.ts';

test('desktop session history lists local chats and returns only user and final assistant messages', t => {
  const root = mkdtempSync(join(tmpdir(), 'vyomara-desktop-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({
    VYOM_PROVIDER: 'placeholder',
    VYOM_DATA_DIR: root,
  });
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'List this folder.' });
  session.add({
    role: 'assistant',
    kind: 'tool-call',
    content: '',
    toolCalls: [{ toolId: 'list_directory', arguments: { path: '/private' } }],
  });
  session.add({ role: 'tool', toolId: 'list_directory', content: 'private tool output' });
  session.add({ role: 'assistant', content: 'The folder contains two items.' });
  store.saveSession(session);
  store.close();

  const summaries = readDesktopSessions(config);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.id, session.id);
  assert.equal(summaries[0]?.messageCount, 4);
  assert.ok(Number.isFinite(Date.parse(summaries[0]?.createdAt ?? '')));
  assert.ok(Number.isFinite(Date.parse(summaries[0]?.updatedAt ?? '')));
  assert.deepEqual(readDesktopSession(config, session.id), {
    sessionId: session.id,
    messages: [
      { role: 'user', content: 'List this folder.' },
      { role: 'assistant', content: 'The folder contains two items.' },
    ],
  });
  const exported = JSON.parse(exportDesktopSession(config, session.id));
  assert.equal(exported.format, 'vyomara-session');
  assert.equal(exported.version, 1);
  assert.equal(exported.sessionId, session.id);
  assert.ok(Number.isFinite(Date.parse(exported.exportedAt)));
  assert.deepEqual(exported.messages, session.messages());
  assert.equal(deleteDesktopSession(config, session.id), true);
  assert.deepEqual(readDesktopSessions(config), []);
  assert.throws(() => readDesktopSession(config, session.id), /not found/i);
  assert.equal(deleteDesktopSession(config, session.id), false);
  assert.throws(() => readDesktopSession(config, 'not-a-uuid'), /invalid/i);
});
