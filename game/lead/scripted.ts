// A scripted lead: plays a heist over the HTTP API with no model and no API keys.
// It exists so judges can reproduce a full run with one command. A real agent plays the
// same API from /skill.md.
import { OBSTACLES, ROOMS, GEAR, BAG_CAPACITY, BENCH_MAX, LOCK_HINT_AT, type Obstacle, type RoomId } from '../src/rules.ts';
import { ROOM_CLUES } from '../src/content.ts';
import { routes, planRoute, locksOnRoute, type Knowledge } from '../src/solver.ts';
import type { LockId } from '../src/heist.ts';
import type { Plan } from '../src/sim.ts';

export interface Pay {
  // Returns the "payment" field for a hire: {"mock":true} locally, {"hireIndex":n} on testnet.
  (npc: 'scout' | 'cryptographer' | 'operator'): Promise<unknown>;
}

export interface LeadOptions {
  base: string;
  start?: { player?: string; chainRunId?: string };
  style: 'solo' | 'hire' | 'reckless';
  pay?: Pay;
  log?: (line: string) => void;
}

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  for (;;) {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json()) as T & { error?: string };
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 50)); continue; }
    if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error}`);
    return data;
  }
}

// Reads tier-2 and tier-3 images (and the scout NPC's plain report) back into obstacles.
export function readClear(clue: string): Obstacle | null {
  const c = clue.toLowerCase();
  if (/(\bdoor\b|keypad|digits|buttons|panel)/.test(c)) return 'door';
  if (/(shaft|pit|drop|floor stops|floor simply stops|to land|gap that|bolts|line from above|swing)/.test(c)) return 'shaft';
  if (/(laser|threads|beams|lines of light|red lines|straight lines|pulled tight)/.test(c)) return 'laser';
  if (/(camera|turns when you move|whir|watched|glass|watches|lens|dome)/.test(c)) return 'camera';
  return null;
}

// The scripted lead knows the clue bank by heart, so it reads tier-1 metaphors exactly. It is a
// reproducibility harness, not an AI: a real agent has to interpret the metaphor.
export function readMetaphor(clue: string): Obstacle | null {
  for (const ob of OBSTACLES) if (ROOM_CLUES[ob][0].includes(clue)) return ob;
  return null;
}

// A naive reader for tier-1 metaphors. It is wrong on purpose for some clues (a hum is a laser,
// not a camera), which is how the reckless lead produces a readable failure.
function readHastily(clue: string): Obstacle {
  const c = clue.toLowerCase();
  if (/(hum|storm|eye|blink|watch|corner)/.test(c)) return 'camera';
  if (/(down|drop|fall|breath)/.test(c)) return 'shaft';
  if (/(hundred|number|word|counsel)/.test(c)) return 'door';
  return OBSTACLES[1];
}

// Remaining candidates for a code given the hints seen and the wrong guesses made.
function candidates(hints: string[], wrong: Set<number>): number[] {
  let xs = Array.from({ length: 100 }, (_, i) => i).filter((n) => !wrong.has(n));
  for (const h of hints) {
    const range = h.match(/from (\d+) to (\d+)/);
    if (range) {
      const odd = /leaves one behind|refuses to be halved/.test(h);
      xs = xs.filter((n) => n >= Number(range[1]) && n <= Number(range[2]) && n % 2 === (odd ? 1 : 0));
    }
    const sum = h.match(/(?:weigh|get) (\d+)/);
    if (sum) xs = xs.filter((n) => Math.floor(n / 10) + (n % 10) === Number(sum[1]));
    const last = h.match(/(?:rest on|digit is) (\d)/);
    if (last) xs = xs.filter((n) => n % 10 === Number(last[1]));
  }
  return xs;
}

export async function playScripted(o: LeadOptions): Promise<{ runId: string; transcript: unknown }> {
  const log = o.log ?? (() => {});
  const run = await call<{ runId: string }>(o.base, '/runs', o.start ?? {});
  const id = run.runId;
  const p = (path: string, body: unknown) => call<Record<string, unknown>>(o.base, `/runs/${id}/${path}`, body);
  log(`[${o.style}] run ${id}`);
  const k: Knowledge = { rooms: {}, codes: {} };
  const backups: Partial<Record<LockId, number>> = {};

  // 1. Scout. Rooms are probed in parallel; each room's probes are sequential.
  await Promise.all(ROOMS.map(async (room: RoomId) => {
    if (o.style === 'hire') {
      const r = await p('hire', { npc: 'scout', room, payment: await o.pay!('scout') });
      k.rooms[room] = readClear(String(r.report))!;
      log(`  hired scout: ${r.report}`);
      return;
    }
    if (o.style === 'reckless') {
      const r = await p('probe', { room });
      k.rooms[room] = readHastily(String(r.clue));
      log(`  probe ${room}: "${r.clue}" → guessed ${k.rooms[room]}`);
      return;
    }
    // Read the tier-1 metaphor; probe again (the third probe is loud) only if it can't be read.
    for (;;) {
      const r = await p('probe', { room });
      log(`  probe ${room} (tier ${r.tier}): "${r.clue}"${Number(r.startingAlarm) > 0 ? ` [starting alarm ${r.startingAlarm}]` : ''}`);
      const ob = Number(r.tier) === 1 ? readMetaphor(String(r.clue)) : readClear(String(r.clue));
      if (ob) { k.rooms[room] = ob; log(`    → ${room} is a ${ob}`); return; }
    }
  }));

  // 2. Pick the route that needs the fewest locks, then the lightest bag.
  const options = routes()
    .map((route) => {
      const locks = locksOnRoute(route, k.rooms);
      const draft = planRoute(route, { rooms: k.rooms, codes: Object.fromEntries(locks.map((l) => [l, 0])) });
      const weight = draft ? draft.bag.reduce((w, g) => w + GEAR[g].weight, 0) : Infinity;
      return { route, locks, weight };
    })
    .filter((x) => x.weight <= BAG_CAPACITY)
    .sort((a, b) => a.locks.length - b.locks.length || a.weight - b.weight || a.route.length - b.route.length);
  const choice = options[0];
  log(`  route ${choice.route.join(' → ')} (locks: ${choice.locks.join(', ')}; bag weight ${choice.weight})`);

  // 3. Crack the route's locks in parallel; each lock's bench is one-at-a-time.
  await Promise.all(choice.locks.map(async (lock: LockId) => {
    const wrong = new Set<number>();
    let hints: string[] = [];
    let bought = false;
    for (;;) {
      // The hiring lead uses the free bench hints first, then buys the third hint only if the code is still open.
      if (o.style === 'hire' && !bought && wrong.size >= LOCK_HINT_AT[1] && candidates(hints, wrong).length > 1) {
        const r = await p('hire', { npc: 'cryptographer', lock, payment: await o.pay!('cryptographer') });
        hints = r.hints as string[];
        bought = true;
        log(`  hired cryptographer for ${lock}: ${hints.at(-1)}`);
      }
      const xs = candidates(hints, wrong);
      const guess = o.style === 'reckless' ? xs[Math.floor(xs.length / 2)] : xs[0];
      const r = await p('bench', { lock, guess });
      hints = r.hints as string[];
      if (r.newHint) log(`  lock ${lock} hint: ${r.newHint}`);
      if (r.open) { k.codes[lock] = guess; log(`  lock ${lock} cracked: ${guess} (${r.attempts} attempts)`); return; }
      wrong.add(guess);
      if (Number(r.attempts) >= BENCH_MAX) {
        const [best, next] = candidates(hints, wrong);
        k.codes[lock] = best ?? guess;
        if (next !== undefined) backups[lock] = next;
        log(`  lock ${lock}: bench budget spent; will risk ${k.codes[lock]}${next !== undefined ? ` then ${next}` : ''} in the plan`);
        return;
      }
      if (o.style === 'reckless' && Number(r.attempts) >= 3) { k.codes[lock] = guess + 1; log(`  lock ${lock}: gave up, will try ${guess + 1}`); return; }
    }
  }));

  // 4. Plan, optionally check it with the operator, then submit once.
  const plan: Plan = planRoute(choice.route, k)!;
  // One wrong code (+3) fits the alarm budget, so one lock can carry a backup code.
  const risky = Object.entries(backups)[0] as [LockId, number] | undefined;
  if (risky) {
    const at = plan.steps.findIndex((st) => 'enter' in st && st.enter === risky[0]);
    plan.steps.splice(at + 1, 0, { enter: risky[0], code: risky[1] });
  }
  if (o.style === 'hire') {
    const r = await p('hire', { npc: 'operator', plan, payment: await o.pay!('operator') });
    log(`  hired operator dry run: ${r.verdict}${r.reason ? ' ' + r.reason : ''}`);
  }
  log(`  plan: bag [${plan.bag.join(', ')}], ${plan.steps.length} steps`);
  const t = await p('plan', plan);
  log(`  result: ${String(t.status).toUpperCase()}: ${t.reason}`);
  return { runId: id, transcript: await call<Record<string, unknown>>(o.base, `/runs/${id}`) };
}
