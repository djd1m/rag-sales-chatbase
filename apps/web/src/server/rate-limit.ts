// из N5: projects/05-podcast-clips-opus/apps/web/src/server/rate-limit.ts — префикс ключа n6, IPv6 /48 через ip.ts
import { createHmac, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { ipPrefix } from './ip';

export const RATE_LIMIT_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
return used
`;
export async function allowMutation(redis: Redis, ip: string, secret: string, account?: string): Promise<boolean> {
  return allowRequest(redis, ip, secret, account, 'mutation', 30);
}
export async function allowRead(redis: Redis, ip: string, secret: string, account?: string): Promise<boolean> {
  return allowRequest(redis, ip, secret, account, 'read', 120);
}
async function allowRequest(redis: Redis, ip: string, secret: string, account: string | undefined, kind: string, limit: number): Promise<boolean> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  // В Redis только HMAC префикса IPv4 /24 или IPv6 /48 с TTL, полный IP не сохраняется даже на минуту.
  const identity = account ? `account:${account}` : `anonymous:${ipPrefix(ip)}`;
  const key = `n6:${kind}:rate:` + createHmac('sha256', secret).update(identity).digest('hex');
  return Number(await redis.eval(RATE_LIMIT_SCRIPT, 1, key)) <= limit;
}

// Check all dimensions atomically. Redis time gives a sliding hour across web processes.
const issueLimit = `
local tick = redis.call('TIME')
local now = tonumber(tick[1]) * 1000 + math.floor(tonumber(tick[2]) / 1000)
for i,key in ipairs(KEYS) do
  local ttl = tonumber(ARGV[2*i])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now-ttl)
  if redis.call('ZCARD', key) >= tonumber(ARGV[2*i+1]) then return 0 end
end
for i,key in ipairs(KEYS) do
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('PEXPIRE', key, ARGV[2*i])
end
return 1`;

export async function allowCustomerEmailIssue(redis: Redis, secret: string,
  dimensions: {scope: 'ip'|'recipient'|'session'|'cooldown'; identity: string}[]): Promise<boolean> {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  const keys = dimensions.map(({scope,identity}) => 'n6:mail:' + scope + ':' +
    createHmac('sha256',secret).update(scope + '\0' + identity).digest('hex'));
  const limits = dimensions.flatMap(({scope}) => scope === 'cooldown' ? [60000,1] : [3600000,scope === 'ip' ? 30 : 5]);
  return Number(await redis.eval(issueLimit,keys.length,...keys,randomUUID(),...limits)) === 1;
}
