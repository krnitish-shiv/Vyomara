import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DiagnosticEvent } from '../diagnostics/logger.ts';
import type { SessionMessage } from '../session/session.ts';
import { Session } from '../session/session.ts';

const maximumMemoryChars = 32_000;
const maximumAuditEvents = 10_000;
const maximumSessionMessages = 1_000;
const maximumSessionBytes = 8 * 1024 * 1024;
const maximumFilesystemRoots = 32;
const maximumFilesystemRootChars = 4_096;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalBackupSummary {
  readonly sessions: number;
  readonly memories: number;
}

export class PersistenceError extends Error {
  readonly code: 'invalid-path' | 'database-error' | 'not-found' | 'invalid-data';

  constructor(
    message: string,
    code: PersistenceError['code'],
  ) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export interface StoredSessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  /** The first thing the user asked, shortened. */
  readonly title?: string;
  /** The last final reply, shortened. */
  readonly preview?: string;
}

/** Shorten stored text for a list: drop app notes and footers, collapse whitespace. */
export function summaryText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/^\[Note from the Vyomara app:[^\]]*\]\s*/u, '')
    .replace(/\n*\s*-{3,}\s*\n+\s*\**Verified actions\**[\s\S]*$/iu, '')
    .replace(/[`*_#>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text === '') return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
}

export interface StoredMemorySummary {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key));
}

function validToolCalls(value: unknown): value is SessionMessage & {
  readonly role: 'assistant';
  readonly kind: 'tool-call';
} {
  return isRecord(value) &&
    value.role === 'assistant' &&
    value.kind === 'tool-call' &&
    exactKeys(value, ['role', 'kind', 'content', 'toolCalls']) &&
    typeof value.content === 'string' &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(call =>
      isRecord(call) &&
      exactKeys(call, ['toolId', 'arguments']) &&
      typeof call.toolId === 'string' &&
      /^[a-z][a-z0-9_.-]{0,63}$/.test(call.toolId) &&
      isRecord(call.arguments));
}

function validSessionMessage(value: unknown): value is SessionMessage {
  if (!isRecord(value)) return false;
  if (value.role === 'user') {
    return exactKeys(value, ['role', 'content']) && typeof value.content === 'string';
  }
  if (value.role === 'assistant' && value.kind === undefined) {
    return exactKeys(value, ['role', 'content']) && typeof value.content === 'string';
  }
  if (value.role === 'tool') {
    return exactKeys(value, ['role', 'toolId', 'content']) &&
      typeof value.toolId === 'string' &&
      /^[a-z][a-z0-9_.-]{0,63}$/.test(value.toolId) &&
      typeof value.content === 'string';
  }
  if (value.role === 'assistant' && value.kind === 'tool-call') {
    return validToolCalls(value);
  }
  return false;
}

function assertUuid(value: string): void {
  if (!uuidPattern.test(value)) {
    throw new PersistenceError('The requested record ID is invalid.', 'invalid-data');
  }
}

function safeDirectory(dataDirectory: string): string {
  if (!isAbsolute(dataDirectory) || dataDirectory.trim() !== dataDirectory || dataDirectory.includes('\0')) {
    throw new PersistenceError('The local data directory must be an absolute path.', 'invalid-path');
  }
  const directory = resolve(dataDirectory);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new PersistenceError('The local data directory is not a safe directory.', 'invalid-path');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new PersistenceError(
        'The local data directory must be accessible only to the current user.',
        'invalid-path',
      );
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('The local data directory could not be created safely.', 'database-error');
  }
  return directory;
}

function prepareDatabaseFile(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new PersistenceError('The local database file is not a safe regular file.', 'invalid-path');
    }
    chmodSync(path, 0o600);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    if (isRecord(error) && error.code === 'ENOENT') {
      try {
        const descriptor = openSync(path, 'wx', 0o600);
        closeSync(descriptor);
      } catch {
        throw new PersistenceError('The local database file could not be created safely.', 'database-error');
      }
      return;
    }
    throw new PersistenceError('The local database file could not be checked safely.', 'database-error');
  }
}

function migrate(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get();
  const version = isRecord(versionRow) ? versionRow.user_version : undefined;
  if (typeof version !== 'number' || version < 0 || version > 2) {
    throw new PersistenceError('The local database version is not supported.', 'database-error');
  }

  if (version === 0) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE session_messages (
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          message_json TEXT NOT NULL,
          PRIMARY KEY (session_id, ordinal)
        ) STRICT;

        CREATE TABLE memories (
          id TEXT PRIMARY KEY NOT NULL,
          content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND ${maximumMemoryChars}),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY,
          occurred_at TEXT NOT NULL,
          event_name TEXT NOT NULL,
          task_id TEXT,
          run_id TEXT,
          details_json TEXT NOT NULL
        ) STRICT;

        CREATE INDEX sessions_updated_at ON sessions(updated_at DESC);
        CREATE INDEX audit_events_occurred_at ON audit_events(occurred_at DESC);
        PRAGMA user_version = 1;
      `);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('The local database migration failed safely.', 'database-error');
    }
  }

  if (version < 2) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        CREATE TABLE filesystem_roots (
          path TEXT PRIMARY KEY NOT NULL CHECK (length(path) BETWEEN 1 AND ${maximumFilesystemRootChars})
        ) STRICT;

        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        ) STRICT;

        PRAGMA user_version = 2;
      `);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('The local database migration failed safely.', 'database-error');
    }
  }
}

export function defaultDataDirectory(): string {
  return join(homedir(), 'Library', 'Application Support', 'Vyomara');
}

export class SqliteStore {
  readonly directory: string;
  readonly databasePath: string;
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(dataDirectory = defaultDataDirectory()) {
    this.directory = safeDirectory(dataDirectory);
    this.databasePath = join(this.directory, 'vyomara.sqlite');
    prepareDatabaseFile(this.databasePath);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.databasePath, {
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
      });
      chmodSync(this.databasePath, 0o600);
      database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      migrate(database);
    } catch (error) {
      database?.close();
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        'The local database could not be opened or migrated safely. Existing data was not replaced.',
        'database-error',
      );
    }
    if (!database) {
      throw new PersistenceError('The local database could not be opened safely.', 'database-error');
    }
    this.#database = database;
  }

  createSession(): Session {
    this.assertOpen();
    return new Session();
  }

  getSession(id: string): Session {
    this.assertOpen();
    assertUuid(id);
    const exists = this.#database.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!exists) throw new PersistenceError('The requested session was not found.', 'not-found');
    const size = this.#database.prepare(`
      SELECT COUNT(*) AS message_count,
             COALESCE(SUM(length(CAST(message_json AS BLOB))), 0) AS total_bytes
      FROM session_messages
      WHERE session_id = ?
    `).get(id);
    if (!isRecord(size) ||
      typeof size.message_count !== 'number' ||
      typeof size.total_bytes !== 'number' ||
      size.message_count > maximumSessionMessages ||
      size.total_bytes > maximumSessionBytes) {
      throw new PersistenceError(
        'Stored session history exceeds the supported size limit and was not loaded.',
        'invalid-data',
      );
    }
    const rows = this.#database.prepare(
      'SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY ordinal',
    ).all(id);
    const messages = rows.map(row => {
      if (!isRecord(row) || typeof row.message_json !== 'string') {
        throw new PersistenceError('Stored session data is invalid and was not changed.', 'invalid-data');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.message_json);
      } catch {
        throw new PersistenceError('Stored session data is invalid and was not changed.', 'invalid-data');
      }
      if (!validSessionMessage(parsed)) {
        throw new PersistenceError('Stored session data is invalid and was not changed.', 'invalid-data');
      }
      return parsed;
    });
    return new Session(id, messages);
  }

  saveSession(session: Session): void {
    this.assertOpen();
    assertUuid(session.id);
    const now = new Date().toISOString();
    const messages = session.messages();
    let serializedMessages: string[];
    try {
      serializedMessages = messages.map(message => JSON.stringify(message));
    } catch {
      throw new PersistenceError('Session history contains data that cannot be stored safely.', 'invalid-data');
    }
    if (
      serializedMessages.length > maximumSessionMessages ||
      serializedMessages.reduce((total, message) => total + Buffer.byteLength(message), 0) > maximumSessionBytes
    ) {
      throw new PersistenceError(
        `Session history exceeded the limit of ${maximumSessionMessages} messages or ${maximumSessionBytes} bytes. Start a new session.`,
        'invalid-data',
      );
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.prepare(
        `INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(session.id, now, now);
      this.#database.prepare('DELETE FROM session_messages WHERE session_id = ?').run(session.id);
      const insert = this.#database.prepare(
        'INSERT INTO session_messages (session_id, ordinal, message_json) VALUES (?, ?, ?)',
      );
      serializedMessages.forEach((message, ordinal) => {
        insert.run(session.id, ordinal, message);
      });
      this.#database.exec('COMMIT');
    } catch {
      this.#database.exec('ROLLBACK');
      throw new PersistenceError('Session history could not be saved safely.', 'database-error');
    }
  }

  listSessions(): readonly StoredSessionSummary[] {
    this.assertOpen();
    return this.#database.prepare(`
      SELECT s.id, s.created_at, s.updated_at, COUNT(m.ordinal) AS message_count,
        (SELECT substr(json_extract(f.message_json, '$.content'), 1, 600) FROM session_messages AS f
          WHERE f.session_id = s.id AND json_extract(f.message_json, '$.role') = 'user'
          ORDER BY f.ordinal LIMIT 1) AS title,
        (SELECT substr(json_extract(l.message_json, '$.content'), 1, 600) FROM session_messages AS l
          WHERE l.session_id = s.id AND json_extract(l.message_json, '$.role') = 'assistant'
            AND json_extract(l.message_json, '$.kind') IS NULL
          ORDER BY l.ordinal DESC LIMIT 1) AS preview
      FROM sessions AS s
      LEFT JOIN session_messages AS m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC, s.id
    `).all().map(row => {
      if (!isRecord(row) ||
        typeof row.id !== 'string' ||
        typeof row.created_at !== 'string' ||
        typeof row.updated_at !== 'string' ||
        typeof row.message_count !== 'number') {
        throw new PersistenceError('Stored session index is invalid.', 'invalid-data');
      }
      const title = summaryText(row.title, 90);
      const preview = summaryText(row.preview, 140);
      return {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        ...(title === undefined ? {} : { title }),
        ...(preview === undefined ? {} : { preview }),
      };
    });
  }

  initializeFilesystemRoots(defaultRoots: readonly string[]): readonly string[] {
    this.assertOpen();
    if (defaultRoots.length > maximumFilesystemRoots || defaultRoots.some(root => !this.validFilesystemRoot(root))) {
      throw new PersistenceError('Configured filesystem roots are invalid.', 'invalid-data');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const initialized = this.#database.prepare(
        'SELECT value FROM app_settings WHERE key = ?',
      ).get('filesystem-roots-initialized');
      if (initialized && (!isRecord(initialized) || initialized.value !== 'true')) {
        throw new PersistenceError('Stored filesystem permission state is invalid.', 'invalid-data');
      }
      if (!initialized) {
        const insert = this.#database.prepare('INSERT OR IGNORE INTO filesystem_roots (path) VALUES (?)');
        for (const root of defaultRoots) insert.run(root);
        this.#database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(
          'filesystem-roots-initialized',
          'true',
        );
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('Filesystem permissions could not be initialized safely.', 'database-error');
    }
    return this.listFilesystemRoots();
  }

  listFilesystemRoots(): readonly string[] {
    this.assertOpen();
    return this.#database.prepare('SELECT path FROM filesystem_roots ORDER BY path').all().map(row => {
      if (!isRecord(row) || typeof row.path !== 'string' || !this.validFilesystemRoot(row.path)) {
        throw new PersistenceError('Stored filesystem permissions are invalid.', 'invalid-data');
      }
      return row.path;
    });
  }

  getAppSetting(key: string): string | undefined {
    this.assertOpen();
    const row = this.#database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    if (row === undefined) return undefined;
    if (!isRecord(row) || typeof row.value !== 'string') {
      throw new PersistenceError('Stored application settings are invalid.', 'invalid-data');
    }
    return row.value;
  }

  setAppSettings(settings: Readonly<Record<string, string>>): void {
    this.assertOpen();
    const entries = Object.entries(settings);
    if (
      entries.length === 0 ||
      entries.some(([key, value]) => !/^[a-z][a-z0-9-]{0,63}$/.test(key) || value.length > 256)
    ) {
      throw new PersistenceError('Application settings are invalid.', 'invalid-data');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.#database.prepare(`
        INSERT INTO app_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      for (const [key, value] of entries) upsert.run(key, value);
      this.#database.exec('COMMIT');
    } catch {
      this.#database.exec('ROLLBACK');
      throw new PersistenceError('Application settings could not be saved safely.', 'database-error');
    }
  }

  deleteAppSettings(keys: readonly string[]): void {
    this.assertOpen();
    if (keys.length === 0 || keys.some(key => !/^[a-z][a-z0-9-]{0,63}$/.test(key))) {
      throw new PersistenceError('Application setting keys are invalid.', 'invalid-data');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const remove = this.#database.prepare('DELETE FROM app_settings WHERE key = ?');
      for (const key of keys) remove.run(key);
      this.#database.exec('COMMIT');
    } catch {
      this.#database.exec('ROLLBACK');
      throw new PersistenceError('Application settings could not be reset safely.', 'database-error');
    }
  }

  addFilesystemRoot(path: string): readonly string[] {
    this.assertOpen();
    if (!this.validFilesystemRoot(path)) {
      throw new PersistenceError('The selected filesystem root is invalid.', 'invalid-data');
    }
    const existing = this.listFilesystemRoots();
    if (existing.includes(path)) return existing;
    if (existing.length >= maximumFilesystemRoots) {
      throw new PersistenceError(`At most ${maximumFilesystemRoots} filesystem roots can be allowed.`, 'invalid-data');
    }
    try {
      this.#database.prepare('INSERT INTO filesystem_roots (path) VALUES (?)').run(path);
    } catch {
      throw new PersistenceError('The selected filesystem root could not be saved.', 'database-error');
    }
    return this.listFilesystemRoots();
  }

  removeFilesystemRoot(path: string): readonly string[] {
    this.assertOpen();
    if (!this.validFilesystemRoot(path)) {
      throw new PersistenceError('The requested filesystem root is invalid.', 'invalid-data');
    }
    this.#database.prepare('DELETE FROM filesystem_roots WHERE path = ?').run(path);
    return this.listFilesystemRoots();
  }

  deleteSession(id: string): boolean {
    this.assertOpen();
    assertUuid(id);
    return this.#database.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }

  saveMemory(content: string): string {
    this.assertOpen();
    if (content.trim() === '' || content.length > maximumMemoryChars) {
      throw new PersistenceError(
        `Memory must contain between 1 and ${maximumMemoryChars} characters.`,
        'invalid-data',
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#database.prepare(
      'INSERT INTO memories (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run(id, content, now, now);
    return id;
  }

  listMemories(): readonly StoredMemorySummary[] {
    this.assertOpen();
    return this.#database.prepare(
      'SELECT id, created_at, updated_at FROM memories ORDER BY created_at DESC, id',
    ).all().map(row => {
      if (!isRecord(row) ||
        typeof row.id !== 'string' ||
        typeof row.created_at !== 'string' ||
        typeof row.updated_at !== 'string') {
        throw new PersistenceError('Stored memory index is invalid.', 'invalid-data');
      }
      return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }

  getMemory(id: string): string {
    this.assertOpen();
    assertUuid(id);
    const row = this.#database.prepare('SELECT content FROM memories WHERE id = ?').get(id);
    if (!isRecord(row) || typeof row.content !== 'string') {
      throw new PersistenceError('The requested memory was not found.', 'not-found');
    }
    return row.content;
  }

  deleteMemory(id: string): boolean {
    this.assertOpen();
    assertUuid(id);
    return this.#database.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  deleteAllSessionsAndMemories(): { readonly sessionsDeleted: number; readonly memoriesDeleted: number } {
    this.assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const sessionsDeleted = Number(this.#database.prepare('DELETE FROM sessions').run().changes);
      const memoriesDeleted = Number(this.#database.prepare('DELETE FROM memories').run().changes);
      if (!Number.isSafeInteger(sessionsDeleted) || !Number.isSafeInteger(memoriesDeleted)) {
        throw new Error('Deleted record count exceeds the supported range.');
      }
      this.#database.exec('COMMIT');
      return { sessionsDeleted, memoriesDeleted };
    } catch {
      this.#database.exec('ROLLBACK');
      throw new PersistenceError(
        'Local conversations and memories could not be deleted safely.',
        'database-error',
      );
    }
  }

  exportBackup(destination: string): void {
    this.assertOpen();
    if (
      !isAbsolute(destination) ||
      destination.trim() !== destination ||
      destination.includes('\0') ||
      resolve(destination) === this.databasePath
    ) {
      throw new PersistenceError('The local backup destination is invalid.', 'invalid-path');
    }

    let stagingDirectory: string;
    try {
      stagingDirectory = mkdtempSync(join(dirname(destination), '.vyomara-backup-'));
    } catch {
      throw new PersistenceError('A private staging area for the local backup could not be created.', 'database-error');
    }
    const stagedDatabase = join(stagingDirectory, 'vyomara.sqlite');
    try {
      this.#database.prepare('VACUUM INTO ?').run(stagedDatabase);
      chmodSync(stagedDatabase, 0o600);
      linkSync(stagedDatabase, destination);
    } catch {
      throw new PersistenceError(
        'The local backup could not be created without replacing an existing file.',
        'database-error',
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  inspectBackup(sourcePath: string): LocalBackupSummary {
    this.assertOpen();
    if (
      !isAbsolute(sourcePath) ||
      sourcePath.trim() !== sourcePath ||
      sourcePath.includes('\0') ||
      resolve(sourcePath) === this.databasePath
    ) {
      throw new PersistenceError('The selected local backup path is invalid.', 'invalid-path');
    }

    let source: DatabaseSync | undefined;
    try {
      const sourceStats = lstatSync(sourcePath);
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
        throw new PersistenceError('The selected backup must be a regular file.', 'invalid-path');
      }
      source = new DatabaseSync(sourcePath, { readOnly: true });
      const versionRow = source.prepare('PRAGMA user_version').get();
      if (!isRecord(versionRow) || versionRow.user_version !== 2) {
        throw new PersistenceError('The selected backup version is not supported.', 'invalid-data');
      }
      const expectedSchema = this.#database.prepare(`
        SELECT type, name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all();
      const backupSchema = source.prepare(`
        SELECT type, name, sql FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `).all();
      if (JSON.stringify(backupSchema) !== JSON.stringify(expectedSchema)) {
        throw new PersistenceError('The selected backup does not have the expected Vyomara schema.', 'invalid-data');
      }
      const integrity = source.prepare('PRAGMA integrity_check').all();
      if (
        integrity.length !== 1 ||
        !isRecord(integrity[0]) ||
        integrity[0].integrity_check !== 'ok' ||
        source.prepare('PRAGMA foreign_key_check').all().length !== 0
      ) {
        throw new PersistenceError('The selected backup failed database integrity checks.', 'invalid-data');
      }
      const sessionRows = source.prepare(
        'SELECT id, created_at, updated_at FROM sessions',
      ).all();
      const readMessages = source.prepare(
        'SELECT message_json FROM session_messages WHERE session_id = ? ORDER BY ordinal',
      );
      for (const row of sessionRows) {
        if (
          !isRecord(row) ||
          typeof row.id !== 'string' ||
          typeof row.created_at !== 'string' ||
          !Number.isFinite(Date.parse(row.created_at)) ||
          typeof row.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(row.updated_at))
        ) {
          throw new PersistenceError('The selected backup contains an invalid session.', 'invalid-data');
        }
        assertUuid(row.id);
        const messages = readMessages.all(row.id);
        let totalBytes = 0;
        if (messages.length > maximumSessionMessages) {
          throw new PersistenceError('A session in the selected backup exceeds the supported size.', 'invalid-data');
        }
        for (const message of messages) {
          if (!isRecord(message) || typeof message.message_json !== 'string') {
            throw new PersistenceError('The selected backup contains invalid session data.', 'invalid-data');
          }
          totalBytes += Buffer.byteLength(message.message_json);
          let parsed: unknown;
          try {
            parsed = JSON.parse(message.message_json);
          } catch {
            throw new PersistenceError('The selected backup contains invalid session data.', 'invalid-data');
          }
          if (!validSessionMessage(parsed)) {
            throw new PersistenceError('The selected backup contains invalid session data.', 'invalid-data');
          }
        }
        if (totalBytes > maximumSessionBytes) {
          throw new PersistenceError('A session in the selected backup exceeds the supported size.', 'invalid-data');
        }
      }
      const memoryRows = source.prepare(
        'SELECT id, content, created_at, updated_at FROM memories',
      ).all();
      for (const row of memoryRows) {
        if (
          !isRecord(row) ||
          typeof row.id !== 'string' ||
          typeof row.content !== 'string' ||
          row.content.trim() === '' ||
          row.content.length > maximumMemoryChars ||
          typeof row.created_at !== 'string' ||
          !Number.isFinite(Date.parse(row.created_at)) ||
          typeof row.updated_at !== 'string' ||
          !Number.isFinite(Date.parse(row.updated_at))
        ) {
          throw new PersistenceError('The selected backup contains invalid memory data.', 'invalid-data');
        }
        assertUuid(row.id);
      }
      const roots = source.prepare('SELECT path FROM filesystem_roots').all();
      if (
        roots.length > maximumFilesystemRoots ||
        roots.some(row =>
          !isRecord(row) ||
          typeof row.path !== 'string' ||
          row.path.length === 0 ||
          row.path.length > maximumFilesystemRootChars ||
          row.path.trim() !== row.path ||
          row.path.includes('\0') ||
          !isAbsolute(row.path))
      ) {
        throw new PersistenceError('The selected backup contains invalid folder permissions.', 'invalid-data');
      }
      const settings = source.prepare('SELECT key, value FROM app_settings').all();
      const settingValues = new Map<string, string>();
      for (const row of settings) {
        if (
          !isRecord(row) ||
          typeof row.key !== 'string' ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(row.key) ||
          typeof row.value !== 'string' ||
          row.value.length > 256
        ) {
          throw new PersistenceError('The selected backup contains invalid application settings.', 'invalid-data');
        }
        settingValues.set(row.key, row.value);
      }
      if (
        (settingValues.has('provider') !== settingValues.has('ollama-model')) ||
        (settingValues.has('provider') &&
          settingValues.get('provider') !== 'ollama' &&
          settingValues.get('provider') !== 'placeholder') ||
        (settingValues.has('ollama-model') &&
          !/^[a-zA-Z0-9._:/-]{1,128}$/.test(settingValues.get('ollama-model') ?? '')) ||
        (settingValues.has('filesystem-roots-initialized') &&
          settingValues.get('filesystem-roots-initialized') !== 'true')
      ) {
        throw new PersistenceError('The selected backup contains unsupported application settings.', 'invalid-data');
      }
      const counts = source.prepare(`
        SELECT
          (SELECT COUNT(*) FROM sessions) AS sessions,
          (SELECT COUNT(*) FROM memories) AS memories
      `).get();
      if (
        !isRecord(counts) ||
        typeof counts.sessions !== 'number' ||
        typeof counts.memories !== 'number'
      ) {
        throw new PersistenceError('The selected backup summary is invalid.', 'invalid-data');
      }
      return { sessions: counts.sessions, memories: counts.memories };
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('The selected file is not a valid Vyomara backup.', 'invalid-data');
    } finally {
      source?.close();
    }
  }

  restoreBackup(sourcePath: string, safetyBackupPath: string): LocalBackupSummary {
    this.assertOpen();
    const summary = this.inspectBackup(sourcePath);
    if (
      !isAbsolute(safetyBackupPath) ||
      safetyBackupPath.trim() !== safetyBackupPath ||
      safetyBackupPath.includes('\0') ||
      resolve(safetyBackupPath) === resolve(sourcePath) ||
      resolve(safetyBackupPath) === this.databasePath
    ) {
      throw new PersistenceError('The pre-restore backup destination is invalid.', 'invalid-path');
    }

    let stagingDirectory: string;
    try {
      stagingDirectory = mkdtempSync(join(this.directory, '.vyomara-restore-'));
    } catch {
      throw new PersistenceError('A private staging area for restore could not be created.', 'database-error');
    }
    const stagedDatabase = join(stagingDirectory, 'vyomara.sqlite');
    try {
      copyFileSync(sourcePath, stagedDatabase, fsConstants.COPYFILE_EXCL);
      chmodSync(stagedDatabase, 0o600);
      this.inspectBackup(stagedDatabase);
      this.exportBackup(safetyBackupPath);
      this.close();
      renameSync(stagedDatabase, this.databasePath);
      return summary;
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        'Restore failed safely. The existing database was not replaced.',
        'database-error',
      );
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  appendAuditEvent(event: DiagnosticEvent): void {
    this.assertOpen();
    const record = event as DiagnosticEvent & { readonly taskId?: string; readonly runId?: string };
    const now = new Date().toISOString();
    this.#database.prepare(`
      INSERT INTO audit_events (occurred_at, event_name, task_id, run_id, details_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      now,
      event.event,
      record.taskId ?? null,
      record.runId ?? null,
      JSON.stringify(event),
    );
    this.#database.prepare(`
      DELETE FROM audit_events
      WHERE sequence <= COALESCE(
        (SELECT sequence FROM audit_events ORDER BY sequence DESC LIMIT 1 OFFSET ?),
        0
      )
    `).run(maximumAuditEvents);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) throw new PersistenceError('The local database is closed.', 'database-error');
  }

  private validFilesystemRoot(path: string): boolean {
    return path.length > 0 &&
      path.length <= maximumFilesystemRootChars &&
      path.trim() === path &&
      !path.includes('\0') &&
      isAbsolute(path);
  }
}
