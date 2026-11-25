// Маршруты оплаты и интереса (фича tariffs-and-interest, FR-TARIFF-002, SC-US-011-1/2, ADR-017 дополненный, A-N6-040).
// Доноры: N4 projects/04-calorie-vision-cal-ai/apps/api/src/routes/subscription.ts (оформление) и routes/payments-webhook.ts
// (приём уведомлений) — адаптировано в route handlers Next по форме N1 apps/web/src/app/api/webhooks/payment/route.ts.
//
// ПОРЯДОК — это и есть защита (security-operation-order):
//  POST /api/checkout          лимит двери → Origin → сессия → тело (закрытое: plan, idempotency_key) → режим оплаты →
//                              намерение (id ДО провайдера, long-running-job) → платёж у провайдера ВНЕ транзакции.
//  POST /api/webhooks/yookassa режим оплаты → сырые байты (≤ 64 КиБ) → адрес источника, записанный дверью (цепочка — отказ) →
//                              подлинность ВНЕ транзакции (сеть ЮKassa из кода + ПЕРЕЗАПРОС + сверка) → транзакция
//                              (ключ повторности → применение). Недоступность ЮKassa — 503 без единой записи; повтор
//                              проходит полным путём (урок N1: потерянная оплата).
import { createHash } from 'node:crypto';
import { isPaidPlan, type PaidPlan } from '@n6/rag';
import type { ApplyPaymentOutcome, openVerifiedPaymentIntent, IntentView, InterestOriginScreen, PaymentProviderName, VerifiedPayment } from '@n6/db';
import { readTrustDocument } from '../lib/trust-legal-catalog';
import { readSessionCookie } from './auth-handler';
import { body, guardMutation } from './cabinet-handler';
import { clientIp } from './ip';
import { PaymentProviderUnavailable, PaymentVerificationError, type PaymentProvider } from './payments/provider';

export const MAX_NOTIFICATION_BYTES = 64 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLAN_TITLE: Readonly<Record<PaidPlan, string>> = { nobadge: 'Без бейджа', studio: 'Студия' };

export interface BillingDependencies {
  publicOrigin: string;
  authenticate: (token: string) => Promise<{ account_id: string } | null>;
  allowMutation: (ip: string, account?: string) => Promise<boolean>;
  // null — оплата выключена (N6_PAYMENTS_MODE=off): оформление отвечает 409 payments_off, вебхук — 404.
  provider: PaymentProvider | null;
  tokenHash: (token: string) => string;
  createIntent: (input: Parameters<typeof openVerifiedPaymentIntent>[1]) => ReturnType<typeof openVerifiedPaymentIntent>;
  // false — у намерения уже ДРУГОЙ платёж: второй платёж по одному намерению — отказ, а не молчание.
  setIntentPayment: (intentId: string, providerPaymentId: string) => Promise<boolean>;
  readIntent: (intentId: string, accountId: string) => Promise<IntentView | null>;
  markCanceled: (intentId: string) => Promise<void>;
  applyPayment: (input: { provider: PaymentProviderName; eventKey: string; payloadSha256: string; payment: VerifiedPayment }) => Promise<ApplyPaymentOutcome>;
  recordRefund: (input: { provider: PaymentProviderName; eventKey: string; payloadSha256: string; payment: VerifiedPayment }) => Promise<ApplyPaymentOutcome>;
  recordInterest: (input: { accountId: string; plan: PaidPlan; originScreen: InterestOriginScreen }) => Promise<'recorded' | 'already_recorded' | 'not_found'>;
  isOriginScreen: (value: unknown) => value is InterestOriginScreen;
  log?: (line: string) => void;
}

const json = (payload: object, status = 200) => Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
const unauthorized = () => fail(401, 'unauthorized', 'Войдите, чтобы оформить план');
const logOf = (deps: BillingDependencies) => deps.log ?? ((line: string) => console.error(line));
function run(deps: BillingDependencies, what: string, handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    logOf(deps)(`Оплата: ${what} не выполнено (${error instanceof Error ? error.name : 'ошибка'})`);
    return fail(503, 'unavailable', 'Сервис временно недоступен. Повторите через минуту');
  });
}
const providerName = (provider: PaymentProvider): PaymentProviderName => {
  if (provider.name === 'yookassa' || provider.name === 'fake') return provider.name;
  throw new Error('Неизвестный платёжный провайдер: платёж не записывается');
};

// POST /api/checkout { plan, idempotency_key } → 201 { intent_id, redirect_url } — форма оплаты ЮKassa.
export function createCheckoutHandler(deps: BillingDependencies) {
  return (request: Request) => run(deps, 'оформление', async () => {
    const entry = await guardMutation(request, deps, unauthorized);
    if (entry instanceof Response) return entry;
    const input = await body(request, ['plan', 'idempotency_key', 'offer_version']);
    if (input instanceof Response) return input;
    // Строгое равенство (ADR-004): 'NOBADGE', ' nobadge', 'free' — не платный план.
    if (!isPaidPlan(input.plan)) return fail(422, 'invalid_plan', 'Выберите план «Без бейджа» или «Студия»');
    if (typeof input.idempotency_key !== 'string' || !IDEMPOTENCY_KEY.test(input.idempotency_key)) {
      return fail(422, 'idempotency_key_required', 'Нужен ключ повтора: 8–128 латинских букв, цифр, «-» или «_»');
    }
    const provider = deps.provider;
    // Оплата не настроена — отказ с понятным кодом, а не «примем на фейке» (honest-configuration).
    if (!provider) return fail(409, 'payments_off', 'Оплата скоро откроется — оставьте заявку, мы сообщим');
    const plan = input.plan;
    if (typeof input.offer_version !== 'string' || !input.offer_version || input.offer_version.length > 128) return fail(422, 'offer_required', 'Ознакомьтесь с редакцией оферты');
    const offer = readTrustDocument('offer');
    const opening = {
      accountId: entry.accountId, plan, sessionHash: deps.tokenHash(readSessionCookie(request)!),
      serializePayment: provider.serializePayment, idempotencyKey: input.idempotency_key, offerVersion: input.offer_version, offer, fiscal: provider.fiscal ?? null,
      shop: provider.shop ?? '', publicOrigin: deps.publicOrigin, description: `Суфлёр: план «${PLAN_TITLE[plan]}» на 30 дней`
    };
    const eligibility = await deps.createIntent({ ...opening, preflightOnly: true });
    if (eligibility.kind === 'eligible') await provider.attestEnvironment?.();
    const created = eligibility.kind === 'eligible' ? await deps.createIntent(opening) : eligibility;
    switch (created.kind) {
      case 'eligible': return fail(503, 'unavailable', 'Не удалось оформить заказ. Попробуйте ещё раз');
      case 'unauthorized': return unauthorized();
      case 'email_verification_required': return fail(403, created.kind, 'Подтвердите текущую почту для получения чека');
      case 'offer_version_changed': return json({ error: { code: created.kind, message: 'Оферта обновилась. Ознакомьтесь с новой редакцией и подтвердите покупку.', version: offer.version } }, 409);
      case 'fiscal_unavailable': return fail(409, created.kind, 'Настройка кассы для новых покупок ещё не завершена');
      case 'plan_conflict': return fail(409, created.kind, 'Активную Студию можно продлить только планом Студия');
      case 'checkout_in_progress':
      case 'payment_reconciliation_required': return json({ error: { code: created.kind, message: 'Проверьте состояние предыдущей оплаты.', intent_id: created.intentId } }, 409);
      case 'conflict': return fail(409, 'idempotency_conflict', 'Этот ключ уже использован для другого плана');
    }
    const intent = created.intent;
    if (intent.status !== 'created') return json({ data: { intent_id: intent.id, redirect_url: null, status: intent.status } });
    try {
      // Платёж по намерению уже создан (ревью фичи 14, находка 2): НЕ создавать второй — идемпотентность ЮKassa держит
      // ключ только 24 часа. Перезапросить сохранённый: ждёт оплаты — та же форма; отменён — намерение canceled;
      // оплачен или ждёт подтверждения — на экран возврата (план выдаст уведомление).
      if (intent.provider_payment_id) {
        const existing = await provider.getPayment(intent.provider_payment_id);
        if (existing.id !== intent.provider_payment_id || existing.orderId !== intent.id || existing.amountMinor !== intent.price_minor)
          return json({ error: { code: 'payment_reconciliation_required', message: 'Требуется сверка оплаты', intent_id: intent.id } }, 409);
        if (existing.status === 'pending' && existing.confirmationUrl) {
          return json({ data: { intent_id: intent.id, redirect_url: existing.confirmationUrl, status: 'created' } }, 201);
        }
        if (existing.status === 'canceled') {
          await deps.markCanceled(intent.id);
          const latest = await deps.readIntent(intent.id, entry.accountId);
          return json({ data: { intent_id: intent.id, redirect_url: null, status: latest?.status ?? 'reconciliation_required' } });
        }
        return json({ data: { intent_id: intent.id, redirect_url: null, status: 'created' } });
      }
      // Сетевой вызов ВНЕ транзакции (shared-resource-verification п.1). Ключ идемпотентности у ЮKassa — id намерения:
      // повтор с тем же ключом клиента не создаёт второй платёж.
      const snapshot = intent.checkout_snapshot;
      if (!snapshot || !intent.first_post_at || Date.now() - intent.first_post_at.getTime() >= (24 * 60 - 10) * 60_000)
        return json({ error: { code: 'payment_reconciliation_required', intent_id: intent.id, message: 'Требуется сверка оплаты' } }, 409);
      const payment = await provider.createPayment({
        orderId: intent.id, amountMinor: intent.price_minor,
        dispatchBeforeMs: intent.first_post_at.getTime() + (24 * 60 - 10) * 60_000,
        returnUrl: new URL(`/upgrade/return?intent=${intent.id}`, snapshot.publicOrigin).href,
        serializedBody: snapshot.serializedBody, description: snapshot.description, receipt: { email: snapshot.email, fiscal: snapshot.fiscal },
      });
      if (payment.orderId !== intent.id || payment.amountMinor !== intent.price_minor) throw new PaymentVerificationError('Неверная привязка платежа');
      if (!await deps.setIntentPayment(intent.id, payment.id)) {
        logOf(deps)('Оплата: у намерения уже другой платёж — второй не выдаётся');
        return fail(409, 'intent_has_payment', 'По этой оплате уже создан платёж. Обновите страницу');
      }
      const bound = await deps.readIntent(intent.id, entry.accountId);
      if (!bound) return unauthorized();
      if (bound.status !== 'created') return json({ data: { intent_id: intent.id, status: bound.status, redirect_url: null } });
      return json({ data: { intent_id: intent.id, redirect_url: payment.status === 'pending' ? payment.confirmationUrl : null, status: bound.status } }, 201);
    } catch (error) {
      if (error instanceof PaymentProviderUnavailable && error.reason === 'idempotency_window_elapsed')
        return json({ error: { code: 'payment_reconciliation_required', intent_id: intent.id, message: 'Требуется сверка оплаты' } }, 409);
      // Намерение остаётся created: повтор с тем же ключом попадёт в него же.
      if (error instanceof PaymentProviderUnavailable) return json({
        error: {
          code: 'payment_provider_unavailable', intent_id: intent.id,
          message: 'Исход запроса пока неизвестен. Можно проверить статус или повторить эту же попытку через минуту.'
        }
      }, 503);
      if (error instanceof PaymentVerificationError) {
        if (intent.provider_payment_id) return json({ error: { code: 'payment_reconciliation_required', message: 'Требуется сверка оплаты', intent_id: intent.id } }, 409);
        logOf(deps)('Оплата: провайдер отклонил создание платежа');
        return fail(503, 'payment_provider_failed', 'Платёжный сервис отклонил платёж. Повторите позже');
      }
      throw error;
    }
  });
}

// GET /api/checkout/{intent_id} — опрос экрана возврата: pending | succeeded | canceled. Чужое намерение — 404.
export function createCheckoutStatusHandler(deps: BillingDependencies) {
  return (request: Request, intentId: string) => run(deps, 'статус оплаты', async () => {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(deps.publicOrigin).origin) return fail(403, 'origin_not_allowed', 'Источник запроса не разрешён');
    const token = readSessionCookie(request);
    const session = token ? await deps.authenticate(token) : null;
    if (!session) return unauthorized();
    if (!INTENT_ID.test(intentId)) return fail(404, 'not_found', 'Оплата не найдена');
    const view = await deps.readIntent(intentId, session.account_id);
    if (!view) return fail(404, 'not_found', 'Оплата не найдена');
    let status: 'pending' | 'succeeded' | 'canceled' | 'reconciliation_required' = view.status === 'created' ? 'pending' : view.status;
    // Отмену видит только провайдер (уведомление payment.canceled мы не принимаем): спросить его. Сбой опроса — это
    // «неизвестно», то есть по-прежнему pending, а не отказ оплаты.
    if (view.shop && deps.provider && view.shop !== deps.provider.shop && status === 'pending') status = 'reconciliation_required';
    if ((status === 'pending' || status === 'reconciliation_required') && view.provider_payment_id && deps.provider &&
      (!view.shop || view.shop === deps.provider.shop)) {
      try {
        const remote = await deps.provider.getPayment(view.provider_payment_id);
        if (remote.id !== view.provider_payment_id || remote.amountMinor !== view.price_minor || remote.orderId !== view.id) status = 'reconciliation_required';
        else if (status === 'pending' && remote.status === 'canceled') { await deps.markCanceled(view.id); status = 'canceled'; }
      } catch (error) {
        if (error instanceof PaymentVerificationError) status = 'reconciliation_required';
        else if (!(error instanceof PaymentProviderUnavailable)) throw error;
      }
    }
    return json({ data: { intent_id: view.id, plan: view.plan, status, account_plan: view.account_plan, plan_paid_until: view.plan_paid_until, applied_paid_until: view.applied_paid_until } });
  });
}

// POST /api/interest { plan, origin_screen } — экран интереса (SC-US-011-1): pro_interest + событие interest, раз в сутки.
export function createInterestHandler(deps: BillingDependencies) {
  return (request: Request) => run(deps, 'заявка', async () => {
    const entry = await guardMutation(request, deps, unauthorized);
    if (entry instanceof Response) return entry;
    const input = await body(request, ['plan', 'origin_screen']);
    if (input instanceof Response) return input;
    if (!isPaidPlan(input.plan)) return fail(422, 'invalid_plan', 'Выберите план «Без бейджа» или «Студия»');
    if (!deps.isOriginScreen(input.origin_screen)) return fail(422, 'invalid_origin_screen', 'Неизвестный экран');
    const outcome = await deps.recordInterest({ accountId: entry.accountId, plan: input.plan, originScreen: input.origin_screen });
    if (outcome === 'not_found') return unauthorized();
    return json({ data: { status: outcome } });
  });
}

async function readRawBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return size > 0 ? Buffer.concat(chunks) : null;
}

// POST /api/webhooks/yookassa — ЕДИНСТВЕННЫЙ вебхук продукта (ADR-017 дополненный). Без cookie: вся защита — подлинность
// уведомления и ключ повторности. Ответ 200 — «обработано или сознательно проигнорировано», 400 — подделка/мусор (не
// ретраится), 503 — источник истины или БД недоступны (ЮKassa повторит, записано ничего не было).
export function createPaymentWebhookHandler(deps: BillingDependencies) {
  return (request: Request) => run(deps, 'уведомление об оплате', async () => {
    const provider = deps.provider;
    if (!provider) return fail(404, 'not_found', 'Маршрут не найден');
    const raw = await readRawBody(request, MAX_NOTIFICATION_BYTES);
    if (!raw) return fail(400, 'invalid_body', 'Тело уведомления пусто или превышает предел');
    let sourceIp: string;
    // Адрес ИСТОЧНИКА — тот, что записала дверь (один адрес в X-Forwarded-For); цепочка и пустота — отказ (урок N4 16.09:
    // адрес сокета — это наша дверь в сети compose, и каждое уведомление отвергалось как foreign_ip).
    try { sourceIp = clientIp(request.headers); } catch { return fail(400, 'no_source_ip', 'Адрес отправителя не определён'); }
    let verified;
    try {
      verified = await provider.verifyNotification({ rawBody: raw, headers: {}, sourceIp });
    } catch (error) {
      if (error instanceof PaymentProviderUnavailable) {
        logOf(deps)(`Оплата: ЮKassa недоступна при проверке уведомления (${error.reason})`);
        return fail(503, 'provider_unavailable', 'Источник истины недоступен');
      }
      if (error instanceof PaymentVerificationError) {
        logOf(deps)(`Оплата: уведомление отвергнуто (${error.message.slice(0, 120)})`);
        return fail(400, 'verification_failed', 'Уведомление не прошло проверку подлинности');
      }
      throw error;
    }
    if (verified.kind === 'ignored') return json({ data: { applied: false, reason: 'ignored_event' } });
    const name = providerName(provider);
    const payloadSha256 = createHash('sha256').update(raw).digest('hex');
    const p = verified.payment;
    if (verified.kind === 'refund_succeeded') {
      const outcome = await deps.recordRefund({ provider: name, eventKey: `refund_succeeded:${verified.refund.id}`, payloadSha256,
        payment: { shop: provider.shop, id: p.id, orderId: p.orderId, amountMinor: p.amountMinor, feeMinor: p.feeMinor, paidAt: p.paidAt }
      });
      return json({ data: outcome });
    }
    const outcome = await deps.applyPayment({ provider: name, eventKey: `payment_succeeded:${p.id}`, payloadSha256,
      payment: { shop: provider.shop, id: p.id, orderId: p.orderId, amountMinor: p.amountMinor, feeMinor: p.feeMinor, paidAt: p.paidAt }
    });
    return json({ data: outcome });
  });
}
