/** Minimal line diff for reviewing proposed edits (no Node.js APIs; used by the renderer too). */

export interface DiffLine {
  readonly type: 'context' | 'add' | 'remove';
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;

  const result: DiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    result.push({ type: 'context', text: a[index] ?? '', oldLine: index + 1, newLine: index + 1 });
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  const n = middleA.length;
  const m = middleB.length;
  if (n * m > MAX_LCS_CELLS) {
    middleA.forEach((text, index) => result.push({ type: 'remove', text, oldLine: prefix + index + 1 }));
    middleB.forEach((text, index) => result.push({ type: 'add', text, newLine: prefix + index + 1 }));
  } else {
    // lengths[i][j] = LCS length of middleA[i..] and middleB[j..]
    const lengths = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = lengths[i]!;
      const next = lengths[i + 1]!;
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = middleA[i] === middleB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && middleA[i] === middleB[j]) {
        result.push({ type: 'context', text: middleA[i]!, oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i += 1;
        j += 1;
      } else if (i < n && (j >= m || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
        // Prefer removals before additions, as in unified diffs.
        result.push({ type: 'remove', text: middleA[i]!, oldLine: prefix + i + 1 });
        i += 1;
      } else {
        result.push({ type: 'add', text: middleB[j]!, newLine: prefix + j + 1 });
        j += 1;
      }
    }
  }

  for (let index = 0; index < suffix; index += 1) {
    const oldIndex = a.length - suffix + index;
    const newIndex = b.length - suffix + index;
    result.push({ type: 'context', text: a[oldIndex] ?? '', oldLine: oldIndex + 1, newLine: newIndex + 1 });
  }
  return result;
}

/** Group a diff into hunks with `context` unchanged lines around each change. */
export function diffHunks(before: string, after: string, context = 3): DiffHunk[] {
  const lines = diffLines(before, after);
  const changed = lines.flatMap((line, index) => line.type === 'context' ? [] : [index]);
  if (changed.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges.map(([start, end]) => {
    const hunk = lines.slice(start, end + 1);
    const firstOld = hunk.find(line => line.oldLine !== undefined)?.oldLine ?? 0;
    const firstNew = hunk.find(line => line.newLine !== undefined)?.newLine ?? 0;
    const oldCount = hunk.filter(line => line.type !== 'add').length;
    const newCount = hunk.filter(line => line.type !== 'remove').length;
    return { header: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@`, lines: hunk };
  });
}

export function diffStats(before: string, after: string): { readonly added: number; readonly removed: number } {
  const lines = diffLines(before, after);
  return {
    added: lines.filter(line => line.type === 'add').length,
    removed: lines.filter(line => line.type === 'remove').length,
  };
}

export function formatUnifiedDiff(before: string, after: string, context = 3): string {
  return diffHunks(before, after, context)
    .map(hunk => [
      hunk.header,
      ...hunk.lines.map(line => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`),
    ].join('\n'))
    .join('\n');
}
