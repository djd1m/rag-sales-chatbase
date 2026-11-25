type Contacts = { contactEmail: string | null; privacyEmail: string | null };
export type CustomerSupportSettings = Contacts & ({ mode: 'disabled' } | { mode: 'libredesk'; baseURL: string; inboxID: string; jwtSecret: string });

export function loadCustomerSupportSettings(env: {
  N6_SUPPORT_MODE?: string; N6_SUPPORT_BASE_URL?: string; N6_SUPPORT_INBOX_ID?: string; N6_SUPPORT_JWT_SECRET?: string;
  N6_SUPPORT_CONTACT_EMAIL?: string; N6_PRIVACY_CONTACT_EMAIL?: string;
}): CustomerSupportSettings {
  const contact = (value?: string) => {
    if (!value) return null;
    if (value.length > 254 || !/^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d.-]+\.[a-z]{2,}$/i.test(value)) throw Error('Некорректная почта контакта');
    return value;
  };
  const contacts = { contactEmail: contact(env.N6_SUPPORT_CONTACT_EMAIL), privacyEmail: contact(env.N6_PRIVACY_CONTACT_EMAIL) };
  if (env.N6_SUPPORT_MODE === undefined || env.N6_SUPPORT_MODE === 'disabled') return { mode: 'disabled', ...contacts };
  const baseURL = env.N6_SUPPORT_BASE_URL, inboxID = env.N6_SUPPORT_INBOX_ID, jwtSecret = env.N6_SUPPORT_JWT_SECRET;
  if (env.N6_SUPPORT_MODE !== 'libredesk' || baseURL !== 'https://support.clipmkr.ru' ||
    !inboxID || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(inboxID) ||
    !jwtSecret || /\s/.test(jwtSecret) || Buffer.byteLength(jwtSecret, 'utf8') < 32) throw Error('Неверные настройки выделенного inbox Суфлёра');
  return { mode: 'libredesk', baseURL, inboxID, jwtSecret, ...contacts };
}
