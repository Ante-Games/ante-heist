import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAnalyst, analystFromEnv, analystPrompt, ANALYST_SYSTEM } from '../src/analyst.ts';
import { ROOM_CLUES } from '../src/content.ts';

function fakeFetch(replies: Record<string, { status: number; body: unknown }>) {
  const calls: { model: string; auth: string }[] = [];
  const f = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    const model = JSON.parse(init.body).model as string;
    calls.push({ model, auth: init.headers.authorization });
    const r = replies[model];
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  return { f, calls };
}

test('the analyst falls back to the next model on an error or an empty answer', async () => {
  const { f, calls } = fakeFetch({
    paid: { status: 402, body: { error: { code: 'insufficient_credit' } } },
    blank: { status: 200, body: { choices: [{ message: { content: '' } }] } },
    free: { status: 200, body: { choices: [{ message: { content: ' A shaft. ' } }] } },
  });
  const a = makeAnalyst({ apiKey: 'k', baseUrl: 'https://x/v1/', models: ['paid', 'blank', 'free'], provider: 'p', fetch: f });
  assert.deepEqual(await a.ask({ observations: ['one'], question: 'q' }), { text: 'A shaft.', model: 'free' });
  assert.deepEqual(calls.map((c) => c.model), ['paid', 'blank', 'free']);
  assert.equal(calls[0].auth, 'Bearer k');

  const none = makeAnalyst({ apiKey: 'k', baseUrl: 'https://x/v1', models: ['paid'], provider: 'p', fetch: f });
  await assert.rejects(none.ask({ observations: [], question: 'q' }), /no model answered.*insufficient_credit/);
});

test('the analyst stops at its daily cap', async () => {
  const { f } = fakeFetch({ m: { status: 200, body: { choices: [{ message: { content: 'ok' } }] } } });
  const a = makeAnalyst({ apiKey: 'k', baseUrl: 'https://x/v1', models: ['m'], provider: 'p', fetch: f, dailyCap: 2 });
  await a.ask({ observations: [], question: 'q' });
  await a.ask({ observations: [], question: 'q' });
  await assert.rejects(a.ask({ observations: [], question: 'q' }), /limit of questions for today/);
});

test('the analyst is off without a key, and its prompt holds no clue text', () => {
  assert.equal(analystFromEnv({}), null);
  assert.deepEqual(analystFromEnv({ ANALYST_API_KEY: 'k', ANALYST_MODELS: 'a, b' })!.models, ['a', 'b']);
  // The system prompt explains the rules but must not carry the clue bank: reading clues is the analyst's job.
  for (const tiers of Object.values(ROOM_CLUES)) for (const clues of tiers) for (const clue of clues) assert.ok(!ANALYST_SYSTEM.includes(clue));
  assert.match(analystPrompt({ observations: [], question: 'why?' }), /nothing yet[\s\S]*The lead asks: why\?/);
});
