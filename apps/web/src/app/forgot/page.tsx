import { CustomerRecoveryForm } from '../verify-email/CustomerRecoveryForm';
import { SiteHeader } from '../SiteHeader';
import { requestTheme } from '../theme-server';
import { getRuntime } from '../../server/runtime';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Восстановление доступа — Суфлёр' };
export default async function Page() {
  return <><SiteHeader theme={await requestTheme()} /><main className="center container">
    <CustomerRecoveryForm mode="forgot" mailEnabled={getRuntime().mail.settings.mode === 'resend'} />
  </main></>;
}
