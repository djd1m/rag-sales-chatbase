'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { errorOf } from '../../lib/api-client';
import { publishCustomerAuthChange } from '../../lib/customer-auth-signal';
import { safeNextPath } from '../../lib/payment-return';
import { PREVIEW_CLAIM_CONTEXT_HEADER, storePreviewClaimNotice } from '../../lib/preview-claim-notice';

type Documents = Record<'terms' | 'consent', { version: string; path: string }>;
const claimMessages: Record<string, string> = {
  expired: 'Срок предпросмотра закончился.', not_found: 'Предпросмотр больше недоступен.',
  unavailable: 'Не удалось сохранить предпросмотр.', plan_limit: 'Предел текущего плана не позволил сохранить предпросмотр.',
};

export function AuthForm({ initialMode = 'login', next = null, documents, recoveryAvailable = false }: {
  initialMode?: 'login' | 'register'; next?: string | null; documents?: Documents; recoveryAvailable?: boolean;
}) {
  const [register, setRegister] = useState(initialMode === 'register'), [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false), [error, setError] = useState(''), [codeError, setCodeError] = useState('');
  const [docs, setDocs] = useState(documents), [terms, setTerms] = useState(false), [consent, setConsent] = useState(false);
  const [claimProblem, setClaimProblem] = useState('');
  const router = useRouter(), destination = safeNextPath(next) ?? '/dashboard';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setCodeError('');
    const form = new FormData(event.currentTarget);
    const code = String(form.get('partner_code') ?? '').trim();
    try {
      if (register && (!docs || !terms || !consent)) throw new Error('Прочитайте и отдельно подтвердите условия и согласие.');
      const response = await fetch('/api/auth/' + (register ? 'register' : 'login'), {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          email: form.get('email'), password: form.get('password'),
          ...(register && docs ? { terms: { accepted: terms, version: docs.terms.version }, consent: { accepted: consent, version: docs.consent.version } } : {}),
          ...(register && code ? { partner_code: code } : {})
        })
      });
      const body = await response.json().catch(() => null);
      const problem = errorOf(body);
      if (!response.ok && problem?.field === 'partner_code') { setCodeError(problem.message); return; }
      if (response.status === 409 && problem?.code === 'legal_version_changed' && docs) {
        const latest = body?.documents as Documents | undefined;
        if (latest && ['terms', 'consent'].every(key => {
          const d = latest[key as keyof Documents];
          return typeof d?.version === 'string' && d.path === '/legal/' + key;
        })) {
          if (docs.terms.version !== latest.terms.version) setTerms(false);
          if (docs.consent.version !== latest.consent.version) setConsent(false);
          setDocs(latest);
        }
      }
      if (!response.ok || body?.data?.ok !== true) throw new Error(problem?.message ?? 'Не удалось войти. Повторите позже.');
      publishCustomerAuthChange();
      const outcome = body.data.preview;
      const context = response.headers.get(PREVIEW_CLAIM_CONTEXT_HEADER);
      const stored = storePreviewClaimNotice(outcome, context);
      if (!stored && context && typeof outcome === 'string' && Object.hasOwn(claimMessages, outcome)) {
        setClaimProblem(claimMessages[outcome]!); return;
      }
      if (stored || (context && typeof outcome === 'string')) {
        window.location.assign(destination);
        return;
      }
      router.push(destination); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Нет связи с сервером'); }
    finally { setBusy(false); }
  }

  if (claimProblem) return <section className="auth-card"><h1>Вход выполнен</h1><p role="status">{claimProblem}</p><a href={destination}>Продолжить</a></section>;
  return <form id="auth" className="auth-card" onSubmit={submit}>
    <h1>{register ? 'Создать аккаунт' : 'Войти в Суфлёр'}</h1>
    <label>Почта<input id="auth-email" name="email" type="email" autoComplete="email" required /></label>
    <label>Пароль<input name="password" type={visible ? 'text' : 'password'} minLength={8} autoComplete={register ? 'new-password' : 'current-password'} required /></label>
    <button type="button" className="text-button" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Скрыть пароль' : 'Показать пароль'}</button>
    {!register && recoveryAvailable && <p><a className="button secondary" href="/forgot">Забыли пароль?</a></p>}
    {register && <>
      <p className="muted">Пароль — от 8 символов, до 72 байт.</p>
      <label>Код партнёра или студии (если есть)<input name="partner_code" type="text" maxLength={40} autoComplete="off" spellCheck={false}
        aria-invalid={codeError ? true : undefined} aria-describedby={codeError ? 'auth-code-error' : undefined} /></label>
      {codeError && <p id="auth-code-error" role="alert" className="field-error">{codeError}</p>}
      {docs && <>
        <p><a href={docs.terms.path} target="_blank" rel="noreferrer">Условия использования</a> · Ред. {docs.terms.version}<br />
          <label><input type="checkbox" name="terms" required checked={terms} onChange={e => setTerms(e.target.checked)} /> Принимаю условия использования Суфлёра</label></p>
        <p><a href={docs.consent.path} target="_blank" rel="noreferrer">Согласие на обработку данных</a> · Ред. {docs.consent.version}<br />
          <label><input type="checkbox" name="consent" required checked={consent} onChange={e => setConsent(e.target.checked)} /> Даю согласие на обработку данных для ведения аккаунта</label></p>
      </>}
      <p><a href="/legal/privacy" target="_blank" rel="noreferrer">Политика обработки персональных данных</a></p>
    </>}
    {error && <p role="alert">{error}</p>}
    <button disabled={busy || (register && !docs)}>{busy ? 'Подождите…' : register ? 'Создать аккаунт' : 'Войти'}</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => {
      setRegister(!register); setVisible(false); setError(''); setCodeError(''); setTerms(false); setConsent(false);
    }}>{register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}</button>
  </form>;
}
