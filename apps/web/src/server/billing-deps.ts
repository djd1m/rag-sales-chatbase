// Боевая связка маршрутов оплаты: SQL из @n6/db, провайдер из payments/config. Одна функция для маршрутов и для тестов
// (tests/billing.integration.test.ts): тест подменяет только провайдера (фейк N4 или адаптер ЮKassa на подменном
// HTTP-сервере) и ограничитель двери — намерение, ключ повторности, план и срок идут по НАСТОЯЩЕМУ SQL.
import {
  applyVerifiedPayment, openVerifiedPaymentIntent, isInterestOriginScreen, markIntentCanceled, readPaymentIntent, recordProInterest,
  recordVerifiedRefund, setIntentProviderPayment, type Pool } from '@n6/db';
import type { BillingDependencies } from './billing-handler';
import type { PaymentProvider } from './payments/provider';

export interface BillingWiring {
  pool: Pool;
  publicOrigin: string;
  provider: PaymentProvider | null;
  allowMutation: (ip: string, account?: string) => Promise<boolean>;
  tokenHash: (token: string) => string;
  authenticate: (token: string) => Promise<{ account_id: string } | null>;
  log?: (line: string) => void;
}

export function createBillingDependencies(w: BillingWiring): BillingDependencies {
  const { pool } = w;
  return {
    publicOrigin: w.publicOrigin, authenticate: w.authenticate, allowMutation: w.allowMutation, provider: w.provider, log: w.log,
    tokenHash: w.tokenHash,
    createIntent: (input) => openVerifiedPaymentIntent(pool, input),
    setIntentPayment: (intentId, paymentId) => setIntentProviderPayment(pool, intentId, paymentId),
    readIntent: (intentId, accountId) => readPaymentIntent(pool, intentId, accountId),
    markCanceled: (intentId) => markIntentCanceled(pool, intentId),
    applyPayment: (input) => applyVerifiedPayment(pool, input),
    recordRefund: (input) => recordVerifiedRefund(pool, input),
    recordInterest: (input) => recordProInterest(pool, input),
    isOriginScreen: isInterestOriginScreen,
  };
}
