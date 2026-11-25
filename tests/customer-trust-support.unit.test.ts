import { createCustomerSupportSdkHandler } from '../apps/web/src/server/customer-support-sdk-proxy';
import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadCustomerSupportSettings } from '../apps/web/src/server/customer-support-settings';
import { createCustomerSupportAuthorityHandler, createCustomerSupportSessionHandler } from '../apps/web/src/server/customer-support-session';

const origin = 'https://sufler.invalid', inbox = '65403484-383b-4407-9c26-8bf943aff908', secret = 'a'.repeat(40);
const env = { N6_SUPPORT_MODE: 'libredesk', N6_SUPPORT_BASE_URL: 'https://support.clipmkr.ru', N6_SUPPORT_INBOX_ID: inbox, N6_SUPPORT_JWT_SECRET: secret };
const owner = { account_id: '836a9458-b2a8-490e-9dc8-f7261e53554d', email: 'customer@example.invalid', verified: true };
const req = (payload: unknown = {}, source = origin, token = 'a'.repeat(43)) => new Request(origin + '/api/support/session', {
  method: 'POST',
  headers: { origin: source, cookie: '__Host-n6_session=' + token, 'x-forwarded-for': '198.51.100.1', 'content-type': 'application/json' }, body: JSON.stringify(payload)
});
describe('support', () => {
  it('support JWT requires a verified current account and its dedicated inbox configuration', async () => {
    const settings = loadCustomerSupportSettings(env);
    const deps = { settings, publicOrigin: origin, viewer: async () => owner, allow: async () => true };
    const sign = createCustomerSupportSessionHandler(deps), authority = createCustomerSupportAuthorityHandler(deps);
    const res = await sign(req({ account_id: owner.account_id }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { data } = await res.json();
    expect(data).toMatchObject({ inboxID: inbox, baseURL: env.N6_SUPPORT_BASE_URL });
    const [header, claims, sig] = data.jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(sig).toBe(createHmac('sha256', secret).update(header + '.' + claims).digest('base64url'));
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect(payload).toEqual({ external_user_id: 'sufler:' + owner.account_id, email: owner.email, first_name: 'Клиент', exp: expect.any(Number) });
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(59);
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
    const probe = (await (await authority(req())).json()).data;
    expect(probe).toEqual({ authority: data.authority });
    expect((await (await authority(req({}, origin, 'b'.repeat(43)))).json()).data.authority).not.toBe(probe.authority);
    for (const [request, override, status] of [
      [req({}, 'https://other.invalid'), {}, 403], [req({ account_id: inbox }), {}, 403], [req({ email: owner.email }), {}, 400],
      [req({ value: 'a'.repeat(4096) }), {}, 413], [req(), { viewer: async () => null }, 401], [req(), { allow: async () => false }, 429],
      [req(), { viewer: async () => ({ ...owner, verified: false }) }, 403], [req(), { settings: loadCustomerSupportSettings({}) }, 503],
    ] as const) {
      const refused = await createCustomerSupportSessionHandler({ ...deps, ...override })(request);
      expect(refused.status).toBe(status); expect(await refused.text()).not.toContain('jwt');
    }
    for (const bad of [{ N6_SUPPORT_MODE: '' }, { N6_SUPPORT_JWT_SECRET: 'x' }, { N6_SUPPORT_JWT_SECRET: 'x'.repeat(32) + '\n' }])
      expect(() => loadCustomerSupportSettings({ ...env, ...bad })).toThrow();
    for (const base of [env.N6_SUPPORT_BASE_URL + '/path', env.N6_SUPPORT_BASE_URL + '?q', env.N6_SUPPORT_BASE_URL + '#a', 'https://evil.invalid', 'https://a@support.clipmkr.ru']) {
      expect(() => loadCustomerSupportSettings({ ...env, N6_SUPPORT_BASE_URL: base })).toThrow();
    }
  });
});

it('support SDK proxy serves only the audited bytes without forwarding account credentials', async () => {
  const source='window.syntheticSDK=true;';
  const integrity='sha384-'+createHash('sha384').update(source).digest('base64');
  const request=new Request(origin+'/api/support/sdk?v='+encodeURIComponent(integrity),{headers:{cookie:'synthetic-session',authorization:'synthetic-only'}});
  const seen: RequestInit[]=[];
  let calls=0;
  const handler=createCustomerSupportSdkHandler(true,{integrity,fetchImpl:async(url,init)=>{
    expect(String(url)).toBe('https://support.clipmkr.ru/widget.js'); seen.push(init!); calls++;
    return new Response(source);
  }});
  for(let i=0;i<2;i++) {const r=await handler(request);expect(r.status).toBe(200);expect(await r.text()).toBe(source);}
  expect(calls).toBe(1);
  expect(seen[0]).toMatchObject({credentials:'omit',redirect:'error',cache:'no-store'});
  const headerNames: string[] = [];
  new Headers(seen[0]!.headers).forEach((_value,name)=>headerNames.push(name));
  expect(headerNames).toEqual(['accept']);
  const changed=createCustomerSupportSdkHandler(true,{integrity,fetchImpl:async()=>new Response(source+';window.changed=true')});
  const refused=await changed(request);expect(refused.status).toBe(503);expect(await refused.text()).toBe('');
  let canceled=false;
  const bad=createCustomerSupportSdkHandler(true,{integrity,fetchImpl:async(_url,init)=>{
    init!.signal!.addEventListener('abort',()=>{canceled=true;});
    return new Response(new ReadableStream(),{status:503});
  }});
  expect((await bad(request)).status).toBe(503);expect(canceled).toBe(true);
  const off=createCustomerSupportSdkHandler(false,{fetchImpl:async()=>{throw Error('must not call');}});
  expect((await off(request)).status).toBe(503);
});
