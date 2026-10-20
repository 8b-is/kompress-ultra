import { describe, it, expect } from "bun:test";
import {
  dedupCrossLine,
  compressMessage,
  CompressionLevel,
  escapeWireToken,
  dedupPipeFrames,
  undedupPipeFrames,
  verifyPipeRoundTrip,
} from "../src/rewriter.js";

// Mozart-shaped fixture: repeated performer (×14), repeated work title (×4),
// distinct timestamps and catalogue numbers. Mirrors the probe in
// garden/observations/mozart-probe.md.
const FIXTURE = [
  "Mozart playlist:",
  "",
  "1. Eine Kleine Nachtmusik, K. 525: I. Allegro (00:00) - Budapest Scoring Symphonic Orchestra",
  "2. Eine Kleine Nachtmusik, K. 525: II. Romanze - Andante (07:45) - Budapest Scoring Symphonic Orchestra",
  "3. Eine Kleine Nachtmusik, K. 525: III. Menuetto - Allegretto (12:50)  - Budapest Scoring Symphonic Orchestra",
  "4. Eine Kleine Nachtmusik, K. 525: IV. Rondo - Allegro (14:50)  - Budapest Scoring Symphonic Orchestra",
  "5. Symphony No 35 in D major, K. 385 (Haffner Symphony): I. Allegro con spirito (20:08) - Budapest Scoring Symphonic Orchestra",
  "6. Symphony No 35 in D major, K. 385 (Haffner Symphony): IV. Presto (25:54) - Budapest Scoring Symphonic Orchestra",
  "7. Symphony No 40 in G minor, KV. 550: I. Molto Allegro (29:53) - Budapest Scoring Symphonic Orchestra",
  "8. The Magic Flute: Overture (37:29) - Budapest Scoring Symphonic Orchestra",
  "9. The Marriage of Figaro: Overture (44:41) - Budapest Scoring Symphonic Orchestra",
  "10. String Quartet No. 23 in F major, K. 590: I. Allegro moderato (49:12) - Accord quartet",
  "11. String Quartet No. 23 in F major, K. 590: IV. Allegro (58:13) - Accord quartet",
  "12. String Quartet No. 20 in D major, K. 499: II. Menuetto and Trio. Allegretto (1:03:17) - Accord quartet",
  "13. Violin Sonata No. 26 in B-flat major, K. 378: III. Rondo. Allegro (1:06:38) - Accord quartet",
  "14. Piano Concerto No. 21 in C major, K. 467: II. Andante (1:10:46) -  Csabay Domonkos",
  "15. Piano Concerto No. 23 in A major, K. 488: I. Allegro (1:16:25) -  Csabay Domonkos",
  "16. Piano Sonata No. 11 in A major, K. 331: III. Alla Turca (1:27:15) - Csabay Domonkos",
  "17. Clarinet Concerto in A major, K. 622: II. Adagio (1:29:35) - Budapest Scoring Symphonic Orchestra",
  "18. Violin Concerto No. 3 in G major, K. 216: I. Allegro (1:36:36) - Budapest Scoring Symphonic Orchestra",
  "19. Flute Concerto No. 2 in D major, K. 314: II. Adagio non troppo (1:46:08) - Budapest Scoring Symphonic Orchestra",
  "20. Horn Concerto No. 3 in E-flat major, K. 447: II. Romance. Larghetto (1:51:36) - Budapest Scoring Symphonic Orchestra",
].join("\n");

const TIMESTAMPS = [
  "(00:00)", "(07:45)", "(12:50)", "(14:50)", "(20:08)", "(25:54)", "(29:53)",
  "(37:29)", "(44:41)", "(49:12)", "(58:13)", "(1:03:17)", "(1:06:38)",
  "(1:10:46)", "(1:16:25)", "(1:27:15)", "(1:29:35)", "(1:36:36)",
  "(1:46:08)", "(1:51:36)",
];
const K_NUMBERS = ["525", "385", "550", "590", "499", "378", "467", "488", "331", "622", "216", "314", "447"];

describe("dedupCrossLine", () => {
  it("collapses repeated prefixes and suffixes on a Mozart-shaped fixture", () => {
    const out = dedupCrossLine(FIXTURE);
    const saved = FIXTURE.length - out.length;

    // Baseline regex Ultra saved only ~3% here (probe: 2064 → 1995).
    // Cross-line dedup must clear a meaningful bar.
    expect(saved).toBeGreaterThan(500);
    expect(out).toContain("″");
  });

  it("preserves every timestamp and catalogue number verbatim", () => {
    const out = dedupCrossLine(FIXTURE);
    for (const ts of TIMESTAMPS) expect(out).toContain(ts);
    for (const k of K_NUMBERS) expect(out).toContain(k);
  });

  it("keeps the first occurrence of each repeated text in full", () => {
    const out = dedupCrossLine(FIXTURE);
    const first = out.split("\n")[2];
    expect(first).toContain("Eine Kleine Nachtmusik, K. 525:");
    expect(first).toContain("Budapest Scoring Symphonic Orchestra");
    expect(first).not.toContain("″");
  });

  it("is idempotent", () => {
    const once = dedupCrossLine(FIXTURE);
    expect(dedupCrossLine(once)).toBe(once);
  });

  it("never touches lines containing protection placeholders", () => {
    const input = [
      "1. First item with __CODE_BLOCK_0__ inside (aaaaaaaaaaaaaaaaaaaa) - Some Long Performer Name",
      "2. First item with __CODE_BLOCK_0__ inside (bbbbbbbbbbbbbbbbbbbb) - Some Long Performer Name",
    ].join("\n");
    const out = dedupCrossLine(input);
    expect(out.split("\n")[1]).toContain("__CODE_BLOCK_0__");
    // Placeholder line untouched; the other line may collapse against it only
    // if thresholds pass — but the placeholder line itself is byte-identical.
    expect(out.split("\n")[0]).toBe(input.split("\n")[0]);
  });

  it("leaves short lines and unstructured prose untouched", () => {
    const prose = [
      "hello world this is fine",
      "hello world this is fine too",
      "- short",
      "- short",
    ].join("\n");
    // "- short" lines share prefix "- short" → content "short" is 5 chars < 15 → no collapse.
    expect(dedupCrossLine(prose)).toBe(prose);
  });

  it("returns input unchanged for empty or single-line text", () => {
    expect(dedupCrossLine("")).toBe("");
    expect(dedupCrossLine("   ")).toBe("   ");
    expect(dedupCrossLine("one line only")).toBe("one line only");
  });

  it("deletes nothing", () => {
    const out = dedupCrossLine(FIXTURE);
    expect(out.split("\n").length).toBe(FIXTURE.split("\n").length);
  });
});

describe("compressMessage Ultra integration", () => {
  it("Ultra beats Lite on the fixture and applies dedup only at Ultra", () => {
    const ultra = compressMessage(FIXTURE, CompressionLevel.Ultra);
    const lite = compressMessage(FIXTURE, CompressionLevel.Lite);

    expect(ultra.length).toBeLessThan(lite.length * 0.8);
    expect(ultra).toContain("″");
    expect(lite).not.toContain("″"); // no behavior change at Lite
  });

  it("preserves URLs through Ultra (placeholders protect them)", () => {
    const input = [
      "See docs here (aaaaaaaaaaaaaaaaaaaaaaaaaa) - https://example.com/page",
      "See docs here (bbbbbbbbbbbbbbbbbbbbbbbbbb) - https://example.com/page",
    ].join("\n");
    const out = compressMessage(input, CompressionLevel.Ultra);
    expect(out).toContain("https://example.com/page");
  });

  it("preserves code fences through Ultra on listy input", () => {
    const input = [
      "```ts",
      "const x = 1;",
      "```",
      "1. item one (aaaaaaaaaaaaaaaaaaaaaaaa) - Some Long Performer Name",
      "2. item one (bbbbbbbbbbbbbbbbbbbbbbbb) - Some Long Performer Name",
    ].join("\n");
    const out = compressMessage(input, CompressionLevel.Ultra);
    expect(out).toContain("const x = 1;");
  });
});

describe("MEDUSA triad pipe-delimited telemetry dedup (wigle-triad & esp32.vaked.dev)", () => {
  const MEDUSA_FRAMES = [
    "W|MAC:MEDUSA|80:B5:4E:DB:3B:C4|8b-is-ADA-STAR|W3|6|-44|2.4GHz|+1|35.6895|139.6917",
    "W|MAC:MEDUSA|80:B5:4E:F2:02:B0|8b-is-VAK-PILLAR|W3|6|-48|2.4GHz|+1|35.6895|139.6917",
    "W|MAC:MEDUSA|80:B5:4E:F2:02:B4|8b-is-OMN-INF|W2|11|-52|2.4GHz|+1|35.6895|139.6917",
    "B|MAC:MEDUSA|DC:A6:32:91:7C:23|Chiro-Sanctuary-BLE|BLE-GATT|38|-57|BLE|+1|35.6895|139.6917",
    "A|MAC:MEDUSA|AC:DE:48:00:11:22|Studio-432Hz-RAOP|RAOP|149|-49|5GHz|+1|35.6895|139.6917",
  ];

  it("collapses repeated column tokens to ditto markers and round-trips losslessly", () => {
    const res = verifyPipeRoundTrip(MEDUSA_FRAMES);
    expect(res.ok).toBe(true);
    expect(res.tokensSaved).toBeGreaterThanOrEqual(15);
    expect(res.dittoLines[1]).toContain("|″|");
    expect(res.restoredLines).toEqual(MEDUSA_FRAMES);
  });

  it("escapes hostile SSIDs containing pipes, backslashes, ditto marks, and newlines", () => {
    const hostileSsid = "Free|WiFi\\″Spoof\nLine2";
    const escaped = escapeWireToken(hostileSsid);
    expect(escaped).not.toContain("|");
    expect(escaped).not.toContain("″");
    expect(escaped).not.toContain("\n");

    const frames = [
      `W|MAC:MEDUSA|AA:BB:CC:DD:EE:01|${escaped}|W2|6|-55|2.4GHz`,
      `W|MAC:MEDUSA|AA:BB:CC:DD:EE:02|${escaped}|W2|6|-61|2.4GHz`,
    ];
    const res = verifyPipeRoundTrip(frames);
    expect(res.ok).toBe(true);
    expect(res.restoredLines).toEqual(frames);
  });

  it("handles empty and single-frame arrays cleanly", () => {
    expect(dedupPipeFrames([])).toEqual([]);
    expect(undedupPipeFrames([])).toEqual([]);
    expect(dedupPipeFrames([MEDUSA_FRAMES[0]])).toEqual([MEDUSA_FRAMES[0]]);
  });
});
