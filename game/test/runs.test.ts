import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Runs, GameError } from '../src/runs.ts';
import { MockChain } from '../src/chain.ts';
import { generateHeist, runSeed, sha256Hex } from '../src/heist.ts';
import { solve } from '../src/solver.ts';
import { RUN_SECONDS, ROOMS } from '../src/rules.ts';

function setup() {
  let clock = 1_000_000;
  const runs = new Runs({ missionSecret: 's3cret', chain: new MockChain(), timeScale: 0, now: () => clock, dataDir: null });
  return { runs, tick: (ms: number) => { clock += ms; } };
}

test('a full run: probe, bench, hire, plan, reveal', async () => {
  const { runs, tick } = setup();
  const { runId, commitment } = await runs.create({ player: 'lead.testnet' });
  assert.equal(commitment, sha256Hex('s3cret'));
  const heist = generateHeist(runSeed('s3cret', runId));

  const p1 = await runs.probe(runId, 'A');
  const p2 = await runs.probe(runId, 'A');
  const p3 = await runs.probe(runId, 'A');
  const p4 = await runs.probe(runId, 'A');
  assert.deepEqual([p1.tier, p2.tier, p3.tier, p4.tier], [1, 2, 3, 3]);
  assert.deepEqual([p2.startingAlarm, p3.startingAlarm, p4.startingAlarm], [0, 1, 2]);
  assert.equal(p3.clue, heist.clues.A[2]);

  // Free lock hints unlock at 2 and 4 bench tests; the bench allows 5 per lock.
  const code = heist.codes.V!;
  const wrong = (code + 1) % 100;
  const tiers: number[] = [];
  for (let i = 0; i < 4; i++) tiers.push((await runs.bench(runId, 'V', wrong)).hints.length);
  assert.deepEqual(tiers, [0, 1, 1, 2]);
  assert.equal((await runs.bench(runId, 'V', code)).open, true);
  await assert.rejects(runs.bench(runId, 'V', code), (e: GameError) => e.status === 409 && /already opened/.test(e.message));

  const scout = await runs.hire(runId, { npc: 'Scout', room: 'B', payment: { mock: true } }); // either case is accepted
  assert.match(String((scout as { report: string }).report), /^Room B holds/);
  await assert.rejects(runs.hire(runId, { npc: 'scout', room: 'B' }), (e: GameError) => e.status === 402);

  const plan = solve(heist)!;
  const dry = await runs.hire(runId, { npc: 'operator', plan, payment: { mock: true } });
  assert.equal((dry as { verdict: string }).verdict, 'This plan reaches the vault.');

  tick(60_000);
  const t = await runs.submit(runId, plan);
  assert.equal(t.status, 'cleared');
  assert.deepEqual(t.heist!.rooms, heist.rooms);
  assert.match(t.settlement!.detail, /would pay/);
  const full = runs.view(runId) as { log: { kind: string; ok?: boolean }[] };
  assert.ok(full.log.some((e) => e.kind === 'settle' && e.ok));
  await assert.rejects(runs.probe(runId, 'A'), (e: GameError) => e.status === 404);
  assert.equal((runs.view(runId) as { status: string }).status, 'cleared');
});

test('the heist stays hidden while the run is active', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  assert.equal((runs.view(runId) as { heist: unknown }).heist, null);
});

test('the clock: actions after 600s are refused and a late plan fails', async () => {
  const { runs, tick } = setup();
  const { runId } = await runs.create({});
  tick(RUN_SECONDS * 1000 + 1);
  await assert.rejects(runs.probe(runId, 'A'), (e: GameError) => e.status === 410);
  const t = await runs.submit(runId, { bag: [], steps: [{ move: 'A' }] });
  assert.equal(t.status, 'failed');
  assert.match(t.reason!, /clock ran out/);
});

test('cryptographer reports a room has no lock, for a fee', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  const heist = generateHeist(runSeed('s3cret', runId));
  const noLock = ROOMS.find((r) => heist.rooms[r] !== 'door')!;
  const r = await runs.hire(runId, { npc: 'cryptographer', lock: noLock, payment: { mock: true } });
  assert.match(String((r as { report: string }).report), /no lock/);
  await assert.rejects(runs.hire(runId, { npc: 'cryptographer', lock: noLock }), (e: GameError) => e.status === 402);
});

test('cryptographer sells the next tier, up to three', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  for (let n = 1; n <= 3; n++) {
    const r = await runs.hire(runId, { npc: 'cryptographer', lock: 'V', payment: { mock: true } });
    assert.equal((r as { hints: string[] }).hints.length, n);
  }
  await assert.rejects(runs.hire(runId, { npc: 'cryptographer', lock: 'V', payment: { mock: true } }), (e: GameError) => e.status === 409);
});

test('operator dry runs are capped at two', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  const plan = { bag: [], steps: [{ move: 'A' }] };
  await runs.hire(runId, { npc: 'operator', plan, payment: { mock: true } });
  await runs.hire(runId, { npc: 'operator', plan, payment: { mock: true } });
  await assert.rejects(runs.hire(runId, { npc: 'operator', plan, payment: { mock: true } }), (e: GameError) => e.status === 409);
});

test('the bench budget stops brute force at 5 tests per lock', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  const code = generateHeist(runSeed('s3cret', runId)).codes.V!;
  for (let i = 0; i < 5; i++) await runs.bench(runId, 'V', (code + 1 + i) % 100);
  await assert.rejects(runs.bench(runId, 'V', code), (e: GameError) => e.status === 409 && /5 tests per lock/.test(e.message));
});

test('rooms without a lock bench like a lock that never opens; one-at-a-time is enforced', async () => {
  const slow = new Runs({ missionSecret: 'x', chain: new MockChain(), timeScale: 0.002, dataDir: null });
  const { runId } = await slow.create({});
  const heist = generateHeist(runSeed('x', runId));
  // A room with no lock benches like a lock that never opens: no free probe from an error.
  const noLock = ROOMS.find((r) => heist.rooms[r] !== 'door')!;
  assert.equal((await slow.bench(runId, noLock, 0)).open, false);
  const second = await slow.bench(runId, noLock, 1);
  assert.equal(second.open, false);
  assert.equal(second.hints.length, 1);
  const a = slow.probe(runId, 'A');
  await assert.rejects(slow.probe(runId, 'A'), (e: GameError) => e.status === 429);
  await Promise.all([a, slow.probe(runId, 'B')]); // different rooms run in parallel
});

// A stand-in for the language model: records what it was shown and can be told to fail.
function stubAnalyst() {
  const seen: { observations: string[]; question: string }[] = [];
  const s = {
    provider: 'stub', models: ['stub-1'], fail: false, seen,
    async ask(input: { observations: string[]; question: string }) {
      seen.push(input);
      if (s.fail) throw new Error('model down');
      return { text: 'Room A is most likely a laser (medium).', model: 'stub-1' };
    },
  };
  return s;
}

test('the analyst sees only what the player has seen, never the heist', async () => {
  const analyst = stubAnalyst();
  const runs = new Runs({ missionSecret: 's3cret', chain: new MockChain(), timeScale: 0, dataDir: null, analyst });
  const { runId } = await runs.create({});
  const heist = generateHeist(runSeed('s3cret', runId));
  const probe = await runs.probe(runId, 'A');
  const wrong = (heist.codes.V! + 1) % 100;
  await runs.bench(runId, 'V', wrong);
  await runs.hire(runId, { npc: 'scout', room: 'B', payment: { mock: true } });

  const a = await runs.hire(runId, { npc: 'analyst', question: 'What is in room A?', payment: { mock: true } }) as { opinion: string; model: string; note: string; question: string };
  assert.equal(a.opinion, 'Room A is most likely a laser (medium).');
  assert.equal(a.model, 'stub-1');
  assert.match(a.note, /can be wrong/);

  const shown = analyst.seen[0].observations.join('\n');
  assert.ok(shown.includes(probe.clue), 'the clue the player saw');
  assert.ok(shown.includes(`Room B holds`), 'the scout report the player bought');
  assert.match(shown, new RegExp(`lock V: ${String(wrong).padStart(2, '0')} did not open`));
  // Nothing the player has not seen: no code, no tier-2/3 clue, no clue for an unprobed room.
  assert.ok(!shown.includes(`${String(heist.codes.V).padStart(2, '0')} OPENED`));
  for (const room of ROOMS) for (const [i, clue] of heist.clues[room].entries()) {
    if (clue === probe.clue) continue; // another room may hold the same obstacle and show the same line
    assert.ok(!shown.includes(clue), `unseen clue for ${room} tier ${i + 1} stays hidden`);
  }
  for (const hint of heist.lockHints.V ?? []) assert.ok(!shown.includes(hint), 'unearned lock hints stay hidden');

  const log = (runs.view(runId) as { log: { kind: string; npc?: string; answer?: { question: string } }[] }).log;
  assert.equal(log.find((e) => e.npc === 'analyst')!.answer!.question, 'What is in room A?');
});

test('the analyst: three questions per run, a question is required, and a failed model call spends nothing', async () => {
  const analyst = stubAnalyst();
  const runs = new Runs({ missionSecret: 's3cret', chain: new MockChain(), timeScale: 0, dataDir: null, analyst });
  const { runId } = await runs.create({});
  await assert.rejects(runs.hire(runId, { npc: 'analyst', payment: { mock: true } }), (e: GameError) => e.status === 400);
  await assert.rejects(runs.hire(runId, { npc: 'analyst', question: 'x'.repeat(801), payment: { mock: true } }), (e: GameError) => e.status === 400);
  await assert.rejects(runs.hire(runId, { npc: 'analyst', question: 'hello' }), (e: GameError) => e.status === 402);

  analyst.fail = true;
  await assert.rejects(runs.hire(runId, { npc: 'analyst', question: 'hello', payment: { mock: true } }), (e: GameError) => e.status === 503 && /not spent/.test(e.message));
  assert.equal((runs.view(runId) as { log: { kind: string }[] }).log.filter((e) => e.kind === 'hire').length, 0, 'a failed call is not logged as a hire');
  analyst.fail = false;

  for (let i = 0; i < 3; i++) await runs.hire(runId, { npc: 'analyst', question: `q${i}`, payment: { mock: true } });
  await assert.rejects(runs.hire(runId, { npc: 'analyst', question: 'one more', payment: { mock: true } }), (e: GameError) => e.status === 409);
  // Analyst questions never change the verdict: the judge reads only the plan.
  const heist = generateHeist(runSeed('s3cret', runId));
  assert.equal((await runs.submit(runId, solve(heist)!)).status, 'cleared');
});

test('without a model the analyst is off and says so before any payment', async () => {
  const { runs } = setup();
  const { runId } = await runs.create({});
  await assert.rejects(runs.hire(runId, { npc: 'analyst', question: 'hello', payment: { mock: true } }), (e: GameError) => e.status === 503 && /nothing was spent/.test(e.message));
  assert.equal((runs.rules().npcs.analyst as { available: boolean }).available, false);
});
