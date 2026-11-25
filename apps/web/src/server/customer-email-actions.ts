import bcrypt from 'bcrypt';
import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CustomerEmailProofStore } from '@n6/db';
import { renderAccountAccessMessage, type CustomerMailSettings, type CustomerMailTransport } from '@n6/notifications';
import { safeNextPath } from '../lib/payment-return';
import { BCRYPT_COST, type AuthService } from './auth';
import { readSessionCookie } from './auth-handler';
import { clientIp, ipPrefix } from './ip';
import { readJsonBody } from './preview-session';

type Action = 'send' | 'confirm' | 'forgot' | 'reset';
type IssueKey = { scope: 'ip' | 'recipient' | 'session' | 'cooldown'; identity: string };
type Dependencies = {
  auth: Pick<AuthService, 'authenticate' | 'tokenHash'>;
  proofs: Pick<CustomerEmailProofStore, 'viewer' | 'prepare' | 'confirm' | 'activate' | 'canReset' | 'reset'>; publicOrigin: string; secret: string;
  allowMutation(ip: string): Promise<boolean>;
  allowIssue(keys: IssueKey[]): Promise<boolean>;
  mail: { settings: CustomerMailSettings; transport: CustomerMailTransport };
};

const tokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
const confirmSchema = z.object({ token: tokenSchema }).strict();
const resetSchema = confirmSchema.extend({ password: z.unknown().optional() }).strict();
const forgotSchema = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict();
const sendSchema = z.object({ next: z.string().max(256).optional() }).strict();
const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });
const denied = () => fail(401, 'unauthorized', 'Войдите в свой аккаунт на этом устройстве');
const invalid = () => fail(422, 'invalid', 'Проверьте введённые данные');
const invalidLink = () => fail(422, 'invalid_recovery_link', 'Ссылка недействительна или её срок закончился');
const unavailable = () => fail(503, 'mail_unavailable', 'Отправка почты сейчас недоступна');
const limited = () => fail(429, 'limit', 'Слишком много запросов. Попробуйте позже');
const forgotAccepted = () => reply(202, { data: { status: 'requested' } });
const proofHash = (secret: string, purpose: 'verify' | 'reset', token: string) =>
  createHmac('sha256', secret).update('customer-email:' + purpose + '\0' + token).digest('hex');

async function consume(action: 'confirm' | 'reset', body: unknown, session: string | null, deps: Dependencies) {
  if (action === 'confirm') {
    if (!session || !await deps.auth.authenticate(session)) return denied();
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) return invalidLink();
    const digest = proofHash(deps.secret, 'verify', parsed.data.token);
    return await deps.proofs.confirm(digest, deps.auth.tokenHash(session)) ? reply(200, { data: { verified: true } }) : invalidLink();
  }
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) return invalidLink();
  const { password, token } = parsed.data;
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return fail(422, 'invalid_password', 'Введите пароль от 8 символов и не более 72 байт');
  }
  const digest = proofHash(deps.secret, 'reset', token);
  if (!await deps.proofs.canReset(digest)) return invalidLink();
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  return await deps.proofs.reset(digest, hash) ? reply(200, { data: { ok: true } }) : invalidLink();
}

async function issue(action: 'send' | 'forgot', body: unknown, session: string | null, deps: Dependencies) {
  const purpose = action === 'send' ? 'verify' : 'reset';
  let email: string, issuer: string | null = null, next: string | null = null;
  if (action === 'send') {
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) return invalid();
    if (!session) return denied();
    issuer = deps.auth.tokenHash(session);
    const viewer = await deps.proofs.viewer(issuer);
    if (!viewer) return denied();
    if (viewer.verified) return reply(200, { data: { verified: true } });
    email = viewer.email;
    const intent = safeNextPath(parsed.data.next);
    if (intent && !intent.startsWith('/invite/')) next = intent;
  } else {
    const parsed = forgotSchema.safeParse(body);
    if (!parsed.success) return invalid();
    email = parsed.data.email;
  }
  if (deps.mail.settings.mode !== 'resend') return unavailable();
  const keys: IssueKey[] = [{ scope: 'recipient', identity: email }, { scope: 'cooldown', identity: purpose + ':' + email }];
  if (issuer) keys.push({ scope: 'session', identity: issuer });
  if (!await deps.allowIssue(keys)) return action === 'forgot' ? forgotAccepted() : limited();

  const token = randomBytes(32).toString('base64url'), digest = proofHash(deps.secret, purpose, token);
  if (!await deps.proofs.prepare(purpose, email, digest, issuer)) return action === 'forgot' ? forgotAccepted() : denied();
  const link = new URL(action === 'send' ? '/verify-email' : '/reset', deps.publicOrigin);
  if (next) link.searchParams.set('next', next);
  link.hash = new URLSearchParams({ token }).toString();
  const message = renderAccountAccessMessage({ purpose, to: email, from: deps.mail.settings.from, link: link.href });
  const deliver = async () => {
    const result = await deps.mail.transport.send(message);
    if (result.status !== 'accepted') return result.status;
    return await deps.proofs.activate(purpose, digest) ? 'accepted' : 'invalidated';
  };
  if (action === 'forgot') {
    void deliver().then(status => console.info('Восстановление доступа: ' + status))
      .catch(() => console.error('Восстановление доступа: результат отправки неизвестен'));
    return forgotAccepted();
  }
  const result = await deliver();
  if (result === 'accepted') return reply(202, { data: { status: 'accepted' } });
  if (result === 'invalidated') return invalidLink();
  return result === 'unknown' ? fail(503, 'delivery_unknown', 'Не удалось подтвердить отправку. Предыдущая действующая ссылка сохраняется.') : unavailable();
}

export function createCustomerEmailActionHandler(action: Action, deps: Dependencies) {
  return async (request: Request) => {
    try {
      if (request.method !== 'POST') return fail(405, 'method', 'Используйте POST');
      const ip = clientIp(request.headers);
      if (!await deps.allowMutation(ip)) return limited();
      if (request.headers.get('origin') !== new URL(deps.publicOrigin).origin) return fail(403, 'origin_not_allowed', 'Источник запроса не разрешён');
      const issuing = action === 'send' || action === 'forgot';
      if (issuing && !await deps.allowIssue([{ scope: 'ip', identity: ipPrefix(ip) }])) return limited();
      const parsed = await readJsonBody(request, 4096);
      if (!parsed.ok) return parsed.code === 'too_large' ? fail(413, 'too_large', 'Тело запроса слишком велико') : invalid();
      const session = readSessionCookie(request);
      return issuing ? await issue(action, parsed.body, session, deps) : await consume(action, parsed.body, session, deps);
    } catch {
      console.error('Действие с почтой временно недоступно');
      return fail(503, 'unavailable', 'Сервис временно недоступен. Попробуйте позже');
    }
  };
}
