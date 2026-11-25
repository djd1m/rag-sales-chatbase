export type PreviewIntent =
  | { mode: 'pdf' }
  | { mode: 'retry'; jobId: string | null }
  | { mode: 'site'; legacy: boolean };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isPreviewJobId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
const TTL = 86400000;
const LAUNCH = 'n6_preview_launch_v2';
const RETRY = 'n6_preview_retry_v2';
const OLD = 'n6_preview_key:';

// Browsers may copy sessionStorage to a newly opened tab. Discard only our copied
// records before detaching the opener. Later visits in this tab keep their own records.
export function previewTabStorage(): Storage {
  const storage = sessionStorage;
  if (typeof window !== 'undefined' && window.opener) {
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && (key === LAUNCH || key === RETRY || key === 'n6_preview_claim_notice_v1' || key.startsWith(OLD))) storage.removeItem(key);
    }
    window.opener = null;
  }
  return storage;
}

export function parsePreviewIntent(params: Record<string, string | string[] | undefined>): PreviewIntent {
  if (params.source === 'pdf') return { mode: 'pdf' };
  if (params.retry !== undefined) return { mode: 'retry', jobId: isPreviewJobId(params.retry) ? params.retry : null };
  return { mode: 'site', legacy: (params.source === undefined || params.source === 'site') && typeof params.url === 'string' && !!params.url };
}

export function readPreviewSiteInput(value: string) {
  const raw = value.trim();
  if (!raw || raw.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(raw) || raw.startsWith('/')) return null;
  const explicitHttp = /^https?:\/\//i.test(raw);
  if (!explicitHttp && /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(raw)) return null;
  const withScheme = explicitHttp ? raw : `https://${raw}`;
  const parts = /^https?:\/\/([^/?#]+)(.*)$/i.exec(withScheme);
  if (!parts || parts[1]!.includes('@')) return null;
  try {
    const url = new URL(withScheme);
    return { raw, origin: !parts[2] || parts[2] === '/' ? url.origin : null };
  } catch { return null; }
}
type Input = NonNullable<ReturnType<typeof readPreviewSiteInput>>;
type Entry = { key: string; value: string; expiresAt: number; acceptedJob?: string | null };

function writeEntries(slot: string, values: Entry[]) {
  try { previewTabStorage().setItem(slot, JSON.stringify(values.slice(-8))); } catch { /* storage may be disabled */ }
}

function entries(slot: string): Entry[] {
  let parsed: unknown = [];
  try { parsed = JSON.parse(previewTabStorage().getItem(slot) ?? '[]'); } catch { /* discard corrupt slot */ }
  const now = Date.now();
  const valid = Array.isArray(parsed) ? parsed.filter((e): e is Entry =>
    !!e && typeof e.key === 'string' && typeof e.value === 'string' && Number.isSafeInteger(e.expiresAt)
    && e.expiresAt > now && e.expiresAt <= now + TTL && (e.acceptedJob == null || isPreviewJobId(e.acceptedJob))
    && (slot === LAUNCH ? /^[a-f0-9]{64}$/.test(e.key) && UUID.test(e.value)
      : UUID.test(e.key) && readPreviewSiteInput(e.value)?.origin === e.value)).slice(-8) : [];
  writeEntries(slot, valid);
  return valid;
}
function put(slot: string, key: string, value: string) {
  const updated = entries(slot).filter(e => e.key !== key);
  updated.push({ key, value, expiresAt: Date.now() + TTL, ...(slot === LAUNCH ? { acceptedJob: null } : {}) });
  writeEntries(slot, updated);
}
export function clearLegacyPreviewKeys(input?: Input | null) {
  let migrated: string | null = null;
  try {
    const storage = previewTabStorage();
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (!key?.startsWith(OLD)) continue;
      if (input?.origin && key.slice(OLD.length) === input.raw) {
        const candidate = storage.getItem(key);
        if (candidate && UUID.test(candidate)) migrated = candidate;
      }
      storage.removeItem(key);
    }
  } catch { /* storage may be disabled */ }
  return migrated;
}
async function originDigest(origin: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function previewLaunchKey(input: Input) {
  const previous = clearLegacyPreviewKeys(input);
  if (!input.origin) return crypto.randomUUID();
  const key = await originDigest(input.origin);
  const existing = entries(LAUNCH).find(e => e.key === key);
  if (existing) return existing.value;
  const value = previous ?? crypto.randomUUID();
  put(LAUNCH, key, value);
  return value;
}
export function rememberPreviewRetry(jobId: string, origin: string | null, launchKey?: string) {
  if (!UUID.test(jobId) || !origin || readPreviewSiteInput(origin)?.origin !== origin) return;
  put(RETRY, jobId, origin);
  if (launchKey) {
    const launches = entries(LAUNCH);
    const accepted = launches.find(entry => entry.value === launchKey);
    if (accepted) { accepted.acceptedJob = jobId; writeEntries(LAUNCH, launches); }
  }
}
export async function retireFailedPreview(jobId: string) {
  // Older tabs stored the origin and acceptance time, without linking the launch to the job.
  const retries = entries(RETRY);
  const retry = retries.find(entry => entry.key === jobId);
  const latestForOrigin = retry && retries.filter(entry => entry.value === retry.value).at(-1);
  const legacyDigest = retry && retry === latestForOrigin && entries(LAUNCH).some(e => e.acceptedJob === undefined)
    ? await originDigest(retry.value) : null;
  const launches = entries(LAUNCH);
  writeEntries(LAUNCH, launches.filter(e => e.acceptedJob !== jobId &&
    !(e.acceptedJob === undefined && e.key === legacyDigest && retry && e.expiresAt <= retry.expiresAt)));
}
export function readPreviewRetry(jobId: string | null): string {
  return entries(RETRY).find(e => e.key === jobId)?.value ?? '';
}
