// /upgrade/return?intent=<id> — адрес возврата, который получает ЮKassa (return_url, createPayment). Состояние читается
// по идентификатору намерения; вход обязателен (чужое намерение — «не найдено»).
import { redirect } from 'next/navigation';
import { SiteHeader } from '../../SiteHeader';
import { requestTheme } from '../../theme-server';
import { currentAccountId } from '../../../server/cabinet-session';
import { getRuntime } from '../../../server/runtime';
import { ReturnScreen } from './ReturnScreen';
export const dynamic = 'force-dynamic';
const INTENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function UpgradeReturnPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const intent = (await searchParams).intent;
  const accountId = await currentAccountId();
  if (!accountId) redirect('/login');
  const { support, pool } = getRuntime();
  const supportAvailable = !!support.contactEmail || (support.mode === 'libredesk' &&
    !!(await pool.query("SELECT 1 FROM account WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [accountId])).rowCount);
  return <><SiteHeader theme={await requestTheme()} />
    <main className="center container"><ReturnScreen supportAvailable={supportAvailable} intentId={typeof intent === 'string' && INTENT_ID.test(intent) ? intent : 'unknown'} /></main></>;
}
