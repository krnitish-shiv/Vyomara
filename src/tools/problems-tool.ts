import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AppConfig } from '../config/config.ts';
import type { ActionToolPorts } from './action-tools.ts';
import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import { resolveSafeFilesystemPath } from './filesystem-tools.ts';

/**
 * `check_problems`: run the project's own type checker / linter (after the
 * user approves the exact command) and return the errors as a list of
 * file:line:column problems, like an editor's Problems panel.
 */

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

interface Input { readonly path: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The checks a project defines, best first: its own scripts, then the standard tool for its language. */
export async function detectChecks(root: string): Promise<string[]> {
  const has = (file: string): boolean => existsSync(join(root, file));
  if (has('package.json')) {
    let scripts: Record<string, unknown> = {};
    try {
      const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      if (isRecord(manifest) && isRecord(manifest.scripts)) scripts = manifest.scripts;
    } catch {
      // A broken package.json falls back to the standard tools.
    }
    const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun run' : 'npm run';
    const exec = has('pnpm-lock.yaml') ? 'pnpm exec' : has('yarn.lock') ? 'yarn' : 'npx --no-install';
    const checks: string[] = [];
    const typeScript = ['typecheck', 'type-check', 'check:types', 'types', 'tsc'].find(name => typeof scripts[name] === 'string');
    if (typeScript) checks.push(`${runner} ${typeScript}`);
    else if (has('tsconfig.json')) checks.push(`${exec} tsc --noEmit --pretty false`);
    if (typeof scripts.lint === 'string') checks.push(`${runner} lint`);
    if (checks.length === 0 && typeof scripts.check === 'string') checks.push(`${runner} check`);
    if (checks.length > 0) return checks;
  }
  if (has('Cargo.toml')) return ['cargo check --message-format=short'];
  if (has('go.mod')) return ['go vet ./...'];
  if (has('Package.swift')) return ['swift build'];
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) {
    return ['if command -v ruff >/dev/null; then ruff check --output-format=concise .; else python3 -m compileall -q .; fi'];
  }
  return [];
}

const PATTERNS: readonly RegExp[] = [
  // TypeScript: src/a.ts(12,5): error TS2322: Type …
  /^(?<file>[^\s(][^(]*?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning)\s+(?<message>.+)$/u,
  // gcc/clang/go/swift/ruff/cargo short/eslint compact: file:12:5: error: message
  /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?:(?<column>\d+):)?\s*(?:(?<severity>error|warning|note)(?:\[[^\]]+\])?:?\s*)?(?<message>.+)$/u,
];

export function parseProblems(output: string, root: string): Problem[] {
  const problems: Problem[] = [];
  let eslintFile: string | undefined;
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/gu, '').trimEnd();
    // ESLint's default format: a file path line, then "  12:5  error  message  rule".
    if (/^\/\S+\.\w+$/u.test(line) || /^[\w./-]+\.(?:[cm]?[jt]sx?|vue|svelte)$/u.test(line)) {
      eslintFile = line;
      continue;
    }
    const eslint = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}\S+)?$/u.exec(line);
    if (eslint && eslintFile) {
      problems.push({ file: eslintFile, line: Number(eslint[1]), column: Number(eslint[2]), severity: eslint[3] as Problem['severity'], message: (eslint[4] as string).trim() });
      continue;
    }
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      const groups = match?.groups;
      if (!groups?.file || !groups.line || !groups.message) continue;
      if (/^(?:https?|file)$/u.test(groups.file) || groups.file.includes(' ') && !existsSync(resolve(root, groups.file))) continue;
      if (groups.severity === 'note') break;
      problems.push({
        file: groups.file.trim(),
        line: Number(groups.line),
        ...(groups.column ? { column: Number(groups.column) } : {}),
        severity: groups.severity === 'warning' ? 'warning' : 'error',
        message: groups.message.trim(),
      });
      break;
    }
    if (problems.length >= 200) break;
  }
  // Paths relative to the project, so the model can read_file them directly.
  return problems.map(problem => {
    const absolute = isAbsolute(problem.file) ? problem.file : resolve(root, problem.file);
    return { ...problem, file: relative(root, absolute) || problem.file };
  });
}

/** Quote for zsh. */
function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function registerProblemsTool(registry: ToolRegistry, config: AppConfig, ports?: ActionToolPorts): void {
  const approval = ports?.approval;
  const runner = ports?.commandRunner;
  if (!approval || !runner) return;
  const memory = ports.approvalMemory;

  const tool: Tool<Input, Record<string, unknown>> = {
    id: 'check_problems',
    effect: 'shell',
    description: 'Find type errors and lint problems in a project, like an editor\'s Problems panel: runs the project\'s own typecheck/lint script (or tsc, cargo check, go vet, ruff, swift build) after the user approves, and returns each problem as file, line, column, and message. Use it after changing code and to find what is broken.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the project root.', maxLength: 4_096 } },
      required: ['path'],
      additionalProperties: false,
    },
    validateInput: (value): value is Input => isRecord(value) && typeof value.path === 'string' && isAbsolute(value.path) && Object.keys(value).every(key => key === 'path'),
    inputError: value => (isRecord(value) && typeof value.path === 'string' && isAbsolute(value.path) ? undefined : 'path must be the absolute path of the project root.'),
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = (await resolveSafeFilesystemPath(input.path, config, 'directory', signal)).target;
      const checks = await detectChecks(root);
      if (checks.length === 0) {
        throw new ToolFailure('No typecheck or lint setup was found here (package.json scripts, tsconfig.json, Cargo.toml, go.mod, Package.swift, or a Python project). Use run_command with the project\'s own check command instead.', 'not-found');
      }
      // Run every check even if one fails, and keep each one's exit code.
      const command = checks.length === 1 ? checks[0] as string : checks.map(check => `echo ${quote(`$ ${check}`)}; ${check}`).join('; ');
      const remembered = memory?.has(command, root) === true;
      const decision = remembered || await approval.request({ kind: 'command', command, cwd: root, timeoutSeconds: 300 }, signal);
      if (!decision) return { status: 'rejected', command };
      if (decision === 'always') memory?.allow(command, root);
      const result = await runner.run(command, root, 300_000, signal);
      const problems = parseProblems(result.output, root);
      const errors = problems.filter(problem => problem.severity === 'error').length;
      return {
        status: 'completed',
        command,
        cwd: root,
        exitCode: result.exitCode,
        summary: problems.length === 0
          ? (result.exitCode === 0 ? 'No problems found.' : 'The check failed but printed no file:line problems; read output.')
          : `${errors} errors, ${problems.length - errors} warnings`,
        problems: problems.slice(0, 100),
        ...(problems.length === 0 || result.exitCode !== 0 ? { output: result.output.slice(-6_000) } : {}),
        timedOut: result.timedOut,
      };
    },
  };
  registry.register(tool);
}
