import { CustomerEmailProofStore } from '@n6/db';
import { createHmac } from 'node:crypto';
import { readSessionCookie } from './auth-handler';
import { body } from './cabinet-handler';
import { clientIp } from './ip';
import { allowMutation } from './rate-limit';
import type { CustomerSupportSettings } from './customer-support-settings';

interface Dependencies {
  publicOrigin: string;
  settings: CustomerSupportSettings;
  viewer: (token: string) => ReturnType<CustomerEmailProofStore['viewer']>;
  allow: (ip: string) => Promise<boolean>;
}
async function runtimeDependencies(): Promise<Dependencies> {
  const { getRuntime } = await import('./runtime');
  const { auth, pool, support, redis, config } = getRuntime();
  const accounts = new CustomerEmailProofStore(pool);
  return {
    publicOrigin: config.publicOrigin, settings: support,
    allow: ip => allowMutation(redis, ip, config.sessionSecret),
    viewer: token => accounts.viewer(auth.tokenHash(token)),
  };
}
const json = (payload: object, status = 200) => Response.json(payload, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string) => json({ error: { code } }, status);

function endpoint(sign: boolean, injected?: Dependencies) {
  return async (request: Request) => {
    try {
      const deps = injected ?? await runtimeDependencies();
      let expected: unknown;
      const origin = request.headers.get('origin');
      if (!sign && origin && origin !== new URL(deps.publicOrigin).origin) return fail(403, 'origin_not_allowed');
      if (sign) {
        if (!await deps.allow(clientIp(request.headers))) return fail(429, 'limit');
        if (request.headers.get('origin') !== new URL(deps.publicOrigin).origin) return fail(403, 'origin_not_allowed');
        const payload = await body(request, ['account_id']);
        if (payload instanceof Response) return fail(payload.status, payload.status === 413 ? 'too_large' : 'invalid');
        expected = payload.account_id;
        if (expected !== undefined && typeof expected !== 'string') return fail(400, 'invalid');
      }
      const settings = deps.settings;
      if (settings.mode !== 'libredesk') return fail(503, 'support_unavailable');
      const token = readSessionCookie(request);
      const viewer = token && await deps.viewer(token);
      if (!viewer) return fail(401, 'unauthorized');
      if (!viewer.verified || (expected !== undefined && expected !== viewer.account_id)) return fail(403, 'support_verification_required');
      const authority = createHmac('sha256', settings.jwtSecret).update(['sufler-support-v1', settings.inboxID, token, viewer.account_id, viewer.email].join('\0')).digest('base64url');
      if (!sign) return json({ data: { authority } });
      const exp = Math.floor(Date.now() / 1000) + 60;
      const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const signed = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ external_user_id: 'sufler:' + viewer.account_id, email: viewer.email, first_name: 'Клиент', exp });
      const jwt = signed + '.' + createHmac('sha256', settings.jwtSecret).update(signed).digest('base64url');
      return json({ data: { jwt, exp, authority, baseURL: settings.baseURL, inboxID: settings.inboxID } });
    } catch { return fail(503, 'support_unavailable'); }
  };
}
export function createCustomerSupportSessionHandler(deps?: Dependencies) { return endpoint(true, deps); }
export function createCustomerSupportAuthorityHandler(deps?: Dependencies) { return endpoint(false, deps); }
