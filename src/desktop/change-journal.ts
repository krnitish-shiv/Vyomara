import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Remembers the file changes the user approved during each request, so
 * "undo karo" can put them back. Only changes made through reviewed file
 * operations are recorded, and an undo never overwrites later edits: a file
 * is restored only if it is still exactly as Vyomara left it.
 */
export type JournalEntry =
  | { readonly kind: 'edited'; readonly path: string; readonly before: Buffer; readonly afterHash: string; readonly mode: number }
  | { readonly kind: 'created-file'; readonly path: string; readonly afterHash: string }
  | { readonly kind: 'created-directory'; readonly path: string }
  /** Moved to Trash: restored from Finder, not by Vyomara. */
  | { readonly kind: 'trashed'; readonly path: string };

export interface ChangeGroup {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly entries: readonly JournalEntry[];
}

export interface UndoResult {
  /** Paths put back as they were. */
  readonly restored: readonly string[];
  /** Of those, files Vyomara had created, now in the Trash. */
  readonly movedToTrash: readonly string[];
  /** Paths left alone, with the reason. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

export interface ChangeJournalOptions {
  /** Files Vyomara created are moved to Trash on undo, never deleted. */
  readonly moveToTrash: (path: string) => Promise<void>;
  /** How many requests can be undone, newest first. */
  readonly maxGroups?: number;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function currentHash(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return undefined;
    const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return sha256(await file.readFile());
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/** Write through a temporary file and rename, like reviewed edits. */
async function writeAtomically(path: string, content: Buffer, mode: number): Promise<void> {
  const temporaryPath = join(dirname(path), `.vyomara-${randomUUID()}.tmp`);
  const file = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    mode & 0o777,
  );
  try {
    await file.writeFile(content);
    await file.chmod(mode & 0o777);
    await file.sync();
  } catch (error) {
    await file.close();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await file.close();
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class ChangeJournal {
  readonly #options: ChangeJournalOptions;
  /** Oldest first. */
  #groups: { requestId: string; sessionId?: string; entries: JournalEntry[] }[] = [];

  constructor(options: ChangeJournalOptions) {
    this.#options = options;
  }

  /** Start recording a request's changes. */
  begin(requestId: string, sessionId?: string): void {
    this.#groups.push({ requestId, ...(sessionId === undefined ? {} : { sessionId }), entries: [] });
    const max = this.#options.maxGroups ?? 20;
    if (this.#groups.length > max) this.#groups = this.#groups.slice(-max);
  }

  /** The request's session id is known only once it has started; set it then. */
  setSession(requestId: string, sessionId: string): void {
    const group = this.#groups.find(item => item.requestId === requestId);
    if (group) group.sessionId = sessionId;
  }

  record(requestId: string, entry: JournalEntry): void {
    this.#groups.find(item => item.requestId === requestId)?.entries.push(entry);
  }

  /** The newest request that changed something. */
  last(): ChangeGroup | undefined {
    for (let index = this.#groups.length - 1; index >= 0; index -= 1) {
      const group = this.#groups[index];
      if (group && group.entries.length > 0) return { ...group, entries: [...group.entries] };
    }
    return undefined;
  }

  /** Put back the newest request's changes, newest change first. */
  async undoLast(): Promise<UndoResult & { readonly group?: ChangeGroup }> {
    const group = this.last();
    if (!group) return { restored: [], movedToTrash: [], skipped: [] };
    const restored: string[] = [];
    const movedToTrash: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const entry of [...group.entries].reverse()) {
      try {
        const reason = await this.#undo(entry);
        if (reason === undefined) {
          restored.push(entry.path);
          if (entry.kind === 'created-file') movedToTrash.push(entry.path);
        }
        else skipped.push({ path: entry.path, reason });
      } catch {
        skipped.push({ path: entry.path, reason: 'it could not be restored' });
      }
    }
    // Undone once: the same changes cannot be undone again.
    this.#groups = this.#groups.filter(item => item.requestId !== group.requestId);
    return { restored, movedToTrash, skipped, group };
  }

  /** Returns why the change was left alone, or undefined when undone. */
  async #undo(entry: JournalEntry): Promise<string | undefined> {
    switch (entry.kind) {
      case 'edited': {
        if (await currentHash(entry.path) !== entry.afterHash) return 'it was changed again after Vyomara edited it';
        await writeAtomically(entry.path, entry.before, entry.mode);
        return undefined;
      }
      case 'created-file': {
        if (await currentHash(entry.path) !== entry.afterHash) return 'it was changed after Vyomara created it';
        await this.#options.moveToTrash(entry.path);
        return undefined;
      }
      case 'created-directory': {
        const stats = await lstat(entry.path).catch(() => undefined);
        if (!stats?.isDirectory()) return 'it no longer exists';
        if ((await readdir(entry.path)).length > 0) return 'it is not empty';
        await rmdir(entry.path);
        return undefined;
      }
      default:
        return 'it is in the Trash; restore it from Finder';
    }
  }
}
