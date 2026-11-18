// Общая граница HTTP: адрес задаёт адаптер, ключ/тело ошибок не журналируются.
import { EMBED_DIMENSIONS, isEmbeddingOfDimension } from './constants.js';
import { RetryableCallError, type SpendResult } from './spend.js';

export class GatewayResponseError extends Error {
  readonly spendResult: SpendResult;
  constructor(result: SpendResult, message: string) { super(message); this.spendResult = result; }
}
export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function usageTokens(body: Record<string, unknown>): number | undefined {
  const usage = body.usage;
  if (!isObject(usage)) return undefined;
  const total = usage.total_tokens ?? usage.prompt_tokens;
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

export function gatewayTransport(base: string, apiKey: string, request: typeof fetch) {
  return async (path: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RetryableCallError(combined.aborted ? 'timeout' : 'provider_error', 'API модели недоступен');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) throw new RetryableCallError('rate_limited', 'API модели: 429');
      if (response.status >= 500) throw new RetryableCallError('provider_error', `API модели: ${response.status}`);
      throw new GatewayResponseError('provider_error', `API модели отказал: ${response.status}`);
    }
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch {
      if (combined.aborted) throw new RetryableCallError('timeout', 'Таймаут чтения API модели');
      throw new GatewayResponseError('schema_violation', 'API модели вернул не JSON');
    }
    if (!isObject(parsed)) throw new GatewayResponseError('schema_violation', 'API модели вернул не объект');
    return parsed;
  };
}

// Ответы могут приходить не в порядке input. Проверка индексов обязательна: иначе фрагменту
// достанется вектор другого текста. Никакого молчаливого fallback на порядок массива.
export function parseEmbeddings(body: Record<string, unknown>, count: number): number[][] {
  const data = body.data;
  if (!Array.isArray(data) || data.length !== count) throw new GatewayResponseError('schema_violation', 'Эмбеддинги: число векторов ≠ числу текстов');
  const vectors: number[][] = new Array(count);
  for (const item of data) {
    const index = isObject(item) ? item.index : undefined;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count || vectors[index] !== undefined) {
      throw new GatewayResponseError('schema_violation', 'Эмбеддинги: неверный или повторный index');
    }
    const embedding = item.embedding;
    if (!Array.isArray(embedding) || embedding.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new GatewayResponseError('schema_violation', 'Эмбеддинги: вектор не массив чисел');
    }
    if (!isEmbeddingOfDimension(embedding)) {
      throw new GatewayResponseError('dimension_mismatch', `Эмбеддинги: длина ${embedding.length} ≠ ${EMBED_DIMENSIONS}`);
    }
    vectors[index] = embedding as number[];
  }
  return vectors;
}
