'use client';
// Возврат с формы ЮKassa (tariffs-and-interest, AC-9). Состояния — decideReturnState (lib/payment-return.ts): выполняется,
// успех, отказ, не подтверждено за отведённое время, не найдено — у каждого СВОЙ блок с data-state (long-running-job:
// два неразличимых на экране состояния — одно состояние). Опрос — GET /api/checkout/{intent_id} по идентификатору,
// выданному ДО ухода к провайдеру.
import { useEffect, useState } from 'react';
import { RETURN_FETCH_TIMEOUT_MS, RETURN_MAX_ATTEMPTS, RETURN_POLL_INTERVAL_MS, decideReturnState, type CheckoutSnapshot, type ReturnState } from '../../../lib/payment-return';

const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const PLAN = { nobadge: 'Без бейджа', studio: 'Студия' } as const;

type Purchase = { plan: keyof typeof PLAN; until: string; current: keyof typeof PLAN | null };
export function ReturnView({ state, supportAvailable = false, purchase }: { state: ReturnState; supportAvailable?: boolean; purchase?: Purchase | null }) {
  switch (state.kind) {
    case 'waiting': return <div className="stack" data-state="waiting" aria-busy="true">
      <h1>Ждём подтверждения оплаты</h1>
      <p role="status">Банк подтверждает платёж. Обычно это несколько секунд. Проверка {Math.min(state.attempts + 1, RETURN_MAX_ATTEMPTS)} из {RETURN_MAX_ATTEMPTS}.</p>
    </div>;
    case 'succeeded': return <div className="stack" data-state="succeeded">
      {purchase ? <>
        <h1>Покупка плана «{PLAN[purchase.plan]}» подтверждена</h1>
        <p role="status" className="notice">Оплачено до {date(purchase.until)} по этой покупке.</p>
        {purchase.current && <p>Сейчас в аккаунте действует план «{PLAN[purchase.current]}».</p>}
      </> : <>
      <h1>План «{PLAN[state.plan as keyof typeof PLAN] ?? 'Без бейджа'}» включён</h1>
      <p role="status" className="notice">{state.until ? `Оплачено до ${date(state.until)}.` : 'Оплата подтверждена.'} Подпись «Работает на Суфлёре» исчезнет с сайта при следующей загрузке страницы.</p>
      </>}
      <a className="button" href="/dashboard">В кабинет</a>
    </div>;
    case 'paid_inactive': return <div className="stack" data-state="paid_inactive">
      <h1>Оплата прошла, но план сейчас не действует</h1>
      {purchase && <p>По этой покупке вы получили план «{PLAN[purchase.plan]}» до {date(purchase.until)}.</p>}
      <p role="status" className="notice">Срок оплаченного плана истёк или план снят вручную. Подпись «Работает на Суфлёре» снова видна на сайте.</p>
      <a className="button" href="/pricing">Тарифы</a>
    </div>;
    case 'failed': return <div className="stack" data-state="failed">
      <h1>Оплата не прошла</h1>
      <p role="alert">Платёж отменён. Статус отмены подтверждён платёжным сервисом.</p>
      <a className="button" href="/pricing">Попробовать снова</a>
    </div>;
    case 'reconciliation_required': return <div className="stack" data-state="reconciliation_required">
      <h1>Платёж на сверке</h1><p role="status">Результат этой покупки ещё уточняется. Повторно оплачивать её не нужно.</p>
      <button type="button" className="button secondary" onClick={() => window.location.reload()}>Проверить ещё раз</button>
      {supportAvailable && <a href="/support">Обратиться в поддержку</a>}
    </div>;
    case 'unconfirmed': return <div className="stack" data-state="unconfirmed">
      <h1>Подтверждение ещё не пришло</h1>
      <p role="status" className="notice">Это не значит, что оплата не прошла. Не платите повторно: откройте эту страницу через несколько минут.</p>
      <button type="button" className="button secondary" onClick={() => window.location.reload()}>Проверить ещё раз</button>
    </div>;
    case 'not_found': return <div className="stack" data-state="not_found">
      <h1>Оплата не найдена</h1>
      <p role="alert">Ссылка устарела или открыта из другого аккаунта. Войдите в тот аккаунт, из которого оплачивали.</p>
      <a className="button secondary" href="/pricing">Тарифы</a>
    </div>;
  }
}

export function ReturnScreen({ intentId, supportAvailable = false }: { intentId: string; supportAvailable?: boolean }) {
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [state, setState] = useState<ReturnState>({ kind: 'waiting', attempts: 0 });
  useEffect(() => {
    let attempts = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const poll = async () => {
      if (stopped) return;
      let snapshot: CheckoutSnapshot | null | 'not_found' = null;
      try {
        const response = await fetch(`/api/checkout/${encodeURIComponent(intentId)}`, { cache: 'no-store', signal: AbortSignal.timeout(RETURN_FETCH_TIMEOUT_MS) });
        if (response.status === 404) snapshot = 'not_found';
        else if (response.ok) snapshot = ((await response.json()) as { data?: CheckoutSnapshot }).data ?? null;
      } catch { snapshot = null; /* сбой опроса — не отказ оплаты */ }
      if (stopped) return;
      attempts += 1;
      const next = decideReturnState(snapshot, attempts, Date.now() - started);
      if (snapshot && snapshot !== 'not_found' && snapshot.status === 'succeeded' &&
        (snapshot.plan === 'nobadge' || snapshot.plan === 'studio') && typeof snapshot.applied_paid_until === 'string') {
        setPurchase({
          plan: snapshot.plan, until: snapshot.applied_paid_until, current:
            snapshot.account_plan === 'studio' || snapshot.account_plan === 'nobadge' ? snapshot.account_plan : null
        });
      } else setPurchase(null);
      setState(next);
      if (next.kind === 'waiting') timer = setTimeout(() => { void poll(); }, RETURN_POLL_INTERVAL_MS);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [intentId]);
  return <section className="card stack upgrade" aria-live="polite"><ReturnView purchase={purchase} supportAvailable={supportAvailable} state={state} /></section>;
}
