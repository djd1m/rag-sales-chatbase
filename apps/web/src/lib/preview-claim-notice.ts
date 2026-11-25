import { previewTabStorage } from './preview-intent';

export const PREVIEW_CLAIM_CONTEXT_HEADER = 'X-Sufler-Claim-Context';
const SLOT = 'n6_preview_claim_notice_v1';
const TTL = 120000;
const outcomes = ['claimed', 'already_claimed', 'expired', 'not_found', 'plan_limit', 'unavailable'] as const;
export type PreviewClaimOutcome = typeof outcomes[number];
function known(value: unknown): value is PreviewClaimOutcome {
  return outcomes.some(outcome => outcome === value);
}
export function storePreviewClaimNotice(outcome: unknown, context: string | null): boolean {
  try {
    const storage = previewTabStorage();
    storage.removeItem(SLOT);
    if (!known(outcome) || !context || !/^[\w-]{43}$/.test(context)) return false;
    storage.setItem(SLOT, JSON.stringify({ outcome, context, expiresAt: Date.now() + TTL }));
    return true;
  } catch { return false; }
}
export function consumePreviewClaimNotice(context: string): PreviewClaimOutcome | null {
  try {
    const storage = previewTabStorage();
    const raw = storage.getItem(SLOT);
    storage.removeItem(SLOT);
    if (!raw || !/^[\w-]{43}$/.test(context)) return null;
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || Object.keys(record).length !== 3) return null;
    const now = Date.now();
    return record?.context === context && Number.isSafeInteger(record.expiresAt) && record.expiresAt > now
      && record.expiresAt <= now + TTL && known(record.outcome) ? record.outcome : null;
  } catch { return null; }
}
