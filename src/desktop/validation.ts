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
    keys.some(key => !['prompt', 'sessionId', 'requestId', 'voice', 'planOnly', 'images'].includes(key)) ||
    (record.voice !== undefined && typeof record.voice !== 'boolean') ||
    (record.planOnly !== undefined && typeof record.planOnly !== 'boolean') ||
    (record.images !== undefined && !validImages(record.images)) ||
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
    ...(record.planOnly === true ? { planOnly: true } : {}),
    ...(Array.isArray(record.images) && record.images.length > 0 ? { images: record.images as string[] } : {}),
  };
}

export const MAX_CHAT_IMAGES = 4;
/** About 10 MB of picture data per image. */
const MAX_IMAGE_BASE64_CHARS = 14_000_000;

/** Base64 pictures only: PNG, JPEG, GIF, or WebP, checked by their first bytes. */
function validImages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) return false;
  return value.every(item => typeof item === 'string'
    && item.length > 16
    && item.length <= MAX_IMAGE_BASE64_CHARS
    && /^[A-Za-z0-9+/]+={0,2}$/u.test(item)
    && /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/u.test(item));
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
