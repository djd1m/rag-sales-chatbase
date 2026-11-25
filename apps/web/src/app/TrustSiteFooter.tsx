import { listTrustDocumentLinks } from '../lib/trust-legal-catalog';

export function TrustSiteFooter() {
  return <footer aria-label="Документы и поддержка" className="container" style={{ paddingBlock: '24px', borderTop: '1px solid var(--line)', marginTop: '32px' }}>
    <nav aria-label="Документы сервиса" style={{ display: 'flex', flexWrap: 'wrap', columnGap: '24px', rowGap: '4px' }}>
      {listTrustDocumentLinks().map(document => <a key={document.kind} href={document.path}
        style={{ display: 'inline-flex', alignItems: 'center', minHeight: '44px', overflowWrap: 'anywhere' }}>{document.title}</a>)}
      <a href="/support" style={{ display: 'inline-flex', alignItems: 'center', minHeight: '44px' }}>Поддержка</a>
    </nav>
    <p className="muted">Суфлёр · ответы по вашим материалам</p>
  </footer>;
}
