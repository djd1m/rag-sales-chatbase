'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { publishCustomerAuthChange } from '../../lib/customer-auth-signal';
import { safeNextPath } from '../../lib/payment-return';
import { errorOf } from '../../lib/api-client';

type Mode = 'verify-email' | 'forgot' | 'reset';
type Phase = 'loading' | 'request' | 'proof' | 'invalid' | 'login' | 'done' | 'accepted';
const unavailable = 'Отправка писем пока не настроена.';

export function CustomerRecoveryForm({ mode, authenticated = false, verified = false, mailEnabled = false, next }: {
  mode: Mode; authenticated?: boolean; verified?: boolean; mailEnabled?: boolean; next?: string | null;
}) {
  const token = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [visible, setVisible] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const verify = mode === 'verify-email';
  const destination = safeNextPath(next);
  const continuation = destination?.startsWith('/invite/') ? null : destination;

  useEffect(() => {
    mounted.current = true;
    function readFragment() {
      const hash = location.hash;
      if (hash) {
        generation.current++;
        history.replaceState(history.state, '', location.pathname + location.search);
        token.current = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null;
        setError(''); setBusy(false); setVisible(false);
      }
      if (mode === 'forgot') setPhase('request');
      else if (verify && !authenticated) setPhase('login');
      else if (token.current) setPhase('proof');
      else if (verify && !hash) setPhase(verified ? 'done' : 'request');
      else setPhase('invalid');
    }
    readFragment();
    window.addEventListener('hashchange', readFragment);
    return () => { mounted.current = false; generation.current++; window.removeEventListener('hashchange', readFragment); };
  }, [mode, verify, authenticated, verified]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const confirming = verify && phase === 'proof';
    const sending = verify && !confirming;
    const endpoint = sending ? 'email/send' : confirming ? 'email/confirm' : mode;
    const payload = sending ? (continuation ? { next: continuation } : {}) : confirming ? { token: token.current }
      : mode === 'reset' ? { token: token.current, password: form.get('password') } : { email: form.get('email') };
    setBusy(true); setError('');
    const turn = generation.current;
    const current = () => mounted.current && turn === generation.current;
    const controller = new AbortController();
    const timeout = sending ? setTimeout(() => controller.abort(), 8000) : undefined;
    try {
      const response = await fetch('/api/auth/' + endpoint, {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const body = await response.json().catch(() => null);
      if (!current()) return;
      if (!response.ok) {
        const problem = errorOf(body);
        if (response.status === 401 && verify) { setPhase('login'); return; }
        if (problem?.code === 'invalid_recovery_link') { token.current = null; setPhase('invalid'); return; }
        setError(problem?.message ?? 'Не удалось завершить запрос. Попробуйте ещё раз.');
        return;
      }
      if (response.status === 202 && ((sending && body?.data?.status === 'accepted') || (mode === 'forgot' && body?.data?.status === 'requested'))) {
        setPhase('accepted'); return;
      }
      if (response.status === 200 && ((verify && body?.data?.verified === true) || (mode === 'reset' && body?.data?.ok === true))) {
        token.current = null;
        if (mode === 'reset') publishCustomerAuthChange();
        setPhase('done'); return;
      }
      setError('Не удалось подтвердить результат. Проверьте состояние ещё раз.');
    } catch {
      if (current()) setError(sending ? 'Не удалось узнать результат отправки. Проверьте почту или повторите запрос позже.'
        : 'Нет связи с сервером. Попробуйте ещё раз.');
    } finally { clearTimeout(timeout); if (current()) setBusy(false); }
  }

  const title = verify ? 'Подтверждение почты' : mode === 'forgot' ? 'Восстановление доступа' : 'Новый пароль';
  const askMail = phase === 'request' && mode !== 'reset';
  return <section className="auth-card" aria-labelledby="recovery-title"><h1 id="recovery-title">{title}</h1>
    {phase === 'loading' && <p role="status">Проверяем ссылку…</p>}
    {phase === 'login' && <><p>{token.current ? 'Войдите в свой аккаунт на этом устройстве, затем снова откройте исходное письмо.' : 'Войдите в свой аккаунт, чтобы запросить подтверждение почты.'}</p><a href="/login">Войти</a></>}
    {phase === 'invalid' && <><p role="alert">Ссылка недействительна, уже использована или её срок закончился.</p>
      {verify ? <><a href="/login">Войти в нужный аккаунт</a> · <a href={continuation ? '/verify-email?next=' + encodeURIComponent(continuation) : '/verify-email'}
        onClick={() => { token.current = null; setError(''); setPhase('request'); }}>Запросить новую ссылку</a></>
        : <a href="/forgot">Запросить новую ссылку</a>}</>}
    {phase === 'done' && (verify ? <><p role="status">Почта подтверждена.</p>
      <a href={continuation ?? '/dashboard'}>{continuation === '/dashboard?source=pdf' ? 'Продолжить с PDF' : continuation ? 'Продолжить оформление' : 'В кабинет'}</a></>
      : <><p role="status">Пароль изменён. Войдите с новым паролем.</p><a href="/login">Войти</a></>)}
    {phase === 'accepted' && <><p role="status">{verify ? 'Почтовый сервис принял письмо. Откройте ссылку в письме, чтобы подтвердить адрес.'
      : 'Запрос принят. Если восстановление доступно для этого адреса, проверьте почту.'}</p>
      <button type="button" className="text-button" onClick={() => setPhase('request')}>Повторить запрос</button></>}
    {(askMail || phase === 'proof') && <form onSubmit={submit}>
      {askMail && (mailEnabled ? <p>{verify ? 'Отправьте ссылку на текущую почту аккаунта. Она действует 24 часа.'
        : 'Укажите почту аккаунта. Ссылка для смены пароля действует один час.'}</p> : <p role="status">{unavailable}</p>)}
      {mode === 'forgot' && <label>Почта<input type="email" name="email" autoComplete="email" maxLength={254} required /></label>}
      {mode === 'reset' && <><label>Новый пароль<input name="password" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={8} required /></label>
        <button className="text-button" type="button" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Скрыть пароль' : 'Показать пароль'}</button>
        <p className="muted">От 8 символов, до 72 байт. После смены пароля все устройства выйдут из аккаунта.</p></>}
      {verify && phase === 'proof' && <p>Подтвердите, что этот адрес принадлежит вашему аккаунту Суфлёра.</p>}
      <button disabled={busy || (askMail && !mailEnabled)}>{busy ? 'Подождите…' : mode === 'reset' ? 'Сменить пароль' : phase === 'proof' ? 'Подтвердить почту' : 'Запросить письмо'}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
    {verify && authenticated && phase !== 'done' && <p><a href="/dashboard">В кабинет</a></p>}
    {mode === 'forgot' && <p><a href="/login">Вернуться ко входу</a></p>}
    <p><a className="button secondary" href="/support">Помощь с доступом</a></p>
  </section>;
}
