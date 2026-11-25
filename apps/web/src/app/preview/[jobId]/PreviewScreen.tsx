'use client';
// Контейнер экрана предпросмотра: опрос GET /api/preview/{index_job_id} раз в 2 с (long-job-contract), вопросы в
// POST …/ask, сохранение — POST …/claim (вошедший) или регистрация (cookie предпросмотра сохранит бота сервер).
// Разметка — PreviewViews (её же проверяет прибор адаптивности). История диалога — на СЕРВЕРЕ: клиент шлёт только вопрос.
import { useCallback, useEffect, useState } from 'react';
import { dataOf, errorOf } from '../../../lib/api-client';
import { retireFailedPreview } from '../../../lib/preview-intent';
import { PREVIEW_CLAIM_CONTEXT_HEADER, storePreviewClaimNotice } from '../../../lib/preview-claim-notice';
import { useRouter } from 'next/navigation';
import { PreviewChat, PreviewNextSteps, PreviewProgress, type ChatMessage, type ClaimFeedback, type ClaimTarget, type PreviewJobView, type PreviewSiteView } from '../PreviewViews';

const POLL_MS = 2000;
const SHARE_TIMEOUT_MS = 2000;   // запись клика «Поделиться» — метрика, дольше её не ждём
interface ReadData extends PreviewJobView { site?: PreviewSiteView | null; questions_left?: number }
function usableSite(site: PreviewSiteView | null | undefined): site is PreviewSiteView {
  return !!site && typeof site.host === 'string' && typeof site.title === 'string' && typeof site.h1 === 'string'
    && Array.isArray(site.suggestions) && site.suggestions.every(value => typeof value === 'string');
}

export function PreviewScreen({ jobId, signedIn }: { jobId: string; signedIn: boolean }) {
  return <PreviewWorkspace key={jobId} jobId={jobId} signedIn={signedIn} />;
}
function PreviewWorkspace({ jobId, signedIn }: { jobId: string; signedIn: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<ReadData | null>(null);
  const [gone, setGone] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askError, setAskError] = useState('');
  const [claimError, setClaimError] = useState<ClaimFeedback | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [readError, setReadError] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/preview/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal: controller.signal });
        const body: unknown = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (response.status === 404) { setGone(errorOf(body)?.message ?? 'Предпросмотр не найден.'); return; }
        if (!response.ok) { setReadError('Не удалось получить состояние задания.'); return; }
        const data = dataOf<ReadData>(body);
        if (!data || !['running', 'no_response', 'failed', 'done'].includes(data.state)) {
          setReadError('Сервис не вернул состояние задания.'); return;
        }
        if (data.state === 'failed') await retireFailedPreview(jobId);
        if (controller.signal.aborted) return;
        setView(data); setReadError('');
        if (typeof data.questions_left === 'number') setLeft(data.questions_left);
        if (data.state === 'running' || data.state === 'no_response') timer = setTimeout(poll, POLL_MS);
      } catch { if (!controller.signal.aborted) setReadError('Нет связи с сервисом предпросмотра.'); }
      finally { if (!controller.signal.aborted) setChecking(false); }
    };
    timer = setTimeout(poll, 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [jobId, attempt]);

  const ask = useCallback(async (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    setBusy(true); setAskError('');
    try {
      const response = await fetch(`/api/preview/${encodeURIComponent(jobId)}/ask`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429 && errorOf(body)?.code === 'limit_preview') {
        setMessages((m) => [...m, { kind: 'question', text: question }, { kind: 'refused', text: errorOf(body)!.message }]); setLeft(0); setDraft(''); return;
      }
      const data = dataOf<{ status: string; text: string; contact?: string | null; source?: { title: string; url: string | null; excerpt: string }; first_answer?: boolean }>(body);
      if (!response.ok || !data) { setAskError(errorOf(body)?.message ?? 'Не удалось получить ответ. Повторите'); return; }
      const reply: ChatMessage = data.status === 'answered' && data.source
        ? { kind: 'answered', text: data.text, source: data.source, firstAnswer: data.first_answer === true }
        : data.status === 'small_talk' ? { kind: 'small_talk', text: data.text } : { kind: 'unknown', text: data.text, contact: data.contact };
      setMessages((m) => [...m, { kind: 'question', text: question }, reply]);
      setLeft((n) => (n === null ? null : Math.max(0, n - 1)));
      setDraft('');
    } catch { setAskError('Нет связи с сервером. Повторите'); } finally { setBusy(false); }
  }, [busy, jobId]);

  const save = useCallback(async (target: ClaimTarget) => {
    setSaving(true); setClaimError(null);
    try {
      const response = await fetch(`/api/preview/${encodeURIComponent(jobId)}/claim`, { method: 'POST' });
      const body: unknown = await response.json().catch(() => null);
      const claimed = dataOf<{ bot_id?: unknown }>(body);
      if (response.status === 200 && typeof claimed?.bot_id === 'string' && claimed.bot_id) {
        storePreviewClaimNotice('claimed', response.headers.get(PREVIEW_CLAIM_CONTEXT_HEADER));
        window.location.assign('/dashboard');
        return;
      }
      const failure = errorOf(body);
      let action: ClaimFeedback['action'];
      if (response.status === 401) action = { href: '/login?from=preview', label: 'Войти в аккаунт' };
      else if (failure?.code === 'already_claimed') action = { href: '/dashboard', label: 'Мои боты' };
      else if (failure?.code === 'plan_limit') action = { href: '/pricing', label: 'Сравнить планы' };
      else if (response.status === 404) action = { href: '/preview', label: 'Выбрать материал' };
      setClaimError({ target, message: failure?.message ?? 'Не удалось сохранить бота. Повторите', action });
    } catch { setClaimError({ target, message: 'Нет связи с сервером. Повторите сохранение.' }); } finally { setSaving(false); }
  }, [jobId]);

  // «Поделиться ссылкой на бота» (FR-GROWTH-001): нажатие записывается, затем бот сохраняется в аккаунт — ссылку на
  // демо-страницу выдаёт кабинет после публикации (A-N6-038 (5)). Кнопка гаснет сразу; запись клика — метрика, её ждём
  // не дольше SHARE_TIMEOUT_MS: зависший запрос не задерживает переход (ревью фичи 13, находка 3).
  const share = useCallback(async () => {
    setSaving(true); setClaimError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHARE_TIMEOUT_MS);
    await fetch(`/api/preview/${encodeURIComponent(jobId)}/share`, { method: 'POST', signal: controller.signal }).catch(() => undefined);
    clearTimeout(timer);
    if (signedIn) await save('share'); else router.push('/login?mode=register&from=preview');
  }, [jobId, router, save, signedIn]);

  if (gone) {
    return <section className="preview-status stack" aria-labelledby="preview-title">
      <h1 id="preview-title" className="page-title">Предпросмотр недоступен</h1>
      <p className="notice">{gone}</p>
      {signedIn && <a className="source-alternative" href="/dashboard">Мои боты</a>}
      <PreviewNextSteps jobId={jobId} />
    </section>;
  }
  if (readError || (view?.state === 'done' && !usableSite(view.site))) {
    return <section className="preview-status stack">
      <h1 className="page-title">{readError ? 'Состояние задания недоступно' : 'Чтение завершено, но данные предпросмотра недоступны'}</h1>
      {readError && <p role="alert">{readError}</p>}
      {readError && view && <p>Последнее известное состояние: прочитано страниц — {view.pages_done}, фрагментов — {view.chunks_done}.</p>}
      <button type="button" disabled={checking} onClick={() => { setChecking(true); setAttempt(value => value + 1); }}>
        {checking ? 'Проверяем…' : 'Проверить состояние'}</button>
      <PreviewNextSteps jobId={jobId} />
    </section>;
  }
  if (!view) return <p role="status" className="muted">Загружаем состояние задачи…</p>;
  if (view.state !== 'done' || !view.site) return <PreviewProgress host={view.site?.host ?? ''} view={view} />;
  return <PreviewChat site={view.site} messages={messages} questionsLeft={left} draft={draft} busy={busy} error={askError} claimError={claimError}
    truncatedPages={view.truncated ? view.pages_done : null} truncatedBy={view.truncated ?? null}
    signedIn={signedIn} saving={saving} onDraft={setDraft} onAsk={ask} onSave={save} onShare={share} />;
}
