import { App, Editor, Modal, Notice, Plugin, PluginSettingTab, Setting, MarkdownView, TFile, requestUrl } from "obsidian";

// ===== INTERFACES =====

interface ReadingPosition {
  wordIndex: number;
  totalWords: number;
  lastRead: string;
  wpm: number;
  lastStudiedIndex: number;
}

interface SessionLogEntry {
  date: string;        // ISO date YYYY-MM-DD
  notePath: string;
  wordsRead: number;
  minutes: number;
}

interface SpeedReadingSettings {
  defaultWPM: number;
  showProgressBar: boolean;
  autoStart: boolean;
  readingPositions: Record<string, ReadingPosition>;
  studyServerUrl: string;
  studyLanguage: string;
  // Learning-science additions
  studyCue: string;                  // Implementation intention (Adriaanse 2010 — MCII)
  recallPauseWords: number;          // 0 = off, else pause every N words for mid-read recall
  forceRecallOnClose: boolean;       // If true, require free-recall on close when enough read
  recallMinWords: number;            // Minimum words read to trigger end recall
  sessionLog: SessionLogEntry[];
  currentStreak: number;
  longestStreak: number;
  lastSessionDate: string;           // ISO date YYYY-MM-DD
  // Per-file caps (secondary safety — prevents one chapter from ballooning)
  maxCardsPerFile: number;
  maxQuestionsPerFile: number;
  // Daily generation budget across ALL notes (primary safeguard, Anki-style)
  dailyNewCardsBudget: number;
  dailyNewQuestionsBudget: number;
  // Per-day generation tracking: { "2026-04-05": { cards: 8, questions: 3 } }
  dailyGenCounts: Record<string, { cards: number; questions: number }>;
}

const DEFAULT_SETTINGS: SpeedReadingSettings = {
  defaultWPM: 300,
  showProgressBar: true,
  autoStart: false,
  readingPositions: {},
  studyServerUrl: "",
  studyLanguage: "es",
  studyCue: "",
  recallPauseWords: 0,
  forceRecallOnClose: true,
  recallMinWords: 200,
  sessionLog: [],
  currentStreak: 0,
  longestStreak: 0,
  lastSessionDate: "",
  maxCardsPerFile: 4,           // Minimum-information principle: only the 4 most essential per chapter
  maxQuestionsPerFile: 4,
  dailyNewCardsBudget: 20,      // Anki's proven default
  dailyNewQuestionsBudget: 10,
  dailyGenCounts: {},
};

const MAX_DAILY_GEN_HISTORY = 30; // keep last 30 days only

const MAX_POSITIONS = 50;
const MAX_SESSION_LOG = 180; // ~6 months of daily sessions

// ===== DATE / STREAK HELPERS =====

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  if (!a || !b) return Infinity;
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((db - da) / 86400000);
}

interface Flashcard {
  front: string;
  back: string;
}

// ===== TEXT ANALYZER =====

class TextAnalyzer {
  static extractHeadings(text: string): { level: number; text: string }[] {
    const headings: { level: number; text: string }[] = [];
    const regex = /^(#{1,6})\s+(.+)$/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      headings.push({ level: match[1].length, text: match[2].trim() });
    }
    return headings;
  }

  static extractBoldTerms(text: string): string[] {
    const terms: string[] = [];
    const regex = /\*\*([^*]+)\*\*/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const term = match[1].trim();
      if (term.length > 2) terms.push(term);
    }
    return [...new Set(terms)];
  }

  static extractHighlights(text: string): string[] {
    const highlights: string[] = [];
    const regex = /==([^=]+)==/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      highlights.push(match[1].trim());
    }
    return [...new Set(highlights)];
  }
}

// ===== FLASHCARD GENERATOR =====

class FlashcardGenerator {
  static generateFromHeadings(text: string): Flashcard[] {
    const cards: Flashcard[] = [];
    const sections = text.split(/(?=^#{1,6}\s+)/gm);

    for (const section of sections) {
      const headingMatch = section.match(/^#{1,6}\s+(.+)$/m);
      if (headingMatch) {
        const content = section.replace(/^#{1,6}\s+.+$/m, "").trim();
        const sentences = content.split(/(?<=[.!?])\s+/);
        const first = sentences[0];
        if (first && first.length > 15) {
          const clean = SpeedReadModal.stripMarkdown(first).trim();
          if (clean.length > 15) {
            cards.push({ front: headingMatch[1].trim(), back: clean.substring(0, 200) });
          }
        }
      }
    }
    return cards;
  }

  static generateFromBoldTerms(text: string): Flashcard[] {
    const cards: Flashcard[] = [];
    const seen = new Set<string>();
    const sentences = text.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      const regex = /\*\*([^*]+)\*\*/g;
      let match;
      while ((match = regex.exec(sentence)) !== null) {
        const term = match[1].trim();
        if (!seen.has(term.toLowerCase()) && term.length > 2) {
          seen.add(term.toLowerCase());
          const clean = SpeedReadModal.stripMarkdown(sentence).trim();
          if (clean.length > term.length + 10) {
            cards.push({ front: term, back: clean.substring(0, 200) });
          }
        }
      }
    }
    return cards;
  }

  static generateFromHighlights(text: string): Flashcard[] {
    const cards: Flashcard[] = [];
    const seen = new Set<string>();
    const sentences = text.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
      const regex = /==([^=]+)==/g;
      let match;
      while ((match = regex.exec(sentence)) !== null) {
        const term = match[1].trim();
        if (!seen.has(term.toLowerCase()) && term.length > 2) {
          seen.add(term.toLowerCase());
          const clean = SpeedReadModal.stripMarkdown(sentence.replace(/==/g, "")).trim();
          if (clean.length > term.length + 10) {
            cards.push({ front: term, back: clean.substring(0, 200) });
          }
        }
      }
    }
    return cards;
  }

  static generateAll(text: string): Flashcard[] {
    return [
      ...this.generateFromHeadings(text),
      ...this.generateFromBoldTerms(text),
      ...this.generateFromHighlights(text),
    ];
  }

  static formatForSpacedRepetition(cards: Flashcard[]): string {
    if (cards.length === 0) return "";
    let output = "\n\n#flashcards\n\n";
    for (const card of cards) {
      output += `${card.front}::${card.back}\n\n`;
    }
    return output;
  }
}

// ===== PRE-READING MODAL =====

class PreReadingModal extends Modal {
  private rawText: string;
  private wpm: number;
  private savedPosition: ReadingPosition | null;
  private onStart: (fromBeginning: boolean) => void;
  private serverUrl: string;
  private language: string;
  private notePath: string | null;

  constructor(
    app: App,
    rawText: string,
    wpm: number,
    savedPosition: ReadingPosition | null,
    serverUrl: string,
    language: string,
    onStart: (fromBeginning: boolean) => void,
    notePath?: string | null
  ) {
    super(app);
    this.rawText = rawText;
    this.wpm = wpm;
    this.savedPosition = savedPosition;
    this.serverUrl = serverUrl;
    this.language = language;
    this.onStart = onStart;
    this.notePath = notePath ?? null;
  }

  private getNotePath(): string | null {
    return this.notePath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-pre-modal");

    const stripped = SpeedReadModal.stripMarkdown(this.rawText);
    const wordCount = SpeedReadModal.tokenizeText(stripped).length;
    const estMinutes = Math.ceil(wordCount / this.wpm);

    contentEl.createEl("h2", { text: "Pre-reading Overview" });

    // Stats
    const stats = contentEl.createDiv({ cls: "sr-pre-stats" });
    stats.createEl("span", { text: `${wordCount} words`, cls: "sr-stat-badge" });
    stats.createEl("span", { text: `~${estMinutes} min`, cls: "sr-stat-badge" });
    stats.createEl("span", { text: `${this.wpm} WPM`, cls: "sr-stat-badge" });

    // Resume info
    if (this.savedPosition) {
      const pct = Math.round((this.savedPosition.wordIndex / this.savedPosition.totalWords) * 100);
      const dateStr = new Date(this.savedPosition.lastRead).toLocaleDateString();
      const resumeBox = contentEl.createDiv({ cls: "sr-resume-box" });
      resumeBox.createEl("p", { text: `Last read: ${pct}% — ${dateStr}` });
      const resumeBtn = resumeBox.createEl("button", { text: `Continue from ${pct}%`, cls: "sr-btn sr-btn-primary" });
      resumeBtn.onclick = () => { this.close(); this.onStart(false); };
    }

    // Scrollable content area
    const scrollArea = contentEl.createDiv({ cls: "sr-pre-scroll" });

    // Check for existing Summary companion file first
    const notePath = this.getNotePath();
    if (notePath) {
      const summaryPath = companionPath(notePath, "Summary");
      const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);
      if (summaryFile instanceof TFile) {
        // Show saved summary
        const summarySection = scrollArea.createDiv({ cls: "sr-ai-summary-section" });
        summarySection.createEl("h3", { text: "Summary", cls: "sr-section-title" });
        const summaryContent = summarySection.createDiv({ cls: "sr-ai-summary" });
        summaryContent.setText("Loading...");
        this.app.vault.read(summaryFile).then(content => {
          // Strip frontmatter for display
          const display = content.replace(/^---\n[\s\S]*?\n---\n?/m, "").trim();
          summaryContent.empty();
          renderMultilineText(summaryContent, display);
        });
      } else if (this.serverUrl) {
        // No saved summary but server available → fetch AI summary
        const summarySection = scrollArea.createDiv({ cls: "sr-ai-summary-section" });
        summarySection.createEl("h3", { text: "AI Summary", cls: "sr-section-title" });
        const summaryContent = summarySection.createDiv({ cls: "sr-ai-summary" });
        summaryContent.setText("Loading summary...");
        this.fetchAISummary(summaryContent, scrollArea);
      } else {
        this.renderHeuristicContent(scrollArea);
      }
    } else {
      this.renderHeuristicContent(scrollArea);
    }

    // Actions
    const actions = contentEl.createDiv({ cls: "sr-pre-actions" });
    const startBtn = actions.createEl("button", { text: "Start Reading", cls: "sr-btn sr-btn-primary" });
    startBtn.onclick = () => { this.close(); this.onStart(true); };

    const closeBtn = actions.createEl("button", { text: "Close", cls: "sr-btn" });
    closeBtn.onclick = () => this.close();
  }

  private async fetchAISummary(summaryContent: HTMLElement, scrollArea: HTMLElement) {
    try {
      const resp = await requestUrl({
        url: `${this.serverUrl}/api/summary`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: this.rawText, language: this.language }),
      });
      const data = resp.json;

      summaryContent.empty();
      if (data.summary) {
        renderMultilineText(summaryContent, data.summary);
      }

      if (data.keyTerms && data.keyTerms.length > 0) {
        scrollArea.createEl("h3", { text: "Key Terms", cls: "sr-section-title" });
        const terms = scrollArea.createDiv({ cls: "sr-terms" });
        for (const t of data.keyTerms) {
          terms.createEl("span", { text: t.term, cls: "sr-term-badge", title: t.definition });
        }
      }

      if (data.topics && data.topics.length > 0) {
        scrollArea.createEl("h3", { text: "Topics", cls: "sr-section-title" });
        const topics = scrollArea.createDiv({ cls: "sr-terms" });
        for (const topic of data.topics) {
          topics.createEl("span", { text: topic, cls: "sr-stat-badge" });
        }
      }

      // Auto-save summary as companion file so it's cached for next time
      const notePath = this.getNotePath();
      if (notePath && data.summary) {
        const filePath = companionPath(notePath, "Summary");
        let fileContent = `---\nsource: "[[${notePath}]]"\n---\n\n# Summary\n\n${data.summary}\n\n`;
        if (data.keyTerms && data.keyTerms.length > 0) {
          fileContent += "## Key Terms\n\n" + data.keyTerms.map((t: any) => `- **${t.term}**: ${t.definition}`).join("\n") + "\n\n";
        }
        if (data.topics && data.topics.length > 0) {
          fileContent += "## Topics\n\n" + data.topics.map((t: string) => `- ${t}`).join("\n") + "\n";
        }
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
          await this.app.vault.modify(existing, fileContent);
        } else {
          await this.app.vault.create(filePath, fileContent);
        }
      }
    } catch (err: any) {
      summaryContent.setText(`Could not load AI summary: ${err.message}`);
      // Show heuristic content as fallback
      this.renderHeuristicContent(scrollArea);
    }
  }

  private renderHeuristicContent(scrollArea: HTMLElement) {
    const headings = TextAnalyzer.extractHeadings(this.rawText);
    if (headings.length > 0) {
      scrollArea.createEl("h3", { text: "Structure", cls: "sr-section-title" });
      const list = scrollArea.createEl("ul", { cls: "sr-heading-list" });
      for (const h of headings) {
        const li = list.createEl("li");
        li.style.paddingLeft = `${(h.level - 1) * 1}em`;
        li.setText(h.text);
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ===== COMMAND EXECUTION HELPER =====

function tryExecuteCommand(app: App, commandId: string): boolean {
  try {
    const result = (app as any).commands.executeCommandById(commandId);
    return result !== false;
  } catch {
    return false;
  }
}

// ===== AI REQUEST HELPER =====

async function aiRequest(
  serverUrl: string,
  endpoint: string,
  body: any
): Promise<any> {
  if (!serverUrl) {
    throw new Error("No Study Server URL configured. Set it in plugin settings.");
  }

  const resp = await requestUrl({
    url: `${serverUrl}${endpoint}`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    throw: false,
  });

  if (resp.status < 200 || resp.status >= 400) {
    const errMsg = resp.json?.error || resp.text?.substring(0, 200) || `HTTP ${resp.status}`;
    throw new Error(errMsg);
  }

  return resp.json;
}

// ===== COMPANION FILE HELPERS =====

function companionPath(notePath: string, suffix: string): string {
  const base = notePath.replace(/\.md$/, "");
  return `${base} - ${suffix}.md`;
}

function companionDir(notePath: string): string {
  const parts = notePath.split("/");
  parts.pop();
  return parts.join("/");
}

/**
 * Render plain text with line breaks into a container without using innerHTML.
 */
function renderMultilineText(container: HTMLElement, text: string) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    container.appendText(line);
    if (i < lines.length - 1) container.createEl("br");
  });
}

/**
 * Extract existing flashcard fronts from a markdown file.
 * Matches lines of the form `front::back` (spaced-repetition plugin format).
 * Skips code fences.
 */
function extractExistingFronts(content: string): Set<string> {
  const fronts = new Set<string>();
  const noFences = content.replace(/```[\s\S]*?```/g, "");
  const regex = /^([^\n:]{1,400})::[^\n]+/gm;
  let m;
  while ((m = regex.exec(noFences)) !== null) {
    fronts.add(m[1].trim().toLowerCase());
  }
  return fronts;
}

/**
 * Extract existing quiz question texts from callout-format markdown.
 * Matches `> [!question] ...`.
 */
function extractExistingQuestions(content: string): Set<string> {
  const questions = new Set<string>();
  const regex = /^>\s*\[!question\]\s*(.+?)$/gim;
  let m;
  while ((m = regex.exec(content)) !== null) {
    questions.add(m[1].trim().toLowerCase());
  }
  return questions;
}

// ===== STUDY MODAL (ORCHESTRATOR) =====

class StudyModal extends Modal {
  private rawText: string;
  private notePath: string | null;
  private serverUrl: string;
  private language: string;
  private plugin: SpeedReadingPlugin;

  constructor(
    app: App,
    rawText: string,
    notePath: string | null,
    plugin: SpeedReadingPlugin,
  ) {
    super(app);
    this.rawText = rawText;
    this.notePath = notePath;
    this.plugin = plugin;
    this.serverUrl = plugin.settings.studyServerUrl;
    this.language = plugin.settings.studyLanguage;
  }

  private get maxCards() { return this.plugin.settings.maxCardsPerFile; }
  private get maxQuestions() { return this.plugin.settings.maxQuestionsPerFile; }

  onOpen() {
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-study-modal");

    contentEl.createEl("h2", { text: "Study Mode" });

    if (!this.serverUrl) {
      contentEl.createEl("p", {
        text: "Configure Study Server URL in settings to enable AI study features.",
        cls: "sr-muted",
      });
      const closeBtn = contentEl.createEl("button", { text: "Close", cls: "sr-btn" });
      closeBtn.onclick = () => this.close();
      return;
    }

    if (!this.notePath) {
      contentEl.createEl("p", { text: "No active note.", cls: "sr-muted" });
      const closeBtn = contentEl.createEl("button", { text: "Close", cls: "sr-btn" });
      closeBtn.onclick = () => this.close();
      return;
    }

    const flashPath = companionPath(this.notePath, "Flashcards");
    const quizPath = companionPath(this.notePath, "Quiz");
    const summaryPath = companionPath(this.notePath, "Summary");
    const hasFlash = !!this.app.vault.getAbstractFileByPath(flashPath);
    const hasQuiz = !!this.app.vault.getAbstractFileByPath(quizPath);
    const hasSummary = !!this.app.vault.getAbstractFileByPath(summaryPath);

    // === REVIEW section (if existing files) ===
    if (hasFlash || hasQuiz || hasSummary) {
      const reviewSection = contentEl.createDiv({ cls: "sr-study-section" });
      reviewSection.createEl("h3", { text: "Review", cls: "sr-section-title" });
      const reviewBtns = reviewSection.createDiv({ cls: "sr-ai-buttons" });

      if (hasFlash) {
        const btn = reviewBtns.createEl("button", { text: "Review Flashcards", cls: "sr-btn sr-btn-primary sr-btn-large" });
        btn.onclick = async () => {
          this.close();
          await this.app.workspace.openLinkText(flashPath, "", true);
          setTimeout(() => {
            tryExecuteCommand(this.app, "obsidian-study-spaced-repetition:srs-review-flashcards-in-note");
          }, 800);
        };
      }

      if (hasQuiz) {
        const btn = reviewBtns.createEl("button", { text: "Review Quiz", cls: "sr-btn sr-btn-primary sr-btn-large" });
        btn.onclick = async () => {
          this.close();
          await this.app.workspace.openLinkText(quizPath, "", true);
          setTimeout(() => {
            tryExecuteCommand(this.app, "obsidian-study-quiz:open-quiz-from-active-note");
          }, 800);
        };
      }

      if (hasSummary) {
        const btn = reviewBtns.createEl("button", { text: "Read Summary", cls: "sr-btn sr-btn-large" });
        btn.onclick = async () => {
          await this.app.workspace.openLinkText(summaryPath, "", true);
          this.close();
        };
      }
    }

    // === GENERATE section ===
    const genSection = contentEl.createDiv({ cls: "sr-study-section" });
    genSection.createEl("h3", { text: hasFlash || hasQuiz || hasSummary ? "Generate New" : "Generate", cls: "sr-section-title" });
    const genBtns = genSection.createDiv({ cls: "sr-ai-buttons" });

    const flashBtn = genBtns.createEl("button", {
      text: hasFlash ? "Add More Flashcards" : "Generate Flashcards",
      cls: "sr-btn sr-btn-ai",
    });
    flashBtn.onclick = () => this.generateFlashcards(flashBtn);

    const quizBtn = genBtns.createEl("button", {
      text: hasQuiz ? "Add More Questions" : "Generate Quiz",
      cls: "sr-btn sr-btn-ai",
    });
    quizBtn.onclick = () => this.generateQuiz(quizBtn);

    const summaryBtn = genBtns.createEl("button", {
      text: hasSummary ? "Regenerate Summary" : "Generate Summary",
      cls: "sr-btn sr-btn-ai",
    });
    summaryBtn.onclick = () => this.generateSummary(summaryBtn);

    // Close
    const closeBtn = contentEl.createDiv({ cls: "sr-study-actions" }).createEl("button", { text: "Close", cls: "sr-btn" });
    closeBtn.onclick = () => this.close();
  }

  private async getFullNoteText(): Promise<string> {
    if (!this.notePath) return this.rawText;
    const file = this.app.vault.getAbstractFileByPath(this.notePath);
    if (file instanceof TFile) return await this.app.vault.read(file);
    return this.rawText;
  }

  private async getStudyText(): Promise<string> {
    // Use read portion if substantial (>100 words), otherwise full note
    if (this.rawText.split(/\s+/).length > 100) return this.rawText;
    return await this.getFullNoteText();
  }

  private async generateFlashcards(btn: HTMLButtonElement) {
    // Check daily budget BEFORE calling the server — no point generating if we can't save
    const dailyLeft = this.plugin.remainingDailyCards();
    if (dailyLeft === 0) {
      const budget = this.plugin.settings.dailyNewCardsBudget;
      new Notice(`Daily budget reached (${budget} new cards). Come back tomorrow or raise it in settings.`);
      return;
    }

    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      const studyText = await this.getStudyText();
      // Ask the server for at most maxCards cards — no point pulling more than we can fit
      const requestCount = Math.min(this.maxCards, dailyLeft);
      const data = await aiRequest(this.serverUrl, "/api/flashcards", {
        text: studyText, language: this.language, count: requestCount,
      });
      const cards: Flashcard[] = (data.cards || []).map((c: any) => ({ front: c.front, back: c.back }));
      if (cards.length === 0) { new Notice("No flashcards generated."); btn.textContent = "Generate Flashcards"; btn.disabled = false; return; }

      // Build a nested deck tag that mirrors the note's folder hierarchy.
      // Generic container folders ("Books", "chapters") are stripped so cards
      // group by topic rather than by folder scaffolding.
      const pathParts = this.notePath!.replace(/\.md$/, "").split("/");
      const deckParts = pathParts.filter(p => p !== "Books" && p !== "chapters").map(p => p.replace(/\s+/g, "-"));
      const deckTag = `#flashcards/${deckParts.join("/")}`;

      // Save as companion file (APPEND only — preserving obsidian-spaced-repetition review metadata)
      const filePath = companionPath(this.notePath!, "Flashcards");
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      let addedCount = 0;

      let fileCapReached = false;
      let dailyCapHit = false;

      if (existing instanceof TFile) {
        // File exists: parse existing fronts, only append non-duplicates, respect BOTH caps
        const currentContent = await this.app.vault.read(existing);
        const existingFronts = extractExistingFronts(currentContent);
        const fileSlotsLeft = Math.max(0, this.maxCards - existingFronts.size);
        const effectiveSlots = Math.min(fileSlotsLeft, dailyLeft);
        const unique = cards.filter(c => !existingFronts.has(c.front.trim().toLowerCase()));
        const toAdd = unique.slice(0, effectiveSlots);
        fileCapReached = existingFronts.size + toAdd.length >= this.maxCards && unique.length > toAdd.length;
        dailyCapHit = toAdd.length === dailyLeft && unique.length > toAdd.length;
        if (toAdd.length > 0) {
          const appended = currentContent.trimEnd() + "\n\n"
            + toAdd.map(c => `${c.front}::${c.back}`).join("\n\n") + "\n";
          await this.app.vault.modify(existing, appended);
        }
        addedCount = toAdd.length;
      } else {
        const effectiveSlots = Math.min(this.maxCards, dailyLeft);
        const capped = cards.slice(0, effectiveSlots);
        fileCapReached = cards.length > this.maxCards;
        dailyCapHit = capped.length === dailyLeft && cards.length > capped.length;
        const formatted = `---\ntags:\n  - flashcards\nsource: "[[${this.notePath}]]"\n---\n\n${deckTag}\n\n`
          + capped.map(c => `${c.front}::${c.back}`).join("\n\n") + "\n";
        await this.app.vault.create(filePath, formatted);
        addedCount = capped.length;
      }

      // Update daily counter
      if (addedCount > 0) {
        await this.plugin.incrementDailyGen("cards", addedCount);
      }

      // User feedback — most specific case first
      const remainingAfter = this.plugin.remainingDailyCards();
      if (addedCount === 0 && dailyCapHit) {
        new Notice(`Daily budget reached (${this.plugin.settings.dailyNewCardsBudget}). Come back tomorrow.`);
      } else if (addedCount === 0 && fileCapReached) {
        new Notice(`This note is full (${this.maxCards} cards). Review what you have first.`);
      } else if (addedCount === 0) {
        new Notice("No new flashcards — all generated cards already exist.");
      } else if (dailyCapHit) {
        new Notice(`${addedCount} added — daily budget reached. Tomorrow: +${this.plugin.settings.dailyNewCardsBudget}.`);
      } else if (fileCapReached) {
        new Notice(`${addedCount} added — this note is now full.`);
      } else {
        new Notice(`${addedCount} new card${addedCount === 1 ? "" : "s"} · ${remainingAfter} left today`);
      }
      // Re-render modal to show Review buttons
      this.render();
    } catch (err: any) {
      const msg = err.message || "Unknown error";
      if (msg.includes("net::") || msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED")) {
        new Notice(`Flashcards: Server not reachable at ${this.serverUrl}. Is it running?`);
      } else if (msg.includes("400")) {
        new Notice(`Flashcards: Text too short to generate cards. Read more first.`);
      } else if (msg.includes("timeout") || msg.includes("Timeout")) {
        new Notice(`Flashcards: Server took too long. Try again.`);
      } else {
        new Notice(`Flashcards failed: ${msg}`);
      }
      btn.textContent = "Generate Flashcards";
      btn.disabled = false;
    }
  }

  private async generateQuiz(btn: HTMLButtonElement) {
    const dailyLeft = this.plugin.remainingDailyQuestions();
    if (dailyLeft === 0) {
      const budget = this.plugin.settings.dailyNewQuestionsBudget;
      new Notice(`Daily question budget reached (${budget}). Come back tomorrow or raise it in settings.`);
      return;
    }

    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      const studyText = await this.getStudyText();
      const requestCount = Math.min(this.maxQuestions, dailyLeft);
      const data = await aiRequest(this.serverUrl, "/api/quiz", {
        text: studyText,
        language: this.language,
        types: ["true-false", "multiple-choice", "short-answer"],
        count: requestCount,
      });
      const questions = data.questions || [];
      if (questions.length === 0) { new Notice("No questions generated."); btn.textContent = "Generate Quiz"; btn.disabled = false; return; }

      // Render a single question into callout format
      const renderQuestion = (q: any): string => {
        const answerText = q.type === "true-false" ? (q.answer ? "True" : "False")
          : q.type === "multiple-choice" && q.options ? `${String.fromCharCode(97 + q.answer)}) ${q.options[q.answer]}`
          : Array.isArray(q.answer) ? q.answer.join(", ")
          : String(q.answer);
        let out = `> [!question] ${q.question}\n`;
        if (q.type === "multiple-choice" && q.options) {
          for (let i = 0; i < q.options.length; i++) {
            out += `> ${String.fromCharCode(97 + i)}) ${q.options[i]}\n`;
          }
        }
        out += `>> [!success]- Answer\n>> ${answerText}\n\n`;
        return out;
      };

      // Save as companion file — APPEND only, deduping by question text, respecting cap
      const filePath = companionPath(this.notePath!, "Quiz");
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      let addedCount = 0;
      let fileCapReached = false;
      let dailyCapHit = false;

      if (existing instanceof TFile) {
        const currentContent = await this.app.vault.read(existing);
        const existingQs = extractExistingQuestions(currentContent);
        const fileSlotsLeft = Math.max(0, this.maxQuestions - existingQs.size);
        const effectiveSlots = Math.min(fileSlotsLeft, dailyLeft);
        const unique = questions.filter((q: any) => q.question && !existingQs.has(q.question.trim().toLowerCase()));
        const toAdd = unique.slice(0, effectiveSlots);
        fileCapReached = existingQs.size + toAdd.length >= this.maxQuestions && unique.length > toAdd.length;
        dailyCapHit = toAdd.length === dailyLeft && unique.length > toAdd.length;
        if (toAdd.length > 0) {
          const appended = currentContent.trimEnd() + "\n\n" + toAdd.map(renderQuestion).join("");
          await this.app.vault.modify(existing, appended);
        }
        addedCount = toAdd.length;
      } else {
        const effectiveSlots = Math.min(this.maxQuestions, dailyLeft);
        const capped = questions.slice(0, effectiveSlots);
        fileCapReached = questions.length > this.maxQuestions;
        dailyCapHit = capped.length === dailyLeft && questions.length > capped.length;
        let content = `---\ntags:\n  - quiz\nsource: "[[${this.notePath}]]"\n---\n\n`;
        for (const q of capped) content += renderQuestion(q);
        await this.app.vault.create(filePath, content);
        addedCount = capped.length;
      }

      if (addedCount > 0) {
        await this.plugin.incrementDailyGen("questions", addedCount);
      }

      const remainingAfter = this.plugin.remainingDailyQuestions();
      if (addedCount === 0 && dailyCapHit) {
        new Notice(`Daily question budget reached (${this.plugin.settings.dailyNewQuestionsBudget}). Come back tomorrow.`);
      } else if (addedCount === 0 && fileCapReached) {
        new Notice(`This note is full (${this.maxQuestions} questions).`);
      } else if (addedCount === 0) {
        new Notice("No new questions — all generated questions already exist.");
      } else if (dailyCapHit) {
        new Notice(`${addedCount} added — daily budget reached.`);
      } else if (fileCapReached) {
        new Notice(`${addedCount} added — this note is now full.`);
      } else {
        new Notice(`${addedCount} new question${addedCount === 1 ? "" : "s"} · ${remainingAfter} left today`);
      }
      // Re-render modal to show Review buttons
      this.render();
    } catch (err: any) {
      const msg = err.message || "Unknown error";
      if (msg.includes("net::") || msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED")) {
        new Notice(`Quiz: Server not reachable at ${this.serverUrl}. Is it running?`);
      } else if (msg.includes("400")) {
        new Notice(`Quiz: Text too short to generate questions. Read more first.`);
      } else if (msg.includes("timeout") || msg.includes("Timeout")) {
        new Notice(`Quiz: Server took too long. Try again.`);
      } else {
        new Notice(`Quiz failed: ${msg}`);
      }
      btn.textContent = "Generate Quiz";
      btn.disabled = false;
    }
  }

  private async generateSummary(btn: HTMLButtonElement) {
    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      const studyText = await this.getStudyText();
      const data = await aiRequest(this.serverUrl, "/api/summary", {
        text: studyText, language: this.language,
      });

      let content = `---\nsource: "[[${this.notePath}]]"\n---\n\n# Summary\n\n`;
      if (data.summary) content += data.summary + "\n\n";
      if (data.keyTerms && data.keyTerms.length > 0) {
        content += "## Key Terms\n\n";
        for (const t of data.keyTerms) {
          content += `- **${t.term}**: ${t.definition}\n`;
        }
        content += "\n";
      }
      if (data.topics && data.topics.length > 0) {
        content += "## Topics\n\n" + data.topics.map((t: string) => `- ${t}`).join("\n") + "\n";
      }

      // Save as companion file — preserve any user recall sections when regenerating
      const filePath = companionPath(this.notePath!, "Summary");
      const existing = this.app.vault.getAbstractFileByPath(filePath);
      if (existing instanceof TFile) {
        const prev = await this.app.vault.read(existing);
        // Extract and preserve "## My Recall" sections (user's own recall journal)
        const recallMatches = prev.match(/^## My Recall[\s\S]*?(?=^## (?!My Recall)|\Z)/gm);
        if (recallMatches && recallMatches.length > 0) {
          content = content.trimEnd() + "\n\n" + recallMatches.join("\n").trimEnd() + "\n";
        }
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(filePath, content);
      }

      new Notice("Summary saved!");
      // Re-render modal to show Review buttons
      this.render();
    } catch (err: any) {
      const msg = err.message || "Unknown error";
      if (msg.includes("net::") || msg.includes("Failed to fetch") || msg.includes("ECONNREFUSED")) {
        new Notice(`Summary: Server not reachable at ${this.serverUrl}. Is it running?`);
      } else if (msg.includes("400")) {
        new Notice(`Summary: Text too short to summarize.`);
      } else if (msg.includes("timeout") || msg.includes("Timeout")) {
        new Notice(`Summary: Server took too long. Try again.`);
      } else {
        new Notice(`Summary failed: ${msg}`);
      }
      btn.textContent = "Generate Summary";
      btn.disabled = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ===== QUICK RECALL MODAL (free recall — testing effect) =====
//
// Implements free-recall retrieval practice: the single most robust learning
// technique in the literature (Roediger & Karpicke 2011; Pan & Rickard 2018).
// Appears at RSVP close and during reading pauses; saves the user's own recall
// to the Summary companion so they build a personal study journal over time.

type RecallMode = "end" | "mid";

class QuickRecallModal extends Modal {
  private textarea!: HTMLTextAreaElement;
  private vvHandler: (() => void) | null = null;

  constructor(
    app: App,
    private readText: string,       // portion of text just read
    private notePath: string | null,
    private wordsRead: number,
    private serverUrl: string,
    private language: string,
    private mode: RecallMode,
    private onDismissed: (saved: boolean) => void,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-recall-modal");
    const isMobile = (this.app as any).isMobile;
    if (isMobile) contentEl.addClass("mobile");

    const headerText = this.mode === "mid" ? "Quick recall" : "Recall check";
    contentEl.createEl("h2", { text: headerText });

    const sub = contentEl.createEl("p", { cls: "sr-recall-sub" });
    if (this.mode === "mid") {
      sub.setText("In one line: what did you just read?");
    } else {
      sub.setText(`You read ${this.wordsRead} words. Write what you remember — recalling from memory is the most effective way to learn.`);
    }

    // On mobile the keyboard eats most of the screen — put the actions ABOVE the
    // textarea so they remain tappable without dismissing the keyboard first.
    let actionsContainer: HTMLElement | null = null;
    if (isMobile) {
      actionsContainer = contentEl.createDiv({ cls: "sr-recall-actions sr-recall-actions-top" });
    }

    this.textarea = contentEl.createEl("textarea", { cls: "sr-recall-textarea" });
    this.textarea.placeholder = this.mode === "mid"
      ? "e.g. The author argues that..."
      : "What were the main ideas? Any surprising claims? Examples you remember?";
    // Fewer rows on mobile so the textarea fits above the keyboard
    this.textarea.rows = isMobile
      ? (this.mode === "mid" ? 2 : 4)
      : (this.mode === "mid" ? 2 : 6);

    if (!isMobile) {
      actionsContainer = contentEl.createDiv({ cls: "sr-recall-actions" });
    }

    const saveBtn = actionsContainer!.createEl("button", {
      text: this.mode === "mid" ? "Continue" : "Save recall",
      cls: "sr-btn sr-btn-primary",
    });
    saveBtn.onclick = () => this.handleSave();

    const skipBtn = actionsContainer!.createEl("button", { text: "Skip", cls: "sr-btn" });
    skipBtn.onclick = () => { this.close(); this.onDismissed(false); };

    // Ctrl/Cmd+Enter to save
    this.textarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.handleSave();
      }
    });

    // Keyboard handling on mobile — critical to avoid the textarea being hidden
    if (isMobile) {
      this.setupMobileKeyboard();
    }

    // Focus after a tick so mobile keyboards open reliably
    setTimeout(() => this.textarea.focus(), 80);
  }

  /**
   * Mobile keyboard handling: on iOS/Android the on-screen keyboard covers the
   * bottom half of the screen when a textarea gets focus, but the modal layout
   * doesn't know. We use the visualViewport API (the only reliable way to detect
   * the keyboard) to push the modal content up and scroll the textarea into view.
   */
  private setupMobileKeyboard() {
    const vv = (window as any).visualViewport;

    const scrollIntoView = () => {
      if (!this.textarea) return;
      try {
        this.textarea.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {
        this.textarea.scrollIntoView();
      }
    };

    if (vv) {
      this.vvHandler = () => {
        const keyboardHeight = Math.max(0, window.innerHeight - vv.height);
        if (keyboardHeight > 80) {
          // Keyboard is open — add bottom padding so content can scroll above it
          this.contentEl.style.paddingBottom = `${keyboardHeight + 24}px`;
          this.contentEl.addClass("sr-recall-keyboard-open");
          // Delay slightly so layout settles before scrolling
          setTimeout(scrollIntoView, 60);
        } else {
          this.contentEl.style.paddingBottom = "";
          this.contentEl.removeClass("sr-recall-keyboard-open");
        }
      };
      vv.addEventListener("resize", this.vvHandler);
      vv.addEventListener("scroll", this.vvHandler);
    }

    // Focus is the reliable trigger across platforms — some don't fire resize immediately
    this.textarea.addEventListener("focus", () => {
      setTimeout(() => {
        if (this.vvHandler) this.vvHandler();
        scrollIntoView();
      }, 300);
    });
  }

  private async handleSave() {
    const text = this.textarea.value.trim();
    if (!text) {
      new Notice("Write something first (or press Skip).");
      return;
    }

    if (this.notePath) {
      try {
        await this.appendRecallToSummary(text);
        new Notice("Recall saved.");
      } catch (err: any) {
        new Notice(`Could not save recall: ${err.message || err}`);
      }
    }

    this.close();
    this.onDismissed(true);
  }

  private async appendRecallToSummary(recallText: string) {
    if (!this.notePath) return;
    const filePath = companionPath(this.notePath, "Summary");
    const existing = this.app.vault.getAbstractFileByPath(filePath);
    const date = todayISO();
    const section = `\n\n## My Recall — ${date}\n\n${recallText}\n`;

    if (existing instanceof TFile) {
      const prev = await this.app.vault.read(existing);
      await this.app.vault.modify(existing, prev.trimEnd() + section);
    } else {
      const content = `---\nsource: "[[${this.notePath}]]"\n---\n\n# Summary\n${section}`;
      await this.app.vault.create(filePath, content);
    }
  }

  onClose() {
    if (this.vvHandler) {
      const vv = (window as any).visualViewport;
      if (vv) {
        vv.removeEventListener("resize", this.vvHandler);
        vv.removeEventListener("scroll", this.vvHandler);
      }
      this.vvHandler = null;
    }
    this.contentEl.empty();
  }
}

// ===== SPEED READ MODAL (ENHANCED RSVP) =====

class SpeedReadModal extends Modal {
  private words: string[];
  private rawText: string;
  private currentIndex: number = 0;
  private sessionStartIndex: number = 0;
  private intervalId: number | null = null;
  private isRunning: boolean = false;
  private wpm: number;
  private notePath: string | null;
  private showProgressBarSetting: boolean;
  private autoStartSetting: boolean;
  private serverUrl: string;
  private language: string;
  private recallPauseWords: number;
  private forceRecallOnClose: boolean;
  private recallMinWords: number;
  private lastRecallPauseIdx: number;
  private sessionStartTime: number;

  // UI elements
  private displayEl!: HTMLElement;
  private startPauseBtn!: HTMLButtonElement;
  private wpmInput!: HTMLInputElement;
  private progressSlider!: HTMLInputElement;
  // contextEl removed
  private statsEl!: HTMLElement;

  // Spacebar handler
  private globalSpaceHandler: ((e: KeyboardEvent) => void) | null = null;

  // Sentence mapping
  private sentenceStarts: number[] = [];
  private wordSentenceMap: string[] = [];

  // Callbacks
  private onWPMChange?: (wpm: number) => void;
  private onPositionSave?: (index: number, total: number, wpm: number) => void;
  private onStudyRequest?: (readPortionText: string) => void;
  private onSessionComplete?: (wordsRead: number, minutes: number) => void;

  // Pivot constants
  private static readonly DISPLAY_CHARS = 20;
  private static readonly PIVOT_POS = 10;

  constructor(
    app: App,
    text: string,
    options: {
      wpm: number;
      showProgressBar: boolean;
      autoStart: boolean;
      notePath: string | null;
      startIndex: number;
      serverUrl: string;
      language: string;
      recallPauseWords: number;
      forceRecallOnClose: boolean;
      recallMinWords: number;
      onWPMChange?: (wpm: number) => void;
      onPositionSave?: (index: number, total: number, wpm: number) => void;
      onStudyRequest?: (readPortionText: string) => void;
      onSessionComplete?: (wordsRead: number, minutes: number) => void;
    }
  ) {
    super(app);
    this.rawText = text;
    this.wpm = options.wpm;
    this.showProgressBarSetting = options.showProgressBar;
    this.autoStartSetting = options.autoStart;
    this.serverUrl = options.serverUrl;
    this.language = options.language;
    this.notePath = options.notePath;
    this.currentIndex = options.startIndex;
    this.sessionStartIndex = options.startIndex;
    this.recallPauseWords = options.recallPauseWords;
    this.forceRecallOnClose = options.forceRecallOnClose;
    this.recallMinWords = options.recallMinWords;
    this.lastRecallPauseIdx = options.startIndex;
    this.sessionStartTime = Date.now();
    this.onWPMChange = options.onWPMChange;
    this.onPositionSave = options.onPositionSave;
    this.onStudyRequest = options.onStudyRequest;
    this.onSessionComplete = options.onSessionComplete;

    const stripped = SpeedReadModal.stripMarkdown(text);
    this.words = SpeedReadModal.tokenizeText(stripped);
    this.buildSentenceMap(stripped);

    if (this.currentIndex >= this.words.length) {
      this.currentIndex = 0;
    }
  }

  private buildSentenceMap(stripped: string) {
    const parts = stripped.split(/(?<=[.!?;:])\s+/);
    let wordIdx = 0;

    for (const part of parts) {
      const sentWords = part.split(/\s+/).filter((w) => w.length > 0);
      this.sentenceStarts.push(wordIdx);
      for (let i = 0; i < sentWords.length; i++) {
        if (wordIdx < this.words.length) {
          this.wordSentenceMap[wordIdx] = part.trim();
        }
        wordIdx++;
      }
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("speed-read-modal");
    if ((this.app as any).isMobile) {
      contentEl.addClass("mobile");
    }

    // RSVP display area
    this.displayEl = contentEl.createDiv({ cls: "rsvp-display" });
    this.displayEl.setAttr("tabindex", "0");
    this.renderCurrentWord();

    // Touch hint
    const touchHint = contentEl.createDiv({ cls: "rsvp-touch-hint" });
    touchHint.setText("Swipe or tap left/right to navigate");

    // Context sentence removed (distracting on mobile)

    // Progress slider
    if (this.showProgressBarSetting) {
      const progressContainer = contentEl.createDiv({ cls: "rsvp-progress-container" });

      this.progressSlider = progressContainer.createEl("input") as HTMLInputElement;
      this.progressSlider.type = "range";
      this.progressSlider.min = "0";
      this.progressSlider.max = String(Math.max(0, this.words.length - 1));
      this.progressSlider.value = String(this.currentIndex);
      this.progressSlider.className = "rsvp-progress-slider";

      this.progressSlider.addEventListener("input", () => {
        const idx = parseInt(this.progressSlider.value, 10);
        if (!isNaN(idx)) {
          this.currentIndex = idx;
          if (this.isRunning) this.stop();
          this.renderCurrentWord();
          // context removed
          this.updateStats();
        }
      });

      // Stats
      this.statsEl = progressContainer.createDiv({ cls: "rsvp-stats" });
      this.updateStats();
    }

    // Touch gestures
    this.setupTouchGestures();

    // Mouse wheel
    this.displayEl.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        if (this.isRunning) this.stop();
        if (e.deltaY < 0) this.showPreviousWord();
        else if (e.deltaY > 0) this.showNextWord();
      },
      { passive: false }
    );

    // Keyboard navigation
    let lastNavTime = 0;
    this.displayEl.addEventListener("keydown", (e: KeyboardEvent) => {
      const now = Date.now();
      if (now - lastNavTime < 80) return;
      lastNavTime = now;

      if (this.isRunning && e.key !== " " && e.code !== "Space") this.stop();

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          this.showPreviousWord();
          break;
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          this.showNextWord();
          break;
        case "PageUp":
          e.preventDefault();
          this.jumpPrevSentence();
          break;
        case "PageDown":
          e.preventDefault();
          this.jumpNextSentence();
          break;
        case "Home":
          e.preventDefault();
          this.jumpTo(0);
          break;
        case "End":
          e.preventDefault();
          this.jumpTo(this.words.length - 1);
          break;
      }
    });

    // Global spacebar
    this.globalSpaceHandler = (e: KeyboardEvent) => {
      if (
        (e.key === " " || e.code === "Space" || e.keyCode === 32) &&
        document.activeElement &&
        !(document.activeElement instanceof HTMLInputElement) &&
        !(document.activeElement instanceof HTMLTextAreaElement) &&
        !(document.activeElement instanceof HTMLButtonElement)
      ) {
        e.preventDefault();
        e.stopPropagation();
        this.toggle();
        if (this.displayEl) this.displayEl.focus();
      }
    };
    window.addEventListener("keydown", this.globalSpaceHandler, true);

    this.displayEl.focus();

    // Controls
    const controls = contentEl.createDiv({ cls: "rsvp-controls" });

    // Prev sentence
    const prevSentBtn = controls.createEl("button", { text: "◀◀", cls: "rsvp-btn-nav" });
    prevSentBtn.title = "Previous sentence";
    prevSentBtn.onclick = () => this.jumpPrevSentence();

    // Play/Pause
    this.startPauseBtn = controls.createEl("button", { text: "Start", cls: "rsvp-btn-play" });
    this.startPauseBtn.onclick = () => this.toggle();

    // Next sentence
    const nextSentBtn = controls.createEl("button", { text: "▶▶", cls: "rsvp-btn-nav" });
    nextSentBtn.title = "Next sentence";
    nextSentBtn.onclick = () => this.jumpNextSentence();

    // Secondary controls
    const secondary = contentEl.createDiv({ cls: "rsvp-secondary" });

    // WPM
    const wpmGroup = secondary.createDiv({ cls: "rsvp-wpm-group" });
    wpmGroup.createSpan({ text: "WPM " });
    this.wpmInput = wpmGroup.createEl("input") as HTMLInputElement;
    this.wpmInput.type = "number";
    this.wpmInput.value = this.wpm.toString();
    this.wpmInput.min = "50";
    this.wpmInput.max = "2000";
    this.wpmInput.className = "rsvp-wpm-input";
    this.wpmInput.onchange = () => {
      const val = parseInt(this.wpmInput.value, 10);
      if (!isNaN(val) && val > 0) {
        this.wpm = val;
        if (this.onWPMChange) this.onWPMChange(val);
        if (this.isRunning) {
          this.stop();
          this.start();
        }
        this.updateStats();
      }
    };

    // Review flashcards button (if flashcards exist for this note)
    if (this.notePath) {
      const flashPath = companionPath(this.notePath, "Flashcards");
      if (this.app.vault.getAbstractFileByPath(flashPath)) {
        const reviewBtn = secondary.createEl("button", { text: "Review", cls: "sr-btn sr-btn-primary" });
        reviewBtn.onclick = async () => {
          if (this.isRunning) this.stop();
          this.close();
          await this.app.workspace.openLinkText(flashPath, "", true);
          setTimeout(() => {
            tryExecuteCommand(this.app, "obsidian-study-spaced-repetition:srs-review-flashcards-in-note");
          }, 800);
        };
      }
    }

    // Study button
    const studyBtn = secondary.createEl("button", { text: "Study", cls: "sr-btn sr-btn-study" });
    studyBtn.onclick = () => {
      if (this.isRunning) this.stop();
      if (this.onStudyRequest) {
        const portionText = this.words.slice(this.sessionStartIndex, this.currentIndex + 1).join(" ");
        this.onStudyRequest(portionText);
      }
    };

    // Overview button
    const overviewBtn = secondary.createEl("button", { text: "Overview", cls: "sr-btn" });
    overviewBtn.onclick = () => {
      if (this.isRunning) this.stop();
      const overview = new PreReadingModal(this.app, this.rawText, this.wpm, null, this.serverUrl, this.language, () => {}, this.notePath);
      overview.open();
    };

    // Close button
    const closeBtn = secondary.createEl("button", { text: "Close", cls: "sr-btn" });
    closeBtn.onclick = () => this.close();

    // Auto-start
    if (this.autoStartSetting && this.words.length > 0) {
      setTimeout(() => this.start(), 300);
    }
  }

  private setupTouchGestures() {
    let touchStartX: number | null = null;
    let touchStartY: number | null = null;
    let touchMoved = false;
    const SWIPE_THRESHOLD = 40;

    this.displayEl.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
      }
    });

    this.displayEl.addEventListener("touchmove", (e: TouchEvent) => {
      if (touchStartX !== null && e.touches.length === 1) {
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - (touchStartY ?? 0);
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
          if (this.isRunning) this.stop();
          if (dx > 0) this.showPreviousWord();
          else this.showNextWord();
          touchMoved = true;
          touchStartX = null;
          touchStartY = null;
        }
      }
    });

    this.displayEl.addEventListener("touchend", (e: TouchEvent) => {
      if (!touchMoved && touchStartX !== null && e.changedTouches.length === 1) {
        const tapX = e.changedTouches[0].clientX;
        const rect = this.displayEl.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (this.isRunning) this.stop();
        if (tapX < mid) this.showPreviousWord();
        else this.showNextWord();
      }
      touchStartX = null;
      touchStartY = null;
      touchMoved = false;
    });
  }

  onClose() {
    if (this.globalSpaceHandler) {
      window.removeEventListener("keydown", this.globalSpaceHandler, true);
      this.globalSpaceHandler = null;
    }
    this.stop();

    const wordsRead = this.currentIndex - this.sessionStartIndex;
    const minutes = Math.max(1, Math.round((Date.now() - this.sessionStartTime) / 60000));

    // Save position on close
    if (this.onPositionSave) {
      this.onPositionSave(this.currentIndex, this.words.length, this.wpm);
    }

    // Log session for streak/analytics
    if (this.onSessionComplete && wordsRead > 0) {
      this.onSessionComplete(wordsRead, minutes);
    }

    // Forced recall: testing effect (Roediger 2011). Only if enough was read.
    if (this.forceRecallOnClose && wordsRead >= this.recallMinWords) {
      const portionText = this.words.slice(this.sessionStartIndex, this.currentIndex + 1).join(" ");
      // Defer so this modal finishes closing cleanly first
      setTimeout(() => {
        const recall = new QuickRecallModal(
          this.app, portionText, this.notePath, wordsRead,
          this.serverUrl, this.language, "end",
          (saved) => {
            // After recall, offer the full Study modal (spaced repetition)
            if (saved && this.onStudyRequest) {
              this.onStudyRequest(portionText);
            }
          },
        );
        recall.open();
      }, 120);
    }

    this.contentEl.empty();
  }

  private toggle() {
    if (this.isRunning) this.stop();
    else this.start();
  }

  private start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startPauseBtn.textContent = "Pause";
    this.startPauseBtn.classList.add("rsvp-btn-playing");
    this.scheduleNextWord();
  }

  private scheduleNextWord() {
    const word = this.words[this.currentIndex] || "";
    let delay = 60000 / this.wpm;

    // Smart pause: longer delay on punctuation for better comprehension
    if (/[.!?]$/.test(word)) delay *= 1.5;
    else if (/[;:]$/.test(word)) delay *= 1.3;
    else if (/[,]$/.test(word)) delay *= 1.15;

    this.intervalId = window.setTimeout(() => {
      if (this.currentIndex >= this.words.length - 1) {
        this.stop();
        return;
      }
      this.showNextWord();

      // Mid-read recall pause (generation effect) — trigger every N words
      if (
        this.recallPauseWords > 0 &&
        this.currentIndex - this.lastRecallPauseIdx >= this.recallPauseWords
      ) {
        this.lastRecallPauseIdx = this.currentIndex;
        this.stop();
        this.triggerMidRecall();
        return;
      }

      if (this.isRunning) this.scheduleNextWord();
    }, delay);
  }

  private triggerMidRecall() {
    const portion = this.words
      .slice(Math.max(0, this.currentIndex - this.recallPauseWords), this.currentIndex + 1)
      .join(" ");
    const modal = new QuickRecallModal(
      this.app, portion, this.notePath,
      this.recallPauseWords,
      this.serverUrl, this.language, "mid",
      () => {
        // Resume after recall
        if (this.displayEl) this.displayEl.focus();
      },
    );
    modal.open();
  }

  private stop() {
    this.isRunning = false;
    this.startPauseBtn.textContent = "Start";
    this.startPauseBtn.classList.remove("rsvp-btn-playing");
    if (this.intervalId !== null) {
      clearTimeout(this.intervalId);
      this.intervalId = null;
    }
  }

  private jumpTo(index: number) {
    this.currentIndex = Math.max(0, Math.min(index, this.words.length - 1));
    if (this.isRunning) this.stop();
    this.renderCurrentWord();
    this.updateSlider();
    this.updateStats();
  }

  private jumpNextSentence() {
    for (let i = 0; i < this.sentenceStarts.length; i++) {
      if (this.sentenceStarts[i] > this.currentIndex) {
        this.jumpTo(this.sentenceStarts[i]);
        return;
      }
    }
    // Already in last sentence, go to end
    this.jumpTo(this.words.length - 1);
  }

  private jumpPrevSentence() {
    for (let i = this.sentenceStarts.length - 1; i >= 0; i--) {
      if (this.sentenceStarts[i] < this.currentIndex) {
        this.jumpTo(this.sentenceStarts[i]);
        return;
      }
    }
    this.jumpTo(0);
  }

  private renderCurrentWord() {
    const word = this.words[this.currentIndex] || "";
    const pivotIdx = SpeedReadModal.getPivotIndex(word);
    const leftPad = SpeedReadModal.PIVOT_POS - pivotIdx;
    const rightPad = Math.max(0, SpeedReadModal.DISPLAY_CHARS - (leftPad + word.length));

    let html = "";
    for (let i = 0; i < leftPad; i++) {
      html += `<span class="rsvp-invisible-word">m</span>`;
    }
    for (let i = 0; i < word.length; i++) {
      if (i === pivotIdx) {
        html += `<span class="rsvp-pivot-char">${word[i]}</span>`;
      } else {
        html += `<span class="rsvp-focus-word">${word[i]}</span>`;
      }
    }
    for (let i = 0; i < rightPad; i++) {
      html += `<span class="rsvp-invisible-word">m</span>`;
    }
    this.displayEl.innerHTML = html;
  }

  private showNextWord() {
    if (this.currentIndex < this.words.length - 1) {
      this.currentIndex++;
      this.renderCurrentWord();
      this.updateSlider();
      // context removed
      this.updateStats();
    }
  }

  private showPreviousWord() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.renderCurrentWord();
      this.updateSlider();
      // context removed
      this.updateStats();
    }
  }

  private updateSlider() {
    if (this.progressSlider) {
      this.progressSlider.value = String(this.currentIndex);
    }
  }

  // updateContext() removed — context sentence was distracting on mobile

  private updateStats() {
    if (!this.statsEl) return;
    const remaining = this.words.length - this.currentIndex - 1;
    const minutesLeft = Math.ceil(remaining / this.wpm);
    const pct = Math.round(((this.currentIndex + 1) / this.words.length) * 100);
    this.statsEl.textContent = `${this.currentIndex + 1}/${this.words.length} — ${pct}% — ${minutesLeft}m left`;
  }

  // Spritz-like pivot index
  static getPivotIndex(word: string): number {
    if (word.length <= 1) return 0;
    if (word.length <= 5) return 1;
    if (word.length <= 9) return 2;
    return 3;
  }

  // Strip Markdown for RSVP
  static stripMarkdown(text: string): string {
    return text
      .replace(/^---\n[\s\S]*?\n---\n?/m, "") // YAML frontmatter
      .replace(/`{3}[\s\S]*?`{3}/g, "")
      .replace(/`[^`]*`/g, "")
      .replace(/!\[.*?\]\(.*?\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/==/g, "")
      .replace(/[*_~`>#-]/g, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*>+\s?/gm, "")
      .replace(/#+\s/g, "")
      .replace(/\n{2,}/g, "\n")
      .replace(/\r/g, "")
      .trim();
  }

  // Tokenize text into words
  static tokenizeText(text: string): string[] {
    return text
      .replace(/\s+/g, " ")
      .split(" ")
      .filter((w) => w.length > 0);
  }
}

// ===== SETTINGS TAB =====

class SpeedReadingSettingTab extends PluginSettingTab {
  plugin: SpeedReadingPlugin;

  constructor(app: App, plugin: SpeedReadingPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Speed Reading Settings" });

    new Setting(containerEl)
      .setName("Default WPM")
      .setDesc("Default words per minute for speed reading.")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(this.plugin.settings.defaultWPM.toString())
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.defaultWPM = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Show Progress Bar")
      .setDesc("Show progress slider and stats in the RSVP modal.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showProgressBar).onChange(async (value) => {
          this.plugin.settings.showProgressBar = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto Start")
      .setDesc("Automatically start reading when the modal opens.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStart).onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        })
      );

    // ===== LEARNING SCIENCE SETTINGS =====

    containerEl.createEl("h2", { text: "Learning Science" });

    const info = containerEl.createEl("p", { cls: "sr-settings-info" });
    info.setText(
      "These features are backed by cognitive psychology research: retrieval practice (Roediger & Karpicke 2011), " +
      "spaced repetition (PNAS 2019), implementation intentions (Adriaanse 2010), and low-friction habit cues (Stawarz CHI 2015)."
    );

    new Setting(containerEl)
      .setName("Study cue (implementation intention)")
      .setDesc("When will you study? e.g. \"after breakfast\" or \"on the bus\". Shown as a reminder in Today's Session. Empirically triples adherence (Adriaanse 2010).")
      .addText((text) =>
        text
          .setPlaceholder("after breakfast")
          .setValue(this.plugin.settings.studyCue)
          .onChange(async (value) => {
            this.plugin.settings.studyCue = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Force recall on close")
      .setDesc("When you close RSVP after reading enough, prompt a free-recall (textarea). This is the single most effective learning technique in the literature.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.forceRecallOnClose).onChange(async (value) => {
          this.plugin.settings.forceRecallOnClose = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Minimum words for recall prompt")
      .setDesc("Minimum words read in a session before the recall prompt appears.")
      .addText((text) =>
        text
          .setPlaceholder("200")
          .setValue(String(this.plugin.settings.recallMinWords))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.recallMinWords = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Mid-read recall pause")
      .setDesc("Pause every N words to write a 1-line recall (generation effect). 0 = disabled. Recommended: 500–800 if you use it.")
      .addText((text) =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.recallPauseWords))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.recallPauseWords = n;
              await this.plugin.saveSettings();
            }
          })
      );

    containerEl.createEl("h3", { text: "Card limits" });

    const limitsInfo = containerEl.createEl("p", { cls: "sr-settings-info" });
    limitsInfo.setText(
      "Two safeguards: a per-note cap (only the most essential N cards per chapter — minimum-information principle, SuperMemo) " +
      "and a daily budget across ALL notes (Anki's proven default: ~20 new cards/day prevents cognitive overload)."
    );

    new Setting(containerEl)
      .setName("Max flashcards per note")
      .setDesc("Only the N most essential cards per chapter. Default: 4. Forces you to keep only the core ideas.")
      .addText((text) =>
        text
          .setPlaceholder("4")
          .setValue(String(this.plugin.settings.maxCardsPerFile))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxCardsPerFile = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max quiz questions per note")
      .setDesc("Default: 4.")
      .addText((text) =>
        text
          .setPlaceholder("4")
          .setValue(String(this.plugin.settings.maxQuestionsPerFile))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxQuestionsPerFile = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Daily new-card budget")
      .setDesc("Global cap on NEW flashcards generated per day, across all notes. Default: 20 (Anki's default). Once reached, generation is blocked until tomorrow.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.dailyNewCardsBudget))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.dailyNewCardsBudget = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Daily new-question budget")
      .setDesc("Global cap on NEW quiz questions per day. Default: 10.")
      .addText((text) =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.dailyNewQuestionsBudget))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.dailyNewQuestionsBudget = n;
              await this.plugin.saveSettings();
            }
          })
      );

    // Today's usage display
    const today = todayISO();
    const gen = this.plugin.settings.dailyGenCounts[today] ?? { cards: 0, questions: 0 };
    const usageBox = containerEl.createDiv({ cls: "sr-settings-streak-box" });
    usageBox.setText(
      `Today: ${gen.cards}/${this.plugin.settings.dailyNewCardsBudget} cards · ${gen.questions}/${this.plugin.settings.dailyNewQuestionsBudget} questions generated`
    );

    // Streak display
    const streakBox = containerEl.createDiv({ cls: "sr-settings-streak-box" });
    streakBox.createEl("span", { text: "🔥 ", cls: "sr-settings-streak-icon" });
    streakBox.createEl("span", {
      text: `Current streak: ${this.plugin.settings.currentStreak} day${this.plugin.settings.currentStreak === 1 ? "" : "s"} — longest: ${this.plugin.settings.longestStreak}`,
    });

    containerEl.createEl("h2", { text: "Study Server" });

    new Setting(containerEl)
      .setName("Study Server URL")
      .setDesc("URL of the Claude Study Server for AI-powered study features. Leave empty to use only heuristic generation. Example: http://100.x.x.x:3457")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:3457")
          .setValue(this.plugin.settings.studyServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.studyServerUrl = value.replace(/\/+$/, "");
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Study Language")
      .setDesc("Language for AI-generated content.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            es: "Spanish",
            en: "English",
            pt: "Portuguese",
            fr: "French",
            de: "German",
            it: "Italian",
          })
          .setValue(this.plugin.settings.studyLanguage)
          .onChange(async (value) => {
            this.plugin.settings.studyLanguage = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h2", { text: "Data" });

    new Setting(containerEl)
      .setName("Clear Reading History")
      .setDesc(`Clear all saved reading positions (${Object.keys(this.plugin.settings.readingPositions).length} saved).`)
      .addButton((button) =>
        button.setButtonText("Clear All").onClick(async () => {
          this.plugin.settings.readingPositions = {};
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
          new Notice("Reading history cleared.");
          this.display();
        })
      );

    new Setting(containerEl)
      .setName("Reset streak & sessions")
      .setDesc(`Clear session log and streak (${this.plugin.settings.sessionLog.length} sessions logged).`)
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.sessionLog = [];
          this.plugin.settings.currentStreak = 0;
          this.plugin.settings.longestStreak = 0;
          this.plugin.settings.lastSessionDate = "";
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
          new Notice("Streak and session log reset.");
          this.display();
        })
      );
  }
}

// ===== TODAY'S SESSION MODAL =====
//
// Single low-friction daily entry point. Research basis:
//   - Stawarz, Cox & Blandford (CHI 2015): habit apps succeed when they act as a
//     contextual cue with one-tap re-entry, not when they show vanity metrics.
//   - Adriaanse (2010): implementation intentions ("I study after ___") greatly
//     increase adherence — we surface the user's cue here as a reminder.
//   - Brown/Roediger (Make It Stick 2014): interleaving beats blocked practice —
//     we route flashcard review through the global spaced-repetition queue, which
//     already mixes cards across notes, rather than opening one file at a time.

class TodaySessionModal extends Modal {
  constructor(
    app: App,
    private plugin: SpeedReadingPlugin,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("sr-today-modal");
    if ((this.app as any).isMobile) contentEl.addClass("mobile");

    const s = this.plugin.settings;

    // Header: streak banner
    const header = contentEl.createDiv({ cls: "sr-today-header" });
    const streakEl = header.createDiv({ cls: "sr-today-streak" });
    streakEl.createSpan({ text: "🔥", cls: "sr-today-streak-icon" });
    streakEl.createSpan({ text: `${s.currentStreak}`, cls: "sr-today-streak-num" });
    streakEl.createSpan({ text: " day streak", cls: "sr-today-streak-label" });

    if (s.longestStreak > s.currentStreak) {
      header.createDiv({ cls: "sr-today-subtle", text: `Best: ${s.longestStreak} days` });
    }

    // Implementation-intention cue
    if (s.studyCue) {
      const cueBox = contentEl.createDiv({ cls: "sr-today-cue" });
      cueBox.createEl("span", { text: "Your cue: ", cls: "sr-today-cue-label" });
      cueBox.createEl("span", { text: s.studyCue, cls: "sr-today-cue-text" });
    }

    // Actions
    const actions = contentEl.createDiv({ cls: "sr-today-actions" });

    // 1) Global spaced-repetition review (interleaved)
    const srBtn = actions.createEl("button", {
      text: "Review flashcards (interleaved)",
      cls: "sr-btn sr-btn-primary sr-btn-large",
    });
    srBtn.onclick = () => {
      this.close();
      const ok = tryExecuteCommand(this.app, "obsidian-study-spaced-repetition:srs-review-flashcards");
      if (!ok) {
        new Notice("Install obsidian-study-spaced-repetition to review due cards.");
      }
    };

    // 2) Continue last reading
    const lastReading = this.plugin.getMostRecentReading();
    if (lastReading) {
      const pct = Math.round((lastReading.pos.wordIndex / lastReading.pos.totalWords) * 100);
      const name = lastReading.path.split("/").pop()?.replace(/\.md$/, "") ?? lastReading.path;
      const contBtn = actions.createEl("button", { cls: "sr-btn sr-btn-large sr-today-continue" });
      contBtn.createDiv({ text: `Continue: ${name}`, cls: "sr-today-btn-title" });
      contBtn.createDiv({ text: `${pct}% — last read ${this.relativeDate(lastReading.pos.lastRead)}`, cls: "sr-today-btn-sub" });
      contBtn.onclick = async () => {
        this.close();
        await this.plugin.continueReading(lastReading.path);
      };
    } else {
      const emptyBtn = actions.createEl("button", {
        text: "Open a note and run \"Speed Read\" to start",
        cls: "sr-btn sr-btn-large",
      });
      emptyBtn.disabled = true;
    }

    // 3) Today's stats
    const todayStr = todayISO();
    const todayEntries = s.sessionLog.filter(e => e.date === todayStr);
    if (todayEntries.length > 0) {
      const wordsToday = todayEntries.reduce((a, e) => a + e.wordsRead, 0);
      const minToday = todayEntries.reduce((a, e) => a + e.minutes, 0);
      const stats = contentEl.createDiv({ cls: "sr-today-stats" });
      stats.setText(`Today: ${wordsToday} words · ${minToday} min · ${todayEntries.length} session${todayEntries.length === 1 ? "" : "s"}`);
    } else if (s.lastSessionDate && s.lastSessionDate !== todayStr) {
      const stats = contentEl.createDiv({ cls: "sr-today-stats sr-today-stats-warn" });
      const gap = daysBetween(s.lastSessionDate, todayStr);
      if (gap === 1) stats.setText("No session yet today — keep the streak alive.");
      else stats.setText(`Last session: ${gap} days ago.`);
    }

    // 4) New-card budget (Anki-style) — shows how many new cards/questions left today
    const gen = this.plugin.getDailyGenCount();
    const budgetBox = contentEl.createDiv({ cls: "sr-today-budget" });
    budgetBox.createDiv({
      cls: "sr-today-budget-row",
      text: `🧠 New cards today: ${gen.cards}/${s.dailyNewCardsBudget}`,
    });
    budgetBox.createDiv({
      cls: "sr-today-budget-row",
      text: `❓ New questions today: ${gen.questions}/${s.dailyNewQuestionsBudget}`,
    });

    // Close
    const closeBtn = contentEl.createEl("button", { text: "Close", cls: "sr-btn sr-today-close" });
    closeBtn.onclick = () => this.close();
  }

  private relativeDate(iso: string): string {
    const dt = new Date(iso);
    const diffDays = Math.floor((Date.now() - dt.getTime()) / 86400000);
    if (diffDays <= 0) return "today";
    if (diffDays === 1) return "yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return dt.toLocaleDateString();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ===== PLUGIN =====

export default class SpeedReadingPlugin extends Plugin {
  settings!: SpeedReadingSettings;
  private currentModal: SpeedReadModal | null = null;
  private statusBarEl: HTMLElement | null = null;

  // ===== Daily generation budget (Anki-style new-card limit) =====

  getDailyGenCount(): { cards: number; questions: number } {
    const today = todayISO();
    return this.settings.dailyGenCounts[today] ?? { cards: 0, questions: 0 };
  }

  /** How many more new cards can be generated today across ALL notes. */
  remainingDailyCards(): number {
    return Math.max(0, this.settings.dailyNewCardsBudget - this.getDailyGenCount().cards);
  }

  remainingDailyQuestions(): number {
    return Math.max(0, this.settings.dailyNewQuestionsBudget - this.getDailyGenCount().questions);
  }

  async incrementDailyGen(kind: "cards" | "questions", n: number) {
    if (n <= 0) return;
    const today = todayISO();
    const cur = this.settings.dailyGenCounts[today] ?? { cards: 0, questions: 0 };
    cur[kind] = (cur[kind] ?? 0) + n;
    this.settings.dailyGenCounts[today] = cur;
    // Trim old entries (keep last MAX_DAILY_GEN_HISTORY days)
    const dates = Object.keys(this.settings.dailyGenCounts).sort();
    if (dates.length > MAX_DAILY_GEN_HISTORY) {
      const toDrop = dates.slice(0, dates.length - MAX_DAILY_GEN_HISTORY);
      for (const d of toDrop) delete this.settings.dailyGenCounts[d];
    }
    await this.saveSettings();
  }

  async savePosition(notePath: string, index: number, total: number, wpm: number) {
    const existing = this.settings.readingPositions[notePath];
    this.settings.readingPositions[notePath] = {
      wordIndex: index,
      totalWords: total,
      lastRead: new Date().toISOString(),
      wpm,
      lastStudiedIndex: existing?.lastStudiedIndex ?? 0,
    };
    this.trimReadingPositions();
    await this.saveSettings();
    this.updateStatusBar();
  }

  openRSVP(text: string, notePath: string | null, startIndex: number, wpm?: number) {
    if (this.currentModal) this.currentModal.close();

    this.currentModal = new SpeedReadModal(this.app, text, {
      wpm: wpm ?? this.settings.defaultWPM,
      showProgressBar: this.settings.showProgressBar,
      autoStart: this.settings.autoStart,
      notePath,
      startIndex,
      serverUrl: this.settings.studyServerUrl,
      language: this.settings.studyLanguage,
      recallPauseWords: this.settings.recallPauseWords,
      forceRecallOnClose: this.settings.forceRecallOnClose,
      recallMinWords: this.settings.recallMinWords,
      onWPMChange: async (newWpm: number) => {
        this.settings.defaultWPM = newWpm;
        await this.saveSettings();
      },
      onPositionSave: async (index: number, total: number, currentWpm: number) => {
        if (notePath) await this.savePosition(notePath, index, total, currentWpm);
      },
      onStudyRequest: (readPortionText: string) => {
        const study = new StudyModal(this.app, readPortionText, notePath, this);
        study.open();
      },
      onSessionComplete: async (wordsRead: number, minutes: number) => {
        await this.logSession(notePath ?? "(selection)", wordsRead, minutes);
      },
    });
    this.currentModal.open();

    if (startIndex > 0 && notePath) {
      const pct = Math.round((startIndex / SpeedReadModal.tokenizeText(SpeedReadModal.stripMarkdown(text)).length) * 100);
      new Notice(`Resumed from ${pct}%`);
    }
  }

  async onload() {
    await this.loadSettings();

    // Get note path from active view, with fallback to workspace.getActiveFile()
    // (handles cases where focus is on sidebar, canvas, or a non-markdown view
    // while a markdown file is still the "active" file in the workspace)
    const getNotePath = (): string | null => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file) return view.file.path;
      const activeFile = this.app.workspace.getActiveFile();
      return activeFile?.path ?? null;
    };

    // Get text from editor, active markdown view, or active file (async read)
    const getText = async (editor?: Editor): Promise<string> => {
      if (editor) {
        const sel = editor.getSelection();
        if (sel && sel.trim() !== "") return sel;
        return editor.getValue();
      }
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        const ed = view.editor;
        const sel = ed.getSelection();
        if (sel && sel.trim() !== "") return sel;
        return ed.getValue();
      }
      // Fallback: read directly from the active file via vault
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof TFile) {
        return await this.app.vault.cachedRead(activeFile);
      }
      return "";
    };

    // Convenience alias for commands defined below
    const openRSVP = (text: string, notePath: string | null, startIndex: number, wpm?: number) =>
      this.openRSVP(text, notePath, startIndex, wpm);

    // ---- COMMANDS ----

    // Speed Read (with pre-reading for new, direct resume for returning)
    this.addCommand({
      id: "speed-read-current-note-or-selection",
      name: "Speed Read Current Note or Selection",
      callback: async () => {
        const text = await getText();
        if (!text || text.trim() === "") {
          new Notice("No text found to speed read.");
          return;
        }

        const notePath = getNotePath();
        const savedPos = notePath ? this.settings.readingPositions[notePath] : null;

        if (savedPos && savedPos.wordIndex > 0) {
          // Has saved position — resume directly
          openRSVP(text, notePath, savedPos.wordIndex, savedPos.wpm);
        } else {
          // First time — show pre-reading overview
          const overview = new PreReadingModal(
            this.app,
            text,
            this.settings.defaultWPM,
            null,
            this.settings.studyServerUrl,
            this.settings.studyLanguage,
            (fromBeginning: boolean) => {
              openRSVP(text, notePath, 0);
            },
            notePath
          );
          overview.open();
        }
      },
    });

    // Speed Read Selected Text (editor command)
    this.addCommand({
      id: "speed-read-selected-text",
      name: "Speed Read Selected Text",
      editorCallback: (editor: Editor) => {
        const selectedText = editor.getSelection();
        if (!selectedText || selectedText.trim() === "") {
          new Notice("Please select text to speed read.");
          return;
        }
        openRSVP(selectedText, null, 0);
      },
    });

    // Continue Last Reading
    this.addCommand({
      id: "speed-read-continue-last",
      name: "Continue Last Reading",
      callback: async () => {
        const entries = Object.entries(this.settings.readingPositions);
        if (entries.length === 0) {
          new Notice("No reading history found.");
          return;
        }

        // Find most recent
        entries.sort((a, b) => new Date(b[1].lastRead).getTime() - new Date(a[1].lastRead).getTime());
        const [lastPath, lastPos] = entries[0];

        const file = this.app.vault.getAbstractFileByPath(lastPath);
        if (!(file instanceof TFile)) {
          new Notice(`File not found: ${lastPath}`);
          return;
        }

        const text = await this.app.vault.read(file);
        if (!text || text.trim() === "") {
          new Notice("File is empty.");
          return;
        }

        openRSVP(text, lastPath, lastPos.wordIndex, lastPos.wpm);
      },
    });

    // Speed Read with Overview (always shows pre-reading)
    this.addCommand({
      id: "speed-read-with-overview",
      name: "Speed Read with Overview",
      callback: async () => {
        const text = await getText();
        if (!text || text.trim() === "") {
          new Notice("No text found to speed read.");
          return;
        }

        const notePath = getNotePath();
        const savedPos = notePath ? this.settings.readingPositions[notePath] : null;

        const overview = new PreReadingModal(
          this.app,
          text,
          this.settings.defaultWPM,
          savedPos ?? null,
          this.settings.studyServerUrl,
          this.settings.studyLanguage,
          (fromBeginning: boolean) => {
            const startIdx = fromBeginning ? 0 : (savedPos?.wordIndex ?? 0);
            const wpm = fromBeginning ? this.settings.defaultWPM : (savedPos?.wpm ?? this.settings.defaultWPM);
            openRSVP(text, notePath, startIdx, wpm);
          },
          notePath
        );
        overview.open();
      },
    });

    // Generate Study Cards
    this.addCommand({
      id: "speed-read-study-cards",
      name: "Generate Study Cards",
      callback: async () => {
        const text = await getText();
        if (!text || text.trim() === "") {
          new Notice("No text found.");
          return;
        }
        const notePath = getNotePath();
        const study = new StudyModal(this.app, text, notePath, this);
        study.open();
      },
    });

    // Restart Reading (resets position)
    this.addCommand({
      id: "speed-read-restart",
      name: "Speed Read from Beginning",
      callback: async () => {
        const text = await getText();
        if (!text || text.trim() === "") {
          new Notice("No text found to speed read.");
          return;
        }
        const notePath = getNotePath();
        openRSVP(text, notePath, 0);
      },
    });

    // Today's Session — one-tap daily entry
    this.addCommand({
      id: "speed-read-today-session",
      name: "Today's Session",
      callback: () => {
        new TodaySessionModal(this.app, this).open();
      },
    });

    // Ribbon icons
    this.addRibbonIcon("bolt", "Speed Read Current Note", () => {
      (this.app as any).commands.executeCommandById("speed-reading:speed-read-current-note-or-selection");
    });

    this.addRibbonIcon("calendar-check", "Today's Session", () => {
      new TodaySessionModal(this.app, this).open();
    });

    this.addRibbonIcon("play", "Continue Last Reading", () => {
      (this.app as any).commands.executeCommandById("speed-reading:speed-read-continue-last");
    });

    // Statusbar: streak + last reading + click to open Today's Session
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("sr-statusbar");
    this.statusBarEl.addEventListener("click", () => {
      new TodaySessionModal(this.app, this).open();
    });
    this.updateStatusBar();

    this.addSettingTab(new SpeedReadingSettingTab(this.app, this));
  }

  // ===== Public helpers used by modals =====

  updateStatusBar() {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();
    const s = this.settings;

    // Streak indicator (only if > 0)
    if (s.currentStreak > 0) {
      const streak = this.statusBarEl.createSpan({ cls: "sr-statusbar-item" });
      streak.createSpan({ text: "🔥" });
      streak.createSpan({ text: ` ${s.currentStreak}` });
    }

    // Current reading
    const recent = this.getMostRecentReading();
    if (recent) {
      const pct = Math.round((recent.pos.wordIndex / recent.pos.totalWords) * 100);
      const name = recent.path.split("/").pop()?.replace(/\.md$/, "") ?? "";
      const short = name.length > 22 ? name.substring(0, 20) + "…" : name;
      const item = this.statusBarEl.createSpan({ cls: "sr-statusbar-item" });
      item.setText(`📖 ${short} ${pct}%`);
    } else if (s.currentStreak === 0) {
      this.statusBarEl.createSpan({ cls: "sr-statusbar-item", text: "📖 Speed Read" });
    }
  }

  getMostRecentReading(): { path: string; pos: ReadingPosition } | null {
    const entries = Object.entries(this.settings.readingPositions);
    if (entries.length === 0) return null;
    entries.sort((a, b) => new Date(b[1].lastRead).getTime() - new Date(a[1].lastRead).getTime());
    const [path, pos] = entries[0];
    // Skip if already finished (>95%)
    if (pos.wordIndex / pos.totalWords > 0.95) {
      // try the next unfinished
      for (const [p, ps] of entries) {
        if (ps.wordIndex / ps.totalWords <= 0.95) return { path: p, pos: ps };
      }
      return { path, pos };
    }
    return { path, pos };
  }

  async continueReading(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`File not found: ${path}`);
      return;
    }
    const text = await this.app.vault.read(file);
    if (!text || text.trim() === "") {
      new Notice("File is empty.");
      return;
    }
    const pos = this.settings.readingPositions[path];
    this.openRSVP(text, path, pos?.wordIndex ?? 0, pos?.wpm);
  }

  async logSession(notePath: string, wordsRead: number, minutes: number) {
    const today = todayISO();
    this.settings.sessionLog.push({ date: today, notePath, wordsRead, minutes });
    // Trim oldest
    if (this.settings.sessionLog.length > MAX_SESSION_LOG) {
      this.settings.sessionLog = this.settings.sessionLog.slice(-MAX_SESSION_LOG);
    }
    // Update streak
    const last = this.settings.lastSessionDate;
    if (last !== today) {
      const gap = last ? daysBetween(last, today) : Infinity;
      if (gap === 1) {
        this.settings.currentStreak += 1;
      } else if (gap > 1) {
        this.settings.currentStreak = 1;
      } else {
        // gap === 0 or negative — shouldn't happen since last !== today
        this.settings.currentStreak = Math.max(1, this.settings.currentStreak);
      }
      if (this.settings.currentStreak > this.settings.longestStreak) {
        this.settings.longestStreak = this.settings.currentStreak;
      }
      this.settings.lastSessionDate = today;
    }
    await this.saveSettings();
    this.updateStatusBar();
  }

  private trimReadingPositions() {
    const entries = Object.entries(this.settings.readingPositions);
    if (entries.length > MAX_POSITIONS) {
      entries.sort((a, b) => new Date(b[1].lastRead).getTime() - new Date(a[1].lastRead).getTime());
      this.settings.readingPositions = Object.fromEntries(entries.slice(0, MAX_POSITIONS));
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.readingPositions) {
      this.settings.readingPositions = {};
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    if (this.currentModal) {
      this.currentModal.close();
      this.currentModal = null;
    }
  }
}
