import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canShowDiff, previewName, VSCodeDiffPreview } from '../src/desktop/vscode-diff.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vyomara-diff-'));
  const cli = join(root, 'code');
  await writeFile(cli, '');
  const calls: { executable: string; args: readonly string[] }[] = [];
  const preview = new VSCodeDiffPreview({
    previewRoot: join(root, 'previews'),
    cli,
    run: async (executable, args) => {
      calls.push({ executable, args });
      return executable === '/bin/ps' ? '/sbin/launchd\n/Applications/Visual Studio Code.app/Contents/MacOS/Code\n' : '';
    },
  });
  return { root, cli, calls, preview };
}

test('an edit opens the real file beside a private copy of the proposal', async t => {
  const { root, cli, calls, preview } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await preview.open({ id: 'a1', operation: 'edit-file', path: '/Users/me/shop/cart.js', proposedContent: 'new\n' });
  const right = join(root, 'previews', 'a1', 'cart (proposed).js');
  assert.deepEqual(calls, [{ executable: cli, args: ['--reuse-window', '--diff', '/Users/me/shop/cart.js', right] }]);
  assert.equal(await readFile(right, 'utf8'), 'new\n');
  assert.equal((await stat(right)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'previews'))).mode & 0o777, 0o700);
});

test('a new file is compared with an empty file', async t => {
  const { root, calls, preview } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await preview.open({ id: 'b2', operation: 'create-file', path: '/Users/me/shop/README', proposedContent: '# Shop\n' });
  const left = join(root, 'previews', 'b2', 'README (new file)');
  assert.deepEqual(calls[0]?.args.slice(2), [left, join(root, 'previews', 'b2', 'README (proposed)')]);
  assert.equal(await readFile(left, 'utf8'), '');
});

test('only edits and new files have a diff; VS Code is detected from running processes', async () => {
  const { preview } = await fixture();
  assert.equal(canShowDiff({ id: 'c', operation: 'delete', path: '/x' }), false);
  assert.equal(canShowDiff({ id: 'c', operation: 'create-directory', path: '/x' }), false);
  assert.equal(await preview.isVSCodeRunning(), true);
  assert.equal(previewName('/a/b/app.test.ts', 'proposed'), 'app.test (proposed).ts');
});
