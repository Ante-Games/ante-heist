// Fixed rules of the heist. Every number here is a starting value to tune.

export const ROOMS = ['A', 'B', 'C', 'D'] as const;
export type RoomId = (typeof ROOMS)[number];
export type Place = 'Lobby' | RoomId | 'Vault';

// Lobby → A/B, A ↔ B, A → C, B → D, C/D → Vault.
export const EDGES: ReadonlyArray<readonly [Place, Place]> = [
  ['Lobby', 'A'], ['Lobby', 'B'], ['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'Vault'], ['D', 'Vault'],
];

export const OBSTACLES = ['camera', 'laser', 'shaft', 'door'] as const;
export type Obstacle = (typeof OBSTACLES)[number];

export const GEAR = {
  jammer: { weight: 4, beats: 'camera' },
  cutter: { weight: 5, beats: 'laser' },
  rope: { weight: 3, beats: 'shaft' },
  drill: { weight: 4, beats: 'door' },
} as const;
export type Gear = keyof typeof GEAR;
export const GEAR_NAMES = Object.keys(GEAR) as Gear[];

export const BAG_CAPACITY = 8;
export const ALARM_BUDGET = 5;
export const ALARM_WRONG_CODE = 3;
export const ALARM_DRILL = 4;

export const RUN_SECONDS = 300;
export const PROBE_SECONDS = 8;
export const BENCH_SECONDS = 5;
export const CLUE_TIERS = 3; // probe 1, 2, 3+ of the same room
// Loud scouting: every probe of a room past this many adds +1 to the plan's starting alarm.
export const QUIET_PROBES = 2;
export const LOCK_HINT_AT = [2, 4] as const; // bench attempts that unlock free hint tiers 1-2; tier 3 is sold by the cryptographer
export const BENCH_MAX = 5; // bench tests per lock: no brute force over 0-99
export const MAX_DRY_RUNS = 2;
export const MAX_ANALYST = 3; // analyst questions per run
export const ANALYST_QUESTION_MAX = 800; // characters

export const NPCS = ['scout', 'cryptographer', 'operator', 'analyst'] as const;
export type Npc = (typeof NPCS)[number];
// Prices in yoctoNEAR (1 NEAR = 10^24). Mirrored by the contract's defaults.
export const NPC_PRICE_YOCTO: Record<Npc, bigint> = {
  scout: 25n * 10n ** 22n, // 0.25 NEAR
  cryptographer: 4n * 10n ** 23n, // 0.4 NEAR
  operator: 4n * 10n ** 23n, // 0.4 NEAR
  analyst: 10n ** 23n, // 0.1 NEAR; set on chain by the owner (scripts/add-analyst.ts)
};
export const REWARD_YOCTO = 10n ** 24n; // 1 NEAR

export function neighbors(p: Place): Place[] {
  const out: Place[] = [];
  for (const [a, b] of EDGES) {
    if (a === p) out.push(b);
    else if (b === p) out.push(a);
  }
  return out;
}

export function isRoom(x: unknown): x is RoomId {
  return typeof x === 'string' && (ROOMS as readonly string[]).includes(x);
}

export function isGear(x: unknown): x is Gear {
  return typeof x === 'string' && x in GEAR;
}

export function isNpc(x: unknown): x is Npc {
  return typeof x === 'string' && (NPCS as readonly string[]).includes(x);
}

// NPC names are lowercase everywhere; "Scout" is accepted too.
export function asNpc(x: unknown): Npc | null {
  const n = typeof x === 'string' ? x.toLowerCase() : x;
  return isNpc(n) ? n : null;
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
