import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import type { Dir, Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { AppConfig } from '../config/config.ts';
import type {
  FileOperationApprovalPort,
  FileOperationKind,
  FileOperationRequest,
} from '../desktop/contracts.ts';
import { ToolFailure } from './contracts.ts';
import type { Tool, ToolArgumentSchema } from './contracts.ts';
import type { ToolRegistry } from './contracts.ts';
import type { ToolFailureCode } from './contracts.ts';

type EntryType = 'file' | 'directory' | 'symlink' | 'other';

interface PathInput {
  readonly path: string;
}

interface ListInput extends PathInput {
  readonly maxEntries?: number;
}

interface TreeInput extends PathInput {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
}

interface SearchInput {
  readonly query: string;
  readonly path?: string;
  readonly maxEntries?: number;
}

interface SearchOutput {
  readonly matches: readonly { readonly path: string; readonly type: 'file' | 'directory' }[];
  readonly scannedDirectories: number;
  readonly skippedDirectories: number;
  readonly truncated: boolean;
}

interface OperationOutput {
  readonly status: 'applied' | 'rejected';
  readonly operation: FileOperationKind;
  readonly path: string;
}

interface ListedEntry {
  readonly name: string;
  readonly type: EntryType;
}

interface ListOutput {
  readonly entries: readonly ListedEntry[];
  readonly truncated: boolean;
}

interface TreeEntry extends ListedEntry {
  readonly path: string;
  readonly depth: number;
  /** Set for dependency/build folders (node_modules, .git, …) that are listed but not expanded. */
  readonly collapsed?: true;
}

/**
 * Generated, dependency, and VCS folders. They are listed but never expanded
 * by the tree or traversed by searches, so results stay focused on source.
 */
export const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', '.pnpm-store',
  'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  '.parcel-cache', 'coverage', '.nyc_output', 'target', '.gradle', '.idea',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv',
  'venv', 'Pods', 'DerivedData', '.build', '.terraform', 'vendor',
]);

interface TreeOutput {
  readonly entries: readonly TreeEntry[];
  readonly truncated: boolean;
}

interface ReadOutput {
  readonly content: string;
  readonly bytes: number;
}

interface ResolvedPath {
  readonly root: string;
  readonly target: string;
  readonly stats: Stats;
}

export interface CanonicalRoot {
  readonly configured: string;
  readonly canonical: string;
}

export interface SafeFilesystemPath {
  readonly root: string;
  readonly target: string;
  readonly stats: Stats;
}

interface DirectoryHandle {
  read(): Promise<Dirent | null>;
  close(): Promise<void>;
}

interface ReadFileHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface FilesystemToolOperations {
  readonly openDirectory?: (path: string) => Promise<DirectoryHandle>;
  readonly openFile?: (path: string, flags: number) => Promise<ReadFileHandle>;
}

class FilesystemToolError extends ToolFailure {
  constructor(message: string, code: ToolFailureCode = 'tool-failed') {
    super(message, code);
    this.name = 'FilesystemToolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xD800 && current <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const following = value.charCodeAt(index + 1);
      if (following < 0xDC00 || following > 0xDFFF) return false;
      index += 1;
    } else if (current >= 0xDC00 && current <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    validUnicode(value) &&
    isAbsolute(value) &&
    !value.split(sep).includes('..');
}

function isWithin(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedRoot === sep ||
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function joinHome(...parts: string[]): string {
  return resolve(homedir(), ...parts);
}

const DEFAULT_PROTECTED_PATHS = [
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/private/etc',
  '/private/var',
  '/dev',
  '/proc',
  '/sys',
  '/boot',
  '/root',
  joinHome('Library', 'Keychains'),
  joinHome('Library', 'Application Support', 'Vyomara'),
  joinHome('.ssh'),
  joinHome('.gnupg'),
  joinHome('.aws'),
  joinHome('.azure'),
  joinHome('.kube'),
  joinHome('.config', 'gcloud'),
  joinHome('.config', 'gh'),
  joinHome('.docker'),
  joinHome('.local', 'share', 'keyrings'),
  joinHome('.netrc'),
  joinHome('.npmrc'),
  joinHome('.git-credentials'),
].map(path => resolve(path));

export function isProtectedFilesystemPath(
  path: string,
  roots: readonly CanonicalRoot[],
  additionalProtectedPaths: readonly string[] = [],
): boolean {
  if (!roots.some(root => root.canonical === sep)) return false;
  const normalized = resolve(path);
  return DEFAULT_PROTECTED_PATHS.some(protectedPath => isWithin(protectedPath, normalized)) ||
    additionalProtectedPaths.some(protectedPath => isWithin(resolve(protectedPath), normalized));
}

/** Convert a simple filename glob (`*`, `?`) to an anchored, case-insensitive RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'iu');
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new FilesystemToolError('Filesystem operation was cancelled.');
}

function closeDirectoryOnAbort(directory: Pick<Dir, 'close'>, signal: AbortSignal): () => void {
  const close = () => {
    void directory.close().catch(() => undefined);
  };
  signal.addEventListener('abort', close, { once: true });
  return () => signal.removeEventListener('abort', close);
}

function closeFileOnAbort(file: Pick<FileHandle, 'close'>, signal: AbortSignal): () => void {
  const close = () => {
    void file.close().catch(() => undefined);
  };
  signal.addEventListener('abort', close, { once: true });
  return () => signal.removeEventListener('abort', close);
}

function publicFilesystemError(error: unknown): FilesystemToolError {
  if (error instanceof FilesystemToolError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FilesystemToolError('The requested file or directory was not found. Do not guess paths: use find_files with its name to locate it. To find a function, class, or variable, use search_text with its name; it is usually not a file name.', 'not-found');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FilesystemToolError('The filesystem path is not accessible.', 'permission-denied');
  }
  if (code === 'ELOOP') {
    return new FilesystemToolError('Symbolic links are not allowed in requested paths.', 'invalid-path');
  }
  return new FilesystemToolError('The filesystem operation failed safely.', 'tool-failed');
}

async function canonicalRoots(roots: readonly string[], signal: AbortSignal): Promise<CanonicalRoot[]> {
  if (roots.length === 0) {
    throw new FilesystemToolError(
      'Filesystem access is unavailable because no allowed roots are configured.',
      'permission-denied',
    );
  }
  const result: CanonicalRoot[] = [];
  for (const configuredRoot of roots) {
    checkCancelled(signal);
    try {
      const root = await realpath(configuredRoot);
      if (!(await stat(root)).isDirectory()) {
        throw new FilesystemToolError('A configured filesystem root is not a directory.', 'invalid-path');
      }
      result.push({ configured: configuredRoot, canonical: root });
    } catch (error) {
      throw publicFilesystemError(error);
    }
  }
  return result.filter((item, index) =>
    result.findIndex(other => other.canonical === item.canonical) === index);
}

async function resolveAllowedPath(
  inputPath: string,
  roots: readonly CanonicalRoot[],
  kind: 'file' | 'directory',
  signal: AbortSignal,
  additionalProtectedPaths: readonly string[] = [],
): Promise<SafeFilesystemPath> {
  if (!validPath(inputPath)) {
    throw new FilesystemToolError(
      'The filesystem path is invalid; use an absolute path without parent traversal.',
      'invalid-path',
    );
  }
  const normalized = resolve(inputPath);
  if (isProtectedFilesystemPath(normalized, roots, additionalProtectedPaths)) {
    throw new FilesystemToolError('Protected system and credential paths are not accessible.', 'permission-denied');
  }
  const matchingRoots = roots
    .filter(root => isWithin(root.configured, normalized) || isWithin(root.canonical, normalized))
    .sort((left, right) => {
      const leftLength = Math.max(
        isWithin(left.configured, normalized) ? left.configured.length : 0,
        isWithin(left.canonical, normalized) ? left.canonical.length : 0,
      );
      const rightLength = Math.max(
        isWithin(right.configured, normalized) ? right.configured.length : 0,
        isWithin(right.canonical, normalized) ? right.canonical.length : 0,
      );
      return rightLength - leftLength;
    });
  const matchedRoot = matchingRoots[0];
  if (!matchedRoot) {
    throw new FilesystemToolError('The requested path is outside the allowed filesystem roots.', 'outside-root');
  }

  const lexicalRoot = isWithin(matchedRoot.configured, normalized)
    ? matchedRoot.configured
    : matchedRoot.canonical;
  const suffix = relative(lexicalRoot, normalized);
  const root = matchedRoot.canonical;
  const expectedTarget = resolve(root, suffix);
  let actualTarget: string;
  try {
    actualTarget = await realpath(normalized);
  } catch (error) {
    throw publicFilesystemError(error);
  }
  if (!isWithin(root, actualTarget)) {
    throw new FilesystemToolError('Symbolic links are not allowed in requested paths.', 'invalid-path');
  }
  if (isProtectedFilesystemPath(actualTarget, roots, additionalProtectedPaths)) {
    throw new FilesystemToolError('Protected system and credential paths are not accessible.', 'permission-denied');
  }
  if (actualTarget !== expectedTarget) {
    throw new FilesystemToolError('Symbolic links are not allowed in requested paths.', 'invalid-path');
  }

  const segments = relative(root, expectedTarget).split(sep).filter(Boolean);
  let current = root;
  let currentStats: Stats;
  try {
    currentStats = await lstat(root);
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) {
      throw new FilesystemToolError('Configured filesystem root is not a safe directory.', 'invalid-path');
    }
    for (const segment of segments) {
      checkCancelled(signal);
      current = resolve(current, segment);
      currentStats = await lstat(current);
      if (currentStats.isSymbolicLink()) {
        throw new FilesystemToolError('Symbolic links are not allowed in requested paths.', 'invalid-path');
      }
    }
    const canonicalTarget = await realpath(current);
    if (!isWithin(root, canonicalTarget)) {
      throw new FilesystemToolError('The requested path is outside the allowed filesystem roots.', 'outside-root');
    }
    if (canonicalTarget !== expectedTarget) {
      throw new FilesystemToolError('Symbolic links are not allowed in requested paths.', 'invalid-path');
    }
  } catch (error) {
    throw publicFilesystemError(error);
  }

  if (kind === 'file' && !currentStats.isFile()) {
    throw new FilesystemToolError('The requested path is not a regular file.', 'invalid-path');
  }
  if (kind === 'directory' && !currentStats.isDirectory()) {
    throw new FilesystemToolError('The requested path is not a directory.', 'invalid-path');
  }
  return { root, target: current, stats: currentStats };
}

export async function resolveSafeFilesystemPath(
  inputPath: string,
  config: AppConfig,
  kind: 'file' | 'directory',
  signal: AbortSignal,
): Promise<SafeFilesystemPath> {
  return resolveAllowedPath(
    inputPath,
    await canonicalRoots(config.filesystemAllowedRoots, signal),
    kind,
    signal,
    [config.dataDirectory],
  );
}

function entryType(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  return 'other';
}

function outputFits(value: unknown, maximum: number): boolean {
  return JSON.stringify(value).length <= maximum;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function retainLexicallyFirst<T extends { readonly name: string }>(
  entries: T[],
  candidate: T,
  maximum: number,
): boolean {
  if (maximum < 1) return false;
  const position = entries.findIndex(entry => compareText(entry.name, candidate.name) > 0);
  entries.splice(position < 0 ? entries.length : position, 0, candidate);
  if (entries.length > maximum) {
    entries.pop();
    return false;
  }
  return true;
}

async function hasDirectoryEntries(
  path: string,
  signal: AbortSignal,
  openDirectory: (path: string) => Promise<DirectoryHandle>,
): Promise<boolean> {
  let directory;
  let removeAbortListener: (() => void) | undefined;
  try {
    directory = await openDirectory(path);
    removeAbortListener = closeDirectoryOnAbort(directory, signal);
    checkCancelled(signal);
    return (await directory.read()) !== null;
  } catch (error) {
    throw publicFilesystemError(error);
  } finally {
    removeAbortListener?.();
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The iterator may already have closed the directory handle.
      }
    }
  }
}

async function listDirectory(
  input: ListInput,
  config: AppConfig,
  signal: AbortSignal,
  openDirectory: (path: string) => Promise<DirectoryHandle>,
): Promise<ListOutput> {
  const roots = await canonicalRoots(config.filesystemAllowedRoots, signal);
  const target = await resolveAllowedPath(input.path, roots, 'directory', signal, [config.dataDirectory]);
  const limit = input.maxEntries ?? config.maxDirectoryEntries;
  const entries: ListedEntry[] = [];
  let truncated = false;
  let directory;
  let removeAbortListener: (() => void) | undefined;
  try {
    directory = await openDirectory(target.target);
    removeAbortListener = closeDirectoryOnAbort(directory, signal);
    while (true) {
      checkCancelled(signal);
      const entry = await directory.read();
      if (!entry) break;
      const candidate = { name: entry.name, type: entryType(entry) } satisfies ListedEntry;
      if (!retainLexicallyFirst(entries, candidate, limit)) {
        truncated = true;
      }
    }
  } catch (error) {
    throw publicFilesystemError(error);
  } finally {
    removeAbortListener?.();
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The iterator may already have closed the directory handle.
      }
    }
  }
  while (entries.length > 0 && !outputFits({ entries, truncated: true }, config.maxToolOutputChars)) {
    entries.pop();
    truncated = true;
  }
  return { entries, truncated };
}

async function readFile(
  input: PathInput,
  config: AppConfig,
  signal: AbortSignal,
  openFile: (path: string, flags: number) => Promise<ReadFileHandle>,
): Promise<ReadOutput> {
  const roots = await canonicalRoots(config.filesystemAllowedRoots, signal);
  const target = await resolveAllowedPath(input.path, roots, 'file', signal, [config.dataDirectory]);
  if (target.stats.size > config.maxFileBytes) {
    throw new FilesystemToolError(
      `File is ${target.stats.size} bytes, above the ${config.maxFileBytes}-byte readable limit. Use search_text to find the relevant lines instead.`,
    );
  }

  let file;
  let removeAbortListener: (() => void) | undefined;
  try {
    file = await openFile(target.target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    removeAbortListener = closeFileOnAbort(file, signal);
    const openedStats = await file.stat();
    if (!openedStats.isFile() || openedStats.dev !== target.stats.dev || openedStats.ino !== target.stats.ino) {
      throw new FilesystemToolError('File changed while it was being opened; retry the request.');
    }
    if (openedStats.size > config.maxFileBytes) {
      throw new FilesystemToolError('File exceeds the configured maximum size.');
    }

    const buffer = Buffer.alloc(config.maxFileBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      checkCancelled(signal);
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > config.maxFileBytes) {
      throw new FilesystemToolError('File exceeds the configured maximum size.');
    }

    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new FilesystemToolError('File is not valid UTF-8 text.');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) {
      throw new FilesystemToolError('Binary files cannot be read as text.');
    }
    return { content, bytes };
  } catch (error) {
    throw publicFilesystemError(error);
  } finally {
    removeAbortListener?.();
    if (file) {
      try {
        await file.close();
      } catch {
        // Preserve the original operation error.
      }
    }
  }
}

async function directoryTree(
  input: TreeInput,
  config: AppConfig,
  signal: AbortSignal,
  openDirectory: (path: string) => Promise<DirectoryHandle>,
): Promise<TreeOutput> {
  const roots = await canonicalRoots(config.filesystemAllowedRoots, signal);
  const target = await resolveAllowedPath(input.path, roots, 'directory', signal, [config.dataDirectory]);
  const maxDepth = input.maxDepth ?? config.maxTreeDepth;
  const maxEntries = input.maxEntries ?? config.maxDirectoryEntries;
  const entries: TreeEntry[] = [];
  let truncated = false;
  let stopTraversal = false;

  const visit = async (directoryPath: string, relativeParent: string, depth: number): Promise<void> => {
    if (depth > maxDepth || stopTraversal) return;
    checkCancelled(signal);
    let directory;
    const children: Dirent[] = [];
    let omittedChildren = false;
    let removeAbortListener: (() => void) | undefined;
    try {
      directory = await openDirectory(directoryPath);
      removeAbortListener = closeDirectoryOnAbort(directory, signal);
      while (true) {
        checkCancelled(signal);
        const entry = await directory.read();
        if (!entry) break;
        const remaining = maxEntries - entries.length;
        if (remaining <= 0) {
          omittedChildren = true;
          break;
        }
        // Scan the whole directory while retaining only the lexically first
        // candidates that can fit in the remaining global entry budget.
        if (!retainLexicallyFirst(children, entry, remaining)) omittedChildren = true;
      }
    } catch (error) {
      throw publicFilesystemError(error);
    } finally {
      removeAbortListener?.();
      if (directory) {
        try {
          await directory.close();
        } catch {
          // The iterator may already have closed the directory handle.
        }
      }
    }

    for (const child of children) {
      if (stopTraversal) break;
      if (entries.length >= maxEntries) {
        truncated = true;
        stopTraversal = true;
        break;
      }
      const entryPath = relativeParent ? `${relativeParent}/${child.name}` : child.name;
      const type = entryType(child);
      if (isProtectedFilesystemPath(resolve(directoryPath, child.name), roots, [config.dataDirectory])) {
        truncated = true;
        continue;
      }
      const candidate: TreeEntry = { name: child.name, path: entryPath, type, depth };
      if (!outputFits({ entries: [...entries, candidate], truncated: true }, config.maxToolOutputChars)) {
        truncated = true;
        stopTraversal = true;
        break;
      }
      entries.push(candidate);
      if (type !== 'directory') continue;
      if (SKIPPED_DIRECTORY_NAMES.has(child.name)) {
        entries[entries.length - 1] = { ...candidate, collapsed: true };
        continue;
      }

      let safeChild: ResolvedPath | undefined;
      try {
        safeChild = await resolveAllowedPath(
          resolve(directoryPath, child.name),
          roots,
          'directory',
          signal,
          [config.dataDirectory],
        );
      } catch (error) {
        if (
          error instanceof FilesystemToolError &&
          error.message === 'Symbolic links are not allowed in requested paths.'
        ) {
          const index = entries.findIndex(item => item.path === entryPath);
          if (index >= 0) entries[index] = { ...candidate, type: 'symlink' };
        } else {
          throw error;
        }
      }
      if (!safeChild) continue;
      if (depth < maxDepth) {
        await visit(safeChild.target, entryPath, depth + 1);
      } else if (await hasDirectoryEntries(safeChild.target, signal, openDirectory)) {
        truncated = true;
      }
    }

    if (omittedChildren) {
      truncated = true;
      stopTraversal = true;
    }
  };

  try {
    await visit(target.target, '', 1);
  } catch (error) {
    throw publicFilesystemError(error);
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return { entries, truncated };
}

async function searchFilesystem(
  input: SearchInput,
  config: AppConfig,
  signal: AbortSignal,
  openDirectory: (path: string) => Promise<DirectoryHandle>,
): Promise<SearchOutput> {
  const roots = await canonicalRoots(config.filesystemAllowedRoots, signal);
  const targetPath = input.path ?? roots[0]?.configured;
  if (!targetPath) {
    throw new FilesystemToolError('Filesystem access is unavailable because no allowed roots are configured.', 'permission-denied');
  }
  const target = await resolveAllowedPath(targetPath, roots, 'directory', signal, [config.dataDirectory]);
  const query = input.query.toLocaleLowerCase();
  const globPattern = /[*?]/.test(query) ? globToRegExp(query) : undefined;
  const nameMatches = (name: string): boolean => {
    const lower = name.toLocaleLowerCase();
    return globPattern ? globPattern.test(lower) : lower.includes(query);
  };
  const limit = input.maxEntries ?? config.maxDirectoryEntries;
  const directoryLimit = 10_000;
  const depthLimit = 32;
  const prioritizeHome = input.path === undefined && roots.some(root => root.canonical === sep);
  const home = resolve(homedir());
  const projectRootNames = new Set([
    'code',
    'codes',
    'developer',
    'development',
    'dev',
    'documents',
    'desktop',
    'downloads',
    'projects',
    'repos',
    'repositories',
    'source',
    'src',
    'work',
    'workspace',
    'workspaces',
  ]);
  const projectPending: { path: string; depth: number }[] = [];
  const homePending: { path: string; depth: number }[] = [];
  const otherPending: { path: string; depth: number }[] = [];
  let projectIndex = 0;
  let homeIndex = 0;
  let otherIndex = 0;
  const enqueue = (directory: { path: string; depth: number }): void => {
    const path = resolve(directory.path);
    const relativeToHome = relative(home, path);
    const isInsideHome = relativeToHome === '' ||
      (!isAbsolute(relativeToHome) &&
        relativeToHome !== '..' &&
        !relativeToHome.startsWith(`..${sep}`));
    const firstHomeSegment = relativeToHome.split(sep)[0]?.toLocaleLowerCase();
    const prioritizedProjectPath = isInsideHome && (
      relativeToHome === '' ||
      (firstHomeSegment !== undefined && projectRootNames.has(firstHomeSegment))
    );
    const isAncestorOfHome = path === sep || home.startsWith(`${path}${sep}`);
    if (prioritizeHome && (prioritizedProjectPath || isAncestorOfHome)) {
      projectPending.push(directory);
    } else if (prioritizeHome && isInsideHome) {
      homePending.push(directory);
    } else {
      otherPending.push(directory);
    }
  };
  enqueue({ path: target.target, depth: 0 });
  const matches: SearchOutput['matches'][number][] = [];
  let scannedDirectories = 0;
  let skippedDirectories = 0;
  let truncated = false;
  let exactNameMatchFound = false;

  while (
    projectIndex < projectPending.length ||
    homeIndex < homePending.length ||
    otherIndex < otherPending.length
  ) {
    checkCancelled(signal);
    if (scannedDirectories >= directoryLimit || matches.length >= limit) {
      truncated = true;
      break;
    }
    const current = projectIndex < projectPending.length
      ? projectPending[projectIndex++]
      : homeIndex < homePending.length
        ? homePending[homeIndex++]
        : otherPending[otherIndex++];
    if (!current) break;
    let directory;
    let removeAbortListener: (() => void) | undefined;
    const children: Dirent[] = [];
    try {
      directory = await openDirectory(current.path);
      removeAbortListener = closeDirectoryOnAbort(directory, signal);
      scannedDirectories += 1;
      while (true) {
        checkCancelled(signal);
        const entry = await directory.read();
        if (!entry) break;
        if (!retainLexicallyFirst(children, entry, 1_000)) truncated = true;
      }
    } catch (error) {
      if (
        scannedDirectories > 0 &&
        error instanceof Error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ENOENT' || error.code === 'ENOTDIR')
      ) {
        skippedDirectories += 1;
        truncated = true;
        continue;
      }
      throw publicFilesystemError(error);
    } finally {
      removeAbortListener?.();
      if (directory) {
        try {
          await directory.close();
        } catch {
          // The iterator may already have closed the directory handle.
        }
      }
    }

    const childDirectories: string[] = [];
    for (const child of children) {
      checkCancelled(signal);
      const childPath = resolve(current.path, child.name);
      const type = entryType(child);
      if (isProtectedFilesystemPath(childPath, roots, [config.dataDirectory])) {
        if (type === 'directory') skippedDirectories += 1;
        truncated = true;
        continue;
      }
      if ((type === 'file' || type === 'directory') && nameMatches(child.name)) {
        matches.push({ path: childPath, type });
        if (!globPattern && child.name.toLocaleLowerCase() === query) {
          exactNameMatchFound = true;
          break;
        }
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (type !== 'directory') continue;
      if (SKIPPED_DIRECTORY_NAMES.has(child.name) || child.name === '.Trash') continue;
      if (current.depth >= depthLimit) {
        truncated = true;
        continue;
      }
      try {
        const safeChild = await resolveAllowedPath(
          childPath,
          roots,
          'directory',
          signal,
          [config.dataDirectory],
        );
        childDirectories.push(safeChild.target);
      } catch (error) {
        if (
          error instanceof FilesystemToolError &&
          ['invalid-path', 'permission-denied', 'not-found'].includes(error.code)
        ) {
          skippedDirectories += 1;
          truncated = true;
          continue;
        }
        throw error;
      }
    }
    if (exactNameMatchFound) {
      truncated = true;
      break;
    }
    for (const childPath of childDirectories) {
      enqueue({ path: childPath, depth: current.depth + 1 });
    }
  }

  matches.sort((left, right) => compareText(left.path, right.path));
  while (
    matches.length > 0 &&
    !outputFits(
      { matches, scannedDirectories, skippedDirectories, truncated: true },
      config.maxToolOutputChars,
    )
  ) {
    matches.pop();
    truncated = true;
  }
  return { matches, scannedDirectories, skippedDirectories, truncated };
}

// ---------------------------------------------------------------------------
// Content search (search_text)
// ---------------------------------------------------------------------------

interface TextSearchInput {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string;
  readonly ignore_case?: boolean;
  readonly max_results?: number;
}

interface TextSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

interface TextSearchOutput {
  readonly matches: readonly TextSearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
  /** Set when nothing matched: how to search more widely. */
  readonly hint?: string;
}

const TEXT_SEARCH_MAX_FILE_BYTES = 1_048_576;
const TEXT_SEARCH_MAX_FILES = 25_000;

function searchExpression(pattern: string, ignoreCase: boolean): RegExp {
  const flags = ignoreCase ? 'iu' : 'u';
  try {
    return new RegExp(pattern, flags);
  } catch {
    // Not a valid regular expression: search for the literal text instead.
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
}

async function searchText(
  input: TextSearchInput,
  config: AppConfig,
  signal: AbortSignal,
  openDirectory: (path: string) => Promise<DirectoryHandle>,
): Promise<TextSearchOutput> {
  const roots = await canonicalRoots(config.filesystemAllowedRoots, signal);
  const protectedExtra = [config.dataDirectory];
  let start: SafeFilesystemPath;
  try {
    start = await resolveAllowedPath(input.path, roots, 'directory', signal, protectedExtra);
  } catch (error) {
    if (!(error instanceof FilesystemToolError) || error.code !== 'invalid-path') throw error;
    start = await resolveAllowedPath(input.path, roots, 'file', signal, protectedExtra);
  }
  const expression = searchExpression(input.pattern, input.ignore_case ?? false);
  const fileFilter = input.glob ? globToRegExp(input.glob) : undefined;
  const limit = input.max_results ?? 100;
  const matches: TextSearchMatch[] = [];
  let filesScanned = 0;
  let truncated = false;
  let outputChars = 64;

  const scanFile = async (path: string): Promise<boolean> => {
    let file;
    try {
      file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > TEXT_SEARCH_MAX_FILE_BYTES) return true;
      const buffer = Buffer.alloc(stats.size);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      if (bytes.subarray(0, 8192).includes(0)) return true;
      filesScanned += 1;
      const lines = bytes.toString('utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        expression.lastIndex = 0;
        if (!expression.test(line)) continue;
        const text = line.length > 240 ? `${line.slice(0, 240)}…` : line;
        const match = { path, line: index + 1, text };
        outputChars += JSON.stringify(match).length + 1;
        if (matches.length >= limit || outputChars > config.maxToolOutputChars - 256) {
          truncated = true;
          return false;
        }
        matches.push(match);
      }
      return true;
    } catch {
      return true;
    } finally {
      await file?.close().catch(() => undefined);
    }
  };

  if (start.stats.isFile()) {
    await scanFile(start.target);
    return { matches, filesScanned, truncated };
  }

  const pending: string[] = [start.target];
  while (pending.length > 0) {
    checkCancelled(signal);
    const directoryPath = pending.shift();
    if (directoryPath === undefined) break;
    const children: Dirent[] = [];
    let directory;
    try {
      directory = await openDirectory(directoryPath);
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        children.push(entry);
      }
    } catch {
      truncated = true;
      continue;
    } finally {
      await directory?.close().catch(() => undefined);
    }
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      checkCancelled(signal);
      const childPath = resolve(directoryPath, child.name);
      if (isProtectedFilesystemPath(childPath, roots, protectedExtra)) continue;
      if (child.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(child.name)) pending.push(childPath);
        continue;
      }
      if (!child.isFile()) continue;
      if (fileFilter && !fileFilter.test(child.name)) continue;
      if (filesScanned >= TEXT_SEARCH_MAX_FILES) {
        return { matches, filesScanned, truncated: true };
      }
      if (!await scanFile(childPath)) return { matches, filesScanned, truncated: true };
    }
  }
  return withSearchHint({ matches, filesScanned, truncated }, input);
}

/** With no matches, say how to widen the search, so the model does not conclude the code is absent. */
function withSearchHint(output: TextSearchOutput, input: TextSearchInput): TextSearchOutput {
  if (output.matches.length > 0) return output;
  const tips = [
    ...(input.glob ? [`the glob "${input.glob}" may exclude the right files: retry without glob`] : []),
    ...(input.ignore_case ? [] : ['retry with ignore_case: true']),
    'search a shorter or simpler pattern (part of the name)',
  ];
  return { ...output, hint: `No matches in ${output.filesScanned} files. Before concluding it does not exist: ${tips.join('; ')}.` };
}

// ---------------------------------------------------------------------------
// Schema-driven argument validation
// ---------------------------------------------------------------------------

function argumentError(
  value: unknown,
  schema: ToolArgumentSchema,
  pathKeys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const allowed = Object.keys(schema.properties);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    return `Unknown argument(s): ${unknown.join(', ')}. Use only: ${allowed.join(', ')}.`;
  }
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) return `The required argument "${key}" is missing.`;
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (property.type === 'string') {
      if (typeof candidate !== 'string') return `"${key}" must be a string.`;
      if (!validUnicode(candidate) || candidate.includes('\0')) return `"${key}" contains invalid characters.`;
      if (property.maxLength !== undefined && candidate.length > property.maxLength) {
        return `"${key}" is longer than ${property.maxLength} characters.`;
      }
      if (pathKeys.includes(key) && !validPath(candidate)) {
        return `"${key}" must be an absolute path (starting with /) without "..".`;
      }
    } else if (property.type === 'integer') {
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate)) {
        return `"${key}" must be an integer number.`;
      }
      if (property.minimum !== undefined && candidate < property.minimum) {
        return `"${key}" must be at least ${property.minimum}.`;
      }
      if (property.maximum !== undefined && candidate > property.maximum) {
        return `"${key}" must be at most ${property.maximum}.`;
      }
    } else if (typeof candidate !== 'boolean') {
      return `"${key}" must be true or false.`;
    }
  }
  return undefined;
}

/** Remove `null` optional arguments and coerce integer strings, as small models often send them. */
function normalizeArguments(value: unknown, schema: ToolArgumentSchema): unknown {
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value)) {
    const property = schema.properties[key];
    if ((candidate === null || candidate === '') && !(schema.required ?? []).includes(key)) continue;
    if (property?.type === 'integer' && typeof candidate === 'string' && /^-?\d+$/.test(candidate)) {
      normalized[key] = Number(candidate);
    } else if (property?.type === 'boolean' && (candidate === 'true' || candidate === 'false')) {
      normalized[key] = candidate === 'true';
    } else {
      normalized[key] = candidate;
    }
  }
  return normalized;
}

function defineTool<Input, Output>(
  definition: Omit<Tool<Input, Output>, 'validateInput' | 'inputError' | 'normalizeInput'> & {
    readonly pathKeys?: readonly string[];
    readonly extraCheck?: (input: Input) => string | undefined;
  },
): Tool<Input, Output> {
  const pathKeys = definition.pathKeys ?? ['path'];
  const check = (value: unknown): string | undefined =>
    argumentError(value, definition.parameters, pathKeys) ??
    definition.extraCheck?.(value as Input);
  return {
    id: definition.id,
    effect: definition.effect,
    description: definition.description,
    parameters: definition.parameters,
    normalizeInput: value => normalizeArguments(value, definition.parameters),
    validateInput: (value): value is Input => check(value) === undefined,
    inputError: value => check(value),
    validateOutput: definition.validateOutput,
    run: definition.run,
  };
}

const PATH_PROPERTY = {
  type: 'string',
  description: 'Absolute path, e.g. /Users/name/Projects/app/src/index.ts',
  maxLength: 4096,
} as const;

const BINARY_CONTROL_CHARACTERS = /[\u0000\u0007-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

// ---------------------------------------------------------------------------
// Output shapes and validators
// ---------------------------------------------------------------------------

interface ReadFileInput extends PathInput {
  readonly offset?: number;
  readonly limit?: number;
}

interface ReadFileOutput {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

interface EditFileInput extends PathInput {
  readonly old_text: string;
  readonly new_text: string;
  readonly replace_all?: boolean;
}

interface MultiEditInput extends PathInput {
  readonly edits: string;
}

interface ParsedEdit {
  readonly old_text: string;
  readonly new_text: string;
  readonly replace_all?: boolean;
}

function parseEdits(text: string): { readonly edits?: readonly ParsedEdit[]; readonly error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'edits must be a JSON array like [{"old_text": "a", "new_text": "b"}].' };
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return { error: 'edits must be a JSON array of 1-20 edits.' };
  for (const [index, edit] of value.entries()) {
    const item = edit as Record<string, unknown> | null;
    if (typeof item !== 'object' || item === null || typeof item.old_text !== 'string' || typeof item.new_text !== 'string') {
      return { error: `Edit ${index + 1} needs old_text and new_text strings.` };
    }
    if (item.old_text === '') return { error: `Edit ${index + 1}: old_text must not be empty.` };
    if (item.old_text === item.new_text) return { error: `Edit ${index + 1}: old_text and new_text are identical.` };
    if (item.replace_all !== undefined && typeof item.replace_all !== 'boolean') return { error: `Edit ${index + 1}: replace_all must be true or false.` };
    if (BINARY_CONTROL_CHARACTERS.test(item.new_text)) return { error: `Edit ${index + 1}: new_text must be text without binary control characters.` };
  }
  return { edits: value as ParsedEdit[] };
}

function isListOutput(value: unknown): value is ListOutput {
  return isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(entry =>
      isRecord(entry) &&
      typeof entry.name === 'string' &&
      ['file', 'directory', 'symlink', 'other'].includes(String(entry.type)) &&
      exactKeys(entry, ['name', 'type'])) &&
    typeof value.truncated === 'boolean' &&
    exactKeys(value, ['entries', 'truncated']);
}

function isTreeOutput(value: unknown): value is TreeOutput {
  return isRecord(value) &&
    Array.isArray(value.entries) &&
    value.entries.every(entry =>
      isRecord(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.path === 'string' &&
      Number.isSafeInteger(entry.depth) &&
      (entry.collapsed === undefined || entry.collapsed === true) &&
      ['file', 'directory', 'symlink', 'other'].includes(String(entry.type)) &&
      exactKeys(entry, ['name', 'path', 'type', 'depth', 'collapsed'])) &&
    typeof value.truncated === 'boolean' &&
    exactKeys(value, ['entries', 'truncated']);
}

function isReadFileOutput(value: unknown): value is ReadFileOutput {
  return isRecord(value) &&
    typeof value.content === 'string' &&
    validUnicode(value.content) &&
    Number.isSafeInteger(value.startLine) &&
    Number.isSafeInteger(value.endLine) &&
    Number.isSafeInteger(value.totalLines) &&
    typeof value.truncated === 'boolean' &&
    exactKeys(value, ['content', 'startLine', 'endLine', 'totalLines', 'truncated']);
}

function isSearchOutput(value: unknown): value is SearchOutput {
  return isRecord(value) &&
    Array.isArray(value.matches) &&
    value.matches.every(match =>
      isRecord(match) &&
      typeof match.path === 'string' &&
      (match.type === 'file' || match.type === 'directory') &&
      exactKeys(match, ['path', 'type'])) &&
    Number.isSafeInteger(value.scannedDirectories) &&
    Number.isSafeInteger(value.skippedDirectories) &&
    typeof value.truncated === 'boolean' &&
    exactKeys(value, ['matches', 'scannedDirectories', 'skippedDirectories', 'truncated']);
}

function isTextSearchOutput(value: unknown): value is TextSearchOutput {
  return isRecord(value) &&
    Array.isArray(value.matches) &&
    value.matches.every(match =>
      isRecord(match) &&
      typeof match.path === 'string' &&
      Number.isSafeInteger(match.line) &&
      typeof match.text === 'string' &&
      exactKeys(match, ['path', 'line', 'text'])) &&
    Number.isSafeInteger(value.filesScanned) &&
    typeof value.truncated === 'boolean' &&
    (value.hint === undefined || typeof value.hint === 'string') &&
    exactKeys(value, value.hint === undefined ? ['matches', 'filesScanned', 'truncated'] : ['matches', 'filesScanned', 'truncated', 'hint']);
}

function isOperationOutput(value: unknown): value is OperationOutput {
  return isRecord(value) &&
    (value.status === 'applied' || value.status === 'rejected') &&
    typeof value.operation === 'string' &&
    ['create-file', 'create-directory', 'edit-file', 'delete'].includes(value.operation) &&
    typeof value.path === 'string' &&
    exactKeys(value, ['status', 'operation', 'path']);
}

/** Select a window of lines that fits the tool-output budget. */
export function readFileWindow(
  content: string,
  offset: number | undefined,
  limit: number | undefined,
  maxChars: number,
): ReadFileOutput {
  const lines = content.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const totalLines = content === '' ? 0 : lines.length;
  const startLine = Math.max(1, offset ?? 1);
  if (totalLines > 0 && startLine > totalLines) {
    throw new FilesystemToolError(
      `offset ${startLine} is beyond the end of the file (${totalLines} lines).`,
      'tool-failed',
    );
  }
  const wanted = Math.min(limit ?? 800, 2_000);
  // Leave room for the JSON envelope (keys, line numbers, flags).
  const budget = Math.max(64, maxChars - 160);
  const selected: string[] = [];
  let used = 0;
  for (let index = startLine - 1; index < totalLines && selected.length < wanted; index += 1) {
    const line = lines[index] ?? '';
    const cost = JSON.stringify(line).length + 1;
    if (used + cost > budget && selected.length > 0) break;
    selected.push(cost > budget ? `${line.slice(0, budget - 32)}… [line truncated]` : line);
    used += cost;
  }
  const endLine = totalLines === 0 ? 0 : startLine + selected.length - 1;
  return {
    content: selected.length === 0
      ? ''
      : selected.join('\n') + (endLine < totalLines || content.endsWith('\n') ? '\n' : ''),
    startLine: totalLines === 0 ? 0 : startLine,
    endLine,
    totalLines,
    truncated: endLine < totalLines,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFilesystemTools(
  registry: ToolRegistry,
  config: AppConfig,
  operations: FilesystemToolOperations = {},
  approval?: FileOperationApprovalPort,
): void {
  const openDirectory = operations.openDirectory ?? (path => opendir(path));
  const openFile = operations.openFile ?? ((path, flags) => open(path, flags));

  registry.register(defineTool<ListInput, ListOutput>({
    id: 'list_directory',
    effect: 'read',
    description: 'List the direct children (files and folders) of one directory. Not recursive; use directory_tree for nested structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute directory path.' },
        maxEntries: { type: 'integer', description: 'Optional maximum entries.', minimum: 1, maximum: config.maxDirectoryEntries },
      },
      required: ['path'],
      additionalProperties: false,
    },
    validateOutput: isListOutput,
    run: (input, signal) => listDirectory(input, config, signal, openDirectory),
  }));

  registry.register(defineTool<TreeInput, TreeOutput>({
    id: 'directory_tree',
    effect: 'read',
    description: 'Show the recursive file/folder structure under a directory (e.g. a project root). Dependency and build folders such as node_modules, .git, and dist are listed but not expanded ("collapsed").',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute directory path.' },
        maxDepth: { type: 'integer', description: `Optional depth (default ${config.maxTreeDepth}).`, minimum: 1, maximum: config.maxTreeDepth },
        maxEntries: { type: 'integer', description: 'Optional maximum entries.', minimum: 1, maximum: config.maxDirectoryEntries },
      },
      required: ['path'],
      additionalProperties: false,
    },
    validateOutput: isTreeOutput,
    run: (input, signal) => directoryTree(input, config, signal, openDirectory),
  }));

  registry.register(defineTool<ReadFileInput, ReadFileOutput>({
    id: 'read_file',
    effect: 'read',
    description: 'Read a UTF-8 text file. Returns up to ~800 lines starting at `offset` (1-based line number) plus startLine, endLine, totalLines, and truncated. For long files, call again with offset = endLine + 1.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute file path.' },
        offset: { type: 'integer', description: 'Optional 1-based line number to start from.', minimum: 1 },
        limit: { type: 'integer', description: 'Optional maximum number of lines (up to 2000).', minimum: 1, maximum: 2_000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    validateOutput: isReadFileOutput,
    async run(input, signal) {
      const file = await readFile(input, config, signal, openFile);
      return readFileWindow(file.content, input.offset, input.limit, config.maxToolOutputChars);
    },
  }));

  registry.register(defineTool<SearchInput, SearchOutput>({
    id: 'find_files',
    effect: 'read',
    description: 'Find files or folders by name anywhere on this Mac. `query` is a case-insensitive name fragment ("vyomara") or a glob ("*.test.ts"). Give `path` to search inside one folder; omit it to search the whole machine (home and project folders first). Dependency folders like node_modules are skipped.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment or glob pattern.', maxLength: 256 },
        path: { ...PATH_PROPERTY, description: 'Optional absolute folder to search in.' },
        maxEntries: { type: 'integer', description: 'Optional maximum matches.', minimum: 1, maximum: config.maxDirectoryEntries },
      },
      required: ['query'],
      additionalProperties: false,
    },
    extraCheck: input => input.query.trim() === '' ? 'query must not be empty.' : undefined,
    validateOutput: isSearchOutput,
    run: (input, signal) => searchFilesystem({ ...input, query: input.query.trim() }, config, signal, openDirectory),
  }));

  registry.register(defineTool<TextSearchInput, TextSearchOutput>({
    id: 'search_text',
    effect: 'read',
    description: 'Search file contents (like grep) under a folder or in one file. `pattern` is a regular expression (falls back to literal text). Optional `glob` filters file names, e.g. "*.ts". Returns matching lines with path and line number. Skips binary files and dependency folders.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression or literal text to find.', maxLength: 1_000 },
        path: { ...PATH_PROPERTY, description: 'Absolute folder (or file) to search.' },
        glob: { type: 'string', description: 'Optional file-name glob, e.g. "*.tsx".', maxLength: 256 },
        ignore_case: { type: 'boolean', description: 'Optional case-insensitive search.' },
        max_results: { type: 'integer', description: 'Optional maximum matching lines (default 100).', minimum: 1, maximum: 500 },
      },
      required: ['pattern', 'path'],
      additionalProperties: false,
    },
    extraCheck: input => input.pattern === '' ? 'pattern must not be empty.' : undefined,
    validateOutput: isTextSearchOutput,
    run: (input, signal) => searchText(input, config, signal, openDirectory),
  }));

  if (!approval) return;

  const contentMaximum = Math.min(config.maxFileBytes, config.maxToolInputChars);
  registry.register(defineTool<{ readonly path: string; readonly content: string }, OperationOutput>({
    id: 'write_file',
    effect: 'propose',
    description: 'Create a new file, or completely replace an existing file, with `content`. Prefer edit_file for changes to existing files. The user reviews the change before it is written.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute file path.' },
        content: { type: 'string', description: 'The complete file content.', maxLength: contentMaximum },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    extraCheck: input => BINARY_CONTROL_CHARACTERS.test(input.content)
      ? 'content must be text without binary control characters.'
      : undefined,
    validateOutput: isOperationOutput,
    async run(input, signal) {
      let exists = false;
      try {
        await lstat(input.path);
        exists = true;
      } catch {
        exists = false;
      }
      const operation: FileOperationKind = exists ? 'edit-file' : 'create-file';
      const request: FileOperationRequest = { operation, path: input.path, content: input.content };
      const result = await approval.request(request, signal);
      return { ...result, operation, path: input.path };
    },
  }));

  registry.register(defineTool<EditFileInput, OperationOutput>({
    id: 'edit_file',
    effect: 'propose',
    description: 'Edit an existing file by replacing `old_text` with `new_text`. `old_text` must be copied exactly from the file (same whitespace and indentation) and must match exactly once unless `replace_all` is true; include a few surrounding lines to make it unique. Read the file first. The user reviews a diff before it is applied.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute path of the existing file.' },
        old_text: { type: 'string', description: 'Exact existing text to replace.', maxLength: contentMaximum },
        new_text: { type: 'string', description: 'Replacement text.', maxLength: contentMaximum },
        replace_all: { type: 'boolean', description: 'Optional: replace every occurrence.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    extraCheck: input => input.old_text === ''
      ? 'old_text must not be empty. Use write_file to create a file.'
      : input.old_text === input.new_text
        ? 'old_text and new_text are identical; there is nothing to change.'
        : BINARY_CONTROL_CHARACTERS.test(input.new_text)
          ? 'new_text must be text without binary control characters.'
          : undefined,
    validateOutput: isOperationOutput,
    async run(input, signal) {
      const request: FileOperationRequest = {
        operation: 'edit-file',
        path: input.path,
        replacement: {
          find: input.old_text,
          replace: input.new_text,
          ...(input.replace_all === true ? { all: true } : {}),
        },
      };
      const result = await approval.request(request, signal);
      return { ...result, operation: 'edit-file', path: input.path };
    },
  }));

  // Several edits to one file in one review: fewer steps, and the user sees one diff.
  const multiEdit = defineTool<MultiEditInput, OperationOutput>({
    id: 'multi_edit',
    effect: 'propose',
    description: 'Make several edits to ONE existing file at once, reviewed as a single diff. `edits` is a JSON array of {"old_text": "...", "new_text": "...", "replace_all": false}; they are applied in order, each to the result of the previous one, and each old_text must match exactly once (copy it exactly from read_file). Prefer this over several edit_file calls on the same file.',
    parameters: {
      type: 'object',
      properties: {
        path: { ...PATH_PROPERTY, description: 'Absolute path of the existing file.' },
        edits: { type: 'string', description: 'JSON array of {"old_text","new_text","replace_all"?} objects, 1-20 edits.', maxLength: contentMaximum },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
    extraCheck: input => parseEdits(input.edits).error,
    validateOutput: isOperationOutput,
    async run(input, signal) {
      const { edits } = parseEdits(input.edits);
      const result = await approval.request({
        operation: 'edit-file',
        path: input.path,
        replacements: (edits ?? []).map(edit => ({ find: edit.old_text, replace: edit.new_text, ...(edit.replace_all === true ? { all: true as const } : {}) })),
      }, signal);
      return { ...result, operation: 'edit-file', path: input.path };
    },
  });
  // Models often send the edits as a real JSON array; accept that too.
  const normalizeMultiEdit = multiEdit.normalizeInput;
  registry.register({
    ...multiEdit,
    normalizeInput: value => {
      const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const withText = record && Array.isArray(record.edits) ? { ...record, edits: JSON.stringify(record.edits) } : value;
      return normalizeMultiEdit ? normalizeMultiEdit(withText) : withText;
    },
  });

  registry.register(defineTool<PathInput, OperationOutput>({
    id: 'create_directory',
    effect: 'propose',
    description: 'Create one new folder inside an existing parent folder. The user approves it first.',
    parameters: {
      type: 'object',
      properties: { path: { ...PATH_PROPERTY, description: 'Absolute path of the new folder.' } },
      required: ['path'],
      additionalProperties: false,
    },
    validateOutput: isOperationOutput,
    async run(input, signal) {
      const result = await approval.request({ operation: 'create-directory', path: input.path }, signal);
      return { ...result, operation: 'create-directory', path: input.path };
    },
  }));

  registry.register(defineTool<PathInput, OperationOutput>({
    id: 'delete_path',
    effect: 'propose',
    description: 'Move one file or folder to the macOS Trash. The user must type DELETE to confirm each item.',
    parameters: {
      type: 'object',
      properties: { path: { ...PATH_PROPERTY, description: 'Absolute path of the file or folder.' } },
      required: ['path'],
      additionalProperties: false,
    },
    validateOutput: isOperationOutput,
    async run(input, signal) {
      const result = await approval.request({ operation: 'delete', path: input.path }, signal);
      return { ...result, operation: 'delete', path: input.path };
    },
  }));
}
