import {
  GEAR, BAG_CAPACITY, ALARM_BUDGET, ALARM_WRONG_CODE, ALARM_DRILL,
  neighbors, isGear, isRoom, type Gear, type Place, type RoomId,
} from './rules.ts';
import type { Heist, LockId } from './heist.ts';

export type Step =
  | { move: Place }
  | { use: Gear }
  | { enter: LockId; code: number }
  | { drill: LockId };

export interface Plan {
  bag: Gear[];
  steps: Step[];
}

export interface TraceLine {
  i: number; // step index, -1 for the pre-entry bag check
  step?: Step;
  at: Place;
  alarm: number;
  note: string;
}

export interface SimResult {
  cleared: boolean;
  reason: string; // why it failed, or 'Reached the vault.'
  failedAt: number | null; // step index, -1 = rejected before entry
  alarm: number;
  trace: TraceLine[];
}

const MAX_STEPS = 64;

// Parse untrusted JSON into a Plan, or return an error message.
export function parsePlan(x: unknown): Plan | string {
  if (!x || typeof x !== 'object') return 'plan must be an object with "bag" and "steps"';
  const { bag, steps } = x as { bag?: unknown; steps?: unknown };
  if (!Array.isArray(bag) || !bag.every(isGear)) return `"bag" must be a list of gear: ${Object.keys(GEAR).join(', ')}`;
  if (new Set(bag).size !== bag.length) return '"bag" lists the same gear twice';
  if (!Array.isArray(steps) || steps.length === 0) return '"steps" must be a non-empty list';
  if (steps.length > MAX_STEPS) return `at most ${MAX_STEPS} steps`;
  const out: Step[] = [];
  for (const [i, s] of steps.entries()) {
    const st = parseStep(s);
    if (typeof st === 'string') return `step ${i}: ${st}`;
    out.push(st);
  }
  return { bag: bag as Gear[], steps: out };
}

function isLock(x: unknown): x is LockId {
  return x === 'V' || isRoom(x);
}

function parseStep(s: unknown): Step | string {
  if (!s || typeof s !== 'object') return 'each step is an object';
  const o = s as Record<string, unknown>;
  const keys = Object.keys(o);
  if ('move' in o && keys.length === 1) {
    const p = o.move;
    if (p === 'Lobby' || p === 'Vault' || isRoom(p)) return { move: p };
    return 'move to Lobby, A, B, C, D or Vault';
  }
  if ('use' in o && keys.length === 1) return isGear(o.use) ? { use: o.use } : 'use one of the gear names';
  if ('drill' in o && keys.length === 1) return isLock(o.drill) ? { drill: o.drill } : 'drill a lock: A-D or V';
  if ('enter' in o && 'code' in o && keys.length === 2) {
    if (!isLock(o.enter)) return 'enter a lock: A-D or V';
    if (!Number.isInteger(o.code) || (o.code as number) < 0 || (o.code as number) > 99) return 'code is an integer 0-99';
    return { enter: o.enter, code: o.code as number };
  }
  return 'step must be {"move"}, {"use"}, {"enter","code"} or {"drill"}';
}

function lockFor(h: Heist, target: Place): LockId | null {
  if (target === 'Vault') return 'V';
  if (isRoom(target) && h.rooms[target] === 'door') return target;
  return null;
}

// Pure: same heist and plan always give the same result.
export function simulate(h: Heist, plan: Plan): SimResult {
  const trace: TraceLine[] = [];
  const weight = plan.bag.reduce((w, g) => w + GEAR[g].weight, 0);
  const fail = (i: number, at: Place, alarm: number, reason: string, step?: Step): SimResult => {
    trace.push({ i, step, at, alarm, note: reason });
    return { cleared: false, reason, failedAt: i, alarm, trace };
  };
  if (weight > BAG_CAPACITY) return fail(-1, 'Lobby', 0, `Bag weighs ${weight}/${BAG_CAPACITY}. Plan rejected before entry.`);
  trace.push({ i: -1, at: 'Lobby', alarm: 0, note: `Bag packed: ${plan.bag.join(', ') || 'empty'} (${weight}/${BAG_CAPACITY}).` });

  let at: Place = 'Lobby';
  let alarm = 0;
  let prepared: Gear | null = null; // gear used on the immediately preceding step
  const open = new Set<LockId>();

  for (const [i, step] of plan.steps.entries()) {
    const prev = prepared;
    prepared = null;
    if ('use' in step) {
      if (!plan.bag.includes(step.use)) return fail(i, at, alarm, `No ${step.use} in the bag.`, step);
      prepared = step.use;
      trace.push({ i, step, at, alarm, note: `Readied the ${step.use}.` });
      continue;
    }
    if ('enter' in step || 'drill' in step) {
      const lock = 'enter' in step ? step.enter : step.drill;
      const lockedTarget = neighbors(at).find((n) => lockFor(h, n) === lock);
      if (!lockedTarget) return fail(i, at, alarm, `There is no lock ${lock} next to ${at}.`, step);
      if ('drill' in step) {
        if (!plan.bag.includes('drill')) return fail(i, at, alarm, 'No drill in the bag.', step);
        alarm += ALARM_DRILL;
        if (alarm > ALARM_BUDGET) return fail(i, at, alarm, `Drilled lock ${lock}. The noise trips the alarm (${alarm}/${ALARM_BUDGET}).`, step);
        open.add(lock);
        trace.push({ i, step, at, alarm, note: `Drilled lock ${lock} open (alarm ${alarm}/${ALARM_BUDGET}).` });
        continue;
      }
      if (h.codes[lock] === step.code) {
        open.add(lock);
        trace.push({ i, step, at, alarm, note: `Code ${step.code} opens lock ${lock}.` });
        continue;
      }
      alarm += ALARM_WRONG_CODE;
      if (alarm > ALARM_BUDGET) return fail(i, at, alarm, `Code ${step.code} is wrong for lock ${lock}. Alarm (${alarm}/${ALARM_BUDGET}).`, step);
      trace.push({ i, step, at, alarm, note: `Code ${step.code} is wrong for lock ${lock} (alarm ${alarm}/${ALARM_BUDGET}).` });
      continue;
    }
    // move
    const to = step.move;
    if (!neighbors(at).includes(to)) return fail(i, at, alarm, `${to} is not reachable from ${at}.`, step);
    const lock = lockFor(h, to);
    if (lock && !open.has(lock)) return fail(i, at, alarm, `${to === 'Vault' ? 'The vault door' : `Room ${to}`} is locked.`, step);
    if (isRoom(to)) {
      const ob = h.rooms[to as RoomId];
      if (ob !== 'door') {
        const need = (Object.keys(GEAR) as Gear[]).find((g) => GEAR[g].beats === ob)!;
        if (prev !== need) {
          const why = ob === 'shaft'
            ? `Room ${to}: a shaft. No rope ready. Can't cross.`
            : `Room ${to}: ${ob === 'camera' ? 'a camera' : 'a laser grid'}. No ${need} ready. Alarm.`;
          return fail(i, at, ob === 'shaft' ? alarm : ALARM_BUDGET + 1, why, step);
        }
      }
    }
    at = to;
    if (to === 'Vault') {
      trace.push({ i, step, at, alarm, note: 'Reached the vault.' });
      return { cleared: true, reason: 'Reached the vault.', failedAt: null, alarm, trace };
    }
    trace.push({ i, step, at, alarm, note: `Moved into ${to}.` });
  }
  return fail(plan.steps.length, at, alarm, `Plan ended in ${at}, short of the vault.`);
}
