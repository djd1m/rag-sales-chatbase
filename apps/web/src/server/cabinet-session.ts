// Обе проекции используют только проверенную сессионную cookie текущего запроса.
import { cookies } from 'next/headers';
import { COOKIE_NAME } from './auth-handler';
import { previewClaimContext } from './preview-claim-context';
import { getRuntime } from './runtime';

export async function currentCabinetSession(): Promise<{ accountId: string; context: string } | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const { auth, config } = getRuntime();
  const account = await auth.authenticate(token);
  return account ? { accountId: account.account_id, context: previewClaimContext(config.sessionSecret, token) } : null;
}
export async function currentAccountId(): Promise<string | null> {
  return (await currentCabinetSession())?.accountId ?? null;
}
