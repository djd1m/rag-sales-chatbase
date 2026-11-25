'use client';
import { useEffect, useState } from 'react';
import { consumePreviewClaimNotice, type PreviewClaimOutcome } from '../../lib/preview-claim-notice';

const messages: Record<PreviewClaimOutcome, string> = {
  claimed: 'Бот из предпросмотра сохранён в вашем аккаунте.',
  already_claimed: 'Вы уже сохранили этого бота в своём аккаунте.',
  expired: 'Срок предпросмотра истёк. Начните с нового адреса или PDF.',
  not_found: 'Предпросмотр не найден. Вы можете начать новый предпросмотр.',
  plan_limit: 'Бота не удалось сохранить: достигнут предел плана.',
  unavailable: 'Сервис временно недоступен. Вернитесь в предпросмотр и повторите сохранение.',
};
export function PreviewClaimNotice({ context }: { context: string }) {
  const [outcome, setOutcome] = useState<PreviewClaimOutcome | null>(null);
  useEffect(() => {
    const notice = consumePreviewClaimNotice(context);
    if (notice) setOutcome(notice);
    const clear = () => setOutcome(null);
    const restore = (event: PageTransitionEvent) => { if (event.persisted) clear(); };
    let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel('n6-auth'); channel.onmessage = clear; } catch { /* use storage event */ }
    const onStorage = (event: StorageEvent) => { if (event.key === 'n6_auth_epoch') clear(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', restore);
    return () => {
      channel?.close();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', restore);
    };
  }, [context]);
  return outcome && <p role="status" className="notice cabinet-notice">{messages[outcome]}{' '}
    {outcome === 'plan_limit' && <a href="/pricing">Сравнить планы</a>}
    {(outcome === 'expired' || outcome === 'not_found') && <a href="/preview">Выбрать материал</a>}
  </p>;
}
