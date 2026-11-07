import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDesktopChatRequest,
  parseDesktopSessionDeleteRequest,
  parseDesktopSessionId,
} from '../src/desktop/validation.ts';

const validSessionId = 'c523a2a9-8619-4cf4-8e0a-5e1bfab013f0';
const validRequestId = '6b2fe741-94f9-4ad0-9c7d-16f474cb338e';

test('desktop IPC accepts bounded chat requests with a request UUID and optional session UUID', () => {
  assert.deepEqual(
    parseDesktopChatRequest({ prompt: 'Explain this file.', requestId: validRequestId }, 100),
    { prompt: 'Explain this file.', requestId: validRequestId },
  );
  assert.deepEqual(
    parseDesktopChatRequest({ prompt: 'Continue', requestId: validRequestId, sessionId: validSessionId }, 100),
    { prompt: 'Continue', requestId: validRequestId, sessionId: validSessionId },
  );
  for (const invalid of [
    null,
    [],
    {},
    { prompt: '  ' },
    { prompt: 'x'.repeat(101) },
    { prompt: 'valid' },
    { prompt: 'valid', requestId: '../request' },
    { prompt: 'valid', sessionId: '../outside' },
    { prompt: 'valid', unexpected: true },
  ]) {
    assert.throws(() => parseDesktopChatRequest(invalid, 100), /Chat request is invalid/);
  }
});

test('desktop IPC accepts only UUID session identifiers', () => {
  assert.equal(parseDesktopSessionId(validSessionId), validSessionId);
  for (const invalid of [null, undefined, {}, '../session', '']) {
    assert.throws(() => parseDesktopSessionId(invalid), /Session request is invalid/);
  }
});

test('desktop IPC requires an exact DELETE confirmation for reviewed session history', () => {
  assert.deepEqual(
    parseDesktopSessionDeleteRequest({ id: validSessionId, confirmation: 'DELETE' }),
    { id: validSessionId, confirmation: 'DELETE' },
  );
  for (const invalid of [
    null,
    {},
    { id: validSessionId },
    { id: validSessionId, confirmation: 'delete' },
    { id: '../outside', confirmation: 'DELETE' },
    { id: validSessionId, confirmation: 'DELETE', extra: true },
  ]) {
    assert.throws(
      () => parseDesktopSessionDeleteRequest(invalid),
      /Session deletion request|Session request|type DELETE/,
    );
  }
});

test('microphone requests are trusted only from Vyomara\'s own page', async () => {
  const { isTrustedPageRequest } = await import('../src/desktop/validation.ts');
  const page = 'file:///Users/me/vyomara/out/renderer/index.html';
  // Regression: Chromium reports the origin as "file:///", which an origin check of "file://" rejected.
  assert.equal(isTrustedPageRequest(page, page), true);
  assert.equal(isTrustedPageRequest(`${page}#pip`, page), true);
  assert.equal(isTrustedPageRequest('file:///Users/me/Downloads/evil.html', page), false);
  assert.equal(isTrustedPageRequest('https://example.com/', page), false);
  assert.equal(isTrustedPageRequest('http://localhost:5173/', page, 'http://localhost:5173'), true);
  assert.equal(isTrustedPageRequest('http://localhost:9999/', page, 'http://localhost:5173'), false);
});
