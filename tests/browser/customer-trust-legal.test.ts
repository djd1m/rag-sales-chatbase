import { afterAll, beforeAll, expect, it } from 'vitest';
import { testOrigin } from '../fixtures/sufler-source-journey';
import { chromium, type Browser } from 'playwright';
import { listTrustDocumentLinks, readTrustDocument } from '../../apps/web/src/lib/trust-legal-catalog';
import { startHarness, HOST, WIDGET, KEY_FREE, type Harness } from './widget-harness';

let browser: Browser, harness: Harness;
beforeAll(async () => { harness = await startHarness(); browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); await harness?.close(); });
it('public documents and visitor notice expose the approved Sufler terms and contacts', async () => {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const origin = testOrigin();
  const documents = listTrustDocumentLinks();
  try {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 840 });
      for (const d of documents) {
        expect((await page.goto(origin + d.path))?.status()).toBe(200);
        expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe(d.title);
        const text = await page.locator('main').innerText();
        expect(text).toContain('324632700125469');
        expect(text).toContain('632309450004');
        expect(text).toContain(d.version);
        expect(await page.getByRole('main').getByRole('link', { name: 'Поддержка', exact: true }).getAttribute('href')).toBe('/support');
        if (d.kind === 'offer') for (const term of ['990 ₽', '4 900 ₽', '30 дней', 'без автопродления', 'вручную']) expect(text).toContain(term);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
    }
    await page.goto(HOST + '/host.html?bot=' + KEY_FREE);
    await page.locator('n6-sufler .bubble').click();
    const panel = page.locator('n6-sufler .panel');
    await expect.poll(() => panel.innerText()).toContain(readTrustDocument('widget-notice').sections[0]!.paragraphs[0]);
    expect(await panel.locator('a[href$="/legal/privacy"]').getAttribute('href')).toBe(WIDGET + '/legal/privacy');
  } finally { await page.close(); }
});
