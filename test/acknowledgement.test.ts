import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgementFor } from '../src/shared/acknowledgement.ts';

test('the twin says a short gendered line before working', () => {
  assert.equal(acknowledgementFor('delegate', 'Handing to Khoj: find the Node LTS', 'female'), 'Khoj ko de rahi hoon.');
  assert.equal(acknowledgementFor('delegate', 'Handing to the team: x', 'male'), 'Team ko de raha hoon.');
  assert.equal(acknowledgementFor('web_search', 'Searching the web for “x”', 'male'), 'Ek second, dekh raha hoon.');
  assert.equal(acknowledgementFor('edit_file', 'Editing cart.js', 'female'), 'Theek hai, kar rahi hoon.');
  assert.equal(acknowledgementFor('open_application', 'Opening Safari', 'male'), 'Haan, khol raha hoon.');
  assert.equal(acknowledgementFor('read_file', 'Reading x', 'female'), 'Ek second, dekh rahi hoon.');
});
