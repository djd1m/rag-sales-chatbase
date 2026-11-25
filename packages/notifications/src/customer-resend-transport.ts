import type { CustomerMailMessage } from './customer-mail-templates.js';
import type { CustomerMailSettings } from './customer-mail-settings.js';

export type CustomerMailResult = { status: 'accepted'; providerId: string } | { status: 'unknown' | 'permanent' | 'retryable' };
export interface CustomerMailTransport {
  send(message: CustomerMailMessage, options?: { idempotencyKey?: string; deadlineMs?: number }): Promise<CustomerMailResult>;
}
const capacity = globalThis as typeof globalThis & { n6CustomerMailInFlight?: number };
const MAX_BYTES = 16 * 1024;

async function providerId(response: Response, signal: AbortSignal): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const cancel = () => { void reader.cancel().catch(() => { }); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) { void reader.cancel().catch(() => { }); return null; }
      chunks.push(value);
    }
    if (signal.aborted) return null;
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') return null;
    return /^[A-Za-z0-9_-]{1,128}$/.test(data.id) ? data.id : null;
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function createCustomerMailTransport(settings: CustomerMailSettings, { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {}): CustomerMailTransport {
  return {
    async send(message, options) {
      if (options?.deadlineMs !== undefined && options.deadlineMs <= Date.now()) return { status: 'retryable' };
      if (settings.mode !== 'resend' || (capacity.n6CustomerMailInFlight ?? 0) >= 2) return { status: 'retryable' };
      capacity.n6CustomerMailInFlight = (capacity.n6CustomerMailInFlight ?? 0) + 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(5000, Math.max(0, (options?.deadlineMs ?? Infinity) - Date.now())));
      try {
        if (options?.deadlineMs !== undefined && options.deadlineMs <= Date.now()) return { status: 'retryable' };
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST', redirect: 'error', signal: controller.signal, cache: 'no-store',
          headers: {
            Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json',
            ...(options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {})
          },
          body: JSON.stringify(message),
        });
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== 'https://api.resend.com')) {
          void response.body?.cancel().catch(() => { });
          if (response.status === 429) return { status: 'retryable' };
          if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) return { status: 'permanent' };
          return { status: 'unknown' };
        }
        const id = await providerId(response, controller.signal);
        return id ? { status: 'accepted', providerId: id } : { status: 'unknown' };
      } catch { return { status: 'unknown' }; }
      finally { clearTimeout(timer); controller.abort(); capacity.n6CustomerMailInFlight = (capacity.n6CustomerMailInFlight ?? 1) - 1; }
    }
  };
}
