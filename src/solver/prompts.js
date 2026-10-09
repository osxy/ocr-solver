/**
 * Prompt loading.
 *
 * Prompts live in text files so they can be tuned without touching code, and the
 * loader is mtime-cached so an edit takes effect on the next puzzle rather than
 * needing a restart. Built-in fallbacks keep the app working when the config
 * directory is missing (packaged builds, tests).
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_PROMPT_DIR = join(PROJECT_ROOT, 'config', 'prompts');

const FALLBACKS = {
  solve: [
    'Je lost Nederlandse puzzel-captcha\'s op. De vraag komt uit foutgevoelige OCR.',
    'Antwoord met ALLEEN JSON:',
    '{"transcript": "...", "answer": "...", "puzzle_class": "count|arithmetic|ordinal-pick|unknown", "confidence": 0.0}',
    '- "hoeveel" -> kaal getal.',
    '- rekensom -> kaal getal.',
    '- "wat is de/het <rangtelwoord> <categorie>" -> een woord uit de lijst, kleine letters.',
    '- Geen uitleg, geen leestekens.',
  ].join('\n'),
  vision: 'Hieronder staat de afbeelding van de puzzel. Lees de tekst en los de puzzel op.',
};

const cache = new Map();

/**
 * Read a prompt by name. Re-reads the file when its mtime changes, so editing the
 * file is enough to change behaviour on the next call.
 */
export function loadPrompt(name, { promptDir = DEFAULT_PROMPT_DIR } = {}) {
  const file = join(promptDir, `${name}.txt`);
  if (!existsSync(file)) {
    return cache.get(`fallback:${name}`) ?? FALLBACKS[name] ?? '';
  }

  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.text;

  const text = readFileSync(file, 'utf8').trim();
  cache.set(file, { mtime, text });
  return text;
}

/** Drop the cache. Only needed by tests. */
export function clearPromptCache() {
  cache.clear();
}

export const FALLBACK_PROMPTS = FALLBACKS;
