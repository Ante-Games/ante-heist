import type { Obstacle } from './rules.ts';

// Room clues by obstacle and tier. Tier 1 is a metaphor that tells the four apart if read well.
// Tier 2 is deliberately shared by pairs (camera/laser, shaft/door): it narrows, never decides.
// Tier 3 is clear, and costs alarm (loud scouting). Literal tier-1/2 clues make scouting trivial.
export const ROOM_CLUES: Record<Obstacle, [string[], string[], string[]]> = {
  camera: [
    [
      'Something in this room never blinks.',
      'A patient eye keeps a ledger of everyone who passes.',
      'The corners here always know what the middle is doing.',
    ],
    [
      'A thin red light glows somewhere in the room.',
      'Something red and fine catches the dust.',
      'A faint electric whine, and a point of red light.',
    ],
    [
      'A lens on a slow swivel tracks the doorway; blind it and walk through.',
      'A dome of dark glass on the ceiling turns to follow movement.',
    ],
  ],
  laser: [
    [
      'The air here tastes of a coming storm.',
      'The room hums a note just below hearing.',
      'Dust falls here and never reaches the floor in one piece.',
    ],
    [
      'A thin red light glows somewhere in the room.',
      'Something red and fine catches the dust.',
      'A faint electric whine, and a point of red light.',
    ],
    [
      'Red lines of light crisscross the floor at waist height; break one and the room screams.',
      'A lattice of beams fills the room; it can be cut, not walked through.',
    ],
  ],
  shaft: [
    [
      'This room has more down than across.',
      'A cold breath rises from under the floor.',
      'Footsteps here fall a long way before they land.',
    ],
    [
      'The way across is not open to you yet.',
      'Your path stops short here; something has to give.',
      'Cold metal, and no simple way through.',
    ],
    [
      'The floor ends at a deep pit; hooks above could take a line across.',
      'A drop of several floors cuts the room in two; you would have to swing over it.',
    ],
  ],
  door: [
    [
      'This room keeps its own counsel and counts to a hundred.',
      'The way on is closed, and it is waiting for the right word.',
      'Something here only opens for those who know its number.',
    ],
    [
      'The way across is not open to you yet.',
      'Your path stops short here; something has to give.',
      'Cold metal, and no simple way through.',
    ],
    [
      'A steel door with a two-digit keypad; the right number, or a lot of noise, opens it.',
      'A vault-grade door, keypad glowing 0 to 99.',
    ],
  ],
};

export function parityHint(code: number, variant: number): string {
  const even = code % 2 === 0;
  const lo = Math.max(0, Math.min(20, code - (variant % 80)));
  const range = `somewhere from ${lo} to ${lo + 79}`;
  return even
    ? ['It walks in pairs, ', 'Halve it and nothing is left over; it sits '][variant % 2] + range + '.'
    : ['It always leaves one behind when split, ', 'It refuses to be halved cleanly; it sits '][variant % 2] + range + '.';
}

export function digitSumHint(code: number, variant: number): string {
  const s = Math.floor(code / 10) + (code % 10);
  return [`Its two digits together weigh ${s}.`, `Add its digits and you get ${s}.`][variant % 2];
}

export function lastDigitHint(code: number, variant: number): string {
  const d = code % 10;
  return [`It comes to rest on ${d}.`, `Its last digit is ${d}.`][variant % 2];
}
