import { randomUUID, createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppConfig } from '../config/config.ts';
import { OperationStoppedError } from '../shared/bounded.ts';
import { ToolFailure } from '../tools/contracts.ts';
import type {
  DesktopFileOperationProposal,
  FileOperationApprovalPort,
  FileOperationRequest,
  FileOperationResult,
} from './contracts.ts';
import { resolveSafeFilesystemPath } from '../tools/filesystem-tools.ts';
import { sha256, type JournalEntry } from './change-journal.ts';
import { replaceText } from '../shared/text-replace.ts';

interface FileSnapshot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly contentHash?: string;
}

interface PreparedOperation {
  readonly targetPath: string;
  readonly directory: boolean;
  readonly snapshot?: FileSnapshot;
  readonly currentContent?: string;
}

interface PendingOperation {
  readonly request: FileOperationRequest;
  readonly proposal: DesktopFileOperationProposal;
  readonly snapshot?: FileSnapshot;
  readonly targetPath: string;
  readonly directory: boolean;
  readonly signal: AbortSignal;
  readonly resolve: (result: FileOperationResult) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbortListener: () => void;
  applying: boolean;
}

export interface FileOperationApprovalOptions {
  readonly config: AppConfig;
  readonly onProposal: (proposal: DesktopFileOperationProposal) => void;
  readonly moveToTrash: (path: string) => Promise<void>;
  /** Called after each change is applied, so it can be undone later. */
  readonly onApplied?: (entry: JournalEntry) => void;
}

/** A safe, user- and model-facing explanation of why a reviewed change could not proceed. */
export class FileOperationApprovalError extends ToolFailure {
  constructor(message: string) {
    super(message, 'tool-failed');
    this.name = 'FileOperationApprovalError';
  }
}

function publicOperationError(error: unknown): Error {
  if (error instanceof FileOperationApprovalError) return error;
  if (error instanceof ToolFailure) return new FileOperationApprovalError(error.message);
  if (error instanceof Error && !('code' in error)) return new FileOperationApprovalError(error.message);
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FileOperationApprovalError('The reviewed item no longer exists; no change was made.');
  }
  if (code === 'EEXIST') {
    return new FileOperationApprovalError('The destination became occupied after review; no change was made.');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FileOperationApprovalError('The operating system denied this file operation.');
  }
  return new FileOperationApprovalError('The reviewed file operation failed safely; no success is implied.');
}

function isAbortError(signal: AbortSignal): boolean {
  return signal.aborted;
}

function snapshotMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode &&
    (left.contentHash === undefined ||
      right.contentHash === undefined ||
      left.contentHash === right.contentHash);
}

function contentHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readFileSnapshot(
  path: string,
  expected: FileSnapshot,
  maximumBytes: number,
): Promise<{ readonly snapshot: FileSnapshot; readonly content: string; readonly bytes: Buffer }> {
  if (expected.size > maximumBytes) {
    throw new Error('The file exceeds the configured maximum size for reviewed changes.');
  }
  const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
      throw new Error('The file changed while it was being reviewed; retry the request.');
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > maximumBytes) {
      throw new Error('The file exceeds the configured maximum size for reviewed changes.');
    }
    const bytes = buffer.subarray(0, length);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Binary or invalid UTF-8 files cannot be edited as text.');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) {
      throw new Error('Binary files cannot be edited as text.');
    }
    const snapshot: FileSnapshot = {
      path,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mode: stats.mode,
      contentHash: contentHash(bytes),
    };
    return { snapshot, content, bytes };
  } finally {
    await file.close();
  }
}

async function pathSnapshot(path: string): Promise<FileSnapshot> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error('Only regular files and directories can be changed.');
  }
  return {
    path,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mode: stats.mode,
  };
}

export class FileOperationApprovalManager implements FileOperationApprovalPort {
  readonly #options: FileOperationApprovalOptions;
  readonly #pending = new Map<string, PendingOperation>();
  /** The user chose "approve all edits" for this task; deletions still need DELETE. */
  #approveEdits = false;

  constructor(options: FileOperationApprovalOptions) {
    this.#options = options;
  }

  async request(request: FileOperationRequest, signal: AbortSignal): Promise<FileOperationResult> {
    if (isAbortError(signal)) throw new OperationStoppedError('cancelled');
    let prepared: PreparedOperation;
    try {
      prepared = await this.#prepare(request, signal);
    } catch (error) {
      if (error instanceof OperationStoppedError) throw error;
      throw publicOperationError(error);
    }
    if (signal.aborted) throw new OperationStoppedError('cancelled');
    let reviewedRequest = request;
    const replacements = request.replacements ?? (request.replacement ? [request.replacement] : undefined);
    if (replacements) {
      if (request.operation !== 'edit-file' || prepared.currentContent === undefined) {
        throw new FileOperationApprovalError('Text replacement requires an existing regular file.');
      }
      let content = prepared.currentContent;
      for (const [index, { find, replace, all }] of replacements.entries()) {
        // Edits apply in order, each to the result of the previous one.
        const which = replacements.length > 1 ? `Edit ${index + 1}: ` : '';
        const replaced = replaceText(content, find, replace, all === true);
        if (!replaced.ok && replaced.reason === 'ambiguous') {
          throw new FileOperationApprovalError(
            `${which}old_text matches ${replaced.count ?? 'several'} places in the file. Include more surrounding lines so it matches exactly once, or set replace_all to true.`,
          );
        }
        if (!replaced.ok) {
          throw new FileOperationApprovalError(
            `${which}old_text was not found in the file${index > 0 ? ' (after the earlier edits were applied)' : ''}. Copy it exactly from read_file output (without the line numbers).`
              + (replaced.hint ? ` The closest lines in the file are:\n${replaced.hint}` : ' Read the file again first.'),
          );
        }
        content = replaced.content;
      }
      if (Buffer.byteLength(content, 'utf8') > this.#options.config.maxFileBytes) {
        throw new FileOperationApprovalError('The proposed file exceeds the configured maximum size.');
      }
      reviewedRequest = { operation: 'edit-file', path: request.path, content };
    }
    const id = randomUUID();
    const proposal: DesktopFileOperationProposal = {
      id,
      operation: request.operation,
      path: request.path,
      targetType: prepared.directory ? 'directory' : 'file',
      ...(prepared.currentContent === undefined ? {} : { currentContent: prepared.currentContent }),
      ...(reviewedRequest.content === undefined ? {} : { proposedContent: reviewedRequest.content }),
    };
    return new Promise<FileOperationResult>((resolveResult, rejectResult) => {
      const onAbort = (): void => {
        this.#finish(id, pending => pending.reject(new OperationStoppedError('cancelled')));
      };
      const pending: PendingOperation = {
        request: reviewedRequest,
        proposal,
        ...(prepared.snapshot === undefined ? {} : { snapshot: prepared.snapshot }),
        targetPath: prepared.targetPath,
        directory: prepared.directory,
        signal,
        resolve: resolveResult,
        reject: rejectResult,
        removeAbortListener: () => signal.removeEventListener('abort', onAbort),
        applying: false,
      };
      this.#pending.set(id, pending);
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.#approveEdits && request.operation !== 'delete') {
        queueMicrotask(() => { void this.approve(id).catch(() => undefined); });
        return;
      }
      try {
        this.#options.onProposal(proposal);
      } catch (error) {
        this.#finish(id, entry => entry.reject(
          error instanceof Error ? error : new Error('The file review request could not be displayed.'),
        ));
      }
    });
  }

  async approve(id: string, confirmation?: string): Promise<void> {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error('This file review is no longer active.');
    if (pending.applying) throw new Error('This file review is already being applied.');
    if (pending.request.operation === 'delete' && confirmation !== 'DELETE') {
      throw new FileOperationApprovalError('Type DELETE to confirm this specific deletion.');
    }
    pending.applying = true;
    try {
      await this.#apply(pending);
      this.#finish(id, entry => entry.resolve({ status: 'applied' }));
    } catch (error) {
      const safeError = publicOperationError(error);
      this.#finish(id, entry => entry.reject(
        safeError,
      ));
      throw safeError;
    }
  }

  /**
   * Approve this change and every later edit, new file, and new folder in the
   * same task. Deletions still need their own typed confirmation.
   */
  async approveAllEdits(id: string): Promise<void> {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error('This file review is no longer active.');
    if (pending.request.operation === 'delete') throw new FileOperationApprovalError('Deletions are confirmed one by one.');
    this.#approveEdits = true;
    const others = [...this.#pending.entries()]
      .filter(([otherId, other]) => otherId !== id && other.request.operation !== 'delete' && !other.applying)
      .map(([otherId]) => otherId);
    await this.approve(id);
    for (const otherId of others) await this.approve(otherId).catch(() => undefined);
  }

  reject(id: string): void {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error('This file review is no longer active.');
    if (pending.applying) throw new Error('This file review is already being applied.');
    this.#finish(id, entry => entry.resolve({ status: 'rejected' }));
  }

  #finish(id: string, finish: (pending: PendingOperation) => void): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.removeAbortListener();
    finish(pending);
  }

  async #prepare(
    request: FileOperationRequest,
    signal: AbortSignal,
  ): Promise<PreparedOperation> {
    const normalizedPath = resolve(request.path);
    if (
      request.operation === 'delete' &&
      ['/', '/Users', '/Volumes'].includes(normalizedPath)
    ) {
      throw new Error('This top-level system or user-data directory cannot be moved to Trash.');
    }
    if (request.operation === 'create-file' || request.operation === 'create-directory') {
      const parent = await resolveSafeFilesystemPath(dirname(normalizedPath), this.#options.config, 'directory', signal);
      const targetPath = join(parent.target, basename(normalizedPath));
      try {
        await lstat(targetPath);
        throw new Error('A file or folder already exists at the requested destination.');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { targetPath, directory: request.operation === 'create-directory' };
        }
        throw error;
      }
    }

    if (request.operation === 'edit-file') {
      const target = await resolveSafeFilesystemPath(normalizedPath, this.#options.config, 'file', signal);
      const initialSnapshot = await pathSnapshot(target.target);
      const read = await readFileSnapshot(target.target, initialSnapshot, this.#options.config.maxFileBytes);
      return {
        targetPath: target.target,
        directory: false,
        snapshot: read.snapshot,
        currentContent: read.content,
      };
    }

    let directory = false;
    try {
      const target = await resolveSafeFilesystemPath(normalizedPath, this.#options.config, 'directory', signal);
      directory = target.stats.isDirectory();
    } catch (error) {
      const target = await resolveSafeFilesystemPath(normalizedPath, this.#options.config, 'file', signal);
      directory = target.stats.isDirectory();
    }
    if (request.operation === 'delete' && directory) {
      const target = await resolveSafeFilesystemPath(normalizedPath, this.#options.config, 'directory', signal);
      return {
        targetPath: target.target,
        directory: true,
        snapshot: await pathSnapshot(target.target),
      };
    }
    const target = await resolveSafeFilesystemPath(normalizedPath, this.#options.config, 'file', signal);
    const initialSnapshot = await pathSnapshot(target.target);
    return { targetPath: target.target, directory: false, snapshot: initialSnapshot };
  }

  async #apply(pending: PendingOperation): Promise<void> {
    if (pending.signal.aborted) throw new OperationStoppedError('cancelled');
    const { request, targetPath } = pending;
    if (request.operation === 'create-file' || request.operation === 'create-directory') {
      const parent = await resolveSafeFilesystemPath(dirname(targetPath), this.#options.config, 'directory', pending.signal);
      if (parent.target !== dirname(targetPath)) {
        throw new Error('The destination folder changed after review; no file was created.');
      }
      try {
        await lstat(targetPath);
        throw new Error('The destination became occupied after review; no file was created.');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (request.operation === 'create-directory') {
        if (pending.signal.aborted) throw new OperationStoppedError('cancelled');
        await mkdir(targetPath, { mode: 0o700 });
        this.#options.onApplied?.({ kind: 'created-directory', path: targetPath });
        return;
      }
      const content = Buffer.from(request.content ?? '', 'utf8');
      if (content.length > this.#options.config.maxFileBytes) {
        throw new Error('The proposed file exceeds the configured maximum size.');
      }
      const file = await open(
        targetPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (pending.signal.aborted) throw new OperationStoppedError('cancelled');
        await file.writeFile(content);
        await file.sync();
      } catch (error) {
        await file.close();
        await unlink(targetPath).catch(() => undefined);
        throw error;
      }
      await file.close();
      this.#options.onApplied?.({ kind: 'created-file', path: targetPath, afterHash: sha256(content) });
      return;
    }

    const snapshot = pending.snapshot;
    if (!snapshot) throw new Error('The reviewed file snapshot is unavailable.');
    const safePath = await resolveSafeFilesystemPath(
      targetPath,
      this.#options.config,
      pending.directory ? 'directory' : 'file',
      pending.signal,
    );
    if (safePath.target !== targetPath) {
      throw new Error('The file path changed after review; no operation was performed.');
    }
    const current = await pathSnapshot(targetPath);
    if (!snapshotMatches(snapshot, current)) {
      throw new Error('The file changed after review; no operation was performed.');
    }
    let before: Buffer | undefined;
    if (snapshot.contentHash !== undefined) {
      const read = await readFileSnapshot(targetPath, current, this.#options.config.maxFileBytes);
      if (read.snapshot.contentHash !== snapshot.contentHash) {
        throw new Error('The file contents changed after review; no operation was performed.');
      }
      before = Buffer.from(read.bytes);
    }
    if (request.operation === 'delete') {
      if (pending.signal.aborted) throw new OperationStoppedError('cancelled');
      await this.#options.moveToTrash(targetPath);
      this.#options.onApplied?.({ kind: 'trashed', path: targetPath });
      return;
    }
    if (request.operation !== 'edit-file') throw new Error('Unsupported reviewed file operation.');
    const content = Buffer.from(request.content ?? '', 'utf8');
    if (content.length > this.#options.config.maxFileBytes) {
      throw new Error('The proposed file exceeds the configured maximum size.');
    }
    const temporaryPath = join(dirname(targetPath), `.vyomara-${randomUUID()}.tmp`);
    const temporary = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      snapshot.mode & 0o777,
    );
    try {
      await temporary.writeFile(content);
      await temporary.chmod(snapshot.mode & 0o777);
      await temporary.sync();
    } catch (error) {
      await temporary.close();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await temporary.close();
    try {
      const latest = await pathSnapshot(targetPath);
      if (!snapshotMatches(snapshot, latest)) {
        throw new Error('The file changed after review; no operation was performed.');
      }
      if (pending.signal.aborted) throw new OperationStoppedError('cancelled');
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    if (before !== undefined) {
      this.#options.onApplied?.({ kind: 'edited', path: targetPath, before, afterHash: sha256(content), mode: snapshot.mode });
    }
  }
}
