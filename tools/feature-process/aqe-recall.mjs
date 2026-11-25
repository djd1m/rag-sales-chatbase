import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const pattern = process.argv[2] ?? 'patterns/feature-adr/*';
const aqe = fileURLToPath(new URL('./node_modules/.bin/aqe', import.meta.url));
const child = spawn(aqe, ['mcp'], {
  env: { ...process.env, AQE_MEMORY_BACKEND: 'memory', AQE_V3_MODE: 'true' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.once('error', error => child.stdout.destroy(error));
child.stdin.on('error', error => child.stdout.destroy(error));
const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let id = 0;
const deadline = setTimeout(() => child.kill('SIGKILL'), 25_000);
child.once('close', () => clearTimeout(deadline));

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function request(method, params) {
  const requestId = ++id;
  send({ id: requestId, method, params });
  for (;;) {
    const frame = await responses.next();
    if (frame.done) throw new Error(`AQE connection ended during ${method}`);
    const message = JSON.parse(frame.value);
    if (message.id === undefined) continue;
    if (message.id !== requestId || message.error || message.result?.isError || !message.result) {
      throw new Error(`${method}: ${JSON.stringify(message.error ?? message.result ?? message)}`);
    }
    return message.result;
  }
}

async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  const response = result.structuredContent ?? JSON.parse(result.content[0].text);
  if (response.success !== true) throw new Error(`${name} did not return success`);
  return response.data;
}

try {
  const { serverInfo } = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'sufler-feature-process', version: '1.0.0' },
  });
  send({ method: 'notifications/initialized', params: {} });
  const fleet = await call('fleet_init', {});
  const memory = await call('memory_query', { pattern, namespace: 'learning', limit: 5 });
  console.log(JSON.stringify({ status: 'observed', server: serverInfo, fleet, memory }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ status: 'not_available', reason: error.message }));
  process.exitCode = 3;
} finally {
  child.stdin.end();
}
