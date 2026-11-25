// Деньги в БД (фича tariffs-and-interest, FR-TARIFF-002, ADR-017 дополненный, A-N6-040). Донор — N4
// projects/04-calorie-vision-cal-ai/apps/api/src/routes/payments-webhook.ts (applyPayment) и routes/subscription.ts
// (намерение) — адаптировано: план аккаунта вместо подписки, разовая оплата на 30 дней, без комиссий (фича 15), возврат
// и несовпадение суммы — вручную оператором (решения владельца 26.09).
//
// Подлинность уведомления проверяет web ДО вызова applyVerifiedPayment и ВНЕ транзакции (security-operation-order):
// сюда приходит только перезапрошенный у ЮKassa платёж. Внутри транзакции нет сетевых вызовов.
import { randomUUID } from 'node:crypto';
import { PAID_PLAN_DAYS, PLAN_PRICE_MINOR, PLAN_RANK, isPaidPlan, readAccountPlan, type PaidPlan } from '@n6/rag';
import type { Pool, PoolClient } from 'pg';
import { accrueCommissionTx, clawbackCommissionTx } from './commission.js';
import { isUuid } from './index-jobs.js';
import { transaction } from './quota.js';

export type PaymentProviderName = 'yookassa' | 'fake';
interface CheckoutSnapshot {
  serializedBody?: string;
  email: string;
  shop: string;
  fiscal: { vat_code: number; payment_mode: 'full_payment'; payment_subject: string; tax_system_code?: number };
  description: string;
  publicOrigin: string;
}
export interface IntentRow { id: string; plan: PaidPlan; price_minor: number; status: 'created' | 'succeeded' | 'canceled' | 'reconciliation_required'; provider_payment_id: string | null; first_post_at?: Date | null; checkout_snapshot?: CheckoutSnapshot | null }
export type CreateIntentResult = { kind: 'created' | 'existing'; intent: IntentRow } | { kind: 'conflict' };

// Намерение выдаётся ДО ухода к провайдеру (long-running-job): повтор с тем же ключом клиента — то же намерение.
// «Вставить, иначе прочитать» атомарно: UNIQUE (account_id, idempotency_key) + ON CONFLICT DO NOTHING (донор N4).
export async function createPaymentIntent(pool: Pool, input: { accountId: string; plan: PaidPlan; priceMinor: number; idempotencyKey: string }): Promise<CreateIntentResult> {
  const inserted = (await pool.query<IntentRow>(`INSERT INTO payment_intent (account_id, plan, price_minor, idempotency_key) VALUES ($1, $2, $3, $4)
    ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING id, plan, price_minor, status, provider_payment_id`,
  [input.accountId, input.plan, input.priceMinor, input.idempotencyKey])).rows[0];
  if (inserted) return { kind: 'created', intent: inserted };
  const existing = (await pool.query<IntentRow>(`SELECT id, plan, price_minor, status, provider_payment_id FROM payment_intent
    WHERE account_id = $1 AND idempotency_key = $2`, [input.accountId, input.idempotencyKey])).rows[0];
  // Тот же ключ для ДРУГОГО плана — не повтор, а ошибка клиента: второй платёж по старому намерению не создаётся.
  if (!existing || existing.plan !== input.plan) return { kind: 'conflict' };
  return { kind: 'existing', intent: existing };
}

type OpenResult = CreateIntentResult | { kind: 'unauthorized' | 'email_verification_required' | 'offer_version_changed' | 'fiscal_unavailable' | 'plan_conflict' }
  | { kind: 'checkout_in_progress' | 'payment_reconciliation_required'; intentId: string } | { kind: 'eligible' };

export async function openVerifiedPaymentIntent(pool: Pool, input: {
  preflightOnly?: boolean;
  accountId: string; sessionHash: string; plan: PaidPlan; idempotencyKey: string; offerVersion: string;
  serializePayment?: (request: { orderId: string; amountMinor: number; returnUrl: string; description: string; receipt: { email: string; fiscal: CheckoutSnapshot['fiscal'] } }) => string;
  offer: { version: string; digest: string }; shop: string; fiscal: CheckoutSnapshot['fiscal'] | null; publicOrigin: string; description: string;
}): Promise<OpenResult> {
  // Existing rows follow erasure's intent → account lock order. If a concurrent opener
  // inserted while this transaction waited for the account, release it before locking the intent.
  const attempt = (): Promise<OpenResult | 'reload'> => transaction(pool, async tx => {
    const existing = (await tx.query<IntentRow>(`SELECT * FROM payment_intent WHERE account_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.accountId, input.idempotencyKey])).rows[0];
    const account = (await tx.query<{ email: string; verified: boolean; active_plan: string }>(`SELECT email, email_verified_at IS NOT NULL AS verified,
      CASE WHEN plan_source='payment' AND plan_paid_until<=now() THEN 'free' ELSE plan END AS active_plan
      FROM account WHERE id=$1 AND status='active' FOR NO KEY UPDATE`, [input.accountId])).rows[0];
    if (!account) return { kind: 'unauthorized' };
    const session = (await tx.query<{ now: Date }>(`SELECT clock_timestamp() AS now FROM session WHERE account_id=$1 AND token_hash=$2 AND revoked_at IS NULL
      AND expires_at>clock_timestamp() FOR SHARE`, [input.accountId, input.sessionHash])).rows[0];
    if (!session) return { kind: 'unauthorized' };
    if (existing) {
      if (existing.plan !== input.plan) return { kind: 'conflict' };
      if (existing.status === 'succeeded' || existing.status === 'canceled') return { kind: 'existing', intent: existing };
      const snap = existing.checkout_snapshot;
      const expired = !existing.first_post_at || session.now.getTime() - existing.first_post_at.getTime() >= (24 * 60 - 10) * 60_000;
      if (existing.status === 'reconciliation_required' || (snap && snap.shop !== input.shop) ||
        (!existing.provider_payment_id && (!snap || expired || !account.verified || account.email !== snap.email ||
          PLAN_RANK[readAccountPlan(account.active_plan)] > PLAN_RANK[input.plan]))) {
        await tx.query("UPDATE payment_intent SET status='reconciliation_required' WHERE id=$1", [existing.id]);
        return { kind: 'payment_reconciliation_required', intentId: existing.id };
      }
      return { kind: 'existing', intent: existing };
    }
    const competing = (await tx.query<{ id: string; idempotency_key: string }>(`SELECT id,idempotency_key FROM payment_intent WHERE account_id=$1
      AND (idempotency_key=$2 OR status IN ('created','reconciliation_required')) ORDER BY (idempotency_key=$2) DESC,created_at LIMIT 1`,
      [input.accountId, input.idempotencyKey])).rows[0];
    if (competing?.idempotency_key === input.idempotencyKey) return 'reload';
    if (input.offerVersion !== input.offer.version) return { kind: 'offer_version_changed' };
    if (!account.verified) return { kind: 'email_verification_required' };
    if (PLAN_RANK[readAccountPlan(account.active_plan)] > PLAN_RANK[input.plan]) return { kind: 'plan_conflict' };
    if (competing) return { kind: 'checkout_in_progress', intentId: competing.id };
    if (!input.fiscal || !input.shop) return { kind: 'fiscal_unavailable' };
    if (input.preflightOnly) return { kind: 'eligible' };
    const snapshot: CheckoutSnapshot = { email: account.email, shop: input.shop, fiscal: input.fiscal, publicOrigin: input.publicOrigin, description: input.description };
    const id = randomUUID();
    if (input.serializePayment) snapshot.serializedBody = input.serializePayment({
      orderId: id, amountMinor: PLAN_PRICE_MINOR[input.plan],
      returnUrl: new URL('/upgrade/return?intent=' + id, snapshot.publicOrigin).href, description: snapshot.description,
      receipt: { email: snapshot.email, fiscal: snapshot.fiscal }
    });
    const intent = (await tx.query<IntentRow>(`INSERT INTO payment_intent(account_id,idempotency_key,plan,price_minor,
      offer_version,offer_digest,offer_accepted_at,checkout_snapshot,first_post_at,id)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,clock_timestamp(),$8) RETURNING *`, [input.accountId, input.idempotencyKey, input.plan,
    PLAN_PRICE_MINOR[input.plan], input.offer.version, input.offer.digest, snapshot, id])).rows[0]!;
    return { kind: 'created', intent };
  });
  let result = await attempt();
  while (result === 'reload') result = await attempt();
  return result;
}

// Идентификатор платежа у провайдера — для опроса возврата с формы (отменённый платёж → состояние «отказ»).
// false — у намерения уже ДРУГОЙ платёж (ревью фичи 14, находка 2): расхождение не игнорируется молча.
export async function setIntentProviderPayment(pool: Pool, intentId: string, providerPaymentId: string): Promise<boolean> {
  const updated = await pool.query(`UPDATE payment_intent SET provider_payment_id = $2 WHERE id = $1 AND (provider_payment_id IS NULL OR provider_payment_id = $2)`,
    [intentId, providerPaymentId]);
  return updated.rowCount === 1;
}
export async function markIntentCanceled(pool: Pool, intentId: string): Promise<void> {
  await pool.query(`UPDATE payment_intent SET status = 'canceled' WHERE id = $1 AND status = 'created'`, [intentId]);
}

export interface IntentView extends IntentRow { shop?: string | null; applied_paid_until?: Date | null; account_plan: string; plan_paid_until: string | null }
// Чужое и несуществующее намерение — один ответ null (канон: чужой ресурс — 404).
export async function readPaymentIntent(pool: Pool, intentId: string, accountId: string): Promise<IntentView | null> {
  if (!isUuid(intentId) || !isUuid(accountId)) return null;
  const row = (await pool.query<IntentRow & { account_plan: string; plan_paid_until: Date | null }>(`SELECT i.id, i.plan, i.price_minor, CASE WHEN i.status='created' AND i.provider_payment_id IS NULL AND
      (i.checkout_snapshot IS NULL OR i.first_post_at <= now()-interval '23 hours 50 minutes') THEN 'reconciliation_required' ELSE i.status END AS status,
      i.checkout_snapshot->>'shop' AS shop, i.applied_paid_until,
      i.provider_payment_id, CASE WHEN a.plan_source='payment' AND a.plan_paid_until<=now() THEN 'free' ELSE a.plan END AS account_plan, a.plan_paid_until
    FROM payment_intent i JOIN account a ON a.id = i.account_id WHERE i.id = $1 AND i.account_id = $2`, [intentId, accountId])).rows[0];
  if (!row) return null;
  return { ...row, plan_paid_until: row.plan_paid_until?.toISOString() ?? null };
}

export interface VerifiedPayment { shop?: string; id: string; orderId: string | null; amountMinor: number; feeMinor: number | null; paidAt: string | null }
export type ApplyPaymentOutcome =
  | { applied: true; plan: string; paidUntil: string }
  | { applied: false; reason: 'duplicate' | 'amount_mismatch' | 'unknown_intent' | 'refunded' | 'refund_recorded' | 'account_erasing' | 'plan_conflict' | 'binding_conflict' };

// Ключ повторности (incoming-webhooks): ПОЛЕ — событие + object.id у ЮKassa; МЕСТО — payment_event; МЕХАНИЗМ — уникальный
// индекс, конфликт вставки И ЕСТЬ «уже обработано» (две одновременные доставки не проходят обе).
async function claimEvent(tx: PoolClient, provider: PaymentProviderName, eventKey: string, payloadSha256: string): Promise<boolean> {
  const claimed = await tx.query(`INSERT INTO payment_event (provider, provider_event_id, payload_sha256) VALUES ($1, $2, $3)
    ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`, [provider, eventKey, payloadSha256]);
  return claimed.rowCount === 1;
}
// Оплата и возврат ОДНОГО платежа — разные события с разными ключами и приходят в любом порядке и одновременно (ревью
// фичи 14, находка 1): транзакции по одному платежу сериализуются блокировкой до конца транзакции.
async function lockPayment(tx: PoolClient, provider: PaymentProviderName, paymentId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payment:${provider}:${paymentId}`]);
}

// Допуск к выдаче сериализован по intent и аккаунту. Несовместимая оплата остаётся в финансовом учёте для разбора.
export function applyVerifiedPayment(pool: Pool, input: { provider: PaymentProviderName; eventKey: string; payloadSha256: string; payment: VerifiedPayment }): Promise<ApplyPaymentOutcome> {
  const { payment } = input;
  return transaction(pool, async (tx) => {
    if (!await claimEvent(tx, input.provider, input.eventKey, input.payloadSha256)) return { applied: false, reason: 'duplicate' } as const;
    await lockPayment(tx, input.provider, payment.id);
    // Возврат приехал РАНЬШЕ оплаты (перестановка): платёж уже записан refunded на разбор — план по нему не выдаётся.
    const prior = (await tx.query<{ status: string }>(`SELECT status FROM payment WHERE provider = $1 AND provider_payment_id = $2`,
      [input.provider, payment.id])).rows[0];
    if (prior?.status === 'refunded') return { applied: false, reason: 'refunded' } as const;
    const paidAt = payment.paidAt ?? new Date().toISOString();
    if (prior) return { applied: false, reason: 'duplicate' } as const;
    const intent = payment.orderId && isUuid(payment.orderId)
      ? (await tx.query<IntentRow & { account_id: string }>(`SELECT account_id, plan, price_minor,status,provider_payment_id,checkout_snapshot FROM payment_intent
          WHERE id = $1 FOR UPDATE`, [payment.orderId])).rows[0]
      : undefined;
    const record = (accountId: string | null, plan: string | null, review: string | null) => tx.query(`INSERT INTO payment
        (intent_id, account_id, provider, provider_payment_id, plan, amount_minor, fee_minor, needs_review, review_reason, paid_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (provider, provider_payment_id) DO NOTHING`,
    [intent ? payment.orderId : null, accountId, input.provider, payment.id, plan, payment.amountMinor, payment.feeMinor, review !== null, review, paidAt]);
    // Платёж без нашего намерения: деньги реальны — записываются на разбор, план не выдаётся никому.
    if (!intent || !isPaidPlan(intent.plan)) { await record(null, null, 'unknown_intent'); return { applied: false, reason: 'unknown_intent' } as const; }
    const reconcile = async (reason: 'amount_mismatch' | 'binding_conflict' | 'plan_conflict' | 'account_erasing') => {
      await record(intent.account_id, intent.plan, reason);
      // A conflicting second payment cannot invalidate the first successful grant.
      await tx.query("UPDATE payment_intent SET status='reconciliation_required' WHERE id=$1 AND status<>'succeeded'", [payment.orderId]);
      return { applied: false, reason } as const;
    };
    if (intent.status === 'succeeded' || (intent.provider_payment_id && intent.provider_payment_id !== payment.id) ||
      (intent.checkout_snapshot && intent.checkout_snapshot.shop !== payment.shop)) return reconcile('binding_conflict');
    if (payment.amountMinor !== intent.price_minor) return reconcile('amount_mismatch');
    await tx.query('UPDATE payment_intent SET provider_payment_id=$2 WHERE id=$1', [payment.orderId, payment.id]);
    const owner = (await tx.query<{ status: string; active_plan: string }>(`SELECT status,
      CASE WHEN plan_source='payment' AND plan_paid_until<=now() THEN 'free' ELSE plan END AS active_plan
      FROM account WHERE id=$1 FOR NO KEY UPDATE`, [intent.account_id])).rows[0];
    if (owner?.status !== 'active') return reconcile('account_erasing');
    if (PLAN_RANK[readAccountPlan(owner.active_plan)] > PLAN_RANK[intent.plan]) return reconcile('plan_conflict');
    await record(intent.account_id, intent.plan, null);
    const updated = await grantPaidPlan(tx, intent.account_id, intent.plan);
    await tx.query("UPDATE payment_intent SET status='succeeded',applied_paid_until=$2 WHERE id=$1", [payment.orderId, updated.paidUntil]);
    const paymentId = await paymentRowId(tx, input.provider, payment.id);
    if (intent.checkout_snapshot) {
      await tx.query(`INSERT INTO purchase_mail_delivery(intent_id,payment_id,account_id,recipient,plan,amount_minor,paid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [payment.orderId, paymentId, intent.account_id, intent.checkout_snapshot.email, intent.plan, payment.amountMinor, updated.paidUntil]);
    }
    // Атрибуция конвертируется ОПЛАТОЙ (A-N6-015: «появляется свой магазин — план назначает оплата»).
    await tx.query(`UPDATE attribution SET status = 'converted' WHERE account_id = $1 AND status = 'pending'`, [intent.account_id]);
    // Комиссия партнёру — В ТОЙ ЖЕ транзакции (partner-and-studio, A-N6-043): платёж и обязательство одним коммитом.
    await accrueCommissionTx(tx, {
      paymentId, accountId: intent.account_id,
      amountMinor: payment.amountMinor, feeMinor: payment.feeMinor, paidAt });
    return { applied: true, plan: updated.plan, paidUntil: updated.paidUntil } as const;
  });
}

async function grantPaidPlan(tx: PoolClient, accountId: string, paid: PaidPlan): Promise<{ plan: string; paidUntil: string }> {
  const row = (await tx.query<{ plan: string; plan_source: string; plan_paid_until: Date | null; now: Date }>(`SELECT plan, plan_source, plan_paid_until, now() AS now
    FROM account WHERE id = $1 FOR NO KEY UPDATE`, [accountId])).rows[0];   // не блокирует FK-проверку комиссии (ревью фичи 15, находка 2)
  if (!row) throw new Error('Аккаунт намерения не найден: оплата не применяется, транзакция откатывается');
  const current = readAccountPlan(row.plan);
  // Действующий план: оплаченный — пока не истёк; назначенный оператором или до миграции 006 — бессрочно.
  const active = row.plan_source === 'payment' ? (row.plan_paid_until && row.plan_paid_until > row.now ? current : 'free') : current;
  const keepOperator = row.plan_source !== 'payment' && row.plan_source !== 'none' && PLAN_RANK[active] >= PLAN_RANK[paid];
  const keepLegacy = row.plan_source === 'none' && active !== 'free' && PLAN_RANK[active] >= PLAN_RANK[paid];
  const plan = PLAN_RANK[paid] > PLAN_RANK[active] ? paid : active;
  const result = (await tx.query<{ plan: string; plan_paid_until: Date }>(`UPDATE account SET plan = $2,
      plan_source = CASE WHEN $3::boolean THEN plan_source ELSE 'payment' END,
      plan_paid_until = GREATEST(COALESCE(plan_paid_until, now()), now()) + make_interval(days => $4)
    WHERE id = $1 RETURNING plan, plan_paid_until`, [accountId, plan, keepOperator || keepLegacy, PAID_PLAN_DAYS])).rows[0]!;
  return { plan: result.plan, paidUntil: result.plan_paid_until.toISOString() };
}

// Возврат (refund.succeeded): принимается и помечается на разбор; план снимает оператор (решение владельца 26.09).
// Перестановочно (ревью фичи 14, находка 1): если строки платежа ещё нет (возврат раньше оплаты), она создаётся СРАЗУ
// refunded из перезапрошенного у ЮKassa платежа — последующая оплата увидит возврат и план не выдаст.
export function recordVerifiedRefund(pool: Pool, input: { provider: PaymentProviderName; eventKey: string; payloadSha256: string; payment: VerifiedPayment }): Promise<ApplyPaymentOutcome> {
  const { payment } = input;
  return transaction(pool, async (tx) => {
    if (!await claimEvent(tx, input.provider, input.eventKey, input.payloadSha256)) return { applied: false, reason: 'duplicate' } as const;
    await lockPayment(tx, input.provider, payment.id);
    const candidate = payment.orderId && isUuid(payment.orderId)
      ? (await tx.query<IntentRow & { account_id: string }>('SELECT * FROM payment_intent WHERE id = $1 FOR UPDATE', [payment.orderId])).rows[0]
      : undefined;
    const matching = candidate && candidate.price_minor === payment.amountMinor &&
      (!candidate.provider_payment_id || candidate.provider_payment_id === payment.id) &&
      (!candidate.checkout_snapshot || candidate.checkout_snapshot.shop === payment.shop);
    const intent = matching ? candidate : undefined;
    await tx.query(`INSERT INTO payment (intent_id, account_id, provider, provider_payment_id, plan, amount_minor, fee_minor, status, needs_review, review_reason, paid_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'refunded', true, 'refund', $8)
      ON CONFLICT (provider, provider_payment_id) DO UPDATE SET status = 'refunded', needs_review = true, review_reason = 'refund'`,
    [intent ? payment.orderId : null, intent?.account_id ?? null, input.provider, payment.id, intent && isPaidPlan(intent.plan) ? intent.plan : null,
      payment.amountMinor, payment.feeMinor, payment.paidAt ?? new Date().toISOString()]);
    if (intent) await tx.query("UPDATE payment_intent SET status='reconciliation_required' WHERE id=$1 AND status<>'succeeded'", [payment.orderId]);
    // Сторно комиссии этого платежа — той же транзакцией (partner-and-studio): возврат раньше оплаты начисления не имеет.
    await clawbackCommissionTx(tx, await paymentRowId(tx, input.provider, payment.id));
    return { applied: false, reason: 'refund_recorded' } as const;
  });
}

async function paymentRowId(tx: PoolClient, provider: PaymentProviderName, providerPaymentId: string): Promise<string> {
  const row = (await tx.query<{ id: string }>('SELECT id FROM payment WHERE provider = $1 AND provider_payment_id = $2', [provider, providerPaymentId])).rows[0];
  if (!row) throw new Error('Строка платежа не найдена после записи: транзакция откатывается');
  return row.id;
}

// Сторож: истёкший ОПЛАЧЕННЫЙ план → free (бейдж возвращается). План оператора и назначенный до 006 не истекают.
export async function expirePaidPlans(pool: Pool, batch: number): Promise<number> {
  const expired = await pool.query(`UPDATE account SET plan = 'free', plan_source = 'none' WHERE id IN (
      SELECT id FROM account WHERE plan_source = 'payment' AND plan_paid_until <= now() ORDER BY plan_paid_until LIMIT $1 FOR NO KEY UPDATE SKIP LOCKED)
    AND plan_source = 'payment' AND plan_paid_until <= now()`, [batch]);
  return expired.rowCount ?? 0;
}

export interface AccountBilling { email_verified: boolean; plan: string; plan_source: string; plan_paid_until: string | null }
export async function readAccountBilling(pool: Pool, accountId: string): Promise<AccountBilling | null> {
  if (!isUuid(accountId)) return null;
  const row = (await pool.query<{ email_verified: boolean; plan: string; plan_source: string; plan_paid_until: Date | null }>(`SELECT email_verified_at IS NOT NULL AS email_verified, CASE WHEN plan_source='payment' AND plan_paid_until<=now() THEN 'free' ELSE plan END AS plan, plan_source, plan_paid_until
    FROM account WHERE id = $1 AND status = 'active'`, [accountId])).rows[0];
  return row ? { email_verified: row.email_verified, plan: readAccountPlan(row.plan), plan_source: row.plan_source, plan_paid_until: row.plan_paid_until?.toISOString() ?? null } : null;
}
