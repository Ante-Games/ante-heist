import { GEAR, BAG_CAPACITY, ALARM_BUDGET, ALARM_DRILL, neighbors, isRoom, type Gear, type Obstacle, type Place, type RoomId } from './rules.ts';
import type { Heist, LockId } from './heist.ts';
import type { Plan, Step } from './sim.ts';

const BEATEN_BY: Record<Exclude<Obstacle, 'door'>, Gear> = { camera: 'jammer', laser: 'cutter', shaft: 'rope' };

// All simple paths Lobby → Vault.
export function routes(): Place[][] {
  const out: Place[][] = [];
  const walk = (path: Place[]) => {
    const at = path[path.length - 1];
    if (at === 'Vault') { out.push(path); return; }
    for (const n of neighbors(at)) if (!path.includes(n) && n !== 'Lobby') walk([...path, n]);
  };
  walk(['Lobby']);
  return out;
}

export interface Knowledge {
  rooms: Partial<Record<RoomId, Obstacle>>;
  codes: Partial<Record<LockId, number>>;
}

// Build a plan for a route from what is known. Locks without a known code are drilled if
// the bag and alarm budget allow; returns null if the route can't be planned.
export function planRoute(route: Place[], k: Knowledge): Plan | null {
  const bag = new Set<Gear>();
  const steps: Step[] = [];
  let drills = 0;
  for (const to of route.slice(1)) {
    const lock: LockId | null = to === 'Vault' ? 'V' : isRoom(to) && k.rooms[to] === 'door' ? to : null;
    if (isRoom(to) && k.rooms[to] === undefined) return null;
    if (lock) {
      const code = k.codes[lock];
      if (code !== undefined) steps.push({ enter: lock, code });
      else { bag.add('drill'); drills++; steps.push({ drill: lock }); }
    } else if (isRoom(to)) {
      const g = BEATEN_BY[k.rooms[to] as Exclude<Obstacle, 'door'>];
      bag.add(g);
      steps.push({ use: g });
    }
    steps.push({ move: to });
  }
  const weight = [...bag].reduce((w, g) => w + GEAR[g].weight, 0);
  if (weight > BAG_CAPACITY || drills * ALARM_DRILL > ALARM_BUDGET) return null;
  return { bag: [...bag], steps };
}

// The locks a route needs codes for.
export function locksOnRoute(route: Place[], rooms: Partial<Record<RoomId, Obstacle>>): LockId[] {
  return route.slice(1).filter((p) => p === 'Vault' || (isRoom(p) && rooms[p] === 'door')).map((p) => (p === 'Vault' ? 'V' : p) as LockId);
}

// Full-knowledge best plan: fewest steps. Used by tests to prove every heist is solvable.
export function solve(h: Heist): Plan | null {
  let best: Plan | null = null;
  for (const r of routes()) {
    const p = planRoute(r, { rooms: h.rooms, codes: h.codes });
    if (p && (!best || p.steps.length < best.steps.length)) best = p;
  }
  return best;
}
