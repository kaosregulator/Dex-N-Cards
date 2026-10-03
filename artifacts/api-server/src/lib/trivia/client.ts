// Trivia question providers — OpenTDB (no key), QuizAPI.io (QUIZAPI_KEY),
// boneitis.org (prompts / gaming trivia display), dog.ceo picture flashes.

import { resolvedEnv } from "../runtime-env.js";
import { logger } from "../logger.js";

export type TriviaAudience = "younger" | "general";
export type TriviaProvider = "opentdb" | "quizapi" | "boneitis" | "picture";

export type NormalizedQuestion = {
  id: string;
  provider: TriviaProvider;
  category: string;
  difficulty: string;
  type: "multiple" | "boolean" | "open" | "picture";
  question: string;
  /** Shuffled choices for multiple/boolean; empty for open/picture typing. */
  choices: string[];
  correctAnswer: string;
  imageUrl?: string | null;
  meta?: Record<string, unknown>;
};

const OPENTDB_SAFE_YOUNGER = new Set([
  9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32,
]);
/** Politics / Celebrities left out of younger audiences. */
const OPENTDB_BLOCKED_YOUNGER = new Set([23, 24, 25, 26]);

export const OPENTDB_CATEGORIES: Array<{ id: number; name: string; emoji: string }> = [
  { id: 9, name: "General Knowledge", emoji: "🧠" },
  { id: 15, name: "Video Games", emoji: "🎮" },
  { id: 16, name: "Board Games", emoji: "🎲" },
  { id: 11, name: "Film", emoji: "🎬" },
  { id: 14, name: "Television", emoji: "📺" },
  { id: 12, name: "Music", emoji: "🎵" },
  { id: 17, name: "Science & Nature", emoji: "🔬" },
  { id: 18, name: "Computers", emoji: "💻" },
  { id: 21, name: "Sports", emoji: "⚽" },
  { id: 22, name: "Geography", emoji: "🌍" },
  { id: 27, name: "Animals", emoji: "🐾" },
  { id: 31, name: "Anime & Manga", emoji: "🍥" },
  { id: 32, name: "Cartoons", emoji: "🎨" },
  { id: 20, name: "Mythology", emoji: "⚡" },
  { id: 23, name: "History", emoji: "📜" },
  { id: 10, name: "Books", emoji: "📚" },
];

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&eacute;/g, "é")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&rsquo;/g, "'")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function normalizeAnswer(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function answersMatch(guess: string, correct: string, alsoAccept?: string[]): boolean {
  const g = normalizeAnswer(guess);
  const candidates = [correct, ...(alsoAccept ?? [])].map(normalizeAnswer).filter(Boolean);
  if (!g || !candidates.length) return false;
  for (const c of candidates) {
    if (g === c) return true;
    // Allow compact forms / slight extras for typed guesses.
    if (c.length >= 4 && (g.includes(c) || c.includes(g))) return true;
    // Token-set equality ("afghan hound" == "hound afghan")
    const gt = [...g.split(" ")].sort().join(" ");
    const ct = [...c.split(" ")].sort().join(" ");
    if (gt && gt === ct) return true;
  }
  return false;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function isQuizApiConfigured(): boolean {
  return Boolean(resolvedEnv("QUIZAPI_KEY") ?? resolvedEnv("QUIZ_API_KEY"));
}

function quizApiKey(): string | null {
  return resolvedEnv("QUIZAPI_KEY") ?? resolvedEnv("QUIZ_API_KEY");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "DN-Cards-Trivia/1.0",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 160) || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchOpenTdbQuestion(opts: {
  categoryId?: number | null;
  audience?: TriviaAudience;
  difficulty?: "easy" | "medium" | "hard" | "";
  type?: "multiple" | "boolean" | "";
}): Promise<NormalizedQuestion> {
  const params = new URLSearchParams({ amount: "1", encode: "url3986" });
  let cat = opts.categoryId ?? null;
  if (opts.audience === "younger") {
    params.set("difficulty", opts.difficulty || "easy");
    if (cat != null && OPENTDB_BLOCKED_YOUNGER.has(cat)) cat = null;
    if (cat == null) {
      const pool = [...OPENTDB_SAFE_YOUNGER];
      cat = pool[Math.floor(Math.random() * pool.length)]!;
    }
  } else if (opts.difficulty) {
    params.set("difficulty", opts.difficulty);
  }
  if (cat != null) params.set("category", String(cat));
  if (opts.type) params.set("type", opts.type);

  const data = await fetchJson<{
    response_code: number;
    results: Array<{
      category: string;
      type: string;
      difficulty: string;
      question: string;
      correct_answer: string;
      incorrect_answers: string[];
    }>;
  }>(`https://opentdb.com/api.php?${params}`);

  if (data.response_code !== 0 || !data.results?.[0]) {
    throw new Error("OpenTDB returned no questions for that filter — try another category.");
  }
  const row = data.results[0]!;
  const question = decodeURIComponent(row.question);
  const correct = decodeURIComponent(row.correct_answer);
  const incorrect = row.incorrect_answers.map(a => decodeURIComponent(a));
  const choices = shuffle([correct, ...incorrect]);
  return {
    id: `opentdb:${normalizeAnswer(question).slice(0, 40)}:${normalizeAnswer(correct)}`,
    provider: "opentdb",
    category: decodeURIComponent(row.category),
    difficulty: row.difficulty,
    type: row.type === "boolean" ? "boolean" : "multiple",
    question: decodeHtml(question),
    choices: choices.map(decodeHtml),
    correctAnswer: decodeHtml(correct),
  };
}

export async function fetchQuizApiQuestion(opts: {
  category?: string | null;
  difficulty?: string | null;
  tags?: string | null;
}): Promise<NormalizedQuestion> {
  const key = quizApiKey();
  if (!key) throw new Error("QuizAPI key missing — set QUIZAPI_KEY.");

  const params = new URLSearchParams({ limit: "1" });
  if (opts.category) params.set("category", opts.category);
  if (opts.difficulty) params.set("difficulty", opts.difficulty);
  if (opts.tags) params.set("tags", opts.tags);

  type QuizRow = {
    id: number;
    question: string;
    description?: string | null;
    answers: Record<string, string | null>;
    correct_answers: Record<string, string>;
    category?: string;
    difficulty?: string;
    multiple_correct_answers?: string;
  };

  const rows = await fetchJson<QuizRow[]>(
    `https://quizapi.io/api/v1/questions?${params}`,
    { headers: { "X-Api-Key": key } },
  );
  const row = rows?.[0];
  if (!row) throw new Error("QuizAPI returned no questions.");

  const entries = Object.entries(row.answers ?? {}).filter(([, v]) => v != null && String(v).trim());
  const correctKeys = new Set(
    Object.entries(row.correct_answers ?? {})
      .filter(([, v]) => String(v).toLowerCase() === "true")
      .map(([k]) => k.replace(/_correct$/, "")),
  );
  const correctList = entries.filter(([k]) => correctKeys.has(k)).map(([, v]) => String(v));
  const correctAnswer = correctList[0] ?? "";
  if (!correctAnswer) throw new Error("QuizAPI question had no correct answer.");

  const choices = shuffle(entries.map(([, v]) => String(v)));
  return {
    id: `quizapi:${row.id}`,
    provider: "quizapi",
    category: row.category ?? opts.category ?? "QuizAPI",
    difficulty: (row.difficulty ?? "medium").toLowerCase(),
    type: "multiple",
    question: row.question,
    choices,
    correctAnswer,
    meta: { allCorrect: correctList },
  };
}

export async function fetchBoneitisPrompt(kind: "today" | "random" = "random"): Promise<NormalizedQuestion> {
  const path = kind === "today" ? "/today?category=general" : "/random/general";
  const data = await fetchJson<{ question: string; category?: string; date?: string }>(
    `https://boneitis.org${path}`,
  );
  return {
    id: `boneitis:${kind}:${normalizeAnswer(data.question).slice(0, 48)}`,
    provider: "boneitis",
    category: data.category ?? "Community",
    difficulty: "fun",
    type: "open",
    question: data.question,
    choices: [],
    correctAnswer: "", // conversation prompt — host awards manually / random
    meta: { conversational: true, date: data.date },
  };
}

/** Picture flash: guess the dog breed from dog.ceo. */
export async function fetchPictureQuestion(): Promise<NormalizedQuestion> {
  const data = await fetchJson<{ message: string; status: string }>(
    "https://dog.ceo/api/breeds/image/random",
  );
  if (data.status !== "success" || !data.message) {
    throw new Error("Could not fetch a picture round image.");
  }
  // URL like …/breeds/hound-afghan/n02088094_1003.jpg or …/breeds/pug/…
  const m = data.message.match(/\/breeds\/([^/]+)\//i);
  const slug = m?.[1] ?? "dog";
  // dog.ceo uses "breed" or "breed-subbreed" (e.g. hound-afghan → Afghan Hound).
  const parts = slug.split("-");
  const pretty = (parts.length >= 2
    ? `${parts.slice(1).join(" ")} ${parts[0]}`
    : parts[0]!
  ).replace(/\b\w/g, c => c.toUpperCase());
  return {
    id: `picture:${slug}:${Date.now()}`,
    provider: "picture",
    category: "Animals · Picture",
    difficulty: "easy",
    type: "picture",
    question: "What breed is this dog?",
    choices: [],
    correctAnswer: pretty,
    imageUrl: data.message,
    meta: { breedSlug: slug, accept: [pretty, parts.join(" ")].map(normalizeAnswer) },
  };
}

export async function fetchQuestion(opts: {
  provider: TriviaProvider;
  categoryId?: number | null;
  categoryName?: string | null;
  audience?: TriviaAudience;
  difficulty?: string | null;
  conversational?: boolean;
}): Promise<NormalizedQuestion> {
  switch (opts.provider) {
    case "quizapi":
      return fetchQuizApiQuestion({
        category: opts.categoryName,
        difficulty: opts.difficulty,
      });
    case "boneitis":
      return fetchBoneitisPrompt(opts.conversational === false ? "random" : "random");
    case "picture":
      return fetchPictureQuestion();
    case "opentdb":
    default:
      return fetchOpenTdbQuestion({
        categoryId: opts.categoryId,
        audience: opts.audience ?? "general",
        difficulty: (opts.difficulty as "easy" | "medium" | "hard" | "") || "",
      });
  }
}

export async function listQuizApiCategories(): Promise<Array<{ name: string; slug: string }>> {
  if (!isQuizApiConfigured()) return [];
  try {
    const key = quizApiKey()!;
    const data = await fetchJson<{
      success?: boolean;
      data?: Array<{ name: string; categories?: Array<{ name: string; slug: string }> }>;
    }>("https://quizapi.io/api/v1/categories", { headers: { "X-Api-Key": key } });
    const out: Array<{ name: string; slug: string }> = [];
    for (const group of data.data ?? []) {
      for (const c of group.categories ?? []) {
        out.push({ name: c.name, slug: c.slug });
      }
    }
    return out.slice(0, 25);
  } catch (err) {
    logger.debug({ err }, "QuizAPI categories failed");
    return [];
  }
}
