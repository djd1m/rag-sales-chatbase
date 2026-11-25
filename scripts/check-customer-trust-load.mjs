#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  answerScopes, cadence, customerSchedule, drainMs, providerSteps, measuredMs, origin, quotaEnvironment, warmupMs,
} from '../tests/fixtures/customer-trust-load.mjs';

export const baselineCommit = '32b23aa5cc019e2cf2406db3590e23091632503a';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const liveServices = ['db', 'redis', 'web', 'worker', 'proxy', 'fake'];
const profile = {
  db: [0.5, 384], redis: [0.05, 64], web: [0.85, 640], worker: [0.4, 384],
  proxy: [0.075, 64], fake: [0.075, 128], driver: [0.05, 192],
};
const appImage = 'sufler-ui-audit:pw1.64.1';
const images = [appImage, 'pgvector/pgvector:0.8.6-pg16', 'redis:7.4-alpine', 'caddy:2.8-n6-ratelimit-vps'];
const emptyCounts = ['blocked', 'invalid', 'egress', 'paid'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const phases = ['warmup', 'measured'];
const expectedStatus = { login: 200, checkout: 201, forgot: 202, verify: 202, authority: 200 };

export function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const point = q => sorted.length ? sorted[Math.ceil(sorted.length * q) - 1] : null;
  return { count: sorted.length, p50: point(0.5), p95: point(0.95) };
}

export function summarize(run) {
  const { workload } = run;
  const output = {};
  for (const lane of ['rag', 'job', 'customer']) {
    for (const sample of workload?.[lane] ?? []) {
      if (sample.phase !== 'measured') continue;
      const collection = output[sample.kind] ??= { timings: [], statuses: {} };
      const ms = lane === 'job' ? sample.jobMs : sample.ms;
      if (finite(ms)) collection.timings.push(ms);
      collection.statuses[sample.status] = (collection.statuses[sample.status] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(output).map(([key, value]) =>
    [key, { ...percentiles(value.timings), statuses: value.statuses }]));
}

function gradeTelemetry(run, fail) {
  const { resources, network } = run;
  if (!network?.internal || !network?.onlyIsolated || !network?.blocked || network?.defaultRoute !== false) fail('external network boundary');
  const stages = [resources?.before, resources?.after];
  for (const name of liveServices) {
    const limits = profile[name];
    if (stages.some(stage => {
      const entry = stage?.[name];
      return !entry?.running || entry.oomKilled !== false || entry.restarts !== 0
        || !entry.startedAt || entry.startedAt !== stages[0]?.[name]?.startedAt
        || entry.nanoCpus !== limits[0] * 1e9 || entry.memory !== limits[1] * 2 ** 20
        || ['oom', 'oom_kill', 'oom_group_kill'].some(key => !finite(entry.events?.[key] ?? (key === 'oom_group_kill' ? 0 : NaN))
          || (entry.events?.[key] ?? 0) !== 0);
    })) fail('OOM, restart or missing cgroup evidence for ' + name);
  }
  const stats = resources?.stats;
  if (resources?.sampleErrors !== 0 || !Array.isArray(stats) || stats.length < 36
    || stats.some(point => !finite(point.elapsedMs) || liveServices.some(name => !point.containers?.[name]?.MemUsage
      || !point.containers[name].CPUPerc?.endsWith('%') || !point.containers[name].MemPerc?.endsWith('%')))
    || stats[0].elapsedMs > 15000
    || stats.at(-1).elapsedMs < 700000
    || stats.some((point, index) => index > 0 && (point.elapsedMs <= stats[index - 1].elapsedMs
      || point.elapsedMs - stats[index - 1].elapsedMs > 30000))) fail('incomplete docker stats coverage');
}

function gradeSide(run, side, pair, fail) {
  const { workload, auditBefore, audit } = run ?? {};
  if (!run || run.failure || run.side !== side || !workload) {
    fail('run incomplete');
    return {};
  }
  gradeTelemetry(run, fail);
  if (!finite(workload.durationMs) || workload.durationMs < warmupMs + measuredMs
    || workload.durationMs > warmupMs + measuredMs + drainMs + 2000) fail('warmup, measurement or drain duration');
  for (const [lane, every] of Object.entries(cadence)) {
    const samples = workload[lane] ?? [];
    for (const phase of phases) {
      const expected = (phase === 'warmup' ? warmupMs : measuredMs) / every;
      if (samples.filter(sample => sample.phase === phase).length !== expected) fail(lane + ' ' + phase + ' count');
    }
    if (samples.length !== (warmupMs + measuredMs) / every || samples.some((sample, index) =>
      sample.i !== index || sample.phase !== (index * every < warmupMs ? 'warmup' : 'measured')
      || sample.kind !== (lane === 'customer' ? customerSchedule(side, index) : lane)
      || !finite(sample.lagMs) || sample.lagMs >= cadence.rag
      || !finite(sample.ms))) fail(lane + ' cadence or timings');
  }

  if ((workload.rag ?? []).some(sample => sample.status !== 200 || sample.answered !== true || sample.code !== null)) fail('RAG responses');
  if ((workload.job ?? []).some(job => job.status !== 202 || job.final !== 'done' || job.source !== 'ready'
    || job.attempt !== 'done' || !Number.isInteger(job.chunks) || job.chunks < 1 || job.reason !== null
    || !finite(job.jobMs) || !finite(job.finishedMs) || job.finishedMs < job.i * cadence.job - 1000
    || job.finishedMs > warmupMs + measuredMs + drainMs)) fail('index worker final states or drain deadline');

  if (audit?.delayMs !== 50 || audit?.timeoutEvery !== (pair === 3 ? 5 : 0)
    || emptyCounts.some(key => audit?.[key] !== 0 || auditBefore?.[key] !== 0)
    || auditBefore?.external?.length !== 0 || !finite(auditBefore?.embed) || auditBefore.embed < 1
    || !finite(auditBefore?.answer) || audit?.answer - auditBefore?.answer !== 720
    || !finite(audit?.embed) || audit.embed - auditBefore.embed < 732) fail('provider counters, paid calls or egress');

  let externalIndex = 0;
  for (const sample of workload.customer ?? []) {
    let expectedError;
    for (const [step, kind] of providerSteps(side, sample.kind).entries()) {
      const fake = audit?.external?.[externalIndex++];
      const timeout = pair === 3 && externalIndex % 5 === 0;
      if (fake?.kind !== kind || fake.timeout !== timeout || !finite(fake.ms)
        || (timeout ? (!fake.clientAborted || fake.ms < 4500 || fake.ms > 5250)
          : (fake.clientAborted !== false || fake.ms < 45))) fail('external HTTP scenario or timeout deadline');
      if (!timeout) continue;
      if (sample.kind === 'verify') expectedError = 'delivery_unknown';
      if (sample.kind === 'checkout') expectedError = kind === 'checkout_attest' && step === 0
        ? 'unavailable' : 'payment_provider_unavailable';
      break;
    }
    if (expectedError ? (sample.status !== 503 || sample.code !== expectedError)
      : (sample.status !== expectedStatus[sample.kind] || sample.code !== null || sample.valid !== true)) {
      fail('customer response status or payload for ' + sample.kind);
    }
    if (sample.kind === 'authority' && sample.ms > 2000) fail('support authority deadline');
    if (sample.kind === 'verify' && sample.ms > 8000) fail('verify send deadline');
  }
  if (audit?.external?.length !== externalIndex) fail('extra or missing provider requests');

  const quota = workload.quota;
  const scopeEntries = new Map((quota?.counters ?? []).map(entry => [entry.scope, entry]));
  const question = quota?.answers;
  if (scopeEntries.size !== Object.keys(answerScopes).length
    || Object.entries(answerScopes).some(([scope, ceiling]) => {
      const entry = scopeEntries.get(scope);
      return !entry || !Number.isInteger(entry.max) || entry.max <= 0 || entry.max > ceiling
        || !Number.isInteger(entry.sum) || entry.sum < entry.max || (!scope.endsWith('_tokens') && entry.sum !== 720);
    }) || question?.length !== 1 || question[0].outcome !== 'answered' || question[0].count !== 720) fail('RAG quota or persisted answer accounting');

  const summary = summarize(run);
  if (side === 'current' && ['forgot', 'authority'].some(kind =>
    !finite(summary[kind]?.p95) || summary[kind].p95 > 1000)) fail('forgot or support authority p95');
  return summary;
}

export function gradeReport(report) {
  const failures = new Set();
  const results = [];
  if (report?.failure) failures.add('benchmark execution did not complete');
  if (report?.baseline !== baselineCommit) failures.add('baseline commit');
  if (report?.dependencies?.thirdPartyMatch !== true) failures.add('dependency lock equivalence');
  if (report?.pairs?.length !== 3) failures.add('exactly three paired runs');
  for (let index = 0; index < 3; index++) {
    const pair = report?.pairs?.[index];
    if (pair?.index !== index + 1) failures.add('pair order');
    const result = {};
    for (const side of ['baseline', 'current']) {
      result[side] = gradeSide(pair?.[side], side, index + 1, message => failures.add('pair ' + (index + 1) + ' ' + side + ' ' + message));
    }
    results.push(result);
  }
  const comparisons = {};
  for (const [kind, allowance] of [['rag', 50], ['job', 2000]]) {
    const medians = {};
    for (const side of ['baseline', 'current']) {
      const values = results.map(pair => pair[side][kind]?.p95);
      medians[side] = values.every(finite) ? percentiles(values).p50 : null;
    }
    const limit = medians.baseline === null ? null : medians.baseline * 1.2 + allowance;
    comparisons[kind] = { baseline: medians.baseline, current: medians.current, limit };
    if (limit === null || medians.current === null || medians.current > limit) failures.add(kind + ' comparative p95');
  }
  return { ok: failures.size === 0, failures: [...failures], comparisons, results };
}

function command(program, args, { timeout = 45_000, cwd = root } = {}) {
  return new Promise(resolveCommand => {
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let exceeded = false;
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', data => {
      if (!exceeded) output += data;
      if (output.length > 4_000_000) { exceeded = true; output = ''; child.kill(); }
    });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', () => {});
    child.once('close', code => {
      clearTimeout(timer);
      resolveCommand({ ok: code === 0 && !exceeded, output });
    });
  });
}

async function required(program, args, label, options) {
  const result = await command(program, args, options);
  if (!result.ok) throw new Error(label);
  return result.output.trim();
}

function profileConfig({ project, source, side, pair, work, offerVersion }) {
  const secret = () => randomBytes(24).toString('hex');
  const pgPassword = secret();
  const redisPassword = secret();
  const env = {
    ...quotaEnvironment,
    DATABASE_URL: 'postgresql://sufler:' + pgPassword + '@db:5432/sufler_test',
    REDIS_URL: 'redis://:' + redisPassword + '@redis:6379',
    NODE_ENV: 'production', TZ: 'Etc/UTC', NEXT_TELEMETRY_DISABLED: '1',
    N6_PUBLIC_ORIGIN: origin, N6_UPLOAD_DIR: '/uploads', N6_SPEND_LOG: '/spend/calls.jsonl',
    ANSWER_PROVIDER: 'openrouter', ANSWER_MODEL: 'anthropic/claude-haiku-4.5',
    EMBED_PROVIDER: 'openrouter', EMBED_MODEL: 'openai/text-embedding-3-small', OPENROUTER_API_KEY: secret(),
    SESSION_SECRET: secret(), SUFLER_LOAD_SIDE: side,
    N6_PAYMENTS_MODE: 'live', YOOKASSA_SHOP_ID: '900001', YOOKASSA_SECRET_KEY: secret(), YOOKASSA_TEST_MODE: 'true',
    ...(side === 'current' ? {
      N6_YOOKASSA_RECEIPTS_MODE: 'yookassa', N6_YOOKASSA_RECEIPT_VAT_CODE: '1',
      N6_YOOKASSA_RECEIPT_PAYMENT_SUBJECT: 'service', N6_YOOKASSA_RECEIPT_PAYMENT_MODE: 'full_payment',
      N6_MAIL_MODE: 'resend', N6_RESEND_API_KEY: 're_' + secret(), N6_MAIL_FROM: 'fixture@mail.invalid',
      N6_SUPPORT_MODE: 'libredesk', N6_SUPPORT_BASE_URL: 'https://support.clipmkr.ru',
      N6_SUPPORT_INBOX_ID: randomUUID(), N6_SUPPORT_JWT_SECRET: secret(),
    } : {}),
  };
  const harness = ['tests', 'scripts'].map(dir => root + '/' + dir + ':/harness/' + dir + ':ro');
  const projectFiles = ['apps', 'packages', 'node_modules', 'package.json'].map(dir => source + '/' + dir + ':/project/' + dir + ':ro');
  const node = { image: appImage, user: '10001:10001', working_dir: '/project' };
  const app = {
    ...node, environment: { ...env, SUFLER_LOAD_MODE: 'preload', NODE_OPTIONS: '--max-old-space-size=320' },
    volumes: [...harness, ...projectFiles, work + '/uploads:/uploads', work + '/spend:/spend'],
  };
  const fixture = '/harness/tests/fixtures/customer-trust-load';
  const health = test => ({ test, interval: '2s', timeout: '2s', retries: 25, start_period: '3s' });
  const services = {
    db: {
      image: images[1], environment: { POSTGRES_DB: 'sufler_test', POSTGRES_USER: 'sufler', POSTGRES_PASSWORD: pgPassword },
      healthcheck: health(['CMD', 'pg_isready', '-h', '127.0.0.1', '-U', 'sufler', '-d', 'sufler_test']),
      volumes: ['pg:/var/lib/postgresql/data'],
    },
    redis: {
      image: images[2], environment: { REDIS_PASSWORD: redisPassword },
      command: ['sh', '-c', 'exec redis-server --appendonly no --maxmemory 48mb --maxmemory-policy noeviction --requirepass "$$REDIS_PASSWORD"'],
      healthcheck: health(['CMD-SHELL', 'REDISCLI_AUTH="$$REDIS_PASSWORD" redis-cli ping | grep -qx PONG']),
    },
    fake: {
      ...node, volumes: harness, command: ['node', fixture + '-transport.mjs'],
      environment: { SUFLER_LOAD_MODE: 'provider', SUFLER_LOAD_TIMEOUT_EVERY: pair === 3 ? '5' : '0' },
      healthcheck: health(['CMD', 'node', '-e', "fetch('http://127.0.0.1:8080/audit').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]),
    },
    web: {
      ...app, command: ['node', '--import', fixture + '-transport.mjs', 'node_modules/next/dist/bin/next', 'start', 'apps/web', '--hostname', '0.0.0.0'],
      healthcheck: health(['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]),
    },
    worker: {
      ...app, command: ['node', '--import', fixture + '-transport.mjs', 'apps/worker/dist/index.js'],
      healthcheck: health(['CMD', 'node', '-e', "const t=require('fs').statSync('/tmp/n6-worker-heartbeat'); process.exit(Date.now()-t.mtimeMs<120000?0:1)"]),
    },
    proxy: {
      image: images[3], volumes: [root + '/proxy/Caddyfile:/etc/caddy/Caddyfile:ro'],
    },
    driver: {
      ...node, volumes: [...harness, ...projectFiles], command: ['node', fixture + '.mjs'],
      environment: { DATABASE_URL: env.DATABASE_URL, SESSION_SECRET: env.SESSION_SECRET,
        SUFLER_LOAD_MODE: 'driver', SUFLER_LOAD_SIDE: side, SUFLER_LOAD_OFFER_VERSION: offerVersion },
    },
  };
  for (const [name, service] of Object.entries(services)) {
    const [cpus, memory] = profile[name];
    Object.assign(service, { cpus, mem_limit: memory + 'm', networks: ['isolated'], pull_policy: 'never', restart: 'no' });
  }
  return { name: project, services, networks: { isolated: { internal: true } }, volumes: { pg: {} } };
}

const docker = (args, label, options) => required('docker', args, label, options);

async function readResources(ids) {
  const keys = Object.keys(ids);
  const format = '{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.State.StartedAt}}';
  const rows = (await docker(['inspect', '--format', format, ...Object.values(ids)], 'container_state')).split('\n');
  const resources = await Promise.all(keys.map(async (name, index) => {
    const [running, oomKilled, restarts, nanoCpus, memory, startedAt] = rows[index].split(' ');
    const text = await docker(['exec', ids[name], 'cat', '/sys/fs/cgroup/memory.events'], 'cgroup_memory_events')
      .catch(() => '');
    const events = Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
      const [key, value] = line.split(' ');
      return [key, Number(value)];
    }));
    return [name, { running: running === 'true', oomKilled: oomKilled === 'true', restarts: Number(restarts),
      nanoCpus: Number(nanoCpus), memory: Number(memory), startedAt, events }];
  }));
  return Object.fromEntries(resources);
}

async function topology(project, ids) {
  const isolated = project + '_isolated';
  const network = await docker(['network', 'inspect', '--format', '{{.Internal}} {{.Driver}}', isolated], 'network_inspection');
  const attached = (await docker(['inspect', '--format',
    '{{range $name, $config := .NetworkSettings.Networks}}{{$name}} {{end}}|{{len .HostConfig.PortBindings}}|{{.HostConfig.Privileged}}',
    ...Object.values(ids)], 'container_isolation')).split('\n');
  return { internal: network === 'true bridge', onlyIsolated: attached.length === liveServices.length
    && attached.every(entry => entry === isolated + ' |0|false') };
}

async function sampleResources(ids, stop, resources) {
  const started = performance.now();
  const names = Object.keys(ids);
  const keys = Object.values(ids);
  while (!stop.signal.aborted) {
    const elapsedMs = performance.now() - started;
    try {
      const raw = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...keys], 'docker_stats', { timeout: 12000 });
      const rows = raw.split('\n').map(line => JSON.parse(line));
      const containers = {};
      for (let index = 0; index < keys.length; index++) {
        const row = rows.find(entry => keys[index].startsWith(entry.ID));
        if (!row) throw new Error('missing_stats');
        const { CPUPerc, MemUsage, MemPerc, NetIO, BlockIO, PIDs } = row;
        containers[names[index]] = { CPUPerc, MemUsage, MemPerc, NetIO, BlockIO, PIDs };
      }
      resources.stats.push({ elapsedMs, containers });
    } catch {
      resources.sampleErrors++;
    }
    await sleep(Math.max(0, elapsedMs + 15000 - (performance.now() - started)), undefined, { signal: stop.signal }).catch(() => {});
  }
}

async function runSide({ project, source, side, pair, work, offerVersion }) {
  await mkdir(work, { mode: 0o700 });
  for (const dir of ['uploads', 'spend']) await mkdir(join(work, dir), { mode: 0o777 });
  // The Docker daemon resolves the bind path. Only the mapped directories need access by UID 10001.
  for (const dir of ['uploads', 'spend']) await chmod(join(work, dir), 0o777);
  const file = join(work, 'compose.json');
  const config = profileConfig({ project, source, side, pair, work, offerVersion });
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const compose = (args, label, options) => docker(['compose', '--env-file', '/dev/null', '-f', file, ...args], label, options);
  const result = { side, resources: { stats: [], sampleErrors: 0 } };
  let stage = 'backing_services';
  try {
    await compose(['up', '-d', '--wait', '--wait-timeout', '60', 'db', 'redis', 'fake'], stage, { timeout: 75_000 });
    stage = 'migrate';
    await compose(['run', '--rm', '--no-deps', '-T', 'web', 'node', 'packages/db/dist/migrate.js'], stage);
    stage = 'app_services';
    await compose(['up', '-d', '--wait', '--wait-timeout', '75', 'web', 'worker', 'proxy'], stage, { timeout: 90_000 });
    stage = 'container_ids';
    const ids = Object.fromEntries(await Promise.all(liveServices.map(async name =>
      [name, await compose(['ps', '-q', name], stage)])));
    stage = 'topology';
    const network = await topology(project, ids);
    result.network = network;
    if (!network.internal || !network.onlyIsolated) throw new Error('topology');
    stage = 'starting_resources';
    result.resources.before = await readResources(ids);
    const stop = new AbortController();
    const stats = sampleResources(ids, stop, result.resources);
    stage = 'driver_output';
    try {
      const output = await command('docker', ['compose', '--env-file', '/dev/null', '-f', file,
        'run', '--rm', '--no-deps', '-T', 'driver'], { timeout: warmupMs + measuredMs + drainMs + 60000 });
      const driver = JSON.parse(output.output.trim());
      const { network: driverNetwork, ...evidence } = driver;
      Object.assign(result, evidence, { network: { ...network, ...driverNetwork } });
      if (!output.ok && !result.failure) result.failure = stage;
    } catch {
      result.failure = stage;
    } finally {
      stop.abort();
      await stats;
    }
    stage = 'ending_resources';
    result.resources.after = await readResources(ids);
  } catch {
    result.failure ??= stage;
  } finally {
    try {
      await compose(['down', '--volumes', '--remove-orphans'], 'cleanup', { timeout: 75_000 });
    } catch {
      result.failure ??= 'cleanup';
      result.cleanupFailed = true;
    }
  }
  return result;
}

function npmPackages(lock) {
  return Object.fromEntries(Object.entries(lock.packages).filter(([key, value]) => key.includes('node_modules/') && !value.link)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, [value.version, value.integrity, value.resolved]]));
}

async function verifySources(baseline) {
  const entries = (await required('git', ['ls-tree', '-r', baselineCommit, '--', 'apps', 'packages', 'package.json', 'package-lock.json'],
    'baseline_commit_unavailable')).split('\n');
  for (const entry of entries) {
    const [, expected, file] = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(entry) ?? [];
    if (!file) throw new Error('baseline_archive_entries');
    const content = await readFile(join(baseline, file));
    const digest = createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex');
    if (digest !== expected) throw new Error('baseline_archive_drift');
  }
  const locks = await Promise.all([baseline, root].map(async path => JSON.parse(await readFile(join(path, 'package-lock.json'), 'utf8'))));
  const [before, after] = locks.map(npmPackages);
  const thirdPartyMatch = JSON.stringify(before) === JSON.stringify(after);
  if (!thirdPartyMatch) throw new Error('third_party_lock_drift');
  for (const checkout of [baseline, root]) {
    await stat(join(checkout, 'apps/web/.next/BUILD_ID'));
    await stat(join(checkout, 'apps/worker/dist/index.js'));
    await stat(join(checkout, 'packages/db/dist/migrate.js'));
  }
  const versions = await readFile(join(root, 'apps/web/src/lib/trust-legal-catalog.ts'), 'utf8');
  const offerVersion = /\bversion:\s*'([^']+)'/.exec(versions)?.[1];
  if (!offerVersion || !/^[\d.-]+$/.test(offerVersion)) throw new Error('current_offer_version');
  return { dependencies: { thirdPartyMatch, entries: Object.keys(before).length }, offerVersion };
}

async function runSuite(baselinePath, reportDirectory) {
  const reportRoot = await realpath(reportDirectory);
  if (!reportRoot.startsWith(join(root, '.secrets/codeworkers/load') + '/') && reportRoot !== join(root, '.secrets/codeworkers/load')) {
    throw new Error('report_directory_must_be_private');
  }
  const runId = 'trustload' + randomBytes(5).toString('hex');
  const directory = join(reportRoot, runId);
  await mkdir(directory, { mode: 0o700 });
  const report = { baseline: baselineCommit, starts: [], pairs: [] };
  const reportFile = join(directory, 'report.json');
  const save = () => writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  let stage = 'docker_probe';
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], stage);
    stage = 'built_source_verification';
    const baseline = await realpath(baselinePath);
    const { dependencies, offerVersion } = await verifySources(baseline);
    report.dependencies = dependencies;
    stage = 'local_images';
    report.images = await Promise.all(images.map(async name =>
      [name, await docker(['image', 'inspect', '--format', '{{.Id}}', name], stage)]));
    for (let pair = 1; pair <= 3; pair++) {
      const entry = { index: pair };
      report.pairs.push(entry);
      // Alternating side order limits systematic drift across the paired comparison.
      for (const side of pair === 2 ? ['current', 'baseline'] : ['baseline', 'current']) {
        stage = 'side_execution';
        report.starts.push({ pair, side, at: new Date().toISOString() });
        const project = runId + 'p' + pair + (side === 'baseline' ? 'b' : 'c');
        await save();
        process.stderr.write('Pair ' + pair + ' ' + side + ' started\n');
        entry[side] = await runSide({ project, source: side === 'baseline' ? baseline : root, side, pair,
          work: join(directory, 'pair-' + pair + '-' + side), offerVersion });
        await save();
        process.stderr.write('Pair ' + pair + ' ' + side + ' ' + (entry[side].failure ?? 'measured') + '\n');
        if (entry[side].cleanupFailed) throw new Error('prior_stack_cleanup');
      }
    }
  } catch {
    report.failure = stage;
  }
  report.grade = gradeReport(report);
  await save();
  return { reportFile, ...report.grade, starts: report.starts.length, failure: report.failure };
}

async function cli(args) {
  if (args[0] === '--grade' && args.length === 2) return gradeReport(JSON.parse(await readFile(args[1], 'utf8')));
  if (args[0] === '--run' && args.length === 3) return runSuite(resolve(args[1]), resolve(args[2]));
  throw new Error('usage');
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  cli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  }).catch(() => {
    process.stderr.write('Load runner failed. Usage: node scripts/check-customer-trust-load.mjs --run <built-baseline> <private-report-dir> | --grade <report.json>\n');
    process.exitCode = 1;
  });
}
