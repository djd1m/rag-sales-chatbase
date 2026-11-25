import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, type Pool } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import { applyVerifiedPayment, createPaymentIntent, openVerifiedPaymentIntent, recordVerifiedRefund, setIntentProviderPayment } from '../packages/db/src/payments';
import { PurchaseMailDeliveryStore } from '../packages/db/src/purchase-mail-delivery';
import { runPurchaseMailTick } from '../apps/worker/src/purchase-mail-watchdog';
import { ensureTestDatabase } from '../scripts/test-db.mjs';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('customer trust transactional billing', () => {
  let pool: Pool;
  const schema = 'trust_billing_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith('_test')) throw Error('isolated test database required');
    await ensureTestDatabase(url);
    pool = createPool(url, schema);
    await pool.query('CREATE SCHEMA ' + schema);
    await migrate(pool);
  }, 60_000);
  afterAll(async () => { if (pool) { await pool.query('DROP SCHEMA ' + schema + ' CASCADE'); await pool.end(); } });

  async function owner() {
    const email = randomUUID() + '@example.invalid';
    const accountId = (await pool.query('INSERT INTO account(email,password_hash) VALUES($1,$2) RETURNING id', [email, 'x'])).rows[0].id as string;
    const sessionHash = randomUUID().replaceAll('-', '').repeat(2);
    await pool.query("INSERT INTO session(account_id,token_hash,ip_prefix,expires_at) VALUES($1,$2,'192.0.2.0/24',now()+interval '1 day')", [accountId, sessionHash]);
    return { accountId, email, sessionHash };
  }
  const input = (account: Awaited<ReturnType<typeof owner>>) => ({
    ...account, plan: 'nobadge' as const, idempotencyKey: randomUUID(), offerVersion: 'V1', offer: { version: 'V1', digest: 'a'.repeat(64) },
    shop: 'test:123', fiscal: { vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment' as const }, publicOrigin: 'https://sufler.invalid',
    description: 'Суфлёр, Без бейджа',
  });
  const verify = (id: string) => pool.query('UPDATE account SET email_verified_at=now() WHERE id=$1', [id]);
  const grant = (orderId: string, id = randomUUID(), amountMinor = 99000) => applyVerifiedPayment(pool, {
    provider: 'yookassa', eventKey: 'payment_succeeded:' + id, payloadSha256: 'e'.repeat(64),
    payment: { orderId, id, shop: 'test:123', amountMinor, feeMinor: 100, paidAt: new Date().toISOString() }
  });

  it('new checkout requires a verified current account and immutable fiscal receipt', async () => {
    const a = await owner(), attempt = input(a);
    expect((await openVerifiedPaymentIntent(pool, attempt)).kind).toBe('email_verification_required');
    await verify(a.accountId);
    const stale = { ...attempt, offer: { version: 'V2', digest: 'b'.repeat(64) } };
    expect((await openVerifiedPaymentIntent(pool, stale)).kind).toBe('offer_version_changed');
    expect((await pool.query('SELECT id FROM payment_intent WHERE account_id=$1', [a.accountId])).rows).toEqual([]);
    const opened = await openVerifiedPaymentIntent(pool, attempt);
    if (opened.kind !== 'created') throw Error(opened.kind);
    expect(opened.intent.checkout_snapshot?.email).toBe(a.email);
    const retry = await openVerifiedPaymentIntent(pool, { ...stale, fiscal: null });
    if (retry.kind !== 'existing') throw Error(retry.kind);
    expect(retry.intent.checkout_snapshot).toEqual(opened.intent.checkout_snapshot);
    expect((await pool.query('SELECT offer_version,offer_digest,offer_accepted_at FROM payment_intent WHERE id=$1', [opened.intent.id])).rows[0])
      .toEqual({ offer_version: 'V1', offer_digest: 'a'.repeat(64), offer_accepted_at: expect.any(Date) });
    await pool.query('UPDATE session SET revoked_at=now() WHERE token_hash=$1', [a.sessionHash]);
    expect((await openVerifiedPaymentIntent(pool, attempt)).kind).toBe('unauthorized');
  });
  it('bound and unbound retries respect the provider window and keep legacy intents intact', async () => {
    const a = await owner(), attempt = input(a);
    const legacy = await createPaymentIntent(pool, { ...attempt, priceMinor: 99000 });
    if (legacy.kind === 'conflict') throw Error('fixture');
    expect((await openVerifiedPaymentIntent(pool, attempt)).kind).toBe('payment_reconciliation_required');
    const id = randomUUID();
    await setIntentProviderPayment(pool, legacy.intent.id, id);
    expect((await grant(legacy.intent.id, id)).applied).toBe(true);
    expect((await pool.query('SELECT intent_id FROM purchase_mail_delivery WHERE intent_id=$1', [legacy.intent.id])).rows).toEqual([]);
    await verify(a.accountId);
    const next = { ...attempt, idempotencyKey: randomUUID() };
    const created = await openVerifiedPaymentIntent(pool, next);
    if (created.kind !== 'created') throw Error(created.kind);
    await pool.query("UPDATE payment_intent SET first_post_at=now()-interval '24 hours' WHERE id=$1", [created.intent.id]);
    expect((await openVerifiedPaymentIntent(pool, next)).kind).toBe('payment_reconciliation_required');
  });
  it('racing trusted events fulfill an intent once and never retarget it', async () => {
    const a = await owner(); await verify(a.accountId);
    const opened = await openVerifiedPaymentIntent(pool, input(a));
    if (opened.kind !== 'created') throw Error(opened.kind);
    const id = randomUUID();
    const results = await Promise.all([grant(opened.intent.id, id), grant(opened.intent.id, id), grant(opened.intent.id)]);
    expect(results.filter(r => r.applied)).toHaveLength(1);
    const bound = (await pool.query('SELECT provider_payment_id FROM payment_intent WHERE id=$1', [opened.intent.id])).rows[0].provider_payment_id;
    expect(await setIntentProviderPayment(pool, opened.intent.id, bound)).toBe(true);
    expect(await setIntentProviderPayment(pool, opened.intent.id, randomUUID())).toBe(false);
    expect((await pool.query('SELECT needs_review FROM payment WHERE intent_id=$1 ORDER BY needs_review', [opened.intent.id])).rows)
      .toEqual([{ needs_review: false }, { needs_review: true }]);
  });
  it('lower payments cannot extend an active higher plan across checkout and fulfillment', async () => {
    const a = await owner(); await verify(a.accountId);
    const attempt = input(a);
    const opened = await openVerifiedPaymentIntent(pool, attempt);
    if (opened.kind !== 'created') throw Error(opened.kind);
    expect((await openVerifiedPaymentIntent(pool, { ...attempt, idempotencyKey: randomUUID(), plan: 'studio' })).kind).toBe('checkout_in_progress');
    await pool.query("UPDATE account SET plan='studio',plan_source='payment',plan_paid_until=now()+interval '8 days' WHERE id=$1", [a.accountId]);
    const before = (await pool.query('SELECT plan_paid_until FROM account WHERE id=$1', [a.accountId])).rows;
    expect((await grant(opened.intent.id)).applied).toBe(false);
    expect((await pool.query('SELECT plan_paid_until FROM account WHERE id=$1', [a.accountId])).rows).toEqual(before);
    expect((await pool.query('SELECT status FROM payment_intent WHERE id=$1', [opened.intent.id])).rows[0].status).toBe('reconciliation_required');
  });
  it('purchase email has one durable delivery and a stable Resend key', async () => {
    const a = await owner(); await verify(a.accountId);
    const opened = await openVerifiedPaymentIntent(pool, input(a));
    if (opened.kind !== 'created') throw Error(opened.kind);
    const id = randomUUID(), intent = opened.intent.id;
    await Promise.all([grant(intent, id), grant(intent, id)]);
    const store = new PurchaseMailDeliveryStore(pool);
    // Each case runs in the shared suite schema. Only this test's delivery is due.
    await pool.query("UPDATE purchase_mail_delivery SET due_at=now()+interval '2 days' WHERE intent_id<>$1", [intent]);
    expect(await store.lease(false)).toBeNull();
    const both = await Promise.all([store.lease(true), store.lease(true)]);
    expect(both.filter(Boolean)).toHaveLength(1);
    const first = both.find(Boolean)!;
    const sent = await store.admit(first, () => JSON.stringify({ to: a.email, text: 'first' }));
    expect(sent?.key).toContain(intent);
    await pool.query("UPDATE purchase_mail_delivery SET lease_until=now()-interval '1s', due_at=now() WHERE intent_id=$1", [intent]);
    const second = (await store.lease(true))!;
    const retried = await store.admit(second, () => { throw Error('must not render again'); });
    expect(retried).toMatchObject({key:sent!.key,message:sent!.message});
    expect(retried!.validUntil.getTime()).toBeGreaterThanOrEqual(sent!.validUntil.getTime());
    expect(retried!.validUntil.getTime()).toBeLessThanOrEqual(Date.now()+31_000);
    expect(await store.finish(first, { status: 'accepted', providerId: 'late' })).toBe(false);
    expect(await store.finish(second, { status: 'unknown' })).toBe(true);
    await pool.query("UPDATE purchase_mail_delivery SET first_send_at=now()-interval '24 hours',due_at=now() WHERE intent_id=$1", [intent]);
    await store.expire();
    expect(await store.lease(true)).toBeNull();
    expect((await pool.query('SELECT state,recipient,message,attempts FROM purchase_mail_delivery WHERE intent_id=$1', [intent])).rows)
      .toEqual([{ state: 'reconciliation_required', recipient: null, message: null, attempts: 2 }]);
  });
  it('outbox insertion failure rolls the grant back and a subsequent event can complete it', async () => {
    const a = await owner(); await verify(a.accountId);
    const opened = await openVerifiedPaymentIntent(pool, input(a));
    if (opened.kind !== 'created') throw Error(opened.kind);
    const id = randomUUID(), intent = opened.intent.id;
    await pool.query(`ALTER TABLE purchase_mail_delivery ADD CONSTRAINT reject_fixture CHECK (intent_id <> '${intent}'::uuid) NOT VALID`);
    try {
      await expect(grant(intent, id)).rejects.toThrow();
      expect((await pool.query('SELECT plan FROM account WHERE id=$1', [a.accountId])).rows).toEqual([{ plan: 'free' }]);
      expect((await pool.query('SELECT id FROM payment WHERE provider_payment_id=$1', [id])).rows).toEqual([]);
    } finally { await pool.query('ALTER TABLE purchase_mail_delivery DROP CONSTRAINT reject_fixture'); }
    expect((await grant(intent, id)).applied).toBe(true);
  });
  it('disabled TTL, retry backoff, maximum attempts and terminal cleanup survive a restarted worker', async () => {
    await pool.query("UPDATE purchase_mail_delivery SET due_at=now()+interval '2 days' WHERE state IN ('pending','sending')");
    for (const scenario of ['disabled', 'retryable', 'accepted', 'permanent'] as const) {
      const a = await owner(); await verify(a.accountId);
      const opened = await openVerifiedPaymentIntent(pool, input(a));
      if (opened.kind !== 'created') throw Error(opened.kind);
      const id = opened.intent.id;
      await grant(id);
      const sent: { body: string; key?: string }[] = [];
      const en = { mode: 'resend' as const, apiKey: 'local-fixture', from: 'first@example.invalid' };
      const tick = (from: string, disabled = false) => runPurchaseMailTick(new PurchaseMailDeliveryStore(pool), disabled ? { mode: 'disabled' } : { ...en, from }, {
        send: async (message, options) => {
          sent.push({ body: JSON.stringify(message), key: options?.idempotencyKey });
          return scenario === 'accepted' ? { status: 'accepted', providerId: 'fake-id' } : { status: scenario === 'permanent' ? 'permanent' : 'retryable' };
        },
      }, 'https://sufler.invalid');
      const read = async () => (await pool.query('SELECT state,attempts,first_send_at,recipient,message,round(extract(epoch FROM (due_at-now()))/60) AS backoff FROM purchase_mail_delivery WHERE intent_id=$1', [id])).rows[0]!;
      await tick(en.from, true);
      expect(sent).toHaveLength(0); expect((await read()).first_send_at).toBeNull();
      if (scenario === 'disabled') {
        await pool.query("UPDATE purchase_mail_delivery SET created_at=now()-interval '7 days' WHERE intent_id=$1", [id]);
        await tick(en.from, true);
        expect(await read()).toMatchObject({ state: 'reconciliation_required', attempts: 0, recipient: null, message: null });
        continue;
      }
      await tick(en.from);
      if (scenario === 'retryable') {
        const first = (await read()).first_send_at;
        for (const minutes of [1, 5, 30, 120]) {
          expect(Number((await read()).backoff)).toBe(minutes);
          await tick('changed@example.invalid');
          await pool.query("UPDATE purchase_mail_delivery SET due_at=now() WHERE intent_id=$1", [id]);
          await tick('changed@example.invalid');
          expect((await read()).first_send_at).toEqual(first);
        }
        expect(sent).toHaveLength(5); expect(new Set(sent.map(m => m.body)).size).toBe(1);
        expect(new Set(sent.map(m => m.key)).size).toBe(1);
      }
      const end = await read();
      expect(end).toMatchObject({ state: scenario === 'retryable' ? 'reconciliation_required' : scenario, recipient: null, message: null });
      const count = sent.length;
      await tick(en.from);
      expect(sent).toHaveLength(count);
      expect(JSON.parse(sent[0]!.body)).toMatchObject({ from: en.from, to: a.email, text: expect.stringContaining('https://sufler.invalid/dashboard') });
    }
  });
  it('foreign refunds cannot rebind or block a different checkout intent', async () => {
    for (const mismatch of ['id', 'shop', 'amount']) {
      const a = await owner(); await verify(a.accountId);
      const opened = await openVerifiedPaymentIntent(pool, input(a));
      if (opened.kind !== 'created') throw Error(opened.kind);
      const bound = randomUUID(), remote = mismatch === 'id' ? randomUUID() : bound;
      await setIntentProviderPayment(pool, opened.intent.id, bound);
      await recordVerifiedRefund(pool, { provider: 'yookassa', eventKey: 'refund:' + randomUUID(), payloadSha256: 'e'.repeat(64),
        payment: { id: remote, orderId: opened.intent.id, shop: mismatch === 'shop' ? 'test:456' : 'test:123',
          amountMinor: mismatch === 'amount' ? 490000 : 99000, feeMinor: 100, paidAt: new Date().toISOString() } });
      expect((await pool.query('SELECT status,provider_payment_id FROM payment_intent WHERE id=$1', [opened.intent.id])).rows)
        .toEqual([{status:'created',provider_payment_id:bound}]);
      expect((await pool.query('SELECT intent_id,account_id,needs_review FROM payment WHERE provider_payment_id=$1',[remote])).rows)
        .toEqual([{intent_id:null,account_id:null,needs_review:true}]);
    }
  });

  it('a paused admitted mail attempt cannot dispatch after its deadline', async () => {
    const a=await owner(); await verify(a.accountId);
    const opened=await openVerifiedPaymentIntent(pool,input(a));
    if(opened.kind!=='created') throw Error(opened.kind);
    await grant(opened.intent.id);
    const store=new PurchaseMailDeliveryStore(pool);
    let resume!:()=>void, admitted!:()=>void;
    const paused=new Promise<void>(r=>{resume=r;}), ready=new Promise<void>(r=>{admitted=r;});
    let deadline=0, sends=0;
    const settings={mode:'resend' as const,from:'qa@example.invalid',apiKey:'local-fixture'};
    const transport={send:async()=>{sends++;return {status:'accepted' as const,providerId:'accepted-current-lease'};}};
    const slow={expire:store.expire.bind(store),lease:store.lease.bind(store),finish:store.finish.bind(store),
      admit:async(...args:Parameters<typeof store.admit>)=>{const dispatch=await store.admit(...args);
        if(dispatch) deadline=dispatch.validUntil.getTime(); admitted(); await paused; return dispatch;}};
    const old=runPurchaseMailTick(slow,settings,transport,'https://sufler.invalid');
    try {
      await ready;
      await pool.query("UPDATE purchase_mail_delivery SET lease_until=now()-interval '1 second',due_at=now() WHERE intent_id=$1",[opened.intent.id]);
      await runPurchaseMailTick(store,settings,transport,'https://sufler.invalid');
      expect(sends).toBe(1);
      vi.spyOn(Date,'now').mockReturnValue(deadline+24*60*60*1000);
      resume(); await old;
      expect(sends).toBe(1);
      expect((await pool.query('SELECT state FROM purchase_mail_delivery WHERE intent_id=$1',[opened.intent.id])).rows).toEqual([{state:'accepted'}]);
    } finally {resume(); await old; vi.restoreAllMocks();}
  });

});
