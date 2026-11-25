import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { multipart, normalPdf } from './pdf-factory.ts';

export const warmupMs = 120_000;
export const measuredMs = 600_000;
export const drainMs = 120_000;
export const cadence = { rag: 1000, job: 60_000, customer: 10_000 };
export const origin = 'https://sufler.test';
const merchants = ['https://merchant.test', 'https://merchant-alt.test'];
const gateway = 'http://proxy';
const fakeAudit = 'http://fake:8080/audit';
const knownCodes = new Set([
  'delivery_unknown', 'payment_provider_unavailable', 'limit', 'rate', 'unavailable', 'mail_unavailable',
  'fiscal_unavailable', 'offer_version_changed', 'support_unavailable', 'unauthorized', 'invalid', 'daily_limit', 'plan_limit',
]);
const prefix = (lane, index) => `198.18.${lane * 72 + index}.10`;

export const quotaEnvironment = {
  QUOTA_VISITOR_ANSWERS: '20', QUOTA_IP_ANSWERS: '60', QUOTA_BOT_DAY_FREE: '50', QUOTA_BOT_DAY_PAID: '300',
  QUOTA_BOT_MONTH_FREE: '300', QUOTA_BOT_MONTH_PAID: '3000', QUOTA_GLOBAL_ANSWERS: '3000',
  QUOTA_PREVIEW_SESSION_CREATE: '1', QUOTA_PREVIEW_SESSION_ANSWERS: '10', QUOTA_IP_PREVIEWS: '3',
  QUOTA_GLOBAL_PREVIEWS: '200', QUOTA_GLOBAL_PREVIEW_ANSWERS: '1000', QUOTA_ACCOUNT_EMBED: '2000000',
  QUOTA_GLOBAL_EMBED: '20000000',
};
export const answerScopes = {
  visitor_answers: Number(quotaEnvironment.QUOTA_VISITOR_ANSWERS),
  ip_answers: Number(quotaEnvironment.QUOTA_IP_ANSWERS),
  bot_day_answers: Number(quotaEnvironment.QUOTA_BOT_DAY_PAID),
  bot_month_answers: Number(quotaEnvironment.QUOTA_BOT_MONTH_PAID),
  global_answers: Number(quotaEnvironment.QUOTA_GLOBAL_ANSWERS),
  account_embed_tokens: Number(quotaEnvironment.QUOTA_ACCOUNT_EMBED),
  global_embed_tokens: Number(quotaEnvironment.QUOTA_GLOBAL_EMBED),
};

export function customerSchedule(side, index) {
  return (side === 'baseline' ? ['login', 'checkout'] : ['forgot', 'verify', 'checkout', 'authority'])[index % (side === 'baseline' ? 2 : 4)];
}
export function providerSteps(side, kind, attested = false) {
  if (side === 'current' && kind === 'checkout') return attested ? ['checkout'] : ['checkout_attest', 'checkout'];
  return ['verify', 'forgot', 'checkout'].includes(kind) ? [kind] : [];
}

async function seed(pool, side, secret, passwordHash) {
  const seedVector = JSON.stringify([1, ...Array(1535).fill(0)]);
  const rows = { rag: [], job: [], customer: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [name, count, lane] of [['rag', 48, 0], ['job', 12, 1], ['customer', 72, 2]]) {
      for (let index = 0; index < count; index++) {
        const kind = customerSchedule(side, index);
        const email = `${name}-${index}@customer.invalid`;
        const account = (await client.query(`INSERT INTO account(email, password_hash, plan, plan_source)
          VALUES ($1,$2,$3,$4) RETURNING id`, [email, passwordHash, name === 'rag' ? 'nobadge' : 'free',
          name === 'rag' ? 'operator' : 'none'])).rows[0].id;
        if (side === 'current' && name === 'customer' && ['checkout', 'authority'].includes(kind)) {
          await client.query('UPDATE account SET email_verified_at=now() WHERE id=$1', [account]);
        }
        const ip = prefix(lane, index);
        const token = randomBytes(32).toString('base64url');
        const row = { accountId: account, email, ip, cookie: '__Host-n6_session=' + token };
        rows[name].push(row);
        if (name !== 'rag') {
          await client.query(`INSERT INTO session(account_id,token_hash,ip_prefix,expires_at)
            VALUES ($1,$2,$3,now()+interval '1 hour')`, [account, createHmac('sha256', secret).update(token).digest('hex'),
            ip.replace(/\.10$/, '.0/24')]);
        }
        if (name === 'customer') continue;
        row.botKey = randomBytes(16).toString('base64url');
        row.bot = (await client.query(`INSERT INTO bot(account_id,status,public_key,company_name,contact)
          VALUES ($1,'active',$2,'Ромашка','sales@merchant.test') RETURNING id`, [account, row.botKey])).rows[0].id;
        if (name === 'job') continue;
        row.origin = merchants[index % merchants.length];
        await client.query('INSERT INTO allowed_origin(bot_id,origin) VALUES ($1,$2)', [row.bot, row.origin]);
        const source = (await client.query(`INSERT INTO source(bot_id,kind,root_url,status,pages_indexed)
          VALUES ($1,'site',$2,'ready',1) RETURNING id`, [row.bot, row.origin])).rows[0].id;
        const page = (await client.query(`INSERT INTO page(source_id,bot_id,url_or_page,title,content_hash)
          VALUES ($1,$2,$3,'Доставка',repeat('a',64)) RETURNING id`, [source, row.bot, row.origin])).rows[0].id;
        await client.query(`INSERT INTO chunk(bot_id,source_id,page_id,ordinal,text,token_count,embedding)
          VALUES ($1,$2,$3,0,'Доставка по России стоит 350 руб.',12,$4)`, [row.bot, source, page, seedVector]);
        await client.query('UPDATE bot SET answers_verified_at=now() WHERE id=$1', [row.bot]);
      }
    }
    await client.query('COMMIT');
    return rows;
  } catch {
    await client.query('ROLLBACK');
    throw new Error('seed');
  } finally {
    client.release();
  }
}

async function http(path, actor, { payload, timeout = 8000, headers, raw } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(gateway + path, {
      method: payload !== undefined || raw ? 'POST' : 'GET',
      headers: { origin: actor.origin ?? origin, 'x-forwarded-for': actor.ip,
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (payload === undefined ? undefined : JSON.stringify(payload)),
      redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
    const result = await response.json().catch(() => null);
    const error = result?.error?.code;
    return { ms: performance.now() - started, status: response.status, code: typeof error === 'string'
      ? (knownCodes.has(error) ? error : 'other') : null, data: result?.data,
      errorIntent: result?.error?.intent_id, errorHasIntent: Object.hasOwn(result?.error ?? {}, 'intent_id') };
  } catch {
    return { ms: performance.now() - started, status: 0, code: 'request_failed' };
  }
}

export function record(result) {
  return { ms: result.ms, status: result.status, code: result.code };
}

async function customer(side, index, actor, password, offerVersion, checkoutFailures) {
  const kind = customerSchedule(side, index);
  const requests = {
    login: ['/api/auth/login', { payload: { email: actor.email, password } }],
    checkout: ['/api/checkout', { payload: { plan: 'nobadge', idempotency_key: randomUUID(),
      ...(side === 'current' ? { offer_version: offerVersion } : {}) } }],
    forgot: ['/api/auth/forgot', { payload: { email: actor.email } }],
    verify: ['/api/auth/email/send', { payload: {} }],
    authority: ['/api/support/authority', { timeout: 2000 }],
  };
  const [path, opts] = requests[kind];
  const result = await http(path, actor, opts);
  if (kind === 'checkout' && result.status === 503) checkoutFailures.set(index, {
    accountId: actor.accountId, key: opts.payload.idempotency_key,
    errorIntent: result.errorIntent, errorHasIntent: result.errorHasIntent,
  });
  const verified = {
    login: result.data?.ok === true,
    checkout: result.data?.status === 'created' && result.data?.redirect_url === 'https://merchant.test/payment',
    forgot: result.data?.status === 'requested',
    verify: result.data?.status === 'accepted',
    authority: typeof result.data?.authority === 'string' && result.data.authority.length > 20,
  };
  return { ...record(result), valid: verified[kind] };
}

async function index(actor) {
  const raw = multipart(normalPdf(), 'delivery.pdf');
  const result = await http('/api/bots/' + actor.bot + '/sources', actor, { raw,
    headers: { 'content-type': 'multipart/form-data; boundary=----n6boundary7MA4YWxkTrZu0gW', 'idempotency-key': randomUUID() } });
  return { ...record(result), id: typeof result.data?.index_job_id === 'string' ? result.data.index_job_id : null };
}

async function readJobs(pool, jobs, started) {
  if (jobs.length === 0) return [];
  const round = await pool.query(`SELECT j.id,j.status,j.failure_reason,s.status AS source_status,j.chunks_done,
    a.status AS attempt_status, (EXTRACT(EPOCH FROM (a.finished_at-j.created_at))*1000)::float8 AS "jobMs",
    (EXTRACT(EPOCH FROM a.finished_at)*1000)::float8 AS finished
    FROM index_job j JOIN source s ON s.id=j.source_id
    LEFT JOIN job_attempt a ON a.index_job_id=j.id AND a.fence=j.current_fence
    WHERE j.id = ANY($1::uuid[])`, [jobs.map(job => job.id).filter(Boolean)]);
  return jobs.map(({ id, ...sample }) => {
    const row = round.rows.find(row => row.id === id);
    if (!row) return { ...sample, final: 'missing' };
    return { ...sample, final: row.status, source: row.source_status, attempt: row.attempt_status,
      chunks: row.chunks_done, reason: row.failure_reason, jobMs: row.jobMs,
      finishedMs: row.finished === null ? null : row.finished - started };
  });
}

async function routeProbe() {
  const ipv4 = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1);
  const ipv6 = (await readFile('/proc/net/ipv6_route', 'utf8')).trim().split('\n').filter(Boolean);
  const defaultRoute = ipv4.some(line => line.trim().split(/\s+/)[1] === '00000000')
    || ipv6.some(line => {
      const fields = line.trim().split(/\s+/);
      return fields[0] === '0'.repeat(32) && fields[1] === '00' && fields.at(-1) !== 'lo';
    });
  if (defaultRoute) return { defaultRoute, blocked: false };
  // A documentation address supplies a non-provider control on the other side of the boundary.
  const blocked = await new Promise(resolve => {
    const socket = createConnection({ host: '192.0.2.1', port: 443, timeout: 1000 });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => resolve(['ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(error.code)));
  });
  return { defaultRoute, blocked };
}

async function readQuota(pool) {
  return {
    counters: (await pool.query('SELECT scope, SUM(used)::int AS sum, MAX(used)::int AS max FROM quota_counter GROUP BY scope')).rows,
    answers: (await pool.query('SELECT outcome, COUNT(*)::int AS count FROM question_log GROUP BY outcome')).rows,
  };
}

async function addCheckoutEvidence(pool, samples, failures) {
  if (failures.size === 0) return;
  const ids = Array.from(failures.values(), failure => failure.accountId);
  const { rows } = await pool.query(`SELECT id,account_id,idempotency_key,status,provider_payment_id
    FROM payment_intent WHERE account_id=ANY($1::uuid[])`, [ids]);
  for (const sample of samples) {
    const failure = failures.get(sample.i);
    if (!failure) continue;
    const orders = rows.filter(row => row.account_id === failure.accountId);
    const original = orders[0];
    sample.checkoutEvidence = {
      noIntent: orders.length === 0,
      heldIntent: orders.length === 1 && original.idempotency_key === failure.key
        && original.status === 'created' && original.provider_payment_id === null,
      responseIntentMatches: original !== undefined && failure.errorIntent === original.id,
      responseIntentAbsent: failure.errorHasIntent === false,
    };
  }
}

async function drive(pool, side, rows, password, offerVersion) {
  for (const actor of rows.rag) {
    const result = await http('/w/v1/config?bot=' + actor.botKey, actor);
    if (result.status !== 200 || result.data?.badge_required !== false || !result.data?.visitor_session) {
      throw new Error('widget_session_setup_' + result.status);
    }
    actor.visitor = result.data.visitor_session;
  }
  const start = performance.now();
  const epochStart = Date.now();
  const until = warmupMs + measuredMs;
  const pending = [];
  const output = { rag: [], job: [], customer: [] };
  const checkoutFailures = new Map();
  const lanes = {
    rag: async index => {
      const actor = rows.rag[index % rows.rag.length];
      const result = await http('/w/v1/ask?bot=' + actor.botKey, actor, {
        payload: { visitor_session: actor.visitor, question: 'Сколько стоит доставка по России?' },
      });
      return { ...record(result), answered: result.data?.status === 'answered' && Boolean(result.data.source) };
    },
    job: i => index(rows.job[i]),
    customer: i => customer(side, i, rows.customer[i], password, offerVersion, checkoutFailures),
  };
  for (let tick = 0; tick < until; tick += cadence.rag) {
    await sleep(Math.max(0, start + tick - performance.now()));
    for (const [lane, every] of Object.entries(cadence)) {
      if (tick % every !== 0) continue;
      const i = tick / every;
      const phase = tick < warmupMs ? 'warmup' : 'measured';
      const lagMs = performance.now() - start - tick;
      const kind = lane === 'customer' ? customerSchedule(side, i) : lane;
      pending.push(lanes[lane](i).then(sample => output[lane].push({ i, phase, kind, lagMs, ...sample })));
    }
  }
  await sleep(Math.max(0, start + until - performance.now()));
  await Promise.all(pending);
  for (const lane of Object.values(output)) lane.sort((a, b) => a.i - b.i);
  do {
    const states = await readJobs(pool, output.job, epochStart);
    if (states.every(job => ['done', 'failed', 'missing'].includes(job.final))
      || performance.now() >= start + until + drainMs) {
      output.job = states;
      break;
    }
    await sleep(1000);
  } while (true);
  const durationMs = performance.now() - start;
  await addCheckoutEvidence(pool, output.customer, checkoutFailures);
  return { ...output, durationMs, quota: await readQuota(pool) };
}

async function main() {
  const env = process.env;
  const side = env.SUFLER_LOAD_SIDE;
  if (env.SUFLER_LOAD_MODE !== 'driver' || !['baseline', 'current'].includes(side)) throw new Error('driver_mode');
  const network = await routeProbe();
  if (!network.blocked || network.defaultRoute) return { side, network, failure: 'egress_probe' };
  const loadRequire = createRequire('/project/package.json');
  const { Pool } = loadRequire('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  try {
    const health = await http('/health', { ip: prefix(3, 1) });
    if (health.status !== 200) return { side, network, failure: 'web_health_' + health.status };
    const password = randomBytes(24).toString('base64url');
    const hash = await loadRequire('bcrypt').hash(password, 10);
    const data = await seed(pool, side, env.SESSION_SECRET, hash);
    // Health checks PostgreSQL. An empty login crosses the web Redis limiter
    // before validation and cannot create an auth session or call a provider.
    const readiness = record(await http('/api/auth/login', { ip: '198.19.254.10' }, { payload: {} }));
    if (readiness.status !== 422 || readiness.code !== 'invalid')
      return { side, network, readiness, failure: 'mutation_readiness' };
    const auditBefore = await (await fetch(fakeAudit, { signal: AbortSignal.timeout(2000) })).json();
    const workload = await drive(pool, side, data, password, env.SUFLER_LOAD_OFFER_VERSION);
    const audit = await (await fetch(fakeAudit, { signal: AbortSignal.timeout(2000) })).json();
    return { side, network, readiness, workload, auditBefore, audit };
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(process.argv[1] ?? '').href === import.meta.url) {
  main().then(report => process.stdout.write(JSON.stringify(report) + '\n')).catch(error => {
    const safe = ['seed', 'driver_mode'].includes(error?.message) || /^widget_session_setup_\d+$/.test(error?.message);
    process.stdout.write(JSON.stringify({ failure: safe ? error.message : 'driver_failed' }) + '\n');
    process.exitCode = 1;
  });
}
