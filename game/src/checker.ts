import { RUN_SECONDS, MAX_DRY_RUNS, QUIET_PROBES } from './rules.ts';
import { generateHeist } from './heist.ts';
import { parsePlan, simulate, type SimResult } from './sim.ts';

// One recorded run. Times are milliseconds since the run started.
export type LogEvent =
  | { t: number; kind: 'start'; runId: string; player: string | null; chainRunId: string | null }
  | { t: number; kind: 'probe'; room: string; tier: number; clue: string }
  | { t: number; kind: 'bench'; lock: string; guess: number; open: boolean; hint: string | null }
  | { t: number; kind: 'hire'; npc: string; target: string; receipt: string; answer: unknown; tx?: string; explorer?: string }
  | { t: number; kind: 'plan'; plan: unknown }
  | { t: number; kind: 'settle'; ok: boolean; detail: string; tx?: string; explorer?: string };

export interface Verdict {
  outcome: 'cleared' | 'failed';
  reason: string;
  sim: SimResult | null;
}

// The deterministic judge: (seed, log) → verdict. Reads only the plan, its time and the seed.
// It never scores how many agents, threads or calls produced the plan.
export function replay(seed: string, log: LogEvent[]): Verdict {
  const plans = log.filter((e) => e.kind === 'plan');
  if (plans.length !== 1) return { outcome: 'failed', reason: `Expected exactly one plan, found ${plans.length}.`, sim: null };
  const dry = log.filter((e) => e.kind === 'hire' && e.npc === 'operator').length;
  if (dry > MAX_DRY_RUNS) return { outcome: 'failed', reason: `More than ${MAX_DRY_RUNS} operator dry runs.`, sim: null };
  const p = plans[0];
  if (p.t > RUN_SECONDS * 1000) return { outcome: 'failed', reason: `Plan arrived after the ${RUN_SECONDS}s clock ran out.`, sim: null };
  const plan = parsePlan(p.plan);
  if (typeof plan === 'string') return { outcome: 'failed', reason: `Invalid plan: ${plan}`, sim: null };
  const sim = simulate(generateHeist(seed), plan, suspicion(log));
  return { outcome: sim.cleared ? 'cleared' : 'failed', reason: sim.reason, sim };
}

// Loud scouting: each probe of a room beyond QUIET_PROBES adds 1 to the plan's starting alarm.
export function suspicion(log: LogEvent[]): number {
  const n: Record<string, number> = {};
  let s = 0;
  for (const e of log) {
    if (e.kind !== 'probe') continue;
    n[e.room] = (n[e.room] ?? 0) + 1;
    if (n[e.room] > QUIET_PROBES) s++;
  }
  return s;
}
