export interface CustomerMailMessage { from: string; to: string; subject: string; text: string; html?: string }

function safeLink(raw: string) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Недопустимая ссылка в письме');
  return url.href;
}

function escape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function htmlMessage(title: string, introduction: string, label: string, href: string, detail: string, footer: string) {
  return `<!doctype html><html lang="ru"><body style="margin:0;background:#eef3f5;color:#18252b;font:16px/1.55 Arial,sans-serif">
<table role="presentation" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" style="width:100%;max-width:520px;background:#fff;border:1px solid #cddbdd;border-radius:12px"><tr><td style="padding:28px">
<p style="margin:0 0 24px;font-weight:bold;color:#19646b">Суфлёр</p>
<h1 style="margin:0 0 16px;font-size:25px;line-height:1.2">${escape(title)}</h1>
<p>${escape(introduction)}</p><p style="margin:24px 0"><a style="display:inline-block;padding:12px 20px;border-radius:6px;background:#78dce1;color:#12373d;font-weight:bold;text-decoration:none" href="${escape(href)}">${escape(label)}</a></p>
<p>${escape(detail)}</p><p style="border-top:1px solid #cddbdd;padding-top:16px;font-size:14px;color:#41535b">${footer}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function renderAccountAccessMessage(input: {
  from: string; to: string; purpose: 'verify' | 'reset'; link: string;
}): CustomerMailMessage {
  const verify = input.purpose === 'verify';
  const link = safeLink(input.link);
  const subject = verify ? 'Подтверждение почты в Суфлёре' : 'Смена пароля Суфлёра';
  const intro = verify ? 'Подтвердите адрес своего аккаунта.' : 'Откройте ссылку и задайте новый пароль.';
  const detail = verify ? 'Ссылка действует 24 часа. На другом устройстве сначала войдите в тот же аккаунт, затем снова откройте это письмо.'
    : 'Ссылка действует один час. После смены пароля потребуется войти заново.';
  const footer = 'Если вы не запрашивали письмо, его можно проигнорировать.';
  return {
    from: input.from, to: input.to, subject, text: [intro, link, detail, footer].join('\n\n'),
    html: htmlMessage(subject, intro, verify ? 'Подтвердить почту' : 'Сменить пароль', link, detail, escape(footer))
  };
}

export function renderPurchaseConfirmation(input: {
  from: string; to: string; plan: 'nobadge' | 'studio'; amountMinor: number; paidUntil: string; publicOrigin: string;
}): CustomerMailMessage {
  const amount = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(input.amountMinor / 100);
  const until = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(new Date(input.paidUntil));
  const plan = input.plan === 'studio' ? 'Студия' : 'Без бейджа';
  const dashboard = safeLink(new URL('/dashboard', input.publicOrigin).href), support = safeLink(new URL('/support', input.publicOrigin).href);
  const intro = `Оплачен доступ «${plan}». Сумма: ${amount}. Доступ действует до ${until} (Москва).`;
  const detail = 'Это уведомление о покупке. Фискальный чек оформляется отдельно.';
  return {
    from: input.from, to: input.to, subject: 'Суфлёр — оплата доступа',
    text: [intro, 'Открыть кабинет: ' + dashboard, detail, 'Поддержка: ' + support].join('\n\n'),
    html: htmlMessage('Доступ оплачен', intro, 'Открыть кабинет', dashboard, detail,
      `Вопрос об оплате? <a href="${escape(support)}">Поддержка Суфлёра</a>`)
  };
}
