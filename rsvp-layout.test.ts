/**
 * Tests for the RSVP layout math.
 *
 * Run with: pnpm test
 *
 * The critical invariant: `pivotAbsolutePos === PIVOT_POS` for any non-empty
 * word, at any length, with any character set. When this test passes we know
 * the red pivot character will land on the same horizontal column on every
 * frame, so the reader's fixation point never jitters.
 */

import {
  computeRsvpLayout,
  getPivotIndex,
  DISPLAY_CHARS,
  PIVOT_POS,
} from "./rsvp-layout";

describe("getPivotIndex: Spritz-style boundary mapping", () => {
  test("single-letter word pivots on the only char", () => {
    expect(getPivotIndex("a")).toBe(0);
  });

  test("2-5 letter words pivot on index 1", () => {
    expect(getPivotIndex("ab")).toBe(1);
    expect(getPivotIndex("abc")).toBe(1);
    expect(getPivotIndex("abcd")).toBe(1);
    expect(getPivotIndex("abcde")).toBe(1);
  });

  test("6-9 letter words pivot on index 2", () => {
    expect(getPivotIndex("abcdef")).toBe(2);
    expect(getPivotIndex("abcdefg")).toBe(2);
    expect(getPivotIndex("abcdefghi")).toBe(2);
  });

  test("10+ letter words pivot on index 3", () => {
    expect(getPivotIndex("abcdefghij")).toBe(3);
    expect(getPivotIndex("abcdefghijklmnopqrst")).toBe(3);
  });

  test("accented characters count as single letters", () => {
    // "técnica" has 7 Unicode letters → should pivot at index 2
    expect(getPivotIndex("técnica")).toBe(2);
  });
});

describe("computeRsvpLayout: pivot-stays-fixed invariant", () => {
  test("single-letter word places pivot at PIVOT_POS", () => {
    expect(computeRsvpLayout("a").pivotAbsolutePos).toBe(PIVOT_POS);
  });

  test("short 3-letter word places pivot at PIVOT_POS", () => {
    expect(computeRsvpLayout("cat").pivotAbsolutePos).toBe(PIVOT_POS);
  });

  test("7-letter accented word places pivot at PIVOT_POS", () => {
    expect(computeRsvpLayout("técnica").pivotAbsolutePos).toBe(PIVOT_POS);
  });

  test("10-letter word places pivot at PIVOT_POS", () => {
    expect(computeRsvpLayout("pensamiento").pivotAbsolutePos).toBe(PIVOT_POS);
  });

  test("overflow-length word still places pivot at PIVOT_POS", () => {
    // "electroencefalograma" = 20 chars; with leftPad=7 it overflows the row
    const layout = computeRsvpLayout("electroencefalograma");
    expect(layout.pivotAbsolutePos).toBe(PIVOT_POS);
    expect(layout.rightPad).toBe(0);
    expect(layout.totalCols).toBeGreaterThan(DISPLAY_CHARS);
  });

  test("absurdly long 40-char word places pivot at PIVOT_POS", () => {
    const layout = computeRsvpLayout("a".repeat(40));
    expect(layout.pivotAbsolutePos).toBe(PIVOT_POS);
  });

  test("pivot is invariant across every word length from 1 to 50", () => {
    // Exhaustive check: no matter how long the word, the pivot column
    // never moves. Any future regression to the layout math is caught
    // immediately by this single test.
    for (let len = 1; len <= 50; len++) {
      const word = "x".repeat(len);
      const layout = computeRsvpLayout(word);
      expect(layout.pivotAbsolutePos).toBe(PIVOT_POS);
    }
  });

  test("pivot is invariant for a sample of real Spanish words", () => {
    const cases = [
      "a",
      "el",
      "uno",
      "amor",
      "pensar",
      "técnica",
      "reflexión",
      "pensamiento",
      "electroencefalograma",
      "intergeneracionalmente",
    ];
    for (const word of cases) {
      expect(computeRsvpLayout(word).pivotAbsolutePos).toBe(PIVOT_POS);
    }
  });
});

describe("computeRsvpLayout: structural properties", () => {
  test("chars preserves the full word in order", () => {
    const layout = computeRsvpLayout("cat");
    expect(layout.chars.map((c) => c.char)).toEqual(["c", "a", "t"]);
  });

  test("exactly one char in the layout is flagged as pivot", () => {
    const layout = computeRsvpLayout("pensamiento");
    const pivotChars = layout.chars.filter((c) => c.isPivot);
    expect(pivotChars).toHaveLength(1);
  });

  test("the flagged pivot char matches getPivotIndex", () => {
    const word = "pensamiento";
    const layout = computeRsvpLayout(word);
    const pivotChar = layout.chars.find((c) => c.isPivot)!;
    const expectedIdx = getPivotIndex(word);
    expect(pivotChar.char).toBe([...word][expectedIdx]);
  });

  test("short word row is exactly DISPLAY_CHARS wide", () => {
    const layout = computeRsvpLayout("cat");
    expect(layout.totalCols).toBe(DISPLAY_CHARS);
    expect(layout.leftPad + layout.chars.length + layout.rightPad).toBe(DISPLAY_CHARS);
  });

  test("empty word is handled defensively without throwing", () => {
    const layout = computeRsvpLayout("");
    expect(layout.chars).toHaveLength(0);
    expect(layout.pivotAbsolutePos).toBe(PIVOT_POS);
  });
});
