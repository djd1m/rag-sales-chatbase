import { PurchaseMailDeliveryStore } from '@n6/db';
import { renderPurchaseConfirmation, type CustomerMailSettings, type CustomerMailTransport, type CustomerMailResult } from '@n6/notifications';

export async function runPurchaseMailTick(store: Pick<PurchaseMailDeliveryStore, 'expire' | 'lease' | 'admit' | 'finish'>, settings: CustomerMailSettings,
  transport: CustomerMailTransport, publicOrigin: string): Promise<void> {
  await store.expire();
  if (settings.mode === 'disabled') return;
  for (let count = 0; count < 5; count++) {
    const lease = await store.lease(true);
    if (!lease) break;
    const dispatch = await store.admit(lease, row => JSON.stringify(renderPurchaseConfirmation({
      from: settings.from, to: row.recipient, plan: row.plan, amountMinor: row.amount_minor, paidUntil: row.paid_until.toISOString(), publicOrigin,
    })));
    if (!dispatch || dispatch.validUntil.getTime() <= Date.now()) continue;
    let result: CustomerMailResult;
    try { result = await transport.send(JSON.parse(dispatch.message), { idempotencyKey: dispatch.key, deadlineMs: dispatch.validUntil.getTime() }); }
    catch { result = { status: 'unknown' }; }
    await store.finish(lease, result);
  }
}
