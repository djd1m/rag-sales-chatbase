import { TrustLegalDocument } from '../TrustLegalDocument';
import { SiteHeader } from '../../SiteHeader';
import { requestTheme } from '../../theme-server';
import { readTrustDocument } from '../../../lib/trust-legal-catalog';

export const metadata = { title: readTrustDocument('privacy').title + ' — Суфлёр' };
export default async function Page() {
  return <><SiteHeader theme={await requestTheme()} /><TrustLegalDocument kind="privacy" /></>;
}
