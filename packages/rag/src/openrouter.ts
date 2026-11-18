// из N5: projects/05-podcast-clips-opus/apps/worker/src/llm/provider.ts — адаптировано: один путь OpenRouter
// без BYOK и фолбэков сохранён; добавлены эмбеддинги (POST /embeddings, dimensions 1536, ADR-001/002),
// ответ по JSON-схеме ADR-011 (temperature 0, max_tokens 400); повторяемые отказы (429/5xx/сеть/таймаут)
// выделены в RetryableCallError — повтор решает meteredCall, и каждая попытка списывается заново.
import { EMBED_BATCH_MAX, EMBED_DIMENSIONS } from './constants.js';
import { gatewayTransport, GatewayResponseError, isObject, usageTokens, parseEmbeddings } from './gateway.js';

// Адрес шлюза — константа кода, не окружение (honest-configuration CFG-I8): ключ уходит только сюда.
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const ANSWER_TIMEOUT_MS = 20_000;
export const EMBED_TIMEOUT_MS = 30_000;
export const ANSWER_MAX_TOKENS = 400;

export { GatewayResponseError } from './gateway.js';
export interface OpenRouterConfig { apiKey: string; answerModel: string; embedModel: string }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Completion { value: unknown; tokens?: number }
export interface Embeddings { vectors: number[][]; tokens?: number }
export interface OpenRouter {
  complete(input: { messages: ChatMessage[]; schemaName: string; schema: object; maxTokens?: number; signal?: AbortSignal }): Promise<Completion>;
  embed(input: { texts: string[]; signal?: AbortSignal }): Promise<Embeddings>;
}

export function createOpenRouter(config: OpenRouterConfig, request: typeof fetch = fetch): OpenRouter {
  const post = gatewayTransport(OPENROUTER_BASE, config.apiKey, request);
  return {
    async complete({ messages, schemaName, schema, maxTokens = ANSWER_MAX_TOKENS, signal }) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > ANSWER_MAX_TOKENS) throw new Error('max_tokens вне канона (≤ 400)');
      const body = await post('/chat/completions', {
        model: config.answerModel, messages, temperature: 0, max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
        // Параметры обязательны у поставщика: иначе шлюз молча снимет structured outputs.
        provider: { require_parameters: true },
      }, ANSWER_TIMEOUT_MS, signal);
      const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
      const message = isObject(choice) ? choice.message : undefined;
      if (!isObject(message) || typeof message.content !== 'string' || message.refusal || (isObject(choice) && choice.finish_reason && choice.finish_reason !== 'stop')) {
        throw new GatewayResponseError('schema_violation', 'Ответ модели без содержимого');
      }
      try { return { value: JSON.parse(message.content) as unknown, tokens: usageTokens(body) }; }
      catch { throw new GatewayResponseError('schema_violation', 'Ответ модели не соответствует JSON-схеме'); }
    },
    async embed({ texts, signal }) {
      if (!texts.length || texts.length > EMBED_BATCH_MAX || texts.some((t) => typeof t !== 'string' || !t)) throw new Error('Пачка эмбеддингов: 1–64 непустых текста');
      const body = await post('/embeddings', { model: config.embedModel, input: texts, dimensions: EMBED_DIMENSIONS }, EMBED_TIMEOUT_MS, signal);
      const vectors = parseEmbeddings(body, texts.length);
      return { vectors, tokens: usageTokens(body) };
    },
  };
}
