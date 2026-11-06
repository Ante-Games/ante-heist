import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHeist, runSeed, locksOf, type Heist } from '../src/heist.ts';
import { simulate, parsePlan, type Plan } from '../src/sim.ts';
import { solve, routes } from '../src/solver.ts';
import { replay, suspicion, type LogEvent } from '../src/checker.ts';
import { planRoute, locksOnRoute } from '../src/solver.ts';
import { ROOMS, RUN_SECONDS } from '../src/rules.ts';

const seeds = Array.from({ length: 500 }, (_, i) => runSeed('test-secret', `run-${i}`));

test('heists are deterministic per seed and vary across seeds', () => {
  assert.deepEqual(generateHeist(seeds[0]), generateHeist(seeds[0]));
  const layouts = new Set(seeds.map((s) => JSON.stringify(generateHeist(s).rooms)));
  assert.ok(layouts.size >= 30, `only ${layouts.size} layouts`);
});

test('every door room and the vault have a 0-99 code and three hints', () => {
  for (const s of seeds) {
    const h = generateHeist(s);
    assert.ok(h.codes.V !== undefined);
    for (const r of ROOMS) assert.equal(h.codes[r] !== undefined, h.rooms[r] === 'door');
    for (const l of locksOf(h)) {
      assert.ok(h.codes[l]! >= 0 && h.codes[l]! <= 99);
      assert.equal(h.lockHints[l]!.length, 3);
    }
  }
});

test('parity hint range always contains the code', () => {
  for (const s of seeds) {
    const h = generateHeist(s);
    for (const l of locksOf(h)) {
      const m = h.lockHints[l]![0].match(/from (\d+) to (\d+)/)!;
      const code = h.codes[l]!;
      assert.ok(code >= Number(m[1]) && code <= Number(m[2]), `${code} not in ${m[0]}`);
    }
  }
});

test('every heist is solvable and the solver plan clears', () => {
  for (const s of seeds) {
    const h = generateHeist(s);
    const plan = solve(h);
    assert.ok(plan, `no plan for ${s}`);
    const r = simulate(h, plan);
    assert.ok(r.cleared, `${s}: ${r.reason}`);
  }
});

test('the two short routes always differ in obstacle mix', () => {
  for (const s of seeds) {
    const { rooms } = generateHeist(s);
    assert.notEqual([rooms.A, rooms.C].sort().join(), [rooms.B, rooms.D].sort().join());
  }
  assert.equal(routes().length, 4);
});

// A fixed heist for failure cases: A camera, C shaft, B door, D camera.
const fixed: Heist = {
  seed: 'fixed',
  rooms: { A: 'camera', B: 'door', C: 'shaft', D: 'camera' },
  codes: { B: 37, V: 64 },
  decoys: {},
  clues: { A: [], B: [], C: [], D: [] },
  lockHints: {},
};
const good: Plan = { bag: ['jammer', 'rope'], steps: [{ use: 'jammer' }, { move: 'A' }, { use: 'rope' }, { move: 'C' }, { enter: 'V', code: 64 }, { move: 'Vault' }] };

test('a correct plan clears', () => {
  const r = simulate(fixed, good);
  assert.ok(r.cleared, r.reason);
  assert.equal(r.alarm, 0);
});

test('overweight bag is rejected before entry', () => {
  const r = simulate(fixed, { bag: ['cutter', 'drill', 'rope'], steps: [{ move: 'A' }] });
  assert.equal(r.failedAt, -1);
  assert.match(r.reason, /12\/8/);
});

test('missing or unready gear fails with a readable reason', () => {
  assert.match(simulate(fixed, { bag: ['jammer'], steps: [{ move: 'A' }] }).reason, /camera\. No jammer ready/);
  assert.match(simulate(fixed, { bag: [], steps: [{ use: 'jammer' }] }).reason, /No jammer in the bag/);
  const misread = simulate(fixed, { bag: ['jammer'], steps: [{ use: 'jammer' }, { move: 'A' }, { use: 'jammer' }, { move: 'C' }] });
  assert.match(misread.reason, /shaft\. No rope ready/);
  assert.equal(misread.failedAt, 3);
});

test('wrong codes raise the alarm; one is survivable, two are not', () => {
  const once = simulate(fixed, { ...good, steps: [...good.steps.slice(0, 4), { enter: 'V', code: 1 }, ...good.steps.slice(4)] });
  assert.ok(once.cleared);
  assert.equal(once.alarm, 3);
  const twice = simulate(fixed, { ...good, steps: [...good.steps.slice(0, 4), { enter: 'V', code: 1 }, { enter: 'V', code: 2 }] });
  assert.ok(!twice.cleared);
  assert.match(twice.reason, /Alarm \(6\/5\)/);
});

test('a backup code is allowed: entering an open lock does nothing', () => {
  const backup: Plan = { ...good, steps: [...good.steps.slice(0, 4), { enter: 'V', code: 1 }, { enter: 'V', code: 64 }, { enter: 'V', code: 2 }, { move: 'Vault' }] };
  const r = simulate(fixed, backup);
  assert.ok(r.cleared, r.reason);
  assert.equal(r.alarm, 3);
});

test('drill opens a lock once; a second drill trips the alarm', () => {
  const plan: Plan = { bag: ['jammer', 'drill'], steps: [{ drill: 'B' }, { move: 'B' }, { use: 'jammer' }, { move: 'D' }, { drill: 'V' }] };
  const r = simulate(fixed, plan);
  assert.equal(r.failedAt, 4);
  assert.match(r.reason, /8\/5/);
  const ok = simulate(fixed, { bag: ['jammer', 'drill'], steps: [{ drill: 'B' }, { move: 'B' }, { use: 'jammer' }, { move: 'D' }, { enter: 'V', code: 64 }, { move: 'Vault' }] });
  assert.ok(ok.cleared, ok.reason);
});

test('locked doors, bad moves and short plans fail', () => {
  assert.match(simulate(fixed, { bag: [], steps: [{ move: 'B' }] }).reason, /Room B is locked/);
  assert.match(simulate(fixed, { bag: [], steps: [{ move: 'C' }] }).reason, /not reachable/);
  assert.match(simulate(fixed, { bag: ['jammer'], steps: [{ use: 'jammer' }, { move: 'A' }] }).reason, /short of the vault/);
  assert.match(simulate(fixed, { bag: [], steps: [{ enter: 'D', code: 1 }] }).reason, /no lock D/);
});

test('parsePlan rejects malformed plans', () => {
  assert.equal(typeof parsePlan({ bag: ['laser'], steps: [{ move: 'A' }] }), 'string');
  assert.equal(typeof parsePlan({ bag: ['jammer', 'jammer'], steps: [{ move: 'A' }] }), 'string');
  assert.equal(typeof parsePlan({ bag: [], steps: [{ enter: 'V', code: 100 }] }), 'string');
  assert.equal(typeof parsePlan({ bag: [], steps: [{ move: 'A', use: 'rope' }] }), 'string');
  assert.equal(typeof parsePlan({ bag: [], steps: [] }), 'string');
});

test('replay is deterministic and enforces one plan inside the clock', () => {
  const seed = seeds[7];
  const plan = solve(generateHeist(seed))!;
  const log: LogEvent[] = [{ t: 0, kind: 'start', runId: 'x', player: null, chainRunId: null }, { t: 1000, kind: 'plan', plan }];
  assert.deepEqual(replay(seed, log), replay(seed, log));
  assert.equal(replay(seed, log).outcome, 'cleared');
  assert.match(replay(seed, [{ ...log[1], t: RUN_SECONDS * 1000 + 1 }]).reason, /clock ran out/);
  assert.match(replay(seed, [log[1], log[1]]).reason, /exactly one plan/);
  assert.equal(replay(seeds[8], log).outcome === 'cleared', simulate(generateHeist(seeds[8]), plan).cleared);
});

test('every route that fits the bag needs at least two codes', () => {
  for (const s of seeds) {
    const h = generateHeist(s);
    const fits = routes().filter((r) => planRoute(r, { rooms: h.rooms, codes: h.codes }) !== null);
    assert.ok(fits.length > 0);
    for (const r of fits) {
      assert.ok(locksOnRoute(r, h.rooms).length >= 2, `${s}: ${r.join('>')}`);
      assert.ok(planRoute(r, { rooms: h.rooms, codes: h.codes })!.bag.length >= 1, `${s}: ${r.join('>')} needs no gear`);
    }
  }
});

test('loud scouting: probes past the second on a room raise the starting alarm', () => {
  const probe = (room: string): LogEvent => ({ t: 1, kind: 'probe', room, tier: 1, clue: '' });
  assert.equal(suspicion([probe('A'), probe('A')]), 0);
  assert.equal(suspicion([probe('A'), probe('A'), probe('A'), probe('B'), probe('A')]), 2);
  const withWrong: Plan = { ...good, steps: [...good.steps.slice(0, 4), { enter: 'V', code: 1 }, ...good.steps.slice(4)] };
  assert.ok(simulate(fixed, withWrong, 2).cleared, 'alarm 2 + 3 = 5 is still inside the budget');
  const r = simulate(fixed, withWrong, 3);
  assert.ok(!r.cleared);
  assert.match(r.reason, /6\/5/);
  assert.match(simulate(fixed, good, 6).reason, /too loud/);
});

test('clue tiers: tier 1 tells all four apart, tier 2 only narrows to a pair, tier 3 is clear', async () => {
  const { ROOM_CLUES } = await import('../src/content.ts');
  const { readClear, readMetaphor } = await import('../lead/scripted.ts');
  for (const [ob, tiers] of Object.entries(ROOM_CLUES)) {
    for (const clue of tiers[0]) assert.equal(readMetaphor(clue), ob, clue);
    for (const clue of tiers[1]) assert.equal(readClear(clue), null, `tier 2 should not decide: ${clue}`);
    for (const clue of tiers[2]) assert.equal(readClear(clue), ob, clue);
  }
  assert.deepEqual(ROOM_CLUES.camera[1], ROOM_CLUES.laser[1]);
  assert.deepEqual(ROOM_CLUES.shaft[1], ROOM_CLUES.door[1]);
});
