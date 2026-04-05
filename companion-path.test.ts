import { companionPath, companionDir } from "./companion-path";

// ---------------------------------------------------------------------------
// companionPath
// ---------------------------------------------------------------------------
describe("companionPath", () => {
  it("builds a companion path from a simple note path", () => {
    expect(companionPath("Books/chapter.md", "Summary")).toBe(
      "Books/chapter - Summary.md",
    );
  });

  it("handles deeply nested paths", () => {
    const input =
      "Books/Pensar más, pensar mejor/chapters/04 - Pensar es una técnica.md";
    expect(companionPath(input, "Summary")).toBe(
      "Books/Pensar más, pensar mejor/chapters/04 - Pensar es una técnica - Summary.md",
    );
  });

  it("handles paths with commas", () => {
    expect(companionPath("Notes/one, two, three.md", "Flashcards")).toBe(
      "Notes/one, two, three - Flashcards.md",
    );
  });

  it("handles paths with accented characters", () => {
    expect(companionPath("Libros/Introducción.md", "Quiz")).toBe(
      "Libros/Introducción - Quiz.md",
    );
  });

  it("handles paths with spaces", () => {
    expect(companionPath("My Notes/some file name.md", "Summary")).toBe(
      "My Notes/some file name - Summary.md",
    );
  });

  it("handles root-level notes (no directory)", () => {
    expect(companionPath("note.md", "Flashcards")).toBe(
      "note - Flashcards.md",
    );
  });

  it("handles different suffixes", () => {
    expect(companionPath("a/b.md", "Quiz")).toBe("a/b - Quiz.md");
    expect(companionPath("a/b.md", "Flashcards")).toBe(
      "a/b - Flashcards.md",
    );
    expect(companionPath("a/b.md", "Summary")).toBe("a/b - Summary.md");
  });

  it("does not double-replace if the filename contains '.md' mid-string", () => {
    // Only the trailing .md should be stripped
    expect(companionPath("folder/readme.md.bak.md", "Summary")).toBe(
      "folder/readme.md.bak - Summary.md",
    );
  });

  it("handles a path that does not end in .md gracefully", () => {
    // Edge case: if someone passes a non-.md path, it just appends
    expect(companionPath("folder/file.txt", "Summary")).toBe(
      "folder/file.txt - Summary.md",
    );
  });
});

// ---------------------------------------------------------------------------
// companionDir
// ---------------------------------------------------------------------------
describe("companionDir", () => {
  it("returns the directory of a nested path", () => {
    expect(companionDir("Books/Foo/chapter.md")).toBe("Books/Foo");
  });

  it("returns empty string for a root-level note", () => {
    expect(companionDir("note.md")).toBe("");
  });

  it("handles deeply nested paths", () => {
    expect(
      companionDir(
        "Books/Pensar más, pensar mejor/chapters/04 - Pensar es una técnica.md",
      ),
    ).toBe("Books/Pensar más, pensar mejor/chapters");
  });

  it("handles a single-level directory", () => {
    expect(companionDir("Notes/file.md")).toBe("Notes");
  });

  it("handles paths with spaces and special characters", () => {
    expect(companionDir("My Library/sub dir/file name.md")).toBe(
      "My Library/sub dir",
    );
  });
});
