// ADR-024: маршруты выбираются явно; автоматического переключения между поставщиками нет.
import { ANSWER_MODELS, EMBED_BATCH_MAX, EMBED_DIMENSIONS, EMBED_MODELS } from './constants.js';
import { ANSWER_MAX_TOKENS, ANSWER_TIMEOUT_MS, EMBED_TIMEOUT_MS, createOpenRouter, type OpenRouter } from './openrouter.js';
import { gatewayTransport, GatewayResponseError, isObject, parseEmbeddings, usageTokens } from './gateway.js';

export const ANSWER_PROVIDERS = ['openrouter', 'deepseek'] as const;
export const EMBED_PROVIDERS = ['openrouter', 'cloudru'] as const;
export type AnswerProvider = typeof ANSWER_PROVIDERS[number];
export type EmbedProvider = typeof EMBED_PROVIDERS[number];
// Фиксированные адреса исключают отправку ключей на произвольный BASE_URL из окружения.
export const DEEPSEEK_BASE = 'https://api.deepseek.com';
export const CLOUDRU_BASE = 'https://foundation-models.api.cloud.ru/v1';
export interface EmbeddingConfig { embedProvider: EmbedProvider; embedApiKey: string; embedModel: string }
export interface ModelConfig extends EmbeddingConfig { answerProvider: AnswerProvider; answerApiKey: string; answerModel: string }
export type ModelClient = OpenRouter;

export function assertEmbeddingConfig(config: EmbeddingConfig): void {
  if (!EMBED_PROVIDERS.includes(config.embedProvider)) throw new Error('Неизвестный EMBED_PROVIDER');
  if (!(EMBED_MODELS as readonly string[]).includes(config.embedModel)) throw new Error('Недопустимый EMBED_MODEL');
  if (!config.embedApiKey || /\s/.test(config.embedApiKey)) throw new Error('Ключ провайдера эмбеддингов не задан или непригоден');
}
export function assertAnswerConfig(config: Pick<ModelConfig, 'answerProvider' | 'answerApiKey' | 'answerModel'>): void {
  if (!ANSWER_PROVIDERS.includes(config.answerProvider)) throw new Error('Неизвестный ANSWER_PROVIDER');
  const allowed = config.answerProvider === 'deepseek' ? ['deepseek-flash'] : ['anthropic/claude-haiku-4.5'];
  if (!allowed.includes(config.answerModel) || !(ANSWER_MODELS as readonly string[]).includes(config.answerModel)) {
    throw new Error('ANSWER_MODEL не соответствует ANSWER_PROVIDER');
  }
  if (!config.answerApiKey || /\s/.test(config.answerApiKey)) throw new Error('Ключ провайдера ответов не задан или непригоден');
}

export function createEmbeddingClient(config: EmbeddingConfig, request: typeof fetch = fetch): Pick<ModelClient, 'embed'> {
  assertEmbeddingConfig(config);
  if (config.embedProvider === 'openrouter') {
    const client = createOpenRouter({ apiKey: config.embedApiKey, answerModel: 'anthropic/claude-haiku-4.5', embedModel: config.embedModel }, request);
    return { embed: client.embed };
  }
  const post = gatewayTransport(CLOUDRU_BASE, config.embedApiKey, request);
  return {
    async embed({ texts, signal }) {
      if (!texts.length || texts.length > EMBED_BATCH_MAX || texts.some((text) => typeof text !== 'string' || !text)) throw new Error('Пачка эмбеддингов: 1–64 непустых текста');
      const body = await post('/embeddings', { model: config.embedModel, input: texts, dimensions: EMBED_DIMENSIONS }, EMBED_TIMEOUT_MS, signal);
      return { vectors: parseEmbeddings(body, texts.length), tokens: usageTokens(body) };
    },
  };
}

function createAnswerClient(config: ModelConfig, request: typeof fetch): Pick<ModelClient, 'complete'> {
  assertAnswerConfig(config);
  if (config.answerProvider === 'openrouter') {
    const client = createOpenRouter({ apiKey: config.answerApiKey, answerModel: config.answerModel, embedModel: config.embedModel }, request);
    return { complete: client.complete };
  }
  const post = gatewayTransport(DEEPSEEK_BASE, config.answerApiKey, request);
  return {
    async complete({ messages, schemaName, schema, maxTokens = ANSWER_MAX_TOKENS, signal }) {
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > ANSWER_MAX_TOKENS) throw new Error('max_output_tokens вне канона (≤ 400)');
      const body = await post('/responses', {
        model: config.answerModel, input: messages, temperature: 0, max_output_tokens: maxTokens,
        reasoning: { effort: 'none' }, stream: false,
        text: { format: { type: 'json_schema', name: schemaName, schema } },
      }, ANSWER_TIMEOUT_MS, signal);
      if (body.status !== 'completed' || body.error || body.incomplete_details || !Array.isArray(body.output)) {
        throw new GatewayResponseError('schema_violation', 'Незавершённый ответ DeepSeek');
      }
      const parts: string[] = [];
      for (const item of body.output) {
        if (!isObject(item)) throw new GatewayResponseError('schema_violation', 'Неверный output DeepSeek');
        if (item.type === 'reasoning') continue;
        if (item.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
          throw new GatewayResponseError('schema_violation', 'Ответ DeepSeek без завершённого сообщения');
        }
        for (const part of item.content) {
          if (!isObject(part) || part.type !== 'output_text' || typeof part.text !== 'string') {
            throw new GatewayResponseError('schema_violation', 'Ответ DeepSeek без JSON-содержимого');
          }
          parts.push(part.text);
        }
      }
      if (!parts.length) throw new GatewayResponseError('schema_violation', 'Пустой ответ DeepSeek');
      try { return { value: JSON.parse(parts.join('')) as unknown, tokens: usageTokens(body) }; }
      catch { throw new GatewayResponseError('schema_violation', 'Ответ DeepSeek не соответствует JSON-схеме'); }
    },
  };
}

export function createModelClient(config: ModelConfig, request: typeof fetch = fetch): ModelClient {
  return { ...createAnswerClient(config, request), ...createEmbeddingClient(config, request) };
}
