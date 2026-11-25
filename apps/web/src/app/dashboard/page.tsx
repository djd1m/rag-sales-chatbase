import { listBots } from '@n6/db';
import { currentCabinetSession } from '../../server/cabinet-session';
import { getRuntime } from '../../server/runtime';
import { CabinetEmpty } from './CabinetEmpty';
import { BotListScreen } from './BotListScreen';
import { PreviewClaimNotice } from './PreviewClaimNotice';
export const dynamic = 'force-dynamic';

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ source?: string | string[] }> }) {
  const pdf = (await searchParams).source === 'pdf';
  const session = await currentCabinetSession();
  const list = session ? await listBots(getRuntime().pool, session.accountId).catch(() => null) : null;
  return <>
    {session && <PreviewClaimNotice key={session.context} context={session.context} />}
    {!list ? <section className="stack"><h1>Мои боты</h1><p role="alert">Не удалось получить список ботов.</p>
      <a className="button secondary" href={pdf ? '/dashboard?source=pdf' : '/dashboard'}>Повторить загрузку</a></section>
      : list.bots.length ? <BotListScreen list={list} pdf={pdf} /> : <CabinetEmpty pdf={pdf} />}
    <nav aria-label="Аккаунт" className="cluster">
      <a className="button secondary" href="/dashboard/partner">Партнёрская программа</a>
      {list?.plan === 'studio' && <a className="button secondary" href="/dashboard/studio">Кабинет студии</a>}
      <a className="button secondary" href="/dashboard/account">Удалить аккаунт</a>
    </nav>
  </>;
}
