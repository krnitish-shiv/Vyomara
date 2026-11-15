// A minimal MCP stdio server for tests: one "add" tool and one failing tool.
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
console.log('not json: servers sometimes log here');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [
    { name: 'add', description: 'Add numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['a', 'b'] } },
    { name: 'broken-tool', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  ] } });
  else if (message.method === 'tools/call' && message.params.name === 'add') {
    const { a, b, tags } = message.params.arguments;
    send({ id: message.id, result: { content: [{ type: 'text', text: `${a + b}${tags ? ` ${tags.join(',')}` : ''}` }] } });
  } else if (message.method === 'tools/call') send({ id: message.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } });
  else send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
