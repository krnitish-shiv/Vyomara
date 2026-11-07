import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkAliases } from '../src/shared/link-alias.ts';

const LONG = 'https://news.google.com/rss/articles/CBMiXEFVX3lxTE53WjRpT3VBUmlpUGlaYnpueE80c3pua3NuRm43N2l3SnFRQUtBVXI3?oc=5';

test('long URLs become short aliases for the model and come back in replies and tool arguments', () => {
  const links = new LinkAliases();
  const shown = links.shorten(`{"url":"${LONG}","home":"https://isro.gov.in"}`);
  assert.equal(shown, '{"url":"https://l.vyomara/1","home":"https://isro.gov.in"}');
  assert.equal(links.shorten(`again ${LONG}`), 'again https://l.vyomara/1');
  assert.equal(links.expand('[Watch](https://l.vyomara/1)'), `[Watch](${LONG})`);
  assert.deepEqual(links.expandArguments({ url: 'https://l.vyomara/1', nested: ['https://l.vyomara/9'] }), { url: LONG, nested: ['https://l.vyomara/9'] });
});
