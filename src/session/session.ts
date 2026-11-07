import { randomUUID } from 'node:crypto';

export interface SessionToolCall {
  readonly toolId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type SessionMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly kind?: never }
  | {
    readonly role: 'assistant';
    readonly kind: 'tool-call';
    readonly content: string;
    readonly toolCalls: readonly SessionToolCall[];
  }
  | { readonly role: 'tool'; readonly toolId: string; readonly content: string };

function copyMessage(message: SessionMessage): SessionMessage {
  if (message.role === 'assistant' && message.kind === 'tool-call') {
    return {
      role: 'assistant',
      kind: 'tool-call',
      content: message.content,
      toolCalls: message.toolCalls.map(call => ({
        toolId: call.toolId,
        arguments: structuredClone(call.arguments),
      })),
    };
  }
  return { ...message };
}

export class Session {
  readonly #messages: SessionMessage[] = [];
  readonly id: string;

  constructor(id: string = randomUUID(), initialMessages: readonly SessionMessage[] = []) {
    this.id = id;
    for (const message of initialMessages) this.add(message);
  }

  add(message: SessionMessage): void {
    this.#messages.push(copyMessage(message));
  }

  messages(): readonly SessionMessage[] {
    return this.#messages.map(copyMessage);
  }
}
