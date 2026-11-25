import { CustomerRecoveryForm } from '../verify-email/CustomerRecoveryForm';
import { SiteHeader } from '../SiteHeader';
import { requestTheme } from '../theme-server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Новый пароль — Суфлёр', referrer: 'no-referrer' as const, robots: { index: false, follow: false } };
export default async function Page() {
  return <><SiteHeader theme={await requestTheme()} /><main className="center container"><CustomerRecoveryForm mode="reset" /></main></>;
}
