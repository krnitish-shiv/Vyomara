import type { DesktopChatRequest } from './contracts.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DesktopValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopValidationError';
  }
}

export function parseDesktopSessionId(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new Error('Session request is invalid.');
  }
  return value;
}

export function parseDesktopFileOperationApprovalRequest(
  value: unknown,
): { readonly id: string; readonly confirmation?: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DesktopValidationError('File review request is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(key => key !== 'id' && key !== 'confirmation') ||
    !Object.hasOwn(record, 'id') ||
    (Object.hasOwn(record, 'confirmation') &&
      (typeof record.confirmation !== 'string' || record.confirmation.length > 16))
  ) {
    throw new DesktopValidationError('File review request is invalid.');
  }
  const id = parseDesktopSessionId(record.id);
  return {
    id,
    ...(typeof record.confirmation === 'string' ? { confirmation: record.confirmation } : {}),
  };
}

export function parseDesktopSessionDeleteRequest(value: unknown): { readonly id: string; readonly confirmation: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DesktopValidationError('Session deletion request is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'id') ||
    !Object.hasOwn(record, 'confirmation') ||
    record.confirmation !== 'DELETE'
  ) {
    throw new DesktopValidationError('Review the selected conversation and type DELETE to remove it.');
  }
  const id = parseDesktopSessionId(record.id);
  return { id, confirmation: record.confirmation };
}

export function parseDesktopChatRequest(
  value: unknown,
  maxInputChars: number,
): DesktopChatRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error('Chat request is invalid.');
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some(key => key !== 'prompt' && key !== 'sessionId' && key !== 'requestId' && key !== 'voice') ||
    (record.voice !== undefined && typeof record.voice !== 'boolean') ||
    typeof record.prompt !== 'string' ||
    record.prompt.trim() === '' ||
    record.prompt.length > maxInputChars ||
    typeof record.requestId !== 'string' ||
    !uuidPattern.test(record.requestId) ||
    (record.sessionId !== undefined &&
      (typeof record.sessionId !== 'string' || !uuidPattern.test(record.sessionId)))
  ) {
    throw new Error('Chat request is invalid or exceeds the configured input limit.');
  }

  return {
    prompt: record.prompt,
    requestId: record.requestId,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.voice === true ? { voice: true } : {}),
  };
}

/**
 * Whether a microphone request comes from Vyomara's own page. Chromium reports
 * file pages with the origin "file:///", so the exact page URL is compared
 * (ignoring the hash, e.g. "#pip"). In development the dev-server origin is used.
 */
export function isTrustedPageRequest(requestingUrl: string, pageUrl: string, devServerUrl?: string): boolean {
  if (devServerUrl) {
    try {
      return new URL(requestingUrl).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return requestingUrl.split('#')[0] === pageUrl;
}
