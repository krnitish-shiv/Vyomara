/**
 * Finding old_text for edit_file. Local models often copy a snippet with
 * slightly different whitespace (indentation, trailing spaces, tabs, CRLF),
 * so an exact match fails and the model loops. When the exact text is not
 * found, a whitespace-tolerant line match is tried; it is used only when it
 * matches exactly one place. The user still reviews the resulting diff.
 */
export type ReplaceResult =
  | { readonly ok: true; readonly content: string; readonly fuzzy: boolean; readonly count: number }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous'; readonly count?: number; readonly hint?: string };

function indentOf(line: string): string {
  return /^[\t ]*/u.exec(line)?.[0] ?? '';
}

/** Lines compared without leading/trailing whitespace; blank lines at the edges are ignored. */
function significantLines(text: string): string[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop();
  return lines;
}

/** Start indexes (in file lines) where the trimmed lines of `find` match. */
function lineMatches(fileLines: readonly string[], findLines: readonly string[]): number[] {
  const wanted = findLines.map(line => line.trim());
  const starts: number[] = [];
  if (wanted.length === 0) return starts;
  for (let start = 0; start + wanted.length <= fileLines.length; start += 1) {
    let same = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if ((fileLines[start + offset] ?? '').trim() !== wanted[offset]) {
        same = false;
        break;
      }
    }
    if (same) starts.push(start);
  }
  return starts;
}

/** Re-indent the replacement by the difference between the file's and the snippet's first-line indentation. */
function reindent(replaceLines: readonly string[], fromIndent: string, toIndent: string): string[] {
  if (fromIndent === toIndent) return [...replaceLines];
  return replaceLines.map(line => {
    if (line.trim() === '') return line;
    return line.startsWith(fromIndent) ? toIndent + line.slice(fromIndent.length) : line;
  });
}

/** The file lines most like the snippet's first line, with line numbers, to help the model copy exactly. */
export function closestLinesHint(content: string, find: string, context = 3): string | undefined {
  const fileLines = content.replace(/\r\n?/gu, '\n').split('\n');
  const first = significantLines(find)[0]?.trim();
  if (!first) return undefined;
  const words = new Set(first.split(/\W+/u).filter(word => word.length >= 3));
  let best = -1;
  let bestScore = 0;
  fileLines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    const score = trimmed.includes(first) || first.includes(trimmed)
      ? 100
      : trimmed.split(/\W+/u).filter(word => words.has(word)).length;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  if (best === -1 || bestScore === 0) return undefined;
  const from = Math.max(0, best - context);
  const to = Math.min(fileLines.length, best + context + 1);
  return fileLines.slice(from, to).map((line, offset) => `${String(from + offset + 1).padStart(4)}| ${line}`).join('\n');
}

export function replaceText(content: string, find: string, replace: string, all = false): ReplaceResult {
  if (find.length > 0) {
    const count = content.split(find).length - 1;
    if (count === 1 || (count > 1 && all)) {
      const index = content.indexOf(find);
      const next = all ? content.split(find).join(replace) : content.slice(0, index) + replace + content.slice(index + find.length);
      return { ok: true, content: next, fuzzy: false, count };
    }
    if (count > 1) return { ok: false, reason: 'ambiguous', count };
  }

  // Whitespace-tolerant match on whole lines.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = content.replace(/\r\n?/gu, '\n').split('\n');
  const findLines = significantLines(find);
  const starts = lineMatches(fileLines, findLines);
  if (starts.length === 0) {
    const hint = closestLinesHint(content, find);
    return { ok: false, reason: 'not-found', ...(hint ? { hint } : {}) };
  }
  if (starts.length > 1 && !all) return { ok: false, reason: 'ambiguous', count: starts.length };
  const replaceLines = significantLines(replace);
  let result = [...fileLines];
  // Apply from the last match so earlier indexes stay valid.
  for (const start of [...starts].reverse()) {
    const fileIndent = indentOf(fileLines[start] ?? '');
    const findIndent = indentOf(findLines[0] ?? '');
    const replacement = replace.trim() === '' ? [] : reindent(replaceLines, findIndent, fileIndent);
    result = [...result.slice(0, start), ...replacement, ...result.slice(start + findLines.length)];
  }
  return { ok: true, content: result.join(eol), fuzzy: true, count: starts.length };
}
