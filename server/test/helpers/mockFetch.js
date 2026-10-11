/**
 * Fetch stubbing for AI provider tests.
 *
 * Lets a test queue exact HTTP responses (including 401/429/500 and timeouts)
 * without any network access or paid API usage.
 */
export function installMockFetch({ match = () => true } = {}) {
  const calls = [];
  const original = globalThis.fetch;

  const controller = {
    calls,
    /** Queue a response: {status, body, headers, delayMs, throwError} */
    queue(response) {
      controller.queueList.push(response);
      return controller;
    },
    queueList: [],
    lastCall() {
      return calls[calls.length - 1] ?? null;
    },
    restore() {
      globalThis.fetch = original;
    },
  };

  globalThis.fetch = async function mockFetch(url, options = {}) {
    const target = String(url);
    if (!match(target)) return original(url, options);
    calls.push({ url: target, options });
    const next = controller.queueList.shift();
    if (!next) {
      return new Response(JSON.stringify({ error: { message: 'no queued response' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    if (next.throwError) throw next.throwError;
    const status = next.status ?? 200;
    const body = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };

  return controller;
}

/** Build a Chat Completions response body containing the given content. */
export function chatCompletionResponse(content, extra = {}) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: extra.model ?? 'gpt-6.1-sol',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    ...extra,
  };
}
