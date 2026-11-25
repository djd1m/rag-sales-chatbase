'use client';
import { useState } from 'react';
import { publishCustomerAuthChange } from '../../lib/customer-auth-signal';
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return <><button type="button" className="secondary" disabled={busy} onClick={async () => {
    setBusy(true); setFailed(false);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('logout failed');
      publishCustomerAuthChange();
      window.location.assign('/');
    } catch { setFailed(true); } finally { setBusy(false); }
  }}>{busy ? 'Выходим…' : 'Выйти'}</button>{failed && <span role="alert">Не удалось выйти. Попробуйте ещё раз.</span>}</>;
}
