'use client';
import { useEffect, useRef, useState } from 'react';
import { openCustomerSupportWidget } from '../../lib/customer-support-widget';
import styles from './trust-support-panel.module.css';

export function CustomerSupportPanel({ accountId }: { accountId: string }) {
  const opener = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<ReturnType<typeof openCustomerSupportWidget> | null>(null);
  const [state, setState] = useState<'loading' | 'open' | 'closed' | 'unavailable'>('closed');
  useEffect(() => {
    const instance = openCustomerSupportWidget(container.current!, accountId, setState, () => requestAnimationFrame(() => opener.current?.focus()));
    widget.current = instance;
    return () => { instance.dispose(); widget.current = null; };
  }, [accountId]);
  return <section className="stack" aria-labelledby="support-chat-title">
    <h2 id="support-chat-title">Чат с поддержкой Суфлёра</h2>
    <p>При открытии чата Libredesk получит подтверждённую почту и идентификатор вашего аккаунта для доступа к вашей переписке.</p>
    <button className="button" ref={opener} type="button" aria-expanded={state === 'open'} aria-controls="support-conversation"
      disabled={state === 'loading' || state === 'open'} onClick={() => void widget.current?.open()}>Открыть чат</button>
    {state === 'loading' && <p role="status">Проверяем вход и подключаем чат…</p>}
    {state === 'unavailable' && <p role="alert">Чат недоступен. Проверьте вход в аккаунт и попробуйте ещё раз.</p>}
    {(state === 'loading' || state === 'open') && <button type="button" className="button secondary" onClick={() => widget.current?.close()}>Закрыть чат</button>}
    <div id="support-conversation" ref={container} className={styles.conversation} />
  </section>;
}
