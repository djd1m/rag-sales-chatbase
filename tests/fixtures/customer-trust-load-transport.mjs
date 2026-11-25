import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const endpoints = new Map([
  ['https://openrouter.ai/api/v1/embeddings', 'embed'],
  ['https://openrouter.ai/api/v1/chat/completions', 'answer'],
  ['https://api.resend.com/emails', 'mail'],
  ['https://api.yookassa.ru/v3/payments', 'checkout'],
  ['https://api.yookassa.ru/v3/me', 'checkout_attest'],
]);
const vector = [1, ...Array(1535).fill(0)];

/**
 * @param {{base: string, side: string, env: Record<string, string | undefined>, target?: {fetch: typeof fetch}}} options
 */
export function installLoadTransport({ base, side, env, target = globalThis }) {
  const local = target.fetch.bind(target);
  target.fetch = async (input, init) => {
    const request = new Request(input, init);
    const endpoint = endpoints.get(request.url);
    const url = new URL(request.url);
    if (!endpoint && url.origin === 'http://127.0.0.1:3000') return local(request, { redirect: 'error' });
    const reject = async () => {
      await local(new URL('/denied', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(1000) });
      throw new Error('Load transport rejected an unmapped request');
    };
    const attest = endpoint === 'checkout_attest';
    const payment = attest || endpoint === 'checkout';
    if (!endpoint || request.method !== (attest ? 'GET' : 'POST')) return reject();
    const authorization = request.headers.get('authorization');
    const expected = payment
      ? 'Basic ' + Buffer.from(env.YOOKASSA_SHOP_ID + ':' + env.YOOKASSA_SECRET_KEY).toString('base64')
      : 'Bearer ' + (endpoint === 'mail' ? env.N6_RESEND_API_KEY : env.OPENROUTER_API_KEY);
    if (authorization !== expected || (payment && env.YOOKASSA_TEST_MODE !== 'true')) return reject();
    // Send protocol fields to the fake without forwarding provider credentials.
    const response = await local(new URL('/' + endpoint, base), {
      method: request.method, body: attest ? undefined : await request.text(), redirect: 'error', signal: request.signal,
      headers: {
        'content-type': 'application/json', 'x-load-side': side,
        'x-fake-shop': payment ? env.YOOKASSA_SHOP_ID : '',
        'idempotence-key': request.headers.get('idempotence-key') ?? '',
      },
    });
    // The synthetic HTTP hop stays below the provider client's origin check.
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

function modelResponse(endpoint, body) {
  if (endpoint === 'embed') {
    if (body.dimensions !== 1536 || !Array.isArray(body.input) || !body.input.length
      || body.input.some(value => typeof value !== 'string')) throw new Error('embedding protocol');
    return { data: body.input.map((_, index) => ({ index, embedding: vector })), usage: { total_tokens: 5 } };
  }
  const schema = body.response_format?.json_schema?.name;
  if (!Array.isArray(body.messages) || !['probe', 'answer'].includes(schema)) throw new Error('answer protocol');
  const result = schema === 'probe' ? { ok: true } : { status: 'answered', citations: ['F1'], text: 'Доставка стоит 350 ₽.' };
  return { choices: [{ message: { content: JSON.stringify(result) } }], usage: { total_tokens: 15 } };
}

function mailResponse(body) {
  const match = typeof body.text === 'string' && body.text.match(/https:\/\/sufler\.test\/(forgot|reset|verify-email)#[^\s]+/);
  if (!match || match[1] === 'forgot' || !/^[^@]+@mail\.invalid$/.test(body.from)
    || typeof body.to !== 'string' || !/^[^@]+@customer\.invalid$/.test(body.to)
    || typeof body.subject !== 'string') throw new Error('mail protocol');
  return { kind: match[1] === 'reset' ? 'forgot' : 'verify', value: { id: randomUUID() } };
}

function checkoutResponse(request, body) {
  const order = body.metadata?.order_id;
  const shop = request.headers['x-fake-shop'];
  if (!/^\d+$/.test(shop) || !/^[a-f\d-]{36}$/.test(order) || order !== request.headers['idempotence-key']
    || body.amount?.value !== '990.00' || body.amount?.currency !== 'RUB' || body.capture !== true
    || body.confirmation?.type !== 'redirect'
    || body.confirmation?.return_url !== 'https://sufler.test/upgrade/return?intent=' + order) throw new Error('checkout protocol');
  if (request.headers['x-load-side'] === 'current') {
    const line = body.receipt?.items?.[0];
    if (body.receipt?.items?.length !== 1 || !/^[^@]+@customer\.invalid$/.test(body.receipt?.customer?.email)
      || line?.quantity !== '1.00' || line.amount?.value !== body.amount.value || line.amount?.currency !== body.amount.currency
      || line.vat_code !== 1 || line.payment_mode !== 'full_payment' || line.payment_subject !== 'service') throw new Error('receipt protocol');
  } else if (request.headers['x-load-side'] !== 'baseline' || body.receipt) throw new Error('baseline protocol');
  return { kind: 'checkout', value: {
    id: randomUUID(), status: 'pending', paid: false, test: true, recipient: { account_id: shop },
    amount: body.amount, metadata: body.metadata, confirmation: { confirmation_url: 'https://merchant.test/payment' },
  } };
}

export function createLoadFake({ timeoutEvery = 0, delayMs = 50 } = {}) {
  const audit = { delayMs, timeoutEvery, embed: 0, answer: 0, external: [], blocked: 0, invalid: 0, egress: 0, paid: 0 };
  async function handle(request, response) {
    const send = (value, status = 200) => {
      if (!response.destroyed) response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/audit') return send(audit);
    if (request.method === 'POST' && request.url === '/denied') {
      audit.blocked++;
      return send({}, 403);
    }
    try {
      const endpoint = request.url.slice(1);
      const attest = endpoint === 'checkout_attest';
      if (request.method !== (attest ? 'GET' : 'POST')
        || !['embed', 'answer', 'mail', 'checkout', 'checkout_attest'].includes(endpoint)) throw new Error('endpoint');
      const parts = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 262144) throw new Error('body size');
        parts.push(part);
      }
      const body = attest ? null : JSON.parse(Buffer.concat(parts));
      if (endpoint === 'answer' || endpoint === 'embed') {
        const model = modelResponse(endpoint, body);
        audit[endpoint]++;
        return send(model);
      }
      const shop = request.headers['x-fake-shop'];
      if (attest && (size !== 0 || !/^\d+$/.test(shop) || request.headers['x-load-side'] !== 'current')) throw new Error('attestation protocol');
      const { kind, value } = attest ? { kind: endpoint, value: { account_id: shop, test: true } }
        : endpoint === 'mail' ? mailResponse(body) : checkoutResponse(request, body);
      const timeout = timeoutEvery > 0 && (audit.external.length + 1) % timeoutEvery === 0;
      const sample = { kind, timeout, clientAborted: false, ms: null };
      audit.external.push(sample);
      const started = performance.now();
      if (timeout) {
        response.once('close', () => {
          sample.clientAborted = !response.writableEnded;
          sample.ms = performance.now() - started;
        });
        return; // Leave the socket silent until the real provider client reaches its deadline.
      }
      await sleep(delayMs);
      sample.ms = performance.now() - started;
      send(value);
    } catch {
      audit.invalid++;
      send({}, 400);
    }
  }
  return createServer({ requestTimeout: 10_000 }, (request, response) => {
    void handle(request, response);
  });
}

if (process.env.SUFLER_LOAD_MODE === 'preload') {
  installLoadTransport({ base: 'http://fake:8080', side: process.env.SUFLER_LOAD_SIDE, env: process.env });
} else if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  if (process.env.SUFLER_LOAD_MODE !== 'provider') throw new Error('Load fake requires isolated provider mode');
  createLoadFake({ timeoutEvery: Number(process.env.SUFLER_LOAD_TIMEOUT_EVERY) }).listen(8080, '0.0.0.0');
}
