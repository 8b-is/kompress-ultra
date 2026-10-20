use crate::types::ContextUnit;
use anyhow::Result;

const MAX_TOKENS: usize = 60;

const FILLER: &[&str] = &[
    "basically", "essentially", "actually", "just", "very", "really",
    "quite", "simply", "obviously", "clearly", "of course", "you know",
];

pub struct Rewriter {
    pub max_tokens: usize,
}

impl Rewriter {
    pub fn new() -> Self {
        Self { max_tokens: MAX_TOKENS }
    }

    pub fn rewrite(&self, units: Vec<ContextUnit>) -> Result<Vec<ContextUnit>> {
        Ok(units.into_iter().map(|mut u| {
            let mut text = u.content.clone();
            for filler in FILLER {
                text = text.replace(&format!(" {filler} "), " ");
            }
            let words: Vec<&str> = text.split_whitespace().collect();
            if words.len() > self.max_tokens {
                text = words[..self.max_tokens].join(" ") + "…";
            }
            u.token_count = text.split_whitespace().count();
            u.content = text;
            u
        }).collect())
    }
}

impl Default for Rewriter {
    fn default() -> Self {
        Self::new()
    }
}

pub const DITTO: &str = "″";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeRoundTripResult {
    pub ok: bool,
    pub ditto_lines: Vec<String>,
    pub restored_lines: Vec<String>,
    pub tokens_saved: usize,
}

/// Escape arbitrary SSID / BLE / RAOP token strings so they never split on `|`,
/// collide with the ditto marker `″`, or break single-line wire frames (`W|`, `B|`, `A|`, `Q|`).
pub fn escape_wire_token(val: &str) -> String {
    let mut out = val
        .replace('\\', "\\x5c")
        .replace('|', "\\x7c")
        .replace(DITTO, "\\x22\\x22");
    let mut normalized = String::with_capacity(out.len());
    let mut prev_newline = false;
    for ch in out.drain(..) {
        if ch == '\r' || ch == '\n' {
            if !prev_newline {
                normalized.push(' ');
                prev_newline = true;
            }
        } else {
            prev_newline = false;
            normalized.push(ch);
        }
    }
    normalized
}

/// Collapse repeated tokens (char length > 1) at matching column indices across
/// consecutive pipe-delimited telemetry lines (`W|`, `B|`, `A|`, `Q|`) to `″`.
pub fn dedup_pipe_frames<S: AsRef<str>>(lines: &[S]) -> Vec<String> {
    if lines.len() <= 1 {
        return lines.iter().map(|s| s.as_ref().to_string()).collect();
    }
    let mut prev_tokens: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.as_ref();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push(line.to_string());
            continue;
        }
        let tokens: Vec<&str> = line.split('|').collect();
        if tokens.len() <= 2 {
            out.push(line.to_string());
            continue;
        }
        let resolved: Vec<String> = tokens
            .iter()
            .enumerate()
            .map(|(i, &tok)| {
                if tok == DITTO && i < prev_tokens.len() {
                    prev_tokens[i].clone()
                } else {
                    tok.to_string()
                }
            })
            .collect();
        if !prev_tokens.is_empty() {
            let mut ditto_count = 0usize;
            let deduped: Vec<&str> = resolved
                .iter()
                .enumerate()
                .map(|(i, tok)| {
                    if i < prev_tokens.len() && tok == &prev_tokens[i] && tok.chars().count() > 1 {
                        ditto_count += 1;
                        DITTO
                    } else {
                        tok.as_str()
                    }
                })
                .collect();
            if ditto_count >= 1 {
                out.push(deduped.join("|"));
            } else {
                out.push(resolved.join("|"));
            }
        } else {
            out.push(resolved.join("|"));
        }
        prev_tokens = resolved;
    }
    out
}

/// Losslessly restore `″` tokens in pipe-delimited telemetry lines from the
/// preceding restored frame.
pub fn undedup_pipe_frames<S: AsRef<str>>(lines: &[S]) -> Vec<String> {
    if lines.is_empty() {
        return Vec::new();
    }
    let mut prev_tokens: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for raw_line in lines {
        let line = raw_line.as_ref();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push(line.to_string());
            continue;
        }
        let tokens: Vec<&str> = line.split('|').collect();
        if tokens.len() <= 2 {
            out.push(line.to_string());
            continue;
        }
        let restored: Vec<String> = tokens
            .iter()
            .enumerate()
            .map(|(i, &tok)| {
                if tok == DITTO && i < prev_tokens.len() {
                    prev_tokens[i].clone()
                } else {
                    tok.to_string()
                }
            })
            .collect();
        out.push(restored.join("|"));
        prev_tokens = restored;
    }
    out
}

/// Run pipe-frame ditto compression and verify 100% lossless round-trip restoration.
pub fn verify_pipe_round_trip<S: AsRef<str>>(lines: &[S]) -> PipeRoundTripResult {
    let ditto_lines = dedup_pipe_frames(lines);
    let restored_lines = undedup_pipe_frames(&ditto_lines);
    let tokens_saved = ditto_lines.iter().fold(0usize, |acc, line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            return acc;
        }
        acc + line.split('|').filter(|&t| t == DITTO).count()
    });
    let ok = restored_lines.len() == lines.len()
        && restored_lines
            .iter()
            .zip(lines.iter())
            .all(|(r, orig)| r == orig.as_ref());
    PipeRoundTripResult {
        ok,
        ditto_lines,
        restored_lines,
        tokens_saved,
    }
}
