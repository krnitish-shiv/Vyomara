import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

export const VSCODE_CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const VSCODE_PROCESS = '/Visual Studio Code.app/Contents/MacOS/';

/** What a diff needs from a file-change proposal. */
export interface DiffProposal {
  readonly id: string;
  readonly operation: string;
  readonly path: string;
  readonly proposedContent?: string;
}

export type RunCommand = (executable: string, args: readonly string[]) => Promise<string>;

const runCommand: RunCommand = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { timeout: 10_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

/** "cart.js" → "cart (proposed).js": the extension stays, so VS Code highlights it. */
export function previewName(path: string, label: string): string {
  const name = basename(path);
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${stem} (${label})${extension}`;
}

export function canShowDiff(proposal: DiffProposal): boolean {
  return (proposal.operation === 'edit-file' || proposal.operation === 'create-file') && proposal.proposedContent !== undefined;
}

/**
 * Shows a proposed file change as a side-by-side diff in VS Code, since that
 * is where the owner reads code: the real file on the left, the proposal on
 * the right. The proposal is a private copy; nothing is applied until it is
 * approved in Vyomara.
 */
export class VSCodeDiffPreview {
  readonly #root: string;
  readonly #cli: string;
  readonly #run: RunCommand;

  constructor(options: { readonly previewRoot: string; readonly cli?: string; readonly run?: RunCommand }) {
    this.#root = options.previewRoot;
    this.#cli = options.cli ?? VSCODE_CLI;
    this.#run = options.run ?? runCommand;
  }

  get installed(): boolean {
    return existsSync(this.#cli);
  }

  /** Whether VS Code is open, so a diff can appear there without launching it. */
  async isVSCodeRunning(): Promise<boolean> {
    try {
      const output = await this.#run('/bin/ps', ['-axo', 'comm=']);
      return output.split('\n').some(line => line.includes(VSCODE_PROCESS));
    } catch {
      return false;
    }
  }

  async open(proposal: DiffProposal): Promise<void> {
    if (!canShowDiff(proposal)) throw new Error('Only file edits and new files can be shown as a diff.');
    if (!this.installed) throw new Error('VS Code was not found in /Applications.');
    // Proposal ids are UUIDs from the approval manager; keep the folder name safe anyway.
    const folder = join(this.#root, proposal.id.replace(/[^\w-]/gu, ''));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const right = join(folder, previewName(proposal.path, 'proposed'));
    await writeFile(right, proposal.proposedContent ?? '', { encoding: 'utf8', mode: 0o600 });
    let left = proposal.path;
    if (proposal.operation === 'create-file') {
      left = join(folder, previewName(proposal.path, 'new file'));
      await writeFile(left, '', { mode: 0o600 });
    }
    await this.#run(this.#cli, ['--reuse-window', '--diff', left, right]);
  }

  /** Remove old previews (on start and quit). */
  async clear(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }
}
