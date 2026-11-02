//! Context-window accounting, matching sessions/model/contextUsage.ts.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub used: u64,
    pub window: Option<u64>,
    /// When a provider request last reported context, in epoch milliseconds:
    /// the last time the prompt cache was read or written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
}
impl Usage {
    pub fn ratio(self) -> Option<f32> {
        self.window
            .filter(|w| *w > 0)
            .map(|w| (self.used as f64 / w as f64).min(1.) as f32)
    }
    pub fn merge(&mut self, used: Option<u64>, window: Option<u64>) {
        if let Some(used) = used {
            self.used = used;
            self.at = Some(crate::time::now_ms());
        }
        if let Some(window) = window.filter(|w| *w > 0) {
            self.window = Some(window);
        }
    }
}

/// How long Claude Code keeps a conversation's prompt cache after its last
/// request. Subscription sessions use the one-hour cache.
pub const CLAUDE_CACHE_TTL_MS: u64 = 60 * 60 * 1000;
/// Below this size a cold cache costs too little to warn about.
pub const COLD_WARNING_TOKENS: u64 = 50_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cache {
    /// Still cached; this many milliseconds remain.
    Warm { left_ms: u64 },
    /// Expired this many milliseconds ago; the next message re-reads `tokens`
    /// at full price.
    Cold { since_ms: u64, tokens: u64 },
}

/// Prompt-cache state for a provider whose cache lifetime is known. `last` is
/// the last request time, falling back to the session's last update.
pub fn cache(provider: &str, used: u64, last: Option<u64>, now: u64) -> Option<Cache> {
    if provider != "claude" || used == 0 {
        return None;
    }
    let age = now.saturating_sub(last?);
    Some(if age < CLAUDE_CACHE_TTL_MS {
        Cache::Warm {
            left_ms: CLAUDE_CACHE_TTL_MS - age,
        }
    } else {
        Cache::Cold {
            since_ms: age - CLAUDE_CACHE_TTL_MS,
            tokens: used,
        }
    })
}

/// "42 min", "1h 12m", "3 days".
pub fn format_span(ms: u64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        0 => "under a minute".into(),
        1..=59 => format!("{minutes} min"),
        60..=1439 => match minutes % 60 {
            0 => format!("{}h", minutes / 60),
            m => format!("{}h {m}m", minutes / 60),
        },
        _ => {
            let days = minutes / 1440;
            format!("{days} day{}", if days == 1 { "" } else { "s" })
        }
    }
}

impl Cache {
    pub fn describe(self) -> String {
        match self {
            Cache::Warm { left_ms } => format!("Cache warm · {} left", format_span(left_ms)),
            Cache::Cold { since_ms, tokens } => format!(
                "Cache expired {} ago · next message re-reads {} tokens",
                format_span(since_ms),
                format_tokens(tokens)
            ),
        }
    }
    /// Cold and large enough that sending is worth a second thought.
    pub fn costly(self) -> bool {
        matches!(self, Cache::Cold { tokens, .. } if tokens >= COLD_WARNING_TOKENS)
    }
}

pub fn claude_used(usage: &Value) -> Option<u64> {
    let used = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
    ]
    .iter()
    .map(|key| usage[key].as_u64().unwrap_or(0))
    .sum();
    (used > 0).then_some(used)
}

pub fn format_tokens(count: u64) -> String {
    let (value, suffix) = if count >= 1_000_000 {
        (count as f64 / 1_000_000., "M")
    } else if count >= 1000 {
        (count as f64 / 1000., "K")
    } else {
        return count.to_string();
    };
    if value < 10. {
        format!(
            "{}{suffix}",
            format!("{value:.1}")
                .trim_end_matches('0')
                .trim_end_matches('.')
        )
    } else {
        format!("{value:.0}{suffix}")
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    const HOUR: u64 = 3_600_000;
    #[test]
    fn claude_cache_is_warm_for_an_hour_then_costly_when_large() {
        let now = 10 * HOUR;
        assert_eq!(cache("codex", 200_000, Some(now), now), None);
        assert_eq!(cache("claude", 0, Some(now), now), None);
        assert_eq!(cache("claude", 200_000, None, now), None);
        let warm = cache("claude", 200_000, Some(now - 18 * 60_000), now).unwrap();
        assert_eq!(
            warm,
            Cache::Warm {
                left_ms: 42 * 60_000
            }
        );
        assert_eq!(warm.describe(), "Cache warm · 42 min left");
        assert!(!warm.costly());
        let cold = cache("claude", 180_000, Some(now - HOUR - 72 * 60_000), now).unwrap();
        assert!(cold.costly());
        assert!(
            cold.describe().starts_with("Cache expired 1h 12m ago"),
            "{}",
            cold.describe()
        );
        let small = cache("claude", 20_000, Some(now - 2 * HOUR), now).unwrap();
        assert!(!small.costly());
        assert_eq!(format_span(3 * 24 * HOUR), "3 days");
    }
    #[test]
    fn reported_usage_records_when_the_cache_was_last_used() {
        let mut usage = Usage::default();
        usage.merge(None, Some(1_000_000));
        assert_eq!(usage.at, None, "a window alone is not a request");
        usage.merge(Some(5_000), None);
        assert!(usage.at.is_some());
    }
}
