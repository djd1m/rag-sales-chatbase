import { useEffect, useId, useRef } from 'react';
import { OwnerAnswerSource, OwnerChecks } from '../OwnerAnswerSource';
import { isPreviewJobId } from '../../lib/preview-intent';
import { pagesWord } from '../../lib/source-ribbon';

export type JobState = 'running' | 'done' | 'failed' | 'no_response';
export interface PreviewJobView { index_job_id: string; state: JobState; pages_done: number; pages_total: number | null; page_budget: number; chunks_done: number; reason?: string;
  // budget-truncation (A-N6-052): у готовой задачи — чем она усечена; null/нет поля — прочитано всё, что позволил обход.
  truncated?: string | null }
// Пометка усечённого предпросмотра: готово с прочитанным, это не «ещё читаем» и не отказ (три состояния различимы).
export function truncationNotice(pagesDone: number, reason?: string | null): string {
  // crawl-coverage (ревью Codex, круг 1): остановка потолком времени/запросов обхода — не бюджет предпросмотра.
  if (reason === 'crawl_limit') return `Прочитано ${pagesDone} ${pagesWord(pagesDone)} — обход остановлен пределом времени или запросов к сайту (бережём ваш сайт от нагрузки). Бот отвечает по прочитанному.`;
  return `Прочитано ${pagesDone} ${pagesWord(pagesDone)} — дальше закончился бюджет предпросмотра. Бот отвечает по прочитанному; сохраните бота, чтобы дочитать сайт в пределах тарифа.`;
}
export interface PreviewSiteView { host: string; title: string; h1: string; suggestions: string[] }
export interface SourceView { title: string; url: string | null; excerpt: string }
export type ChatMessage =
  | { kind: 'question'; text: string }
  | { kind: 'answered'; text: string; source: SourceView; firstAnswer: boolean }
  | { kind: 'unknown'; text: string; contact?: string | null }
  | { kind: 'small_talk'; text: string }
  | { kind: 'refused'; text: string };

// Причины канона §4 (index_job.failure_reason) → текст владельцу. Неизвестная — как internal.
const REASONS: Readonly<Record<string, { title: string; hint: string }>> = {
  robots_disallowed: { title: 'Сайт запрещает чтение роботам (robots.txt)', hint: 'Выберите другой адрес или добавьте PDF после входа в кабинет.' },
  unreachable: { title: 'Сайт не открылся', hint: 'Проверьте адрес: сайт должен открываться без входа по паролю.' },
  blocked_address: { title: 'Этот адрес мы не читаем', hint: 'Адрес ведёт во внутреннюю или служебную сеть. Укажите публичный адрес сайта.' },
  no_text: { title: 'На сайте не нашлось текста', hint: 'Похоже, страницы собираются скриптами в браузере. В кабинете можно загрузить материалы из PDF.' },
  // Две причины под одним кодом (ревью budget-truncation, находка 2): первая же страница больше бюджета предпросмотра
  // ИЛИ исчерпан суточный лимит сервиса. Текст честен для обеих и не обещает того, что регистрация не снимет.
  // Бюджет, исчерпанный ПОСЛЕ прочитанных страниц, — не отказ, а готовый предпросмотр с пометкой (A-N6-052).
  quota_refused: { title: 'Не хватило лимита на обработку текста', hint: 'Первая страница оказалась больше бюджета бесплатного предпросмотра, либо на сегодня исчерпан лимит сервиса. Попробуйте адрес конкретной страницы — например, с ценами — или повторите позже.' },
  embedding_unavailable: { title: 'Сервис обработки текста временно недоступен', hint: 'Попробуйте через несколько минут.' },
  stalled: { title: 'Чтение сайта прервалось', hint: 'Задача не отвечала больше 5 минут. Попробуйте ещё раз.' },
  internal: { title: 'Не удалось прочитать сайт', hint: 'Попробуйте ещё раз или укажите другой адрес.' },
};
export const reasonText = (reason: string | undefined) => REASONS[reason ?? 'internal'] ?? REASONS.internal!;
export function PreviewNextSteps({ jobId }: { jobId: string }) {
  return <div className="stack"><p className="cluster"><a className="button" href={isPreviewJobId(jobId) ? `/preview?retry=${jobId}` : '/preview'}>Указать другой адрес</a>
    <a className="button secondary" href="/preview?source=pdf">Начать с PDF</a></p>
    <p className="muted">Для загрузки PDF нужен вход в кабинет.</p>
    {isPreviewJobId(jobId) && <details><summary>Данные для поддержки</summary><p className="muted">Задача {jobId}</p></details>}
  </div>;
}

export function PreviewProgress({ host, view }: { host: string; view: PreviewJobView }) {
  if (view.state === 'failed') {
    const text = reasonText(view.reason);
    return <section className="preview-status stack" aria-labelledby="preview-title">
      <h1 id="preview-title" className="page-title">Бот не собрался</h1>
      <p role="alert" className="notice danger-notice"><strong>{text.title}.</strong> {text.hint}</p>
      <PreviewNextSteps jobId={view.index_job_id} />
    </section>;
  }
  if (view.state === 'no_response') {
    return <section className="preview-status stack" aria-labelledby="preview-title">
      <h1 id="preview-title" className="page-title">Проверяем, что с чтением сайта</h1>
      <p role="status" className="notice">Больше 5 минут не было новостей от задачи — это не «ещё читаем». Мы перепроверим и закроем её с причиной, если она остановилась.</p>
      <PreviewNextSteps jobId={view.index_job_id} />
    </section>;
  }
  const total = Math.min(view.pages_total ?? view.page_budget, view.page_budget);
  const done = Math.min(view.pages_done, total || view.page_budget);
  return <section className="preview-status stack" aria-labelledby="preview-title">
    <h1 id="preview-title" className="page-title">Читаем {host || 'сайт'}</h1>

    <div className="progress" role="progressbar" aria-label="Прочитано страниц" aria-valuemin={0} aria-valuemax={view.page_budget} aria-valuenow={done}
      aria-valuetext={`${done} из ${view.page_budget}`}><span style={{ width: `${Math.round((done / view.page_budget) * 100)}%` }} /></div>
    <p aria-live="polite">Читаем сайт: <strong>{done}</strong> из ≤ {view.page_budget} страниц · фрагментов: {view.chunks_done}</p>
    <p className="muted">Когда чтение завершится, здесь можно будет задать вопрос по материалам сайта.</p>
    <details><summary>Данные для поддержки</summary><p>Задача {view.index_job_id}</p></details>
  </section>;
}

// A numeric target identifies the particular unknown reply that offered contact setup.
export type ClaimTarget = number | 'save' | 'share';
export interface ClaimFeedback { target: ClaimTarget; message: string; action?: { href: string; label: string } }

function ClaimControl({ label, busy, onClick, error, secondary }: {
  label: string; busy: boolean; onClick: () => void; error?: ClaimFeedback | null; secondary?: boolean;
}) {
  const id = useId();
  const control = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error && control.current?.contains(document.activeElement)) control.current.scrollIntoView({ block: 'nearest' });
  }, [error]);
  return <div className="claim-control" ref={control}>
    <button type="button" className={secondary ? 'secondary' : undefined} aria-disabled={busy}
      aria-describedby={error ? id : undefined} onClick={() => { if (!busy) onClick(); }}>{label}</button>
    {error && <p id={id} role="alert" className="chat-error">{error.message}
      {error.action && <> <a href={error.action.href}>{error.action.label}</a></>}</p>}
  </div>;
}

export interface PreviewChatProps {
  site: PreviewSiteView; messages: ChatMessage[]; questionsLeft: number | null; draft: string; busy: boolean; error: string;
  signedIn: boolean; saving: boolean; claimError?: ClaimFeedback | null;
  // Число прочитанных страниц, если предпросмотр усечён бюджетом (A-N6-052); null — не усечён.
  truncatedPages?: number | null;
  // Чем усечён (crawl-coverage): crawl_limit показывается своим текстом; прочее — бюджет предпросмотра.
  truncatedBy?: string | null;
  onDraft: (value: string) => void; onAsk: (question: string) => void; onSave: (target: ClaimTarget) => void; onShare?: () => void;
}
export function PreviewChat(p: PreviewChatProps) {
  const host = p.site.host || 'ваш сайт';
  return <section className="preview-screen" aria-labelledby="preview-title">
    <div className="preview-head">
      <h1 id="preview-title" className="page-title">Спросите бота, как спросил бы клиент</h1>
      <p className="muted">Так бот будет выглядеть на {host}. Ответы — только по прочитанным страницам.</p>
      {typeof p.truncatedPages === 'number' && <p role="status" className="notice truncation-notice">{truncationNotice(p.truncatedPages, p.truncatedBy)}</p>}
    </div>
    <div className="preview-grid">
      <div className="chat-window" role="group" aria-label={`Бот сайта ${host}`}>
        <p className="chat-title"><strong>Бот {host}</strong></p>
        <OwnerAnswerSource messages={p.messages} onMissingContact={index => <div className="stack">
          <p>Укажите в кабинете, как клиенту связаться с компанией.</p>
          {p.signedIn ? <ClaimControl label="Сохранить черновик для настройки контакта" busy={p.saving}
            onClick={() => p.onSave(index)} error={p.claimError?.target === index ? p.claimError : null} />
            : <a className="source-alternative" href="/login?mode=register&from=preview">Войти и настроить контакт</a>}
        </div>} />
        {p.messages.length === 0 && p.site.suggestions.length > 0 && <div className="suggestions" role="group" aria-label="Подсказки">
          {p.site.suggestions.map((s) => <button key={s} type="button" className="secondary" disabled={p.busy} onClick={() => p.onAsk(s)}>{s}</button>)}
        </div>}
        <form className="chat-form" onSubmit={(event) => { event.preventDefault(); p.onAsk(p.draft); }}>
          <label htmlFor="preview-question" className="visually-hidden">Ваш вопрос</label>
          <input id="preview-question" name="question" type="text" autoComplete="off" maxLength={500} placeholder="Например: сколько стоит доставка?"
            value={p.draft} onChange={(event) => p.onDraft(event.target.value)} disabled={p.busy} />
          <button type="submit" disabled={p.busy}>{p.busy ? 'Ищем ответ…' : 'Спросить'}</button>
        </form>
        {p.error && <p role="alert" className="chat-error">{p.error}</p>}
        <p className="chat-foot muted">
          {p.questionsLeft !== null && <span>Осталось вопросов сегодня: {p.questionsLeft}. </span>}
          <a className="powered" href="/">Работает на Суфлёре</a>
        </p>
      </div>
      {/* Макет страницы — заголовок и первый H1 сайта (ADR-007: не скриншот). */}
      <div className="site-mock" aria-label={`Макет страницы ${host}`} role="img">
        <p className="mock-bar"><span aria-hidden="true">●●●</span> {host}</p>
        <p className="mock-title">{p.site.title || host}</p>
        {p.site.h1 && <p className="mock-h1">{p.site.h1}</p>}
        <p className="mock-lines" aria-hidden="true"><span /><span /><span /></p>
      </div>
    </div>
    <OwnerChecks />
    {p.messages.some(m => m.kind === 'answered' && m.firstAnswer) && <section className="aha stack" aria-label="Бот готов">
      <p>Бот ответил по материалам сайта и показал источник.</p>
      <div className="cluster">{p.signedIn
        ? <ClaimControl label={p.saving ? 'Сохраняем…' : 'Сохранить бота и поставить на сайт'} busy={p.saving}
          onClick={() => p.onSave('save')} error={p.claimError?.target === 'save' ? p.claimError : null} />
        : <a className="button" href="/login?mode=register&from=preview">Сохранить бота и поставить на сайт</a>}
        {p.onShare && <ClaimControl label="Поделиться ссылкой на бота" secondary busy={p.saving}
          onClick={p.onShare} error={p.claimError?.target === 'share' ? p.claimError : null} />}
      </div><p className="muted">Публичную страницу можно включить отдельно в кабинете.</p>
    </section>}
  </section>;
}
