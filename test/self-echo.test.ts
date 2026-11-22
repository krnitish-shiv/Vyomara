import assert from 'node:assert/strict';
import test from 'node:test';
import { SelfEchoGuard } from '../src/desktop/self-echo.ts';

test('the twin\'s own words coming back through the microphone are recognised', () => {
  const guard = new SelfEchoGuard();
  guard.noteSpoken('Haan ji, Google Chrome khol diya hai.', 1_000);
  guard.noteSpoken('Aur kuch karna hai?', 2_000);
  assert.equal(guard.isEcho('Google Chrome khol diya hai', 2_500), true, 'heard while speaking');
  guard.noteEnded(4_000);
  assert.equal(guard.isEcho('aur kuch karna hai', 6_000), true, 'heard just after');
  assert.equal(guard.isEcho('हाँ जी, गूगल क्रोम खोल दिया है', 6_000), true, 'in another script');
});

test('the user\'s real reply is not mistaken for an echo', () => {
  const guard = new SelfEchoGuard();
  guard.noteSpoken('Haan ji, Google Chrome khol diya hai. Aur kuch karna hai?', 1_000);
  guard.noteEnded(3_000);
  assert.equal(guard.isEcho('YouTube par gaana chala do', 4_000), false);
  assert.equal(guard.isEcho('haan, ab Safari bhi kholo', 4_000), false, 'one shared word is not enough');
  assert.equal(guard.isEcho('Google Chrome khol diya hai', 20_000), false, 'long after speaking, repeating it is the user');
  assert.equal(guard.isEcho('', 3_500), false);
});
