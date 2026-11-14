import { createInterface } from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the provided text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fail', description: 'Always fails.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } },
];

const rl = createInterface({ input: process.stdin });

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

rl.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (name === 'slow') return;
    if (name === 'fail') {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'fixture failure' } });
      return;
    }
    const text = String(params?.arguments?.text ?? '');
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo:${text}` }] } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
});
