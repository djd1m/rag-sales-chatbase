import { SiteHeader } from '../SiteHeader';
import { requestTheme } from '../theme-server';
import { cookies } from 'next/headers';
import { CustomerEmailProofStore } from '@n6/db';
import { COOKIE_NAME } from '../../server/auth-handler';
import { getRuntime } from '../../server/runtime';
import { CustomerSupportPanel } from './CustomerSupportPanel';
export const dynamic = 'force-dynamic';
export default async function SupportPage({ searchParams }: { searchParams: Promise<{ widget?: string }> }) {
  if ((await searchParams).widget === '1') return null;
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const { auth, pool, support } = getRuntime();
  const viewer = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? await new CustomerEmailProofStore(pool).viewer(auth.tokenHash(token)) : null;
  return <><SiteHeader theme={await requestTheme()} /><main className="container center"><article className="card stack">
    <h1>Поддержка Суфлёра</h1>
    <h2>Доступ к аккаунту</h2>
    {!viewer && <p><a href="/login">Войти в аккаунт</a></p>}
    <p><a href="/forgot">Восстановить пароль</a></p>
    {viewer && (viewer.verified ? <p>Почта подтверждена.</p> : <p><a href="/verify-email">Подтвердить почту</a> для оплаты и чата.</p>)}
    {support.mode === 'libredesk' && viewer && viewer.verified ? <CustomerSupportPanel accountId={viewer.account_id} /> :
      <p role="status">{support.mode === 'disabled' ? 'Чат поддержки пока не подключён.' : 'Чат доступен после входа и подтверждения почты.'}</p>}
    {support.contactEmail && <p>Почта поддержки — <a href={'mailto:' + support.contactEmail}>{support.contactEmail}</a></p>}
    {support.privacyEmail && <p>По вопросам персональных данных — <a href={'mailto:' + support.privacyEmail}>{support.privacyEmail}</a></p>}
    <p><a href="/legal/privacy">Обработка данных и адрес для обращений</a></p>
  </article></main></>;
}
