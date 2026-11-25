import { readTrustDocument, listTrustDocumentLinks, type TrustDocumentKind } from '../../lib/trust-legal-catalog';
import styles from './trust-legal-document.module.css';

export function TrustLegalDocument({ kind }: { kind: TrustDocumentKind }) {
  const document = readTrustDocument(kind);
  return <main className={styles.document}>
    <article>
      <h1>{document.title}</h1>
      <p className={styles.edition}>Редакция {document.version} · Действует с <time dateTime={document.effectiveAt}>
        {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(document.effectiveAt))}</time></p>
      {document.sections.map(section => <section key={section.heading}>
        <h2>{section.heading}</h2>
        {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
      </section>)}
    </article>
    <nav aria-label="Документы и обращения">
      <a href="/support">Поддержка</a>
      {listTrustDocumentLinks().filter(d => d.kind !== kind).map(d => <a key={d.kind} href={d.path}>{d.title}</a>)}
    </nav>
  </main>;
}
