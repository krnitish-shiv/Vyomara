import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config/config.ts';
import { PersistenceError, SqliteStore } from '../src/storage/sqlite-store.ts';
import { readModelSettings, saveModelSettings, saveSelectedModel, withSavedModelSettings } from '../src/app/application.ts';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'vyomara-storage-'));
}

test('SQLite storage applies owner-only permissions and idempotent migrations', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDirectory = join(root, 'private-data');
  const store = new SqliteStore(dataDirectory);
  assert.equal(statSync(dataDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(store.databasePath).mode & 0o777, 0o600);
  store.close();

  const reopened = new SqliteStore(dataDirectory);
  assert.equal(statSync(reopened.databasePath).mode & 0o777, 0o600);
  reopened.close();
});

test('existing shared data directories are rejected without changing their permissions', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sharedDirectory = join(root, 'shared');
  mkdirSync(sharedDirectory, { mode: 0o755 });
  chmodSync(sharedDirectory, 0o755);

  assert.throws(() => new SqliteStore(sharedDirectory), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-path');
  assert.equal(statSync(sharedDirectory).mode & 0o777, 0o755);
});

test('session history survives reopening, stays isolated, and cascades on deletion', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const first = store.createSession();
  first.add({ role: 'user', content: 'first session prompt' });
  first.add({
    role: 'assistant',
    kind: 'tool-call',
    content: '',
    toolCalls: [{ toolId: 'read_file', arguments: { path: '/private/file.txt' } }],
  });
  first.add({ role: 'tool', toolId: 'read_file', content: '{"content":"private fixture"}' });
  first.add({ role: 'assistant', content: 'private fixture' });
  const second = store.createSession();
  second.add({ role: 'user', content: 'second session prompt' });
  store.saveSession(first);
  store.saveSession(second);

  const summaries = store.listSessions();
  assert.equal(summaries.length, 2);
  assert.ok(summaries.every(summary => summary.messageCount > 0));
  // Each summary names the conversation by its first request and shows the last final reply.
  const firstSummary = summaries.find(summary => summary.id === first.id);
  assert.equal(firstSummary?.preview, 'private fixture');
  assert.equal(summaries.find(summary => summary.id === second.id)?.title, 'second session prompt');
  assert.deepEqual(store.getSession(first.id).messages(), first.messages());
  assert.deepEqual(store.getSession(second.id).messages(), second.messages());
  assert.equal(store.deleteSession(first.id), true);
  assert.equal(store.deleteSession(first.id), false);
  assert.deepEqual(store.listSessions().map(summary => summary.id), [second.id]);
  store.close();

  const reopened = new SqliteStore(root);
  assert.throws(() => reopened.getSession(first.id), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'not-found');
  assert.deepEqual(reopened.getSession(second.id).messages(), second.messages());
  reopened.close();
});

test('delete-all removes every session and memory atomically while preserving settings and folder grants', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'saved conversation' });
  store.saveSession(session);
  store.saveMemory('saved memory');
  store.initializeFilesystemRoots([root]);
  store.setAppSettings({ provider: 'placeholder' });
  const blocker = new DatabaseSync(store.databasePath);
  blocker.exec(`
    CREATE TRIGGER reject_memory_deletion
    BEFORE DELETE ON memories
    BEGIN
      SELECT RAISE(ABORT, 'blocked by test');
    END;
  `);
  blocker.close();

  assert.throws(
    () => store.deleteAllSessionsAndMemories(),
    (error: unknown) => error instanceof PersistenceError && error.code === 'database-error',
  );
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.listMemories().length, 1);
  const removeBlocker = new DatabaseSync(store.databasePath);
  removeBlocker.exec('DROP TRIGGER reject_memory_deletion');
  removeBlocker.close();

  assert.deepEqual(store.deleteAllSessionsAndMemories(), {
    sessionsDeleted: 1,
    memoriesDeleted: 1,
  });
  assert.deepEqual(store.listSessions(), []);
  assert.deepEqual(store.listMemories(), []);
  assert.deepEqual(store.listFilesystemRoots(), [root]);
  assert.equal(store.getAppSetting('provider'), 'placeholder');
  assert.deepEqual(store.deleteAllSessionsAndMemories(), {
    sessionsDeleted: 0,
    memoriesDeleted: 0,
  });
  store.close();

  const reopened = new SqliteStore(root);
  assert.deepEqual(reopened.listSessions(), []);
  assert.deepEqual(reopened.listMemories(), []);
  assert.deepEqual(reopened.listFilesystemRoots(), [root]);
  assert.equal(reopened.getAppSetting('provider'), 'placeholder');
  reopened.close();
});

test('SQLite backups are consistent, owner-only, and never overwrite an existing file', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(join(root, 'data'));
  const session = store.createSession();
  session.add({ role: 'user', content: 'private conversation fixture' });
  store.saveSession(session);
  const memoryId = store.saveMemory('private memory fixture');
  store.initializeFilesystemRoots([join(root, 'workspace')]);
  store.setAppSettings({ provider: 'placeholder' });
  const backupPath = join(root, 'vyomara-backup.sqlite');

  store.exportBackup(backupPath);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(
    (backup.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
    'ok',
  );
  assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  assert.equal(
    (backup.prepare('SELECT message_json FROM session_messages').get() as { message_json: string })
      .message_json.includes('private conversation fixture'),
    true,
  );
  assert.equal(
    (backup.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId) as { content: string }).content,
    'private memory fixture',
  );
  assert.equal(
    (backup.prepare('SELECT path FROM filesystem_roots').get() as { path: string }).path,
    join(root, 'workspace'),
  );
  const providerSetting = backup.prepare(
    'SELECT key, value FROM app_settings WHERE key = ?',
  ).get('provider') as { key: string; value: string };
  assert.equal(providerSetting.key, 'provider');
  assert.equal(providerSetting.value, 'placeholder');
  backup.close();

  assert.throws(() => store.exportBackup(backupPath), /could not be created without replacing/);
  assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  assert.throws(
    () => store.exportBackup(store.databasePath),
    (error: unknown) => error instanceof PersistenceError && error.code === 'invalid-path',
  );
  store.close();
});

test('filesystem roots initialize from config once and persist grants and revocations', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const initialRoots = [join(root, 'configured')];
  assert.deepEqual(store.initializeFilesystemRoots(initialRoots), initialRoots);
  assert.deepEqual(store.addFilesystemRoot(join(root, 'selected')), [
    join(root, 'configured'),
    join(root, 'selected'),
  ]);
  assert.deepEqual(store.removeFilesystemRoot(join(root, 'configured')), [join(root, 'selected')]);
  store.close();

  const reopened = new SqliteStore(root);
  assert.deepEqual(reopened.initializeFilesystemRoots([join(root, 'new-env-root')]), [
    join(root, 'selected'),
  ]);
  assert.deepEqual(reopened.removeFilesystemRoot(join(root, 'selected')), []);
  reopened.close();

  const afterRevoke = new SqliteStore(root);
  assert.deepEqual(afterRevoke.initializeFilesystemRoots(initialRoots), []);
  afterRevoke.close();
});

test('version 1 databases migrate filesystem permission tables without losing sessions', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'preserve this history' });
  store.saveSession(session);
  store.close();

  const database = new DatabaseSync(join(root, 'vyomara.sqlite'));
  database.exec(`
    DROP TABLE filesystem_roots;
    DROP TABLE app_settings;
    PRAGMA user_version = 1;
  `);
  database.close();

  const migrated = new SqliteStore(root);
  assert.deepEqual(migrated.getSession(session.id).messages(), [
    { role: 'user', content: 'preserve this history' },
  ]);
  assert.deepEqual(migrated.initializeFilesystemRoots([join(root, 'allowed')]), [
    join(root, 'allowed'),
  ]);
  migrated.close();
});

test('unsupported negative database versions fail without replacing stored data', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'keep existing history' });
  store.saveSession(session);
  store.close();

  const database = new DatabaseSync(join(root, 'vyomara.sqlite'));
  database.exec('PRAGMA user_version = -1');
  database.close();

  assert.throws(() => new SqliteStore(root), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'database-error');
  const unchanged = new DatabaseSync(join(root, 'vyomara.sqlite'), { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get()?.user_version, -1);
  assert.equal(
    unchanged.prepare('SELECT message_json FROM session_messages WHERE session_id = ?').get(session.id)?.message_json,
    JSON.stringify({ role: 'user', content: 'keep existing history' }),
  );
  unchanged.close();
});

test('session history enforces a bounded message count without replacing saved data', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'first saved turn' });
  store.saveSession(session);
  for (let index = 0; index < 1_000; index++) {
    session.add({ role: 'assistant', content: 'bounded fixture' });
  }
  assert.throws(() => store.saveSession(session), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  assert.deepEqual(store.getSession(session.id).messages(), [
    { role: 'user', content: 'first saved turn' },
  ]);
  store.close();
});

test('explicit memory is separate, inspectable, and deletable', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'Remember this only when explicitly saved.' });
  store.saveSession(session);
  assert.deepEqual(store.listMemories(), []);

  const content = 'User-approved memory content';
  const id = store.saveMemory(content);
  assert.equal(store.listMemories().length, 1);
  assert.equal(store.getMemory(id), content);
  assert.equal(store.deleteMemory(id), true);
  assert.equal(store.deleteMemory(id), false);
  assert.deepEqual(store.listMemories(), []);
  store.close();
});

test('stored messages are structurally validated and corruption is not discarded', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  const session = store.createSession();
  session.add({ role: 'user', content: 'keep this record' });
  store.saveSession(session);
  store.close();

  const database = new DatabaseSync(join(root, 'vyomara.sqlite'));
  database.prepare(
    'UPDATE session_messages SET message_json = ? WHERE session_id = ?',
  ).run('{"role":"user","content":"tampered","unexpected":true}', session.id);
  database.close();

  const reopened = new SqliteStore(root);
  assert.throws(() => reopened.getSession(session.id), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  assert.equal(reopened.listSessions().length, 1);
  reopened.close();
});

test('corrupt database fails visibly and is not overwritten', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'vyomara.sqlite');
  writeFileSync(path, 'not a sqlite database');
  chmodSync(path, 0o600);

  assert.throws(() => new SqliteStore(root), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'database-error');
  assert.equal(readFileSync(path, 'utf8'), 'not a sqlite database');
});

test('memory and session identifiers and memory size are validated', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  assert.throws(() => store.getSession('../invalid'), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  assert.throws(() => store.getMemory('not-an-id'), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  assert.throws(() => store.saveMemory('   '), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  assert.throws(() => store.saveMemory('x'.repeat(32_001)), (error: unknown) =>
    error instanceof PersistenceError && error.code === 'invalid-data');
  store.close();
});

test('audit events are persisted as metadata without conversation payloads', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  store.appendAuditEvent({
    event: 'tool.completed',
    taskId: 'task-id-fixture',
    runId: 'run-id-fixture',
    toolCallId: 'call-id-fixture',
    attempt: 1,
    toolId: 'read_file',
    durationMs: 12,
    outputChars: 45,
  });
  store.close();

  const database = new DatabaseSync(join(root, 'vyomara.sqlite'));
  const row = database.prepare('SELECT * FROM audit_events').get();
  database.close();
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes('private file content'), false);
  assert.equal(JSON.stringify(row).includes('file path fixture'), false);
});

test('VYOM_DATA_DIR is absolute and defaults under macOS Application Support', () => {
  assert.match(loadConfig({ VYOM_PROVIDER: 'placeholder' }).dataDirectory, /Library\/Application Support\/Vyomara$/);
  assert.equal(
    loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_DATA_DIR: '/tmp/vyom-test-data' }).dataDirectory,
    '/tmp/vyom-test-data',
  );
  assert.throws(
    () => loadConfig({ VYOM_DATA_DIR: 'relative/path' }),
    /VYOM_DATA_DIR must be an absolute local directory path/,
  );
});

test('model settings chosen in the app are saved and applied over the environment', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vyomara-settings-'));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({ VYOM_DATA_DIR: join(root, 'data') });
  assert.deepEqual(readModelSettings(config), {});
  saveSelectedModel(config, 'deepseek-r1:14b');
  saveModelSettings(config, { numCtx: 16_384, think: true });
  const saved = readModelSettings(config);
  assert.deepEqual(saved, { model: 'deepseek-r1:14b', numCtx: 16_384, think: true });
  const applied = withSavedModelSettings(config, saved);
  assert.equal(applied.ollamaModel, 'deepseek-r1:14b');
  assert.equal(applied.ollamaNumCtx, 16_384);
  assert.equal(applied.ollamaThink, true);
});

test('summary text drops app notes and footers and is shortened', async () => {
  const { summaryText } = await import('../src/storage/sqlite-store.ts');
  assert.equal(summaryText('[Note from the Vyomara app: undid changes.]\n\nFix the **cart** bug', 90), 'Fix the cart bug');
  assert.equal(summaryText('Done.\n\n---\n**Verified actions**\n- ✅ Edited `a.js`', 90), 'Done.');
  assert.equal(summaryText('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
  assert.equal(summaryText(undefined, 10), undefined);
});
