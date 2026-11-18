// Подменный шлюз OpenRouter для подпроцессов (node --import): настоящая сеть в тестах не вызывается.
// FAKE_GATEWAY: ok | 500 | dim1535 | noschema. FAKE_GATEWAY_LOG — файл, куда дописывается строка на
// каждый запрос (число вызовов и тело видны тесту). Чужие адреса — отказ, а не проход в сеть.
import { appendFileSync } from 'node:fs';
const mode = process.env.FAKE_GATEWAY ?? 'ok';
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const base = ['https://openrouter.ai/api/v1', 'https://api.deepseek.com', 'https://foundation-models.api.cloud.ru/v1'].find(b => href.startsWith(b + '/'));
  if (!base) throw new TypeError(`подменный шлюз: чужой адрес ${href}`);
  const body = JSON.parse(String(init.body ?? '{}'));
  if (process.env.FAKE_GATEWAY_LOG) appendFileSync(process.env.FAKE_GATEWAY_LOG, JSON.stringify({ path: href.slice(base.length), body }) + '\n');
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (mode === '500') return json({ error: 'upstream' }, 500);
  if (href.endsWith('/embeddings')) {
    const length = mode === 'dim1535' ? 1535 : body.dimensions === 1536 ? 1536 : 3072;
    return json({ data: body.input.map((_, index) => ({ index, embedding: Array(length).fill(0.01) })), usage: { prompt_tokens: 2, total_tokens: 2 } });
  }
  if (href.endsWith('/responses')) {
    return json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: mode === 'noschema' || !body.text?.format ? 'ok' : '{"ok":true}' }] }], usage: { total_tokens: 24 } });
  }
  const content = mode === 'noschema' || !body.response_format ? 'ok' : '{"ok":true}';
  return json({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } });
};
