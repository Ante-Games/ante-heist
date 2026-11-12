import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOMS, EDGES, GEAR, BAG_CAPACITY, ALARM_BUDGET, ALARM_WRONG_CODE, ALARM_DRILL, RUN_SECONDS,
  PROBE_SECONDS, BENCH_SECONDS, CLUE_TIERS, QUIET_PROBES, LOCK_HINT_AT, BENCH_MAX, MAX_DRY_RUNS, MAX_ANALYST, ANALYST_QUESTION_MAX,
  NPC_PRICE_YOCTO, REWARD_YOCTO,
  formatNear, isRoom, asNpc, type Npc, type RoomId,
} from './rules.ts';
import { generateHeist, runSeed, sha256Hex, type Heist, type LockId } from './heist.ts';
import { parsePlan, simulate } from './sim.ts';
import { replay, suspicion, type LogEvent, type Verdict } from './checker.ts';
import type { Chain } from './chain.ts';
import type { Analyst } from './analyst.ts';

export class GameError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// What a hire paid, and the on-chain proof when the player sent the hire transaction hash.
interface HirePayment { receipt: string; paid?: string; paidTo?: string; tx?: string; explorer?: string }

interface Run {
  id: string;
  seed: string;
  heist: Heist;
  player: string | null;
  chainRunId: string | null;
  startedAt: number; // epoch ms
  log: LogEvent[];
  probes: Partial<Record<RoomId, number>>;
  attempts: Partial<Record<LockId, number>>;
  boughtTier: Partial<Record<LockId, number>>;
  opened: Set<LockId>;
  busy: Set<string>;
  receipts: Set<string>;
  verdict: Verdict | null;
}

export interface RunsOptions {
  missionSecret: string;
  chain: Chain;
  timeScale?: number; // multiplies probe/bench durations; 0 in tests
  now?: () => number;
  dataDir?: string | null;
  analyst?: Analyst | null; // the language-model NPC; null or missing turns it off
}

export const ANALYST_NOTE = 'An opinion from a language model that saw only what you have seen in this run. It does not know the building and it can be wrong.';

// What the analyst is told: only things the player has already been shown in this run.
export function observations(log: LogEvent[], secondsLeft: number): string[] {
  const out: string[] = [];
  for (const e of log) {
    if (e.kind === 'probe') out.push(`Probe of room ${e.room} (tier ${e.tier} clue): "${e.clue}"`);
    else if (e.kind === 'bench') out.push(`Bench test on lock ${e.lock}: ${String(e.guess).padStart(2, '0')} ${e.open ? 'OPENED it' : 'did not open it'}${e.hint ? `. New hint for lock ${e.lock}: "${e.hint}"` : ''}`);
    else if (e.kind === 'hire') {
      const a = (e.answer ?? {}) as Record<string, unknown>;
      if (e.npc === 'scout') out.push(`Scout NPC report (always true): ${String(a.report)}`);
      else if (e.npc === 'cryptographer') out.push(`Cryptographer NPC on lock ${e.target} (always true): ${a.hints ? `hints so far: ${(a.hints as string[]).map((h) => `"${h}"`).join(' ')}` : String(a.report)}`);
      else if (e.npc === 'operator') out.push(`Operator NPC dry run of a draft plan (always true): ${String(a.verdict)}${a.reason ? ` Step ${String(a.failedAtStep)}: ${String(a.reason)}` : ''}`);
    }
  }
  out.push(`Alarm the plan would start with now: ${suspicion(log)} of ${ALARM_BUDGET}.`);
  out.push(`Time left on the clock: about ${Math.max(0, Math.round(secondsLeft))} seconds.`);
  return out;
}

export function rulesSummary(timeScale = 1, analyst: Analyst | null = null) {
  return {
    map: { places: ['Lobby', ...ROOMS, 'Vault'], edges: EDGES },
    gear: GEAR,
    bagCapacity: BAG_CAPACITY,
    alarm: { budget: ALARM_BUDGET, wrongCode: ALARM_WRONG_CODE, drill: ALARM_DRILL },
    clock: { runSeconds: RUN_SECONDS, probeSeconds: PROBE_SECONDS * timeScale, benchSeconds: BENCH_SECONDS * timeScale },
    clueTiers: CLUE_TIERS,
    loudScouting: `each probe of a room beyond the ${QUIET_PROBES}nd adds +1 to your plan's starting alarm`,
    lockHintsAtAttempts: LOCK_HINT_AT,
    benchTestsPerLock: BENCH_MAX,
    maxDryRuns: MAX_DRY_RUNS,
    maxAnalystQuestions: MAX_ANALYST,
    reward: `${formatNear(REWARD_YOCTO)} NEAR`,
    npcs: {
      scout: { price: `${formatNear(NPC_PRICE_YOCTO.scout)} NEAR`, sells: 'a plain report of one room: {"npc":"scout","room":"A"}' },
      cryptographer: { price: `${formatNear(NPC_PRICE_YOCTO.cryptographer)} NEAR`, sells: 'the next hint tier for one lock: {"npc":"cryptographer","lock":"V"}' },
      operator: { price: `${formatNear(NPC_PRICE_YOCTO.operator)} NEAR`, sells: `a dry run of a draft plan, first failing step (max ${MAX_DRY_RUNS}): {"npc":"operator","plan":{...}}` },
      analyst: {
        price: `${formatNear(NPC_PRICE_YOCTO.analyst)} NEAR`,
        sells: `a language model's opinion on what you have seen so far (max ${MAX_ANALYST}, can be wrong): {"npc":"analyst","question":"..."}`,
        available: analyst !== null,
        ...(analyst ? { provider: analyst.provider, models: analyst.models } : { note: 'this server has no model configured, so the analyst is off' }),
      },
    },
  };
}

export class Runs {
  private runs = new Map<string, Run>();
  private chainRuns = new Map<string, string>();
  private ended = new Map<string, unknown>(); // transcripts of finished runs loaded from disk
  private timeScale: number;
  private now: () => number;
  readonly commitment: string;

  private o: RunsOptions;

  constructor(o: RunsOptions) {
    this.o = o;
    this.timeScale = o.timeScale ?? 1;
    this.now = o.now ?? Date.now;
    this.commitment = sha256Hex(o.missionSecret);
    if (o.dataDir) {
      mkdirSync(o.dataDir, { recursive: true });
      for (const f of readdirSync(o.dataDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const t = JSON.parse(readFileSync(join(o.dataDir, f), 'utf8')) as { runId: string };
          this.ended.set(t.runId, t);
        } catch { /* skip unreadable transcript */ }
      }
    }
  }

  rules() {
    return rulesSummary(this.timeScale, this.o.analyst ?? null);
  }

  private get(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new GameError(404, `no active run ${id}`);
    return r;
  }

  private t(r: Run): number {
    return this.now() - r.startedAt;
  }

  private live(r: Run): void {
    if (r.verdict) throw new GameError(409, 'this run is over');
    if (this.t(r) > RUN_SECONDS * 1000) throw new GameError(410, `the ${RUN_SECONDS}s clock ran out; submit nothing more`);
  }

  private async spend(r: Run, key: string, seconds: number): Promise<void> {
    if (r.busy.has(key)) throw new GameError(429, `${key} is busy; one at a time per room or lock`);
    r.busy.add(key);
    try {
      const ms = seconds * 1000 * this.timeScale;
      if (ms > 0) await new Promise((res) => setTimeout(res, ms));
    } finally {
      r.busy.delete(key);
    }
  }

  async create(body: { player?: unknown; chainRunId?: unknown }) {
    const player = typeof body.player === 'string' ? body.player : null;
    const chainRunId = body.chainRunId == null ? null : String(body.chainRunId);
    if (chainRunId && this.chainRuns.has(chainRunId)) throw new GameError(409, `chain run ${chainRunId} already has a heist: ${this.chainRuns.get(chainRunId)}`);
    const check = await this.o.chain.checkStart(chainRunId, player);
    if (!check.ok) throw new GameError(400, check.error ?? 'chain check failed');
    const id = chainRunId ? `chain-${chainRunId}` : randomUUID();
    const seed = runSeed(this.o.missionSecret, id);
    const r: Run = {
      id, seed, heist: generateHeist(seed), player, chainRunId, startedAt: this.now(), log: [],
      probes: {}, attempts: {}, boughtTier: {}, opened: new Set(), busy: new Set(), receipts: new Set(), verdict: null,
    };
    r.log.push({ t: 0, kind: 'start', runId: id, player, chainRunId });
    this.runs.set(id, r);
    if (chainRunId) this.chainRuns.set(chainRunId, id);
    return { runId: id, deadline: new Date(r.startedAt + RUN_SECONDS * 1000).toISOString(), commitment: this.commitment, rules: this.rules() };
  }

  async probe(id: string, room: unknown) {
    const r = this.get(id);
    this.live(r);
    if (!isRoom(room)) throw new GameError(400, 'probe a room: A, B, C or D');
    await this.spend(r, `probe ${room}`, PROBE_SECONDS);
    const n = (r.probes[room] = (r.probes[room] ?? 0) + 1);
    const tier = Math.min(n, CLUE_TIERS);
    const clue = r.heist.clues[room][tier - 1];
    r.log.push({ t: this.t(r), kind: 'probe', room, tier, clue });
    return { room, tier, clue, probes: n, startingAlarm: suspicion(r.log) };
  }

  private hintTier(r: Run, lock: LockId): number {
    const fromAttempts = (LOCK_HINT_AT as readonly number[]).filter((a) => (r.attempts[lock] ?? 0) >= a).length;
    return Math.min(3, Math.max(fromAttempts, r.boughtTier[lock] ?? 0));
  }

  private hints(r: Run, lock: LockId): string[] {
    return (r.heist.lockHints[lock] ?? []).slice(0, this.hintTier(r, lock));
  }

  async bench(id: string, lock: unknown, guess: unknown) {
    const r = this.get(id);
    this.live(r);
    if (lock !== 'V' && !isRoom(lock)) throw new GameError(400, 'bench a lock: A-D or V');
    if (!Number.isInteger(guess) || (guess as number) < 0 || (guess as number) > 99) throw new GameError(400, 'guess is an integer 0-99');
    if (r.opened.has(lock)) throw new GameError(409, `lock ${lock} already opened on the bench; use that code in your plan`);
    if ((r.attempts[lock] ?? 0) >= BENCH_MAX) throw new GameError(409, `the bench allows ${BENCH_MAX} tests per lock and lock ${lock} has used them; read the hints, hire the cryptographer, or drill`);
    await this.spend(r, `bench ${lock}`, BENCH_SECONDS);
    const before = this.hintTier(r, lock);
    r.attempts[lock] = (r.attempts[lock] ?? 0) + 1;
    const open = r.heist.codes[lock] !== undefined && r.heist.codes[lock] === guess; // non-door rooms never open
    if (open) r.opened.add(lock);
    const after = this.hintTier(r, lock);
    const hint = after > before ? r.heist.lockHints[lock]![after - 1] : null;
    r.log.push({ t: this.t(r), kind: 'bench', lock, guess: guess as number, open, hint });
    return { lock, guess, open, attempts: r.attempts[lock], testsLeft: BENCH_MAX - r.attempts[lock]!, hints: this.hints(r, lock), newHint: hint };
  }

  async hire(id: string, body: { npc?: unknown; room?: unknown; lock?: unknown; plan?: unknown; question?: unknown; payment?: unknown }) {
    const r = this.get(id);
    this.live(r);
    const npc = asNpc(body.npc);
    if (!npc) throw new GameError(400, 'npc is scout, cryptographer, operator or analyst');
    let target: string;
    let answer: unknown;
    const pay = async () => {
      const c = await this.o.chain.checkHire(r.chainRunId, npc as Npc, body.payment, r.receipts);
      if (!c.ok) throw new GameError(402, c.error ?? 'payment not found');
      r.receipts.add(c.receipt);
      payment = { receipt: c.receipt, paid: c.paid, paidTo: c.paidTo, tx: c.tx, explorer: c.explorer };
      return c.receipt;
    };
    let payment: HirePayment = { receipt: '' };
    let receipt: string;
    if (npc === 'scout') {
      if (!isRoom(body.room)) throw new GameError(400, 'scout needs "room": A-D');
      receipt = await pay();
      target = body.room;
      answer = { room: body.room, report: `Room ${body.room} holds ${describe(r.heist.rooms[body.room])}.` };
    } else if (npc === 'cryptographer') {
      const lock = body.lock;
      if (lock !== 'V' && !isRoom(lock)) throw new GameError(400, 'cryptographer needs "lock": A-D or V');
      if (this.hintTier(r, lock) >= 3) throw new GameError(409, `every hint for lock ${lock} is already unlocked`);
      receipt = await pay();
      target = lock;
      if (r.heist.codes[lock] === undefined) {
        answer = { lock, report: `There is no lock in Room ${lock}. Whatever is on your bench there will never open.` };
      } else {
        r.boughtTier[lock] = this.hintTier(r, lock) + 1;
        answer = { lock, hints: this.hints(r, lock) };
      }
    } else if (npc === 'operator') {
      const used = r.log.filter((e) => e.kind === 'hire' && e.npc === 'operator').length;
      if (used >= MAX_DRY_RUNS) throw new GameError(409, `the operator only does ${MAX_DRY_RUNS} dry runs per heist`);
      const plan = parsePlan(body.plan);
      if (typeof plan === 'string') throw new GameError(400, `operator: ${plan}`);
      receipt = await pay();
      target = 'plan';
      const sim = simulate(r.heist, plan, suspicion(r.log));
      answer = sim.cleared ? { verdict: 'This plan reaches the vault.' } : { verdict: 'This plan fails.', failedAtStep: sim.failedAt, reason: sim.reason };
    } else {
      // The analyst is the only NPC that runs a model. It is never shown the heist.
      const analyst = this.o.analyst;
      if (!analyst) throw new GameError(503, 'the analyst is not available on this server (no model configured); nothing was spent');
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question || question.length > ANALYST_QUESTION_MAX) throw new GameError(400, `analyst needs "question": 1-${ANALYST_QUESTION_MAX} characters`);
      const used = r.log.filter((e) => e.kind === 'hire' && e.npc === 'analyst').length;
      if (used >= MAX_ANALYST) throw new GameError(409, `the analyst only answers ${MAX_ANALYST} questions per heist`);
      if (r.busy.has('analyst')) throw new GameError(429, 'the analyst is busy; one question at a time');
      r.busy.add('analyst');
      try {
        receipt = await pay();
        target = 'question';
        try {
          const reply = await analyst.ask({ observations: observations(r.log, RUN_SECONDS - this.t(r) / 1000), question });
          answer = { question, opinion: reply.text, model: reply.model, note: ANALYST_NOTE };
        } catch (e) {
          // The model did not answer: the payment stays unspent so the same hire can be sent again.
          r.receipts.delete(receipt);
          console.error(`analyst: ${(e as Error).message}`);
          throw new GameError(503, 'the analyst could not answer right now; your payment is not spent, so send the same hire again or carry on without it');
        }
      } finally {
        r.busy.delete('analyst');
      }
    }
    r.log.push({ t: this.t(r), kind: 'hire', npc, target, receipt, answer, ...(payment.tx ? { tx: payment.tx, explorer: payment.explorer } : {}) });
    return { npc, receipt, ...(answer as object), payment };
  }

  async submit(id: string, plan: unknown) {
    const r = this.get(id);
    if (r.verdict) throw new GameError(409, 'this run already submitted its plan');
    r.log.push({ t: this.t(r), kind: 'plan', plan });
    r.verdict = replay(r.seed, r.log);
    let s = await this.o.chain.settle(r.chainRunId, r.verdict.outcome === 'cleared');
    for (let i = 1; !s.ok && i < 3; i++) {
      await new Promise((res) => setTimeout(res, 1500 * i * this.timeScale));
      s = await this.o.chain.settle(r.chainRunId, r.verdict.outcome === 'cleared');
    }
    r.log.push({ t: this.t(r), kind: 'settle', ok: s.ok, detail: s.detail, ...(s.tx ? { tx: s.tx, explorer: s.explorer } : {}) });
    const transcript = this.transcript(r);
    if (this.o.dataDir) writeFileSync(join(this.o.dataDir, `${r.id}.json`), JSON.stringify(transcript, null, 2));
    this.ended.set(r.id, transcript);
    this.runs.delete(r.id);
    return { runId: r.id, status: transcript.status, reason: transcript.reason, replay: transcript.replay, heist: transcript.heist, settlement: transcript.settlement, transcript: `/runs/${r.id}` };
  }

  private transcript(r: Run) {
    const over = r.verdict !== null;
    return {
      runId: r.id,
      player: r.player,
      chainRunId: r.chainRunId,
      startedAt: new Date(r.startedAt).toISOString(),
      status: over ? r.verdict!.outcome : 'active',
      reason: r.verdict?.reason ?? null,
      log: r.log,
      replay: r.verdict?.sim?.trace ?? null,
      // The heist is revealed only after the run ends. Seed = sha256("<mission secret>:<runId>").
      heist: over ? { seed: r.seed, rooms: r.heist.rooms, codes: r.heist.codes } : null,
      settlement: settlementOf(r.log),
      commitment: this.commitment,
    };
  }

  view(id: string) {
    const r = this.runs.get(id);
    if (r) return this.transcript(r);
    const t = this.ended.get(id);
    if (!t) throw new GameError(404, `no run ${id}`);
    return t;
  }

  list() {
    const active = [...this.runs.values()].map((r) => ({ runId: r.id, player: r.player, status: 'active', startedAt: new Date(r.startedAt).toISOString() }));
    const done = [...this.ended.values()].map((t) => {
      const x = t as { runId: string; player: string | null; status: string; startedAt: string; reason: string };
      return { runId: x.runId, player: x.player, status: x.status, startedAt: x.startedAt, reason: x.reason };
    });
    return [...active, ...done].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  // Finished runs grouped by player: most clears first, then fewest NPC hires, then the fastest clear.
  leaderboard() {
    const by = new Map<string, { player: string; runs: number; clears: number; hires: number; fastestClearSeconds: number | null; lastPayout: string | null }>();
    for (const t of this.ended.values()) {
      const x = t as { player: string | null; status: string; log: LogEvent[]; settlement: { explorer: string | null } | null };
      if (!x.player) continue;
      const row = by.get(x.player) ?? { player: x.player, runs: 0, clears: 0, hires: 0, fastestClearSeconds: null, lastPayout: null };
      row.runs++;
      row.hires += x.log.filter((e) => e.kind === 'hire').length;
      if (x.status === 'cleared') {
        row.clears++;
        const plan = x.log.find((e) => e.kind === 'plan');
        const secs = plan ? Math.round(plan.t / 1000) : null;
        if (secs !== null && (row.fastestClearSeconds === null || secs < row.fastestClearSeconds)) row.fastestClearSeconds = secs;
        row.lastPayout = x.settlement?.explorer ?? row.lastPayout;
      }
      by.set(x.player, row);
    }
    return [...by.values()].sort((a, b) => b.clears - a.clears || a.hires - b.hires || (a.fastestClearSeconds ?? 1e9) - (b.fastestClearSeconds ?? 1e9));
  }
}

// The on-chain proof of the payout: the settle_run transaction and its explorer link.
function settlementOf(log: LogEvent[]) {
  const s = [...log].reverse().find((e) => e.kind === 'settle');
  if (!s || s.kind !== 'settle') return null;
  return { ok: s.ok, detail: s.detail, tx: s.tx ?? null, explorer: s.explorer ?? null };
}

function describe(ob: string): string {
  return ob === 'camera' ? 'a security camera' : ob === 'laser' ? 'a laser grid' : ob === 'shaft' ? 'a shaft' : 'a locked door with a two-digit code';
}
