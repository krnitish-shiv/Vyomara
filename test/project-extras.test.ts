import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { expandSlashCommand, hooksFor } from '../src/agent/project-extras.ts';
import { loadConfig } from '../src/config/config.ts';
import { FileOperationApprovalManager } from '../src/desktop/file-operation-approval.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { registerFilesystemTools } from '../src/tools/filesystem-tools.ts';

test('slash commands expand from the project, the home folder, or the built-ins', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'Projects', 'shop');
  await mkdir(join(project, '.vyomara', 'commands'), { recursive: true });
  await writeFile(join(project, '.vyomara', 'commands', 'deploy.md'), 'Deploy $ARGUMENTS to staging.');
  assert.equal((await expandSlashCommand('/deploy api', project, home)).prompt, 'Deploy api to staging.');
  const review = await expandSlashCommand('/review focus on cart.ts', project, home);
  assert.equal(review.command, 'review');
  assert.match(review.prompt, new RegExp(`uncommitted changes in ${project}[\\s\\S]*Do not change anything\\. focus on cart\\.ts$`, 'u'));
  assert.deepEqual(await expandSlashCommand('/unknown thing', project, home), { prompt: '/unknown thing' });
  assert.deepEqual(await expandSlashCommand('not a command', project, home), { prompt: 'not a command' });
});

test('the nearest project hooks file is found above a changed file', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'shop');
  await mkdir(join(project, '.vyomara'), { recursive: true });
  await mkdir(join(project, 'src', 'deep'), { recursive: true });
  await writeFile(join(project, '.vyomara', 'hooks.json'), JSON.stringify({ afterEdit: 'pnpm exec eslint --fix .' }));
  assert.deepEqual(await hooksFor(join(project, 'src', 'deep', 'a.ts'), home), { root: project, hooks: { afterEdit: 'pnpm exec eslint --fix .' } });
  assert.equal(await hooksFor(join(home, 'other', 'b.ts'), home), undefined);
});

test('notebook_edit replaces, inserts, and deletes cells as one reviewed change', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-nb-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'a.ipynb');
  await writeFile(file, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', execution_count: 3, metadata: {}, outputs: [{ output_type: 'stream' }], source: ['print(1)'] }] }));
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: JSON.stringify([root]), VYOM_DATA_DIR: join(root, '.data') });
  let manager!: FileOperationApprovalManager;
  manager = new FileOperationApprovalManager({ config, moveToTrash: async () => {}, onProposal: proposal => queueMicrotask(() => void manager.approve(proposal.id)) });
  const registry = new ToolRegistry();
  registerFilesystemTools(registry, config, {}, manager);
  const tool = registry.get('notebook_edit');
  assert.ok(tool);
  const signal = new AbortController().signal;
  await tool.run({ path: file, cell: 0, source: 'print(2)\nprint(3)' }, signal);
  await tool.run({ path: file, cell: 1, source: '# Notes', action: 'insert', cell_type: 'markdown' }, signal);
  let cells = (JSON.parse(await readFile(file, 'utf8')) as { cells: Record<string, unknown>[] }).cells;
  assert.deepEqual(cells[0]?.source, ['print(2)\n', 'print(3)']);
  assert.deepEqual(cells[0]?.outputs, [], 'stale outputs are cleared');
  assert.equal(cells[1]?.cell_type, 'markdown');
  await tool.run({ path: file, cell: 0, action: 'delete' }, signal);
  cells = (JSON.parse(await readFile(file, 'utf8')) as { cells: Record<string, unknown>[] }).cells;
  assert.equal(cells.length, 1);
  await assert.rejects(tool.run({ path: file, cell: 5, source: 'x' }, signal), /between 0 and 0/u);
  assert.match(tool.inputError?.({ path: join(root, 'a.py'), cell: 0, source: 'x' }) ?? '', /only edits \.ipynb/u);
});
