import type { Obstacle } from './rules.ts';

// Room clues by obstacle and tier. Tier 1 is a metaphor, tier 2 a clearer image, tier 3 plain.
// Keep tier 1 and 2 cryptic: literal clues make the scout workstream trivial.
export const ROOM_CLUES: Record<Obstacle, [string[], string[], string[]]> = {
  camera: [
    [
      'Something in this room never blinks.',
      'A patient eye keeps a ledger of everyone who passes.',
      'The corners here always know what the middle is doing.',
    ],
    [
      'A small red light turns slowly from wall to wall.',
      'Glass glints near the ceiling and follows your shadow.',
      'Whatever watches here can be blinded, but not cut.',
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
      'Thin red threads cross the room at knee height.',
      'Fine beams stitch the doorway shut; something sharp would unthread them.',
      'Light is pulled tight across this room like wire.',
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
      'The floor stops halfway; the far side is a long drop away.',
      'Bolts in the ceiling once held something to swing across on.',
      'Only a line from above gets anyone over this gap.',
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
      'A heavy door stands at the far side, with a glowing panel of digits.',
      'Two-digit buttons are worn smooth beside a steel door.',
      'Patience or noise will open the door ahead.',
    ],
    [
      'A steel door with a two-digit keypad; the right number, or a lot of noise, opens it.',
      'A vault-grade door, keypad glowing 0 to 99.',
    ],
  ],
};

export function parityHint(code: number, variant: number): string {
  const even = code % 2 === 0;
  const lo = Math.max(0, Math.min(60, code - (variant % 40)));
  const range = `somewhere from ${lo} to ${lo + 39}`;
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
