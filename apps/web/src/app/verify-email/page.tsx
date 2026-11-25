import { cookies } from 'next/headers';
import { CustomerEmailProofStore } from '@n6/db';
import { SiteHeader } from '../SiteHeader';
import { requestTheme } from '../theme-server';
import { getRuntime } from '../../server/runtime';
import { COOKIE_NAME } from '../../server/auth-handler';
import { safeNextPath } from '../../lib/payment-return';
import { CustomerRecoveryForm } from './CustomerRecoveryForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Подтверждение почты — Суфлёр', referrer: 'no-referrer' as const, robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const runtime = getRuntime();
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const viewer = token && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? await new CustomerEmailProofStore(runtime.pool).viewer(runtime.auth.tokenHash(token)) : null;
  const next = safeNextPath((await searchParams).next);
  return <><SiteHeader theme={await requestTheme()} /><main className="center container">
    <CustomerRecoveryForm mode="verify-email" authenticated={!!viewer} verified={viewer?.verified} mailEnabled={runtime.mail.settings.mode === 'resend'} next={next} />
  </main></>;
}
