//! Continue a conversation whose prompt cache has expired in a fresh session.
//!
//! Re-sending to a large cold conversation re-reads the whole history at full
//! price. A fresh session seeded with a compact handoff avoids that: a small
//! model reads the transcript once, cheaply, and the new session starts small.
use crate::{
    accounts::Profile,
    agent::Settings,
    provider::{self, Kind, Request},
    response::limit,
    session_title::TextModel,
    transcript::Row,
};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, Arc},
};

/// Characters of transcript the summarizer reads, newest first after the
/// opening request.
const TRANSCRIPT_CHARS: usize = 120_000;
/// Characters of the opening request always kept.
const OPENING_CHARS: usize = 4_000;

const PROMPT: &str = "You are writing a handoff so a fresh coding-agent session can continue the conversation below without its history. The fresh session sees only your handoff plus the user's next message.

Write plain Markdown, under 600 words, with only the sections that have content:
## Goal: what the user is ultimately trying to achieve
## Decisions and constraints: choices made, preferences and rules the user gave, things to avoid
## Current state: what is done, what was verified, what is in progress
## Files and commands: paths, branches, commands and IDs the next session needs
## Open items: unresolved questions, failures, next steps

Rules: use only the conversation. Do not call tools. Keep exact names, paths, numbers and IDs. Do not invent work. No greeting or preamble.";

/// The conversation as plain text for the summarizer: the opening request,
/// then as much of the most recent exchange as fits.
pub fn transcript(rows: &[Row]) -> String {
    let mut turns: Vec<String> = Vec::new();
    let mut previous: Option<&str> = None;
    for row in rows {
        let role = match row.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            _ => continue,
        };
        if row.text.trim().is_empty() {
            continue;
        }
        if previous != Some(role) || row.first {
            turns.push(format!("{role}: "));
        }
        turns.last_mut().unwrap().push_str(&row.text);
        previous = Some(role);
    }
    let Some(opening) = turns.first().cloned() else {
        return String::new();
    };
    let opening = limit(&opening, OPENING_CHARS);
    let mut budget = TRANSCRIPT_CHARS.saturating_sub(opening.chars().count());
    let mut recent: Vec<String> = Vec::new();
    for turn in turns.iter().skip(1).rev() {
        let size = turn.chars().count();
        if size > budget {
            if budget > 2_000 {
                let tail: String = turn.chars().skip(size - budget + 20).collect();
                recent.push(format!("[earlier part of this message omitted] {tail}"));
            }
            break;
        }
        budget -= size;
        recent.push(turn.clone());
    }
    let omitted = turns.len().saturating_sub(1 + recent.len());
    recent.reverse();
    let mut parts = vec![opening];
    if omitted > 0 {
        parts.push(format!("[{omitted} earlier messages omitted]"));
    }
    parts.extend(recent);
    parts.join("\n\n")
}

pub fn prompt(title: &str, rows: &[Row]) -> String {
    format!(
        "{PROMPT}\n\nConversation title: {title}\n\n<conversation>\n{}\n</conversation>",
        transcript(rows)
    )
}

/// Summarize with the provider's small text model on the conversation's own
/// account. Falls back to the extractive recap when the model is unavailable.
pub fn generate(
    kind: Kind,
    cwd: &Path,
    account: Profile,
    title: &str,
    rows: &[Row],
    cancel: Arc<AtomicBool>,
) -> String {
    let fallback = || crate::response::handoff(rows);
    let text = TextModel::automatic(kind, account);
    let Some(binary) = provider::resolve(kind).filter(|_| text.model.is_some()) else {
        return fallback();
    };
    match provider::run_text(
        Request {
            kind,
            binary,
            cwd: cwd.into(),
            prompt: prompt(title, rows),
            provider_id: None,
            model: text.model,
            settings: Settings {
                account: text.account,
                ..Default::default()
            },
        },
        cancel,
    ) {
        Ok(summary) if summary.trim().chars().count() >= 80 => limit(summary.trim(), 8_000),
        _ => fallback(),
    }
}

/// The first message of the fresh session.
pub fn seed(title: &str, from: i64, handoff: &str, message: &str) -> String {
    format!(
        "You are continuing an earlier conversation (\"{title}\", session {from}) in a fresh session so its full history does not have to be re-read. This is not a new task: treat the handoff below as the thread you are joining, and read files again rather than assuming their contents.\n\n<handoff>\n{}\n</handoff>\n\n{}",
        handoff.trim(),
        message.trim()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(role: &str, text: &str) -> Row {
        Row {
            role: role.into(),
            text: text.into(),
            first: true,
            sent_at: None,
        }
    }
    #[test]
    fn transcript_keeps_the_opening_request_and_the_newest_turns() {
        let mut rows = vec![row("user", "Build the account picker")];
        for i in 0..400 {
            rows.push(row("assistant", &format!("step {i} {}", "x".repeat(500))));
        }
        rows.push(row("user", "Now fix the context meter"));
        let text = transcript(&rows);
        assert!(text.starts_with("User: Build the account picker"));
        assert!(text.ends_with("User: Now fix the context meter"));
        assert!(text.contains("earlier messages omitted"));
        assert!(text.chars().count() <= TRANSCRIPT_CHARS + 200);
        assert!(!text.contains("step 0 "));
        assert!(text.contains("step 399 "));
    }
    #[test]
    fn seed_carries_the_handoff_and_the_users_message() {
        let seed = seed("Fix meter", 42, "## Goal\nFix it", "  continue please ");
        assert!(seed.contains("session 42"));
        assert!(seed.contains("<handoff>\n## Goal\nFix it\n</handoff>"));
        assert!(seed.ends_with("continue please"));
    }
}
