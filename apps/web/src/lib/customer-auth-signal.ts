export function publishCustomerAuthChange() {
  try {
    const channel = new BroadcastChannel('n6-auth');
    channel.postMessage('changed');
    channel.close();
  } catch { /* Storage events remain available in older browsers. */ }
  try { localStorage.setItem('n6_auth_epoch', Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)); } catch { /* Authority polling remains active. */ }
}
