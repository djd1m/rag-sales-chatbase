import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { baselineCommit, gradeReport, percentiles } from '../scripts/check-customer-trust-load.mjs';
import { answerScopes, cadence, customerSchedule, providerSteps, measuredMs, warmupMs } from './fixtures/customer-trust-load.mjs';
import { createLoadFake, installLoadTransport } from './fixtures/customer-trust-load-transport.mjs';

type Side = 'baseline' | 'current';

function specimenSide(side: Side, pair: number) {
  const total = warmupMs + measuredMs;
  const sequences = Object.fromEntries(Object.entries(cadence).map(([lane, every]) => [
    lane, Array.from({ length: total / every }, (_, i) => ({
      i, phase: i * every < warmupMs ? 'warmup' : 'measured', lagMs: 0, ms: 50, status: 200, code: null as string | null,
    })),
  ]));
  const external: { kind: string; timeout: boolean; clientAborted: boolean; ms: number }[] = [];
  const healthy = { login: 200, checkout: 201, forgot: 202, verify: 202, authority: 200 };
  const customer = sequences.customer!.map(sample => {
    const kind = customerSchedule(side, sample.i) as keyof typeof healthy;
    let error = null;
    for (const [step, endpoint] of providerSteps(side, kind).entries()) {
      const timeout = pair === 3 && (external.length + 1) % 5 === 0;
      external.push({ kind: endpoint, timeout, clientAborted: timeout, ms: timeout ? 5000 : 50 });
      if (!timeout) continue;
      if (kind === 'verify') error = 'delivery_unknown';
      if (kind === 'checkout') error = side === 'current' && step === 0 ? 'unavailable' : 'payment_provider_unavailable';
      break;
    }
    return { ...sample, kind, status: error ? 503 : healthy[kind], valid: !error, code: error || null, ms: error ? 5100 : 100 };
  });
  const limits = {
    db: [0.5, 384], redis: [0.05, 64], web: [0.85, 640], worker: [0.4, 384], proxy: [0.075, 64], fake: [0.075, 128],
  };
  const resource = () => Object.fromEntries(Object.entries(limits).map(([name, [cpus, memory]]) => [name, {
    running: true, oomKilled: false, restarts: 0, startedAt: 'same-start', nanoCpus: cpus! * 1e9, memory: memory! * 2 ** 20,
    events: { oom: 0, oom_kill: 0, oom_group_kill: 0 },
  }]));
  const containers = Object.fromEntries(Object.keys(limits).map(name => [name, {
    MemUsage: '1MiB / 64MiB', CPUPerc: '0.23%', MemPerc: '1.56%',
  }]));
  const auditBefore = { delayMs: 50, timeoutEvery: pair === 3 ? 5 : 0, blocked: 0, invalid: 0, egress: 0, paid: 0, answer: 0, embed: 1, external: [] };
  return {
    side, network: { internal: true, onlyIsolated: true, blocked: true, defaultRoute: false },
    resources: { before: resource(), after: resource(), sampleErrors: 0,
      stats: Array.from({ length: 48 }, (_, i) => ({ elapsedMs: i * 15000, containers })) },
    auditBefore, audit: { ...auditBefore, answer: 720, embed: 733, external },
    workload: {
      durationMs: total, customer,
      rag: sequences.rag!.map(sample => ({ ...sample, kind: 'rag', answered: true })),
      job: sequences.job!.map(sample => ({ ...sample, kind: 'job', status: 202, final: 'done', source: 'ready',
        attempt: 'done', chunks: 2, reason: null, jobMs: 200, finishedMs: sample.i * cadence.job + 200 })),
      quota: {
        counters: Object.keys(answerScopes).map(scope => ({ scope, max: 10, sum: 720 })),
        answers: [{ outcome: 'answered', count: 720 }],
      },
    },
  };
}

function specimen() {
  return { baseline: baselineCommit, dependencies: { thirdPartyMatch: true },
    pairs: [1, 2, 3].map(index => ({ index, baseline: specimenSide('baseline', index), current: specimenSide('current', index) })) };
}

test('isolated workload rejects p95 and memory regression against baseline', () => {
  const healthy = specimen();
  expect(gradeReport(healthy)).toMatchObject({ ok: true, failures: [], comparisons: {
    rag: { baseline: 50, current: 50, limit: 110 }, job: { baseline: 200, current: 200, limit: 2240 },
  } });
  expect(percentiles([40, 10, 50, 20, 30])).toEqual({ count: 5, p50: 30, p95: 50 });

  const controls: { label: string; breakEvidence: (report: ReturnType<typeof specimen>) => void }[] = [
    { label: 'rag comparative p95', breakEvidence: r => {
      for (const pair of r.pairs.slice(0, 2)) for (const row of pair.current.workload.rag) row.ms = 111;
    } },
    { label: 'job comparative p95', breakEvidence: r => {
      for (const pair of r.pairs.slice(0, 2)) for (const row of pair.current.workload.job) row.jobMs = 2241;
    } },
    { label: 'pair 1 current OOM, restart or missing cgroup evidence for worker', breakEvidence: r => {
      r.pairs[0]!.current.resources.after.worker!.events.oom_kill = 1;
    } },
    { label: 'pair 1 current OOM, restart or missing cgroup evidence for web', breakEvidence: r => {
      r.pairs[0]!.current.resources.after.web!.restarts = 1;
    } },
    { label: 'pair 1 current incomplete docker stats coverage', breakEvidence: r => {
      r.pairs[0]!.current.resources.stats.length = 1;
    } },
    { label: 'pair 1 current external network boundary', breakEvidence: r => {
      r.pairs[0]!.current.network.blocked = false;
    } },
    { label: 'pair 1 current index worker final states or drain deadline', breakEvidence: r => {
      r.pairs[0]!.current.workload.job.at(-1)!.finishedMs = 840001;
    } },
    { label: 'pair 1 current job measured count', breakEvidence: r => {
      r.pairs[0]!.current.workload.job.pop();
    } },
    { label: 'pair 1 current RAG responses', breakEvidence: r => {
      r.pairs[0]!.current.workload.rag.at(-1)!.status = 503;
    } },
    { label: 'pair 1 current RAG quota or persisted answer accounting', breakEvidence: r => {
      r.pairs[0]!.current.workload.quota.counters.find(row => row.scope === 'visitor_answers')!.max = 21;
    } },
    { label: 'pair 1 current customer cadence or timings', breakEvidence: r => {
      r.pairs[0]!.current.workload.customer.at(-1)!.lagMs = 1000;
    } },
    { label: 'pair 1 current forgot or support authority p95', breakEvidence: r => {
      r.pairs[0]!.current.workload.customer.filter(row => row.kind === 'forgot').forEach(row => { row.ms = 1001; });
    } },
    { label: 'pair 3 current support authority deadline', breakEvidence: r => {
      r.pairs[2]!.current.workload.customer.find(row => row.kind === 'authority')!.ms = 2001;
    } },
    { label: 'pair 3 current verify send deadline', breakEvidence: r => {
      r.pairs[2]!.current.workload.customer.find(row => row.kind === 'verify')!.ms = 8001;
    } },
    { label: 'pair 3 current external HTTP scenario or timeout deadline', breakEvidence: r => {
      r.pairs[2]!.current.audit.external[4]!.ms = 5400;
    } },
    { label: 'pair 1 current provider counters, paid calls or egress', breakEvidence: r => {
      r.pairs[0]!.current.audit.paid = 1;
    } },
    { label: 'pair 1 current customer response status or payload for checkout', breakEvidence: r => {
      r.pairs[0]!.current.workload.customer.find(row => row.kind === 'checkout')!.status = 503;
    } },
    { label: 'exactly three paired runs', breakEvidence: r => { r.pairs.pop(); } },
  ];
  for (const { label, breakEvidence } of controls) {
    const report = structuredClone(healthy);
    breakEvidence(report);
    const result = gradeReport(report);
    expect(result.ok, label).toBe(false);
    expect(result.failures, label).toContain(label);
  }
});

test('isolated trust harness denies external egress and counts fake calls', async () => {
  const server = createLoadFake({ timeoutEvery: 5 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback fake did not acquire a port');
  const base = 'http://127.0.0.1:' + address.port;
  const env = { N6_RESEND_API_KEY: randomBytes(24).toString('hex'), OPENROUTER_API_KEY: randomBytes(24).toString('hex'),
    YOOKASSA_SHOP_ID: '990001', YOOKASSA_SECRET_KEY: randomBytes(24).toString('hex'), YOOKASSA_TEST_MODE: 'true' };
  const localhost = loopbackOnlyFetch(base);
  installLoadTransport({ base, side: 'current', env, target: localhost });
  const mail = (signal?: AbortSignal) => localhost.fetch('https://api.resend.com/emails', {
    method: 'POST', signal, headers: { authorization: 'Bearer ' + env.N6_RESEND_API_KEY },
    body: JSON.stringify({ from: 'fixture@mail.invalid', to: 'fixture@customer.invalid', subject: 'fixture',
      text: 'https://sufler.test/verify-email#' + randomBytes(32).toString('base64url') }),
  });
  try {
    const embedding = await localhost.fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.OPENROUTER_API_KEY },
      body: JSON.stringify({ dimensions: 1536, input: ['fixture'] }),
    });
    expect((await embedding.json()).data[0].embedding).toHaveLength(1536);
    const credentials = 'Basic ' + Buffer.from(env.YOOKASSA_SHOP_ID + ':' + env.YOOKASSA_SECRET_KEY).toString('base64');
    const attestation = await localhost.fetch('https://api.yookassa.ru/v3/me', { headers: { authorization: credentials } });
    const attested = await attestation.json();
    expect(attested.test === true && attested.account_id === env.YOOKASSA_SHOP_ID).toBe(true);
    const order = randomUUID();
    const checkout = await localhost.fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST', headers: {
        authorization: credentials,
        'idempotence-key': order,
      },
      body: JSON.stringify({ amount: { value: '990.00', currency: 'RUB' }, capture: true, metadata: { order_id: order },
        confirmation: { type: 'redirect', return_url: 'https://sufler.test/upgrade/return?intent=' + order },
        receipt: { customer: { email: 'fixture@customer.invalid' }, items: [{ quantity: '1.00', amount: { value: '990.00', currency: 'RUB' },
          vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }] } }),
    });
    expect(await checkout.json()).toMatchObject({ status: 'pending', test: true, paid: false });
    for (let i = 0; i < 2; i++) {
      const response = await mail();
      expect(response.ok).toBe(true);
      await response.body!.cancel();
    }
    await expect(mail(AbortSignal.timeout(150))).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(localhost.fetch('https://egress-control.invalid/')).rejects.toThrow('unmapped request');
    await expect.poll(async () => (await (await fetch(base + '/audit')).json()).external.at(-1)?.clientAborted).toBe(true);
    const report = await (await fetch(base + '/audit')).json();
    expect(report).toMatchObject({ embed: 1, answer: 0, invalid: 0, blocked: 1, paid: 0, egress: 0 });
    expect(report.external.map((sample: { kind: string; timeout: boolean }) => [sample.kind, sample.timeout])).toEqual([
      ['checkout_attest', false], ['checkout', false], ['verify', false], ['verify', false], ['verify', true],
    ]);
    expect(localhost.destinations.every(destination => destination === base)).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function loopbackOnlyFetch(base: string) {
  const destinations: string[] = [];
  return { destinations, fetch: async (input: string | URL | Request, init?: RequestInit) => {
    const destination = new URL(input instanceof Request ? input.url : input).origin;
    destinations.push(destination);
    if (destination !== base) throw new Error('Test fetch left the loopback origin');
    return globalThis.fetch(input, init);
  } };
}
