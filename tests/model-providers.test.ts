import { describe, expect, it, vi } from 'vitest';
import { createEmbeddingClient, createModelClient, CLOUDRU_BASE, DEEPSEEK_BASE, type ModelConfig } from '../packages/rag/src/providers';
import { loadModelConfig, loadWorkerConfig } from '../packages/rag/src/config';
import { OPENROUTER_BASE } from '../packages/rag/src/openrouter';
import { answerQuestion, type SearchHit, type SpendEvent } from '../packages/rag/src/index';
import { environment } from './fixtures/environment';

const hybrid = { ...environment(), ANSWER_PROVIDER: 'deepseek', ANSWER_MODEL: 'deepseek-flash', EMBED_PROVIDER: 'cloudru',
  DEEPSEEK_API_KEY: 'deepseek-local-fixture', CLOUDRU_FM_API_KEY: 'cloudru-local-fixture', OPENROUTER_API_KEY: '' };
const config = () => loadModelConfig(hybrid);
const input = { messages: [{ role: 'user' as const, content: 'Вопрос' }], schemaName: 'probe', schema: { type: 'object' } };
const output = (text = '{"ok":true}') => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], usage: { total_tokens: 24 } });
const embedding = (index: number, value = 0.5) => ({ index, embedding: Array(1536).fill(value) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fake(reply: (url: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  const request = (async (url, init = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, init });
    return reply(String(url), body);
  }) as typeof fetch;
  return { calls, request };
}

describe('Явная конфигурация и возврат к OpenRouter', () => {
  it('гибрид не требует OpenRouter; worker не требует и не получает ключ ответов', () => {
    expect(config()).toMatchObject({ answerProvider: 'deepseek', embedProvider: 'cloudru' });
    const env: NodeJS.ProcessEnv = { ...hybrid }; delete env.DEEPSEEK_API_KEY;
    expect(loadWorkerConfig(env).models).toEqual({ embedProvider: 'cloudru', embedModel: 'openai/text-embedding-3-small', embedApiKey: hybrid.CLOUDRU_FM_API_KEY });
    expect(() => loadModelConfig(env)).toThrow('DEEPSEEK_API_KEY');
  });
  it.each(['ANSWER_PROVIDER', 'EMBED_PROVIDER', 'DEEPSEEK_API_KEY', 'CLOUDRU_FM_API_KEY'])('пустой/отсутствующий %s отвергается без утечки', (name) => {
    for (const value of [undefined, '', ' ']) expect(() => loadModelConfig({ ...hybrid, [name]: value })).toThrow(name);
  });
  it.each([
    { ANSWER_PROVIDER: 'other' }, { EMBED_PROVIDER: 'other' },
    { ANSWER_MODEL: 'deepseek-v4-pro' }, { ANSWER_MODEL: 'anthropic/claude-haiku-4.5' },
    { ANSWER_PROVIDER: 'openrouter' }, { EMBED_MODEL: 'BAAI/bge-m3' },
    { DEEPSEEK_API_KEY: 'secret\nvalue' }, { CLOUDRU_FM_API_KEY: 'secret value' },
  ])('несовместимая конфигурация отвергается: %j', (change) => {
    expect(() => loadModelConfig({ ...hybrid, OPENROUTER_API_KEY: 'or-fixture', ...change })).toThrow();
  });
  for (const answerProvider of ['deepseek', 'openrouter'] as const) for (const embedProvider of ['cloudru', 'openrouter'] as const) {
    it(`${answerProvider} + ${embedProvider}: URL, ключи и complete не перезаписываются адаптером embed`, async () => {
      const cfg = loadModelConfig({ ...hybrid, OPENROUTER_API_KEY: 'or-fixture', ANSWER_PROVIDER: answerProvider,
        ANSWER_MODEL: answerProvider === 'deepseek' ? 'deepseek-flash' : 'anthropic/claude-haiku-4.5', EMBED_PROVIDER: embedProvider });
      const { calls, request } = fake((url) => json(url.endsWith('/embeddings') ? { data: [embedding(0)] } : url.endsWith('/responses') ? output() : { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
      const client = createModelClient(cfg, request);
      expect((await client.complete(input)).value).toEqual({ ok: true });
      await client.embed({ texts: ['текст'] });
      expect(calls.map(c => c.url)).toEqual([
        answerProvider === 'deepseek' ? `${DEEPSEEK_BASE}/responses` : `${OPENROUTER_BASE}/chat/completions`,
        embedProvider === 'cloudru' ? `${CLOUDRU_BASE}/embeddings` : `${OPENROUTER_BASE}/embeddings`,
      ]);
      expect(calls.map(c => (c.init.headers as Record<string, string>).Authorization)).toEqual([`Bearer ${cfg.answerApiKey}`, `Bearer ${cfg.embedApiKey}`]);
      expect(calls.every(c => c.init.redirect === 'error')).toBe(true);
      if (answerProvider === 'deepseek') {
        expect(calls[0]!.body).toEqual({ model: 'deepseek-flash', input: input.messages, temperature: 0, max_output_tokens: 400,
          reasoning: { effort: 'none' }, stream: false, text: { format: { type: 'json_schema', name: 'probe', schema: input.schema } } });
      } else expect(calls[0]!.body).toMatchObject({ response_format: { type: 'json_schema', json_schema: { strict: true } }, provider: { require_parameters: true } });
      expect(calls[1]!.body).toEqual({ model: 'openai/text-embedding-3-small', input: ['текст'], dimensions: 1536 });
    });
  }
});

describe('DeepSeek Responses: отказы и лимиты', () => {
  it.each([{}, { ...output(), status: 'incomplete' }, { ...output(), error: { message: 'bad' } },
    output('не JSON'), { ...output(), output: [] }, { ...output(), output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [] }] },
    { ...output(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }] },
  ])('неполный/ошибочный ответ не выдаётся как успешный', async (reply) => {
    await expect(createModelClient(config(), fake(() => json(reply)).request).complete(input)).rejects.toMatchObject({ spendResult: 'schema_violation' });
  });
  it('проба сохраняет лимит 16 и thinking off', async () => {
    const { request, calls } = fake(() => json(output()));
    await createModelClient(config(), request).complete({ ...input, maxTokens: 16 });
    expect(calls[0]!.body).toMatchObject({ max_output_tokens: 16, reasoning: { effort: 'none' } });
  });
  it('лимит >400 отвергается до сети', async () => {
    const { request, calls } = fake(() => json(output()));
    await expect(createModelClient(config(), request).complete({ ...input, maxTokens: 401 })).rejects.toThrow('≤ 400');
    expect(calls).toHaveLength(0);
  });
  it.each([401, 429, 503])('ошибка %i не вызывает fallback и не выводит тело/ключ', async (status) => {
    const { request, calls } = fake(() => json({ error: hybrid.DEEPSEEK_API_KEY }, status));
    const error = await createModelClient(config(), request).complete(input).catch((e: unknown) => e) as Error;
    expect(error.message).not.toContain(hybrid.DEEPSEEK_API_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${DEEPSEEK_BASE}/responses`);
  });
  it('таймаут: сигнал передан и ошибка очищена', async () => {
    const request = (async (_url, init) => { expect(init?.signal?.aborted).toBe(true); throw new Error(hybrid.DEEPSEEK_API_KEY); }) as typeof fetch;
    await expect(createModelClient(config(), request).complete({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ result: 'timeout' });
  });
  it('неизвестный provider в фабрике не превращается в Cloud.ru по умолчанию', () => {
    expect(() => createModelClient({ ...config(), embedProvider: 'other' } as unknown as ModelConfig)).toThrow('EMBED_PROVIDER');
  });
});

describe('Cloud.ru: размеры и порядок векторов', () => {
  it('переставленные векторы возвращаются в порядке input', async () => {
    const client = createEmbeddingClient(config(), fake(() => json({ data: [embedding(1, 0.2), embedding(0, 0.1)] })).request);
    expect((await client.embed({ texts: ['а', 'б'] })).vectors.map(v => v[0])).toEqual([0.1, 0.2]);
  });
  it.each([
    [embedding(0), embedding(0)], [embedding(0), embedding(2)], [embedding(0), { embedding: Array(1536).fill(0.1) }],
    [embedding(0), { ...embedding(1), index: '1' }], [embedding(0)],
  ].map(data => [data]))('неверные индексы/количество отвергаются', async (data) => {
    const request = fake(() => json({ data })).request;
    await expect(createEmbeddingClient(config(), request).embed({ texts: ['а', 'б'] })).rejects.toMatchObject({ spendResult: 'schema_violation' });
  });
  it('1024 измерения отвергаются до записи', async () => {
    const request = fake(() => json({ data: [{ index: 0, embedding: Array(1024).fill(0.1) }] })).request;
    await expect(createEmbeddingClient(config(), request).embed({ texts: ['а'] })).rejects.toMatchObject({ spendResult: 'dimension_mismatch' });
  });
  it('пустая/слишком большая пачка не оплачивается', async () => {
    const request = vi.fn() as unknown as typeof fetch;
    for (const texts of [[], Array(65).fill('а'), ['']]) await expect(createEmbeddingClient(config(), request).embed({ texts })).rejects.toThrow('1–64');
    expect(request).not.toHaveBeenCalled();
  });
});


describe('Гибрид проходит через настоящее ядро RAG', () => {
  const bot = { id: 'bot-hybrid', status: 'active', companyName: 'Магазин', contact: '+7 900 000-00-00' };
  const hit: SearchHit = { botId: bot.id, chunkId: 'chunk-1', pageId: 'page-1', sourceId: 'source-1',
    pageTitle: 'Доставка', contextPath: 'Доставка', urlOrPage: 'https://example.invalid/delivery',
    text: 'Доставка стоит 350 рублей', similarity: 0.85 };
  async function ask(options: { hits?: SearchHit[]; quota?: boolean; citation?: string } = {}) {
    const trace: string[] = [], events: SpendEvent[] = [];
    const { calls, request } = fake(url => {
      trace.push(url.endsWith('/embeddings') ? 'embed' : 'answer');
      return json(url.endsWith('/embeddings') ? { data: [embedding(0)] } : output(JSON.stringify({
        status: 'answered', text: 'Доставка стоит 350 рублей.', citations: [options.citation ?? 'F1'],
      })));
    });
    const result = await answerQuestion({ client: createModelClient(config(), request), models: config(),
      spend: async e => { events.push(e); trace.push(e.call + ':' + e.phase); },
      chargeQuota: async () => { trace.push('quota'); return options.quota === false ? { granted: false, scope: 'global_answers' } : { granted: true }; },
      search: async () => options.hits ?? [hit], logQuestion: async () => {}, pageTitles: async () => [],
    }, bot, 'widget', { question: 'Сколько стоит доставка?', history: [] });
    return { result, calls, trace, events };
  }
  it('квота и attempt предшествуют сети; цитаты проверяются; provider записан', async () => {
    const t = await ask();
    expect(t.result.status).toBe('answered');
    expect(t.trace).toEqual(['quota', 'embed_question:attempt', 'embed', 'embed_question:outcome', 'answer:attempt', 'answer', 'answer:outcome']);
    expect(t.events.map(e => e.provider)).toEqual(['cloudru', 'cloudru', 'deepseek', 'deepseek']);
  });
  it('пустой поиск не вызывает DeepSeek', async () => {
    const t = await ask({ hits: [] });
    expect(t.result.status).toBe('unknown');
    expect(t.calls.map(c => c.url)).toEqual([`${CLOUDRU_BASE}/embeddings`]);
  });
  it('исчерпанная квота не вызывает ни один API', async () => {
    const t = await ask({ quota: false });
    expect(t.result.status).toBe('refused'); expect(t.calls).toHaveLength(0);
  });
  it('чужая цитата после успешного HTTP остаётся unknown', async () => {
    expect((await ask({ citation: 'F99' })).result.status).toBe('unknown');
  });
});
