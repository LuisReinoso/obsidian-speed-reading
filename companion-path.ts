/**
 * Pure helpers for building companion-file paths (Summary, Flashcards, Quiz)
 * from a note's vault-relative path.
 *
 * These are intentionally free of any Obsidian imports so they can be
 * unit-tested in plain Node.
 */

/**
 * Given a note path like `"Books/Foo/chapter.md"` and a suffix like
 * `"Summary"`, returns `"Books/Foo/chapter - Summary.md"`.
 */
export function companionPath(notePath: string, suffix: string): string {
  const base = notePath.replace(/\.md$/, "");
  return `${base} - ${suffix}.md`;
}

/**
 * Extracts the directory portion of a vault-relative note path.
 * `"Books/Foo/chapter.md"` → `"Books/Foo"`
 * `"note.md"` → `""`
 */
export function companionDir(notePath: string): string {
  const parts = notePath.split("/");
  parts.pop();
  return parts.join("/");
}
