'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { dataOf, errorOf } from '../../lib/api-client';
import { clearLegacyPreviewKeys, isPreviewJobId, previewLaunchKey, readPreviewRetry, readPreviewSiteInput, rememberPreviewRetry, type PreviewIntent } from '../../lib/preview-intent';

export function PreviewStartForm({ url, busy, error, onUrl, onSubmit }: {
  url: string; busy: boolean; error: string; onUrl: (v: string) => void; onSubmit: () => void;
}) {
  return <form className="url-form" method="post" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <label htmlFor="site-url">Адрес вашего сайта</label>
    <div className="url-row">
      <input id="site-url" type="text" inputMode="url" autoComplete="url" spellCheck={false} required maxLength={2048}
        aria-invalid={!!error} aria-describedby={error ? 'site-error site-hint' : 'site-hint'}
        placeholder="Например, example.ru" value={url} onChange={event => onUrl(event.target.value)} disabled={busy} />
      <button type="submit" disabled={busy}>{busy ? 'Запускаем…' : 'Создать бота'}</button>
    </div>
    {error && <p id="site-error" role="alert" className="chat-error">{error}</p>}
    <p id="site-hint" className="muted">Бесплатно, до 20 страниц без регистрации.</p>
  </form>;
}

export function PreviewStart({ intent, signedIn = false }: { intent?: PreviewIntent; signedIn?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempted = useRef<{ value: string; key: string } | null>(null);
  const initialized = useRef(false);
  const pending = useRef(false);

  const submit = useCallback(async (value: string, legacy = false) => {
    if (pending.current) return;
    const input = readPreviewSiteInput(value);
    if (!input) { setError('Укажите HTTP(S)-адрес сайта без логина и пароля.'); return; }
    pending.current = true;
    setBusy(true); setError('');
    try {
      if (attempted.current?.value !== input.raw) attempted.current = { value: input.raw, key: await previewLaunchKey(input) };
      const response = await fetch('/api/preview', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': attempted.current.key,
      }, body: JSON.stringify({ url: input.raw }) });
      const body: unknown = await response.json().catch(() => null);
      const id = dataOf<{ index_job_id?: unknown }>(body)?.index_job_id;
      if (response.status === 202 && isPreviewJobId(id)) {
        rememberPreviewRetry(id, input.origin, attempted.current.key);
        attempted.current = null;
        setUrl(input.origin ?? '');
        window.history.replaceState({ ...history.state, previewRetry: id }, '');
        const path = `/preview/${id}`;
        if (legacy) router.replace(path); else router.push(path);
        return;
      }
      setError(errorOf(body)?.message ?? 'Не удалось запустить чтение сайта. Попробуйте ещё раз.');
    } catch { setError('Нет связи с сервером. Попробуйте ещё раз.'); }
    pending.current = false; setBusy(false);
  }, [router]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const location = new URL(window.location.href);
    const submitted = intent?.mode === 'site' && intent.legacy ? location.searchParams.get('url') : null;
    if (intent && location.searchParams.has('url')) {
      location.searchParams.delete('url');
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    if (submitted) {
      if (readPreviewSiteInput(submitted)) setUrl(submitted);
      else clearLegacyPreviewKeys();
      void submit(submitted, true);
    } else {
      clearLegacyPreviewKeys();
      setUrl(readPreviewRetry(intent?.mode === 'retry' ? intent.jobId : history.state?.previewRetry));
    }
  }, [intent, submit]);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) { pending.current = false; setBusy(false); }
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  const pdf = intent?.mode === 'pdf';
  const form = <PreviewStartForm url={url} busy={busy} error={error} onUrl={value => { setUrl(value); setError(''); }} onSubmit={() => void submit(url)} />;
  if (!intent) return <>{form}<a className="source-alternative" href={signedIn ? '/dashboard?source=pdf' : '/preview?source=pdf'}>Начать с PDF</a></>;
  return <section className="preview-status stack" aria-labelledby="start-title">
    <h1 id="start-title" className="page-title">Выберите материал для бота</h1>
    <nav className="source-choices cluster" aria-label="Тип материала">
      <a className="button secondary" aria-current={!pdf ? 'page' : undefined} href="/preview">Сайт</a>
      <a className="button secondary" aria-current={pdf ? 'page' : undefined} href="/preview?source=pdf">PDF</a>
    </nav>
    {pdf ? <div className="card stack"><h2>Документ PDF</h2><p>Нужен PDF с текстовым слоем, до 10 МБ и 100 страниц.</p>
      <p>{signedIn ? 'Выберите бота в кабинете или создайте нового, затем укажите файл.' : 'Войдите или зарегистрируйтесь, чтобы выбрать своего бота и загрузить файл.'}</p>
      <a className="button" href={signedIn ? '/dashboard?source=pdf' : '/login?next=%2Fdashboard%3Fsource%3Dpdf'}>{signedIn ? 'Выбрать бота' : 'Войти для загрузки PDF'}</a>
    </div> : form}
  </section>;
}
