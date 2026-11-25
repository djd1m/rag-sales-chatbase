import { CUSTOMER_SUPPORT_SDK_INTEGRITY } from './customer-support-sdk-integrity';
// Keep each SDK lifetime in a separate browsing context. Removing it also cancels
// pending initialization, timers and late messages belonging to a previous user.
interface Session { authority: string; baseURL: string; inboxID: string; jwt: string; exp: number }
interface Sdk {
  setUser(jwt: string): void; show(): void; hide(): void; logout(): void; destroy(): void;
}
type Host = Window & { LibredeskSettings?: { baseURL: string; inboxID: string; userJWT: string; hideLauncher: boolean }; Libredesk?: Sdk };

export function openCustomerSupportWidget(container: HTMLElement, accountId: string,
  changed: (state: 'loading' | 'open' | 'closed' | 'unavailable') => void, restoreFocus: () => void) {
  let frame: HTMLIFrameElement | null = null, sdk: Sdk | undefined, key = '', generation = 0, checks = 0;
  let wanted = false, loading = false, disposed = false, timeout: ReturnType<typeof setTimeout> | undefined;
  function discard() {
    generation++; checks++; clearTimeout(timeout);
    if (frame) frame.hidden = true;
    try { sdk?.logout(); } catch { /* detached SDK */ }
    try { sdk?.destroy(); } catch { /* a partial initialization is removed with the frame */ }
    frame?.remove(); frame = null; sdk = undefined; wanted = false; loading = false; key = '';
  }
  function unavailable() { discard(); if (!disposed) changed('unavailable'); }
  async function authority() {
    const response = await fetch('/api/support/authority', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw Error('authority unavailable');
    const data = (await response.json()).data;
    if (typeof data?.authority !== 'string' || !data.authority) throw Error('missing authority');
    return data.authority as string;
  }
  let latestCheck: Promise<boolean> = Promise.resolve(false);
  function check(reveal: boolean): Promise<boolean> {
    const turn = generation, seq = ++checks;
    if (reveal && frame) frame.hidden = true;
    latestCheck = (async () => {
      try {
        const current = await authority();
        if (turn !== generation || disposed) return false;
        if (seq !== checks) return latestCheck;
        if (current !== key) throw Error('session changed');
        if (reveal && frame && wanted && !loading && !document.hidden) frame.hidden = false;
        return true;
      } catch { if (turn === generation && seq === checks) unavailable(); return false; }
    })();
    return latestCheck;
  }
  function close() {
    if (loading) discard();
    else {
      wanted = false;
      if (frame) frame.hidden = true;
      sdk?.hide();
    }
    changed('closed'); restoreFocus();
  }
  async function open() {
    if (disposed || loading || wanted) return;
    wanted = true;
    changed('loading');
    if (sdk && frame) {
      if (await check(false) && wanted && !document.hidden) { sdk.show(); frame.hidden = false; changed('open'); }
      return;
    }
    loading = true;
    const turn = ++generation;
    timeout = setTimeout(() => { if (turn === generation) unavailable(); }, 8000);
    try {
      const res = await fetch('/api/support/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
        signal: AbortSignal.timeout(2000), body: JSON.stringify({ account_id: accountId })
      });
      if (!res.ok) throw Error('support unavailable');
      const s: Session = (await res.json()).data;
      if (turn !== generation || disposed) return;
      if (!s?.jwt || !s.authority || !s.inboxID || !s.baseURL || s.exp * 1000 <= Date.now()) throw Error('invalid session');
      key = s.authority;
      if (!await check(false) || !wanted || document.hidden) return;
      const host = document.createElement('iframe');
      host.title = 'Чат поддержки Суфлёра'; host.hidden = true; host.referrerPolicy = 'no-referrer';
      // Same-origin host supplies the actual parent_origin required by Libredesk.
      host.src = '/support?widget=1';
      frame = host;
      host.onload = () => {
        if (turn !== generation || !wanted) return;
        try {
          const w = host.contentWindow as Host;
          const doc = w.document;
          // Vendor session/visitor cookies belong to this SDK instance. Never import
          // a previous visitor token from the domain or persist an exchanged identity.
          const cookies = new Map<string, string>();
          Object.defineProperty(doc, 'cookie', {
            get: () => Array.from(cookies, ([k, v]) => k + '=' + v).join('; '),
            set: (raw: string) => {
              const item = raw.split(';')[0]!, i = item.indexOf('=');
              if (i >= 0) {
                if (/;\s*max-age=0(?:;|$)/i.test(raw)) cookies.delete(item.slice(0, i));
                else cookies.set(item.slice(0, i), item.slice(i + 1));
              }
            },
          });
          for (const element of Array.from(doc.body.children)) {
            if ('hidden' in element) (element as HTMLElement).hidden = true;
          }
          w.LibredeskSettings = { baseURL: s.baseURL, inboxID: s.inboxID, userJWT: s.jwt, hideLauncher: true };
          let exchanging = false, identified = false;
          const receive = (event: MessageEvent) => {
            const embedded = doc.getElementById('libredesk-widget-' + s.inboxID) as HTMLIFrameElement | null;
            if (!embedded || event.source !== embedded.contentWindow || event.origin !== s.baseURL || turn !== generation) {
              event.stopImmediatePropagation(); return;
            }
            if (event.data?.type === 'VUE_APP_READY') {
              // SDK init otherwise starts page telemetry and may reuse a visitor.
              // Recheck immediately before allowing the identified history exchange.
              event.stopImmediatePropagation();
              if (exchanging || !loading) { unavailable(); return; }
              exchanging = true;
              void (async () => {
                if (!await check(false) || turn !== generation || !wanted || document.hidden) return;
                if (!w.Libredesk || s.exp * 1000 <= Date.now()) { unavailable(); return; }
                w.Libredesk.setUser(s.jwt);
                s.jwt = ''; w.LibredeskSettings!.userJWT = '';
              })().catch(() => { if (turn === generation) unavailable(); });
              return;
            }
            if (['REQUEST_PAGE_INFO', 'SHOW_CAMPAIGN', 'SET_PREVIEW_MODE'].includes(event.data?.type)) { event.stopImmediatePropagation(); return; }
            if (event.data?.type === 'STORE_SESSION' && exchanging) identified = typeof event.data.token === 'string' && !!event.data.token;
            if (event.data?.type === 'CLEAR_SESSION_TOKEN') { event.stopImmediatePropagation(); unavailable(); return; }
            if (event.data?.type === 'CLOSE_WIDGET') { wanted = false; host.hidden = true; changed('closed'); restoreFocus(); }
            if (event.data?.type !== 'WIDGET_LOADED') return;
            event.stopImmediatePropagation();
            if (!loading) return;
            if (!identified) { unavailable(); return; }
            void (async () => {
              if (!await check(false) || turn !== generation || document.hidden || !wanted) return;
              sdk = w.Libredesk;
              if (!sdk || typeof sdk.show !== 'function' || typeof sdk.logout !== 'function') { unavailable(); return; }
              clearTimeout(timeout); loading = false;
              sdk.show(); host.hidden = false; changed('open');
            })().catch(unavailable);
          };
          w.addEventListener('message', receive, true);
          const script = doc.createElement('script');
          script.src = '/api/support/sdk?v=' + encodeURIComponent(CUSTOMER_SUPPORT_SDK_INTEGRITY);
          script.integrity = CUSTOMER_SUPPORT_SDK_INTEGRITY; script.referrerPolicy = 'no-referrer';
          script.onerror = () => { if (turn === generation) unavailable(); };
          doc.head.appendChild(script);
        } catch { unavailable(); }
      };
      container.appendChild(host);
    } catch { if (turn === generation) unavailable(); }
  }
  function suspend() {
    if (frame || loading) { discard(); changed('closed'); }
  }
  function resume() {
    if (disposed) return;
    if (key) void check(true);
    else if (!document.hidden) void authority().catch(() => { if (!disposed && !key && !loading) changed('unavailable'); });
  }
  const visibility = () => { if (document.hidden) suspend(); else resume(); };
  const signal = () => { suspend(); resume(); };
  const storage = (e: StorageEvent) => { if (e.key === 'n6_auth_epoch' || e.key === null) signal(); };
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('n6-auth') : null;
  if (channel) channel.onmessage = signal;
  window.addEventListener('storage', storage); window.addEventListener('pagehide', suspend);
  window.addEventListener('pageshow', resume); window.addEventListener('focus', resume);
  document.addEventListener('visibilitychange', visibility);
  const poll = setInterval(() => { if (key && !document.hidden && !loading) void check(false); }, 15000);
  return {
    open, close, dispose() {
      disposed = true; discard(); clearInterval(poll); channel?.close();
      window.removeEventListener('storage', storage); window.removeEventListener('pagehide', suspend);
      window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', visibility);
    }
  };
}
