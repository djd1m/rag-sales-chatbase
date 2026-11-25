'use client';
import { useId, useState, type ReactNode } from 'react';

import type { OwnerMessage } from './dashboard/CabinetViews';

function citationLink(raw: string | null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function OwnerAnswerSource({ messages, contact, onMissingContact }: {
  messages: OwnerMessage[]; contact?: string; onMissingContact: ReactNode | ((messageIndex: number) => ReactNode);
}) {
  const id = useId();
  const [selection, select] = useState<{ index: number; latest: number } | null>(null);
  let latest = -1;
  messages.forEach((m, i) => { if (m.kind === 'answered') latest = i; });
  const active = selection?.latest === latest ? selection.index : latest;
  if (!messages.length) return null;
  return <ul className="chat-log" aria-live="polite">{messages.map((m, i) => {
    if (m.kind === 'question') return <li className="chat-question" key={i}>{m.text}</li>;
    if (m.kind === 'answered') {
      const href = citationLink(m.source.url);
      return <li className="chat-answer-group" key={i}>
        <div className="chat-answer">{m.text}
          <button type="button" className="source-select text-button" aria-pressed={i === active}
            aria-controls={id} onClick={() => select({ index: i, latest })}>Источник · {m.source.title}</button>
        </div>
        {i === active && <details open className="source-quote" id={id}>
          <summary>Источник: <strong>{m.source.title}</strong></summary>
          <blockquote>{m.source.excerpt}</blockquote>
          {href && <a href={href} target="_blank" rel="noopener nofollow noreferrer">Открыть страницу ↗</a>}
        </details>}
      </li>;
    }
    if (m.kind === 'refused') return <li className="chat-answer chat-refused" key={i}><span role="alert">{m.text}</span></li>;
    if (m.kind === 'unknown') {
      const realContact = m.contact?.trim() || contact?.trim();
      return <li className="chat-answer" key={i}>{m.text}
        {realContact ? !m.text.includes(realContact) && <p>Связь с компанией: {realContact}</p>
          : typeof onMissingContact === 'function' ? onMissingContact(i) : onMissingContact}
      </li>;
    }
    return <li className="chat-answer" key={i}>{m.text}</li>;
  })}</ul>;
}

const cases = ['Обычный вопрос', 'Нет сведений', 'Связь с компанией'] as const;
export function OwnerChecks() {
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  return <fieldset className="owner-checks"><legend>Проверка ответов</legend>
    {cases.map(name => <label key={name}><input type="checkbox" checked={checked.has(name)} onChange={event => {
      const enabled = event.currentTarget.checked;
      setChecked(previous => {
        const next = new Set(previous);
        if (enabled) next.add(name); else next.delete(name);
        return next;
      });
    }} />{name}</label>)}
    <p className="muted" role="status">Отмечено на этом экране: {checked.size} из 3</p>
  </fieldset>;
}
