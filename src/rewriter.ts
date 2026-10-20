export enum CompressionLevel {
  Verbatim = 0,   // 0% savings
  Lite = 1,       // 40% savings
  Ultra = 2,      // 75% savings
  BrainBacked = 3 // 90% savings
}

// ── Cross-line dedup (the "second mountain" — see garden/observations/mozart-probe.md) ──
// Per-message regex rewriting is blind to redundancy that spans lines: repeated
// performer names, repeated work titles. dedupCrossLine collapses consecutive
// list-like lines via ditto markers. Designed to run inside compressMessage at
// Ultra level, WHILE code/URL/error placeholders are still substituted — so the
// protection floors come for free.

const DITTO = "″";
const LIST_MARKER_RE = /^(\s*(?:\d{1,3}[.)]|[-*•])\s+)(.*)$/;
const PROTECTED_TOKEN_RE = /__(?:CODE_BLOCK|URL|ERROR)_\d+__/;
const MIN_PREFIX_CHARS = 15;
const MIN_PREFIX_RATIO = 0.3; // of the shorter line's content
const MIN_PREFIX_WORDS = 3;
const MIN_SUFFIX_WORDS = 3;

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** Reduce a candidate prefix length so it ends on a word boundary. */
function cutPrefixAtWordBoundary(s: string, len: number): number {
  let l = Math.min(len, s.length);
  while (l > 0 && /[A-Za-z0-9]/.test(s[l - 1])) l--;
  return l;
}

/** Reduce a candidate suffix so it starts on a word boundary outside any
 *  enclosing group, so we never cut into a token like `(07:45)`. */
function cutSuffixAtWordBoundary(s: string, len: number): number {
  let l = Math.min(len, s.length);
  while (l > 0 && /[A-Za-z0-9]/.test(s[s.length - l])) l--;
  // Never let the suffix open a group it doesn't close. Stop at the first
  // char that is a group closer (`)`, `]`, `}`) or a group opener that is
  // still open at the window start (e.g. `(14:50)  - X`, where a stray extra
  // space makes the common-suffix scan stop *inside* the parenthesis).
  while (l > 0) {
    const win = s.slice(s.length - l);
    if (!/[\])}]/.test(win) && !/[\[({]/.test(win)) break; // plain text
    let depth = 0;
    for (const ch of win) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
    }
    if (depth === 0) break; // balanced — safe window
    // Unclosed group (depth > 0) or dangling closer (depth < 0): the cut
    // landed inside a token like `(14:50)`. Back off past one word and retry.
    l--;
    while (l > 0 && /[A-Za-z0-9]/.test(s[s.length - l])) l--;
  }
  return l;
}

function wordCount(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Collapse repeated prefixes/suffixes across consecutive list-like lines.
 *
 * - A list-like line is one starting with a marker (`1. `, `2) `, `- `, `* `, `• `).
 * - Each such line is compared to the previous non-empty line's content
 *   (its own marker stripped). Shared prefix ≥ MIN_PREFIX_CHARS, ≥
 *   MIN_PREFIX_RATIO of the shorter content, ≥ MIN_PREFIX_WORDS words →
 *   replaced with `″ `. Shared trailing suffix ≥ MIN_SUFFIX_WORDS words →
 *   replaced with ` ″`.
 * - Lines containing protection placeholders are never modified and reset
 *   the anchor (placeholder round-trip must stay byte-identical).
 * - Collapse only, never delete. Idempotent: dedupCrossLine(dedupCrossLine(x))
 *   === dedupCrossLine(x) — collapsed lines no longer share a long prefix with
 *   their anchor, and ` ″` is below the 3-word suffix floor.
 */
export function dedupCrossLine(text: string): string {
  if (!text || !text.includes("\n")) return text;

  const lines = text.split("\n");
  const out: string[] = [];
  let prevContent: string | null = null; // original content of previous non-empty line

  for (const line of lines) {
    if (!line.trim() || PROTECTED_TOKEN_RE.test(line)) {
      out.push(line);
      if (line.trim()) prevContent = null;
      continue;
    }

    const m = line.match(LIST_MARKER_RE);
    const marker = m ? m[1] : "";
    const originalContent = m ? m[2] : line;
    let content = originalContent;

    // Only list-like lines are candidates; prose anchors are fine to compare
    // against, but prose itself is never collapsed.
    if (m && prevContent !== null) {
      const minLen = Math.min(prevContent.length, content.length);

      // Prefix collapse
      let plen = cutPrefixAtWordBoundary(content, commonPrefixLen(prevContent, content));
      if (
        plen < MIN_PREFIX_CHARS ||
        plen >= content.length ||
        plen < MIN_PREFIX_RATIO * minLen ||
        wordCount(content.slice(0, plen)) < MIN_PREFIX_WORDS
      ) {
        plen = 0;
      }

      // Suffix collapse
      let slen = cutSuffixAtWordBoundary(content, commonSuffixLen(prevContent, content));
      if (wordCount(content.slice(content.length - slen)) < MIN_SUFFIX_WORDS) slen = 0;
      if (slen > 0 && plen + slen >= content.length) slen = 0;

      if (slen > 0) content = content.slice(0, content.length - slen) + " " + DITTO;
      if (plen > 0) content = DITTO + " " + content.slice(plen);
      content = content.replace(/ {2,}/g, " ");
    }

    out.push(marker ? marker + content : content);
    prevContent = originalContent; // anchor on the ORIGINAL, so runs collapse fully
  }

  return out.join("\n");
}

export function compressMessage(content: string, level: CompressionLevel): string {
  if (level === CompressionLevel.Verbatim) return content;

  // Protect code fences (fenced blocks)
  const codeBlocks: string[] = [];
  let result = content.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Protect inline code spans
  result = result.replace(/`[^`\n]+`/g, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Protect URLs
  const urls: string[] = [];
  result = result.replace(/https?:\/\/[^\s]+/g, (match) => {
    urls.push(match);
    return `__URL_${urls.length - 1}__`;
  });

  // Protect error messages
  const errors: string[] = [];
  result = result.replace(/Error:[^\n]*/g, (match) => {
    errors.push(match);
    return `__ERROR_${errors.length - 1}__`;
  });

  if (level === CompressionLevel.Lite) {
    // Drop articles, filler, pleasantries
    result = result.replace(/\b(the|a|an|this|that|these|those)\b/gi, ' ');
    result = result.replace(/\b(just|really|basically|actually|simply)\b/gi, ' ');
    result = result.replace(/\b(I would be happy to|Sure!|Great!|Excellent!)\b/gi, '');
    result = result.replace(/\s{2,}/g, ' ').trim();
  } else if (level === CompressionLevel.Ultra) {
    // Caveman-ultra: [thing] [action] [reason]
    const sentences = result.split(/[.!?]+/).filter(s => s.trim());
    const compressed = sentences.map(s => {
      s = s.trim();
      // Drop pleasantries entirely
      if (/\b(sure|great|excellent|happy|glad|welcome)\b/i.test(s)) return '';
      // Drop "I have", "I will", "I am", "it is", etc
      s = s.replace(/\b(I (have|will|am|would|can|did|was|were)|it (is|was|has))\b/gi, '').trim();
      // Drop articles
      s = s.replace(/\b(the|a|an|this|that|these|those)\b/gi, '').trim();
      // Drop filler
      s = s.replace(/\b(just|really|basically|actually|simply|now|successfully|already|still|even)\b/gi, '').trim();
      // Drop common fluff words
      s = s.replace(/\b(is|are|was|were|been|being|has|had|do|does|did|and|or|but|for|with|from|in|on|at|to|of)\b/gi, ' ').trim();
      // Drop "it", "me", "my", "we", "our", "they", "them"
      s = s.replace(/\b(it|me|my|we|our|they|them|their)\b/gi, ' ').trim();
      // Drop common filler nouns
      s = s.replace(/\b(system|implementation|support|tests|things|stuff|work)\b/gi, ' ').trim();
      return s.replace(/\s{2,}/g, ' ').trim();
    }).filter(Boolean).join('. ');
    result = compressed;
    // Cross-line dedup runs here — placeholders still substituted, so
    // code/URL/error protection is preserved byte-identically.
    result = dedupCrossLine(result);
  }

  // Restore protected content
  result = result.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[parseInt(i)]);
  result = result.replace(/__ERROR_(\d+)__/g, (_, i) => errors[parseInt(i)]);
  result = result.replace(/__URL_(\d+)__/g, (_, i) => urls[parseInt(i)]);

  return result.replace(/\s{2,}/g, ' ').trim();
}

// ── Pipe-delimited telemetry frame ditto dedup (8b-is/wigle-triad & esp32.vaked.dev) ──

/**
 * Escape arbitrary SSID / BLE / RAOP token strings so they never split on `|`,
 * collide with the ditto marker `″`, or break single-line wire frames (`W|`, `B|`, `A|`, `Q|`).
 */
export function escapeWireToken(val: unknown): string {
  return String(val ?? "")
    .replace(/\\/g, "\\x5c")
    .replace(/\|/g, "\\x7c")
    .replace(/″/g, "\\x22\\x22")
    .replace(/[\r\n]+/g, " ");
}

/**
 * Collapse repeated tokens (length > 1) at matching column indices across
 * consecutive pipe-delimited telemetry lines (`W|`, `B|`, `A|`, `Q|`) to `″`.
 */
export function dedupPipeFrames(lines: string[]): string[] {
  if (!Array.isArray(lines) || lines.length <= 1) return lines ? lines.slice() : [];
  let prevTokens: string[] = [];
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = String(rawLine);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const tokens = line.split("|");
    if (tokens.length <= 2) {
      out.push(line);
      continue;
    }
    const resolved = tokens.map((tok, i) =>
      tok === DITTO && i < prevTokens.length ? prevTokens[i] : tok
    );
    if (prevTokens.length > 0) {
      const deduped = resolved.map((tok, i) =>
        i < prevTokens.length && tok === prevTokens[i] && tok.length > 1 ? DITTO : tok
      );
      const dittoCount = deduped.filter((t) => t === DITTO).length;
      out.push(dittoCount >= 1 ? deduped.join("|") : resolved.join("|"));
    } else {
      out.push(resolved.join("|"));
    }
    prevTokens = resolved;
  }
  return out;
}

/**
 * Losslessly restore `″` tokens in pipe-delimited telemetry lines from the
 * preceding restored frame.
 */
export function undedupPipeFrames(lines: string[]): string[] {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  let prevTokens: string[] = [];
  const out: string[] = [];
  for (const rawLine of lines) {
    const line = String(rawLine);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const tokens = line.split("|");
    if (tokens.length <= 2) {
      out.push(line);
      continue;
    }
    const restored = tokens.map((tok, i) =>
      tok === DITTO && i < prevTokens.length ? prevTokens[i] : tok
    );
    out.push(restored.join("|"));
    prevTokens = restored;
  }
  return out;
}

/**
 * Run pipe-frame ditto compression and verify 100% lossless round-trip restoration.
 */
export function verifyPipeRoundTrip(lines: string[]): {
  ok: boolean;
  dittoLines: string[];
  restoredLines: string[];
  tokensSaved: number;
} {
  const dittoLines = dedupPipeFrames(lines);
  const restoredLines = undedupPipeFrames(dittoLines);
  const tokensSaved = dittoLines.reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return acc;
    return acc + line.split("|").filter((t) => t === DITTO).length;
  }, 0);
  const ok =
    restoredLines.length === lines.length &&
    restoredLines.every((line, idx) => line === lines[idx]);
  return { ok, dittoLines, restoredLines, tokensSaved };
}
