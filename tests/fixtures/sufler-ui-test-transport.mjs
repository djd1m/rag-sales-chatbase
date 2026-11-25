// Только --import в выделенном процессе стенда. Ни один запрос к провайдерам не выходит в сеть.
if (process.env.SUFLER_UI_TEST_TRANSPORT !== '1') throw new Error('Для preload требуется выделенный UI-стенд');
const localFetch = globalThis.fetch;
const allowedLocal = new Set([process.env.SUFLER_UI_TEST_ORIGIN, process.env.SUFLER_UI_EXTERNAL_ORIGIN].filter(Boolean));

globalThis.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  const bodyText = async () => String(init?.body ?? (input instanceof Request ? await input.clone().text() : ''));
  if (['https://foundation-models.api.cloud.ru/v1/embeddings', 'https://openrouter.ai/api/v1/embeddings'].includes(url.href)) {
    const payload = JSON.parse(await bodyText());
    if (!Array.isArray(payload.input) || payload.dimensions !== 1536) throw new Error('Неизвестный контракт embedding fixture');
    const embedding = [1, ...Array(1535).fill(0)];
    return Response.json({ data: payload.input.map((_, index) => ({ index, embedding })), usage: { total_tokens: 5 } });
  }
  const deepseek = url.href === 'https://api.deepseek.com/responses';
  if (deepseek || url.href === 'https://openrouter.ai/api/v1/chat/completions') {
    const payload = JSON.parse(await bodyText());
    const schema = deepseek ? payload.text?.format?.name : payload.response_format?.json_schema?.name;
    if (!['probe','answer'].includes(schema)) throw new Error('Неизвестная схема ответа fixture');
    const text = JSON.stringify(schema === 'probe' ? { ok: true } : { status: 'answered', citations: ['F1'], text: 'Доставка стоит 350 ₽.' });
    return Response.json(deepseek
      ? { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], usage: { total_tokens: 15 } }
      : { choices: [{ message: { content: text } }], usage: { total_tokens: 15 } });
  }
  if (allowedLocal.has(url.origin) || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
    return localFetch(input, { ...init, redirect: 'error' });
  }
  throw new Error('Внешний fetch запрещён в изолированном UI fixture');
};
