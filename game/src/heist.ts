import { createHash } from 'node:crypto';
import { ROOMS, OBSTACLES, CLUE_TIERS, type Obstacle, type RoomId } from './rules.ts';
import { ROOM_CLUES, parityHint, digitSumHint, lastDigitHint } from './content.ts';

export type LockId = RoomId | 'V';

export interface Heist {
  seed: string;
  rooms: Record<RoomId, Obstacle>;
  codes: Partial<Record<LockId, number>>; // one per door room, plus the vault 'V'
  clues: Record<RoomId, string[]>; // CLUE_TIERS entries
  lockHints: Partial<Record<LockId, string[]>>; // 3 tiers
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Deterministic stream of 32-bit numbers from a seed string.
function rng(seed: string): () => number {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let pos = 0;
  return () => {
    if (pos + 4 > buf.length) {
      buf = createHash('sha256').update(`${seed}#${counter++}`).digest();
      pos = 0;
    }
    const v = buf.readUInt32BE(pos);
    pos += 4;
    return v;
  };
}

// Each run gets its own heist: seed = H(mission secret, run id). Revealing the secret later
// lets anyone re-derive and verify every run's heist.
export function runSeed(missionSecret: string, runId: string): string {
  return sha256Hex(`${missionSecret}:${runId}`);
}

export function generateHeist(seed: string): Heist {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[next() % xs.length];

  // Short routes are A→C and B→D. Keep them on different obstacle mixes so the choice matters.
  let rooms: Record<RoomId, Obstacle>;
  do {
    rooms = { A: pick(OBSTACLES), B: pick(OBSTACLES), C: pick(OBSTACLES), D: pick(OBSTACLES) };
  } while (sameMix([rooms.A, rooms.C], [rooms.B, rooms.D]) || ROOMS.every((r) => rooms[r] === 'door'));

  const codes: Partial<Record<LockId, number>> = { V: next() % 100 };
  for (const r of ROOMS) if (rooms[r] === 'door') codes[r] = next() % 100;

  const clues = {} as Record<RoomId, string[]>;
  for (const r of ROOMS) {
    const bank = ROOM_CLUES[rooms[r]];
    clues[r] = Array.from({ length: CLUE_TIERS }, (_, t) => pick(bank[t]));
  }

  const lockHints: Partial<Record<LockId, string[]>> = {};
  for (const [lock, code] of Object.entries(codes) as [LockId, number][]) {
    lockHints[lock] = [parityHint(code, next() % 40), digitSumHint(code, next()), lastDigitHint(code, next())];
  }

  return { seed, rooms, codes, clues, lockHints };
}

function sameMix(a: Obstacle[], b: Obstacle[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}

export function locksOf(h: Heist): LockId[] {
  return Object.keys(h.codes) as LockId[];
}
