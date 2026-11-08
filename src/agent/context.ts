import type { SessionMessage } from '../session/session.ts';

/** Rough characters-per-token for mixed code/JSON/prose; deliberately conservative. */
export const CHARS_PER_TOKEN = 3;

function messageChars(message: SessionMessage): number {
  if (message.role === 'assistant' && message.kind === 'tool-call') {
    return message.content.length + JSON.stringify(message.toolCalls).length + 32;
  }
  return message.content.length + 16;
}

function totalChars(messages: readonly SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

function shortened(message: SessionMessage, maxChars: number): SessionMessage {
  if (message.role !== 'tool' || message.content.length <= maxChars) return message;
  const keep = Math.max(0, maxChars - 120);
  return {
    ...message,
    content: `${message.content.slice(0, keep)}… [${message.content.length - keep} characters of this earlier tool result were omitted to save context; call the tool again if you need them]`,
  };
}

/**
 * Fit a conversation into a character budget for the model:
 * 1. shrink tool results from earlier turns,
 * 2. drop the oldest whole turns,
 * 3. shrink older tool results within the current turn.
 * The current user request is always kept, and tool-call/result pairs stay together.
 */
export function fitMessagesToBudget(
  messages: readonly SessionMessage[],
  budgetChars: number,
): SessionMessage[] {
  let currentTurnStart = messages.length - 1;
  while (currentTurnStart > 0 && messages[currentTurnStart]?.role !== 'user') currentTurnStart -= 1;
  const history = messages.slice(0, Math.max(0, currentTurnStart)).map(message => shortened(message, 1_500));
  let current = messages.slice(Math.max(0, currentTurnStart));

  // Drop whole earlier turns, oldest first.
  const turns: SessionMessage[][] = [];
  for (const message of history) {
    if (message.role === 'user' || turns.length === 0) turns.push([]);
    turns.at(-1)?.push(message);
  }
  while (turns.length > 0 && totalChars([...turns.flat(), ...current]) > budgetChars) turns.shift();
  if (totalChars([...turns.flat(), ...current]) <= budgetChars) return [...turns.flat(), ...current];

  // Shrink older tool results in the current turn, keeping the latest ones intact.
  const toolIndexes = current.flatMap((message, index) => message.role === 'tool' ? [index] : []);
  for (const limit of [4_000, 1_500, 500]) {
    const protectedRecent = limit === 500 ? 1 : 3;
    const shrinkable = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - protectedRecent)));
    current = current.map((message, index) => shrinkable.has(index) ? shortened(message, limit) : message);
    if (totalChars(current) <= budgetChars) return current;
  }
  // Last resort: shrink every tool result.
  return current.map(message => shortened(message, 400));
}

/**
 * How many leading messages to replace with a summary so the rest fits
 * comfortably (about 60% of the budget, leaving room for this turn's work).
 * Returns 0 while everything still fits. The cut is always at the start of a
 * turn (a user message), and the current turn is never summarised.
 */
export function summaryCut(messages: readonly SessionMessage[], budgetChars: number): number {
  let currentTurnStart = messages.length - 1;
  while (currentTurnStart > 0 && messages[currentTurnStart]?.role !== 'user') currentTurnStart -= 1;
  if (currentTurnStart <= 0) return 0;
  const compact = messages.map((message, index) => index < currentTurnStart ? shortened(message, 1_500) : message);
  if (totalChars(compact) <= budgetChars) return 0;
  const target = budgetChars * 0.6;
  for (let cut = 1; cut <= currentTurnStart; cut += 1) {
    if (messages[cut]?.role !== 'user') continue;
    if (totalChars(compact.slice(cut)) <= target) return cut;
  }
  return currentTurnStart;
}

/** The earlier messages as plain text for the model to summarise (long tool output trimmed). */
export function transcriptForSummary(messages: readonly SessionMessage[], maxChars = 24_000): string {
  const lines = messages.map(message => {
    if (message.role === 'user') return `User: ${message.content}`;
    if (message.role === 'tool') return `Tool ${message.toolId} result: ${message.content.slice(0, 600)}${message.content.length > 600 ? '…' : ''}`;
    if (message.kind === 'tool-call') {
      return `Assistant called: ${message.toolCalls.map(call => `${call.toolId}(${JSON.stringify(call.arguments).slice(0, 300)})`).join(', ')}`;
    }
    return `Assistant: ${message.content}`;
  });
  const text = lines.join('\n');
  // Keep the end when it is still too long: the latest work matters most.
  return text.length <= maxChars ? text : `…\n${text.slice(-maxChars)}`;
}
