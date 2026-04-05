/**
 * RSVP layout math — pure, DOM-free, testable.
 *
 * RSVP (Rapid Serial Visual Presentation) anchors each word on an "optimal
 * recognition point" (a.k.a. ORP or pivot) — a single character that should
 * appear at a fixed horizontal position on every frame so the reader's eye
 * can lock in without re-fixating. This module computes everything needed
 * to render a word with its pivot at `PIVOT_POS` inside a fixed-width row
 * of `DISPLAY_CHARS` characters, regardless of word length.
 *
 * Invariant under test: for any non-empty word, `pivotAbsolutePos === PIVOT_POS`.
 * When the word is longer than can fit with its left padding, it overflows
 * to the right by design — the pivot never moves.
 */

export const DISPLAY_CHARS = 20;
export const PIVOT_POS = 10;

/**
 * Spritz-inspired pivot index within the word itself.
 * Shorter words pivot on an earlier letter so the eye doesn't travel far.
 */
export function getPivotIndex(word: string): number {
  const len = [...word].length; // unicode-aware length
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

export interface RsvpLayoutChar {
  char: string;
  isPivot: boolean;
}

export interface RsvpLayout {
  /** Number of invisible padding chars on the left side of the word. */
  leftPad: number;
  /** The word split into characters, flagged with which one is the pivot. */
  chars: RsvpLayoutChar[];
  /** Number of invisible padding chars on the right (0 if word overflows the row). */
  rightPad: number;
  /** Absolute column index of the pivot char, 0-based from the left edge. */
  pivotAbsolutePos: number;
  /**
   * Total column count occupied by this frame (leftPad + chars + rightPad).
   * Equals DISPLAY_CHARS for short words; may exceed it when a long word
   * overflows to the right (leftPad stays fixed so the pivot doesn't move).
   */
  totalCols: number;
}

/**
 * Compute the layout for a single RSVP frame.
 *
 * - `leftPad` is chosen so the pivot char lands exactly on column `PIVOT_POS`.
 * - `rightPad` fills the remainder of the row up to `DISPLAY_CHARS`.
 *   If the word extends past `DISPLAY_CHARS`, `rightPad` is 0 and the row
 *   grows to `leftPad + word.length` columns. The pivot's absolute column
 *   stays at `PIVOT_POS` in either case.
 */
export function computeRsvpLayout(word: string): RsvpLayout {
  // Unicode-aware split so accented chars, emoji, etc. count as 1 column each.
  const chars: string[] = [...(word ?? "")];
  const pivotIdx = getPivotIndex(word ?? "");

  const leftPad = PIVOT_POS - pivotIdx;
  const wordCols = chars.length;
  const rightPad = Math.max(0, DISPLAY_CHARS - (leftPad + wordCols));

  const layoutChars: RsvpLayoutChar[] = chars.map((c, i) => ({
    char: c,
    isPivot: i === pivotIdx,
  }));

  return {
    leftPad,
    chars: layoutChars,
    rightPad,
    pivotAbsolutePos: leftPad + pivotIdx,
    totalCols: leftPad + wordCols + rightPad,
  };
}
