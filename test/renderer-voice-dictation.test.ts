import assert from 'node:assert/strict';
import test from 'node:test';
import { appendVoiceDraft } from '../src/renderer/src/ui/voice-dictation.ts';

test('dictation appends each finished phrase to the editable message text', () => {
  assert.equal(appendVoiceDraft('', 'first segment'), 'first segment');
  assert.equal(appendVoiceDraft('first segment', 'second segment'), 'first segment second segment');
  assert.equal(appendVoiceDraft('typed text', ''), 'typed text');
});
