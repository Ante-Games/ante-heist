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

  // Lock hints unlock at 4, 8, 12 bench attempts.
  const code = heist.codes.V!;
  const wrong = (code + 1) % 100;
  const tiers: number[] = [];
  for (let i = 0; i < 12; i++) tiers.push((await runs.bench(runId, 'V', wrong)).hints.length);
  assert.deepEqual(tiers, [0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3]);
  assert.equal((await runs.bench(runId, 'V', code)).open, true);

  const scout = await runs.hire(runId, { npc: 'scout', room: 'B', payment: { mock: true } });
  assert.match(String((scout as { report: string }).report), /^Room B holds/);
  await assert.rejects(runs.hire(runId, { npc: 'scout', room: 'B' }), (e: GameError) => e.status === 402);

  const plan = solve(heist)!;
  const dry = await runs.hire(runId, { npc: 'operator', plan, payment: { mock: true } });
  assert.equal((dry as { verdict: string }).verdict, 'This plan reaches the vault.');

  tick(60_000);
  const t = await runs.submit(runId, plan);
  assert.equal(t.status, 'cleared');
  assert.deepEqual(t.heist!.rooms, heist.rooms);
  assert.ok(t.log.some((e) => e.kind === 'settle' && e.ok));
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

test('bench rejects rooms without a lock and one-at-a-time is enforced', async () => {
  const slow = new Runs({ missionSecret: 'x', chain: new MockChain(), timeScale: 0.002, dataDir: null });
  const { runId } = await slow.create({});
  const heist = generateHeist(runSeed('x', runId));
  const noLock = ROOMS.find((r) => heist.rooms[r] !== 'door')!;
  await assert.rejects(slow.bench(runId, noLock, 5), (e: GameError) => e.status === 400);
  const a = slow.probe(runId, 'A');
  await assert.rejects(slow.probe(runId, 'A'), (e: GameError) => e.status === 429);
  await Promise.all([a, slow.probe(runId, 'B')]); // different rooms run in parallel
});
