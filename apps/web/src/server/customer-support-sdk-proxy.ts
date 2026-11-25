import { createHash } from 'node:crypto';
import { CUSTOMER_SUPPORT_SDK_INTEGRITY } from '../lib/customer-support-sdk-integrity';

// A single public asset; caller headers, cookies and credentials never cross
// this boundary. The SDK becomes trusted only after exact-byte verification.
export function createCustomerSupportSdkHandler(enabled: boolean, options: {
  fetchImpl?: typeof fetch; integrity?: string;
} = {}) {
  const integrity = options.integrity ?? CUSTOMER_SUPPORT_SDK_INTEGRITY;
  let cached: Uint8Array | null = null;
  let pending: Promise<Uint8Array> | null = null;
  async function load() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await (options.fetchImpl ?? fetch)('https://support.clipmkr.ru/widget.js', {
        credentials: 'omit', redirect: 'error', cache: 'no-store', headers: { accept: 'application/javascript' }, signal: controller.signal,
      });
      if (!response.ok || response.redirected || !response.body) throw new Error('SDK unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 64 * 1024) throw new Error('SDK exceeds limit');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = Buffer.concat(chunks);
      const actual = 'sha384-' + createHash('sha384').update(bytes).digest('base64');
      if (actual !== integrity) throw new Error('SDK integrity mismatch');
      cached = bytes;
      return bytes;
    } finally { clearTimeout(timeout); controller.abort(); }
  }
  return async (request: Request) => {
    if (!enabled || new URL(request.url).searchParams.get('v') !== integrity)
      return new Response(null, { status: enabled ? 404 : 503, headers: { 'Cache-Control': 'no-store' } });
    try {
      if (!cached) {
        pending ??= load().finally(() => { pending = null; });
        await pending;
      }
      return new Response(Buffer.from(cached!), { headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer',
        Link: '<https://github.com/abhinavxd/libredesk/blob/f8af161763005454c39d0f6eef8d15bfc2648848/static/widget.js>; rel="source", <https://github.com/abhinavxd/libredesk/blob/f8af161763005454c39d0f6eef8d15bfc2648848/LICENSE>; rel="license"',
      } });
    } catch { return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
  };
}
