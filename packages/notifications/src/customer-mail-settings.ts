export type CustomerMailSettings = { mode: 'disabled' } | { mode: 'resend'; from: string; apiKey: string };

export function readCustomerMailSettings(env: {
  N6_MAIL_MODE?: string; N6_MAIL_FROM?: string; N6_RESEND_API_KEY?: string;
}): CustomerMailSettings {
  const mode = env.N6_MAIL_MODE ?? 'disabled';
  if (mode === 'disabled') return { mode };
  const from = env.N6_MAIL_FROM?.trim();
  const apiKey = env.N6_RESEND_API_KEY?.trim();
  if (mode !== 'resend' || !apiKey || /\s/.test(apiKey) || !from ||
    !/^(?:[^<>\r\n]+ <[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+>|[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+)$/.test(from)) {
    throw new Error('Неполная или неверная конфигурация отправки почты');
  }
  return { mode, from, apiKey };
}
