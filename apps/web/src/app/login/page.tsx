import { SiteHeader } from '../SiteHeader';
import { AuthForm } from './AuthForm';
import { requestTheme } from '../theme-server';
import { safeNextPath } from '../../lib/payment-return';
import { readTrustDocument } from '../../lib/trust-legal-catalog';
import { getRuntime } from '../../server/runtime';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ mode?: string; next?: string }> }) {
  const params = await searchParams;
  const terms = readTrustDocument('terms'), consent = readTrustDocument('consent');
  const documents = { terms: { path: terms.path, version: terms.version }, consent: { path: consent.path, version: consent.version } };
  return <><SiteHeader theme={await requestTheme()} /><main className="center container">
    <AuthForm initialMode={params.mode === 'register' ? 'register' : 'login'} next={safeNextPath(params.next)} documents={documents}
      recoveryAvailable={getRuntime().mail.settings.mode === 'resend'} />
  </main></>;
}
