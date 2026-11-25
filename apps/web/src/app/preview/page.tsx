import { SiteHeader } from '../SiteHeader';
import { requestTheme } from '../theme-server';
import { currentAccountId } from '../../server/cabinet-session';
import { parsePreviewIntent } from '../../lib/preview-intent';
import { PreviewStart } from './PreviewStart';
export const dynamic = 'force-dynamic';
export default async function PreviewStartPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const intent = parsePreviewIntent(await searchParams);
  const signedIn = intent.mode === 'pdf' && !!await currentAccountId();
  return <><SiteHeader theme={await requestTheme()} /><main className="center container">
    <PreviewStart key={JSON.stringify(intent)} intent={intent} signedIn={signedIn} />
  </main></>;
}
