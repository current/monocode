//! Warn before a message re-reads a large conversation whose prompt cache has
//! expired, and offer to continue in a fresh session from a cheap handoff.
use super::*;

pub(crate) struct ColdPrompt {
    pub(crate) text: String,
    invert: bool,
}

/// Ask the shell to continue this conversation in a fresh session, seeded
/// with a handoff, sending `text` as the first request there.
pub(crate) struct ContinueFresh {
    pub(crate) text: String,
}
impl EventEmitter<ContinueFresh> for Conversation {}

impl Conversation {
    /// The composer's Enter key and send button. Automatic deliveries call
    /// `send` directly and are never held here.
    pub(super) fn user_send(&mut self, invert: bool, cx: &mut Context<Self>) {
        if !self.cold_gate(invert, cx) {
            self.send_follow_up(invert, cx);
        }
    }

    /// True when the send was held for the warning.
    fn cold_gate(&mut self, invert: bool, cx: &mut Context<Self>) -> bool {
        if std::mem::take(&mut self.cold_bypass) {
            return false;
        }
        if self.cold_ok
            || self.busy
            || !self.loaded
            || self.settings.mono.is_some()
            || self.is_remote()
            || self.attaching
            || (!self.input.read(cx).has_message_text() && self.attachments.is_empty())
        {
            return false;
        }
        let Some(cache) = self.cache_state().filter(|c| c.costly()) else {
            return false;
        };
        self.cold_prompt = Some(ColdPrompt {
            text: cache.describe(),
            invert,
        });
        cx.notify();
        true
    }

    #[cfg(test)]
    pub(crate) fn cold_prompt_open(&self) -> bool {
        self.cold_prompt.is_some()
    }

    /// The shell finished (or failed) continuing this chat elsewhere.
    pub(crate) fn continued_fresh(
        &mut self,
        result: Result<(), String>,
        text: String,
        cx: &mut Context<Self>,
    ) {
        match result {
            Ok(()) => self.status = "Continued in a fresh chat.".into(),
            Err(error) => {
                self.status = format!("Could not start a fresh chat: {error}");
                if self.input.read(cx).content.is_empty() {
                    self.input.update(cx, |input, cx| input.set_text(text, cx));
                }
            }
        }
        cx.notify();
    }

    fn cold_send_anyway(&mut self, always: bool, cx: &mut Context<Self>) {
        let Some(prompt) = self.cold_prompt.take() else {
            return;
        };
        self.cold_ok |= always;
        self.cold_bypass = true;
        self.send_follow_up(prompt.invert, cx);
        // A send that did not go through must not leave the bypass armed.
        self.cold_bypass = false;
        cx.notify();
    }

    fn cold_cancel(&mut self, cx: &mut Context<Self>) {
        self.cold_prompt = None;
        cx.notify();
    }

    fn cold_continue_fresh(&mut self, cx: &mut Context<Self>) {
        if self.cold_prompt.take().is_none() {
            return;
        }
        let text = self
            .input
            .update(cx, |input, cx| input.take(cx))
            .unwrap_or_default();
        if text.trim().is_empty() {
            cx.notify();
            return;
        }
        self.status = "Writing a handoff for a fresh chat…".into();
        cx.emit(ContinueFresh { text });
        cx.notify();
    }

    pub(super) fn render_cold_prompt(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let prompt = self.cold_prompt.as_ref()?;
        let fresh_allowed = self.attachments.is_empty();
        Some(
            popover("cold-cache-prompt", Anchor::Slot(self.context_anchor.clone()))
                .side(Side::Top)
                .align(Align::End)
                .max_width(360.)
                .padding(14.)
                .child(
                    div()
                        .id("cold-cache-card")
                        .role(Role::Dialog)
                        .aria_label("This chat's cache expired")
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(content(1.))
                        .child(
                            div()
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .child("This chat's prompt cache expired"),
                        )
                        .child(
                            div()
                                .text_color(content(0.6))
                                .child(format!(
                                    "{}. A fresh chat starts from a short handoff written by a small model instead.",
                                    prompt.text
                                )),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_wrap()
                                .justify_end()
                                .gap(px(6.))
                                .pt(px(4.))
                                .child(
                                    crate::modal::ghost_button("cold-cancel", "Cancel").on_click(
                                        cx.listener(|this, _, _, cx| this.cold_cancel(cx)),
                                    ),
                                )
                                .child(
                                    crate::modal::ghost_button("cold-send", "Send anyway")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.cold_send_anyway(false, cx)
                                        })),
                                )
                                .when(fresh_allowed, |d| {
                                    d.child(
                                        crate::modal::primary_button(
                                            "cold-fresh",
                                            "Continue in a fresh chat",
                                        )
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.cold_continue_fresh(cx)
                                        })),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .id("cold-always")
                                .role(Role::Button)
                                .text_size(px(11.))
                                .text_color(content(0.45))
                                .hover(|s| s.text_color(content(0.8)))
                                .cursor_pointer()
                                .child("Send, and don't ask again for this chat")
                                .on_click(
                                    cx.listener(|this, _, _, cx| this.cold_send_anyway(true, cx)),
                                ),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, WindowHandle};
    use monocode_core::store::Store;
    use std::sync::Mutex;

    const HOUR: u64 = 3_600_000;

    fn cold(
        cx: &mut TestAppContext,
        provider: &str,
        used: u64,
        age: u64,
    ) -> WindowHandle<Conversation> {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut summary = store.create("claude", "/missing/cold-cache").unwrap();
        summary.provider = provider.into();
        let window = cx.update(|cx| {
            input::bind(cx);
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| {
                    let mut view = Conversation::new(summary, Arc::new(Mutex::new(store)), cx);
                    view.loaded = true;
                    view.context = Some(monocode_core::context::Usage {
                        used,
                        window: Some(1_000_000),
                        at: Some(monocode_core::time::now_ms() - age),
                    });
                    view
                })
            })
            .unwrap()
        });
        window
            .update(cx, |view, _, cx| {
                view.input
                    .update(cx, |i, cx| i.set_text("keep going".into(), cx))
            })
            .unwrap();
        window
    }

    #[gpui::test]
    fn large_cold_claude_chats_hold_the_send_until_the_user_chooses(cx: &mut TestAppContext) {
        let window = cold(cx, "claude", 180_000, 2 * HOUR);
        window
            .update(cx, |view, _, cx| {
                view.user_send(false, cx);
                assert!(view.cold_prompt_open());
                assert_eq!(
                    view.input.read(cx).content,
                    "keep going",
                    "nothing was sent"
                );
                view.cold_cancel(cx);
                assert!(!view.cold_prompt_open());
                assert_eq!(view.input.read(cx).content, "keep going");
                view.user_send(false, cx);
                assert!(view.cold_prompt_open());
                // Never launch a real provider from a test.
                view.summary.provider = "fixture".into();
                view.cold_send_anyway(true, cx);
                assert!(!view.cold_prompt_open());
                assert!(
                    view.input.read(cx).content.is_empty(),
                    "the message was sent"
                );
                assert!(view.cold_ok, "don't ask again for this chat");
            })
            .unwrap();
    }

    #[gpui::test]
    fn warm_small_or_unknown_caches_send_immediately(cx: &mut TestAppContext) {
        for (provider, used, age) in [
            ("claude", 180_000, 10 * 60_000),
            ("claude", 20_000, 5 * HOUR),
            ("codex", 500_000, 5 * HOUR),
        ] {
            let window = cold(cx, provider, used, age);
            window
                .update(cx, |view, _, cx| {
                    // The real gate, without sending.
                    assert!(!view.cold_gate(false, cx), "{provider} {used} {age}");
                    assert!(!view.cold_prompt_open());
                })
                .unwrap();
        }
    }

    #[gpui::test]
    fn continuing_fresh_hands_the_message_to_the_shell(cx: &mut TestAppContext) {
        let window = cold(cx, "claude", 180_000, 2 * HOUR);
        let seen = Arc::new(Mutex::new(None::<String>));
        let sink = seen.clone();
        let view = window.root(cx).unwrap();
        let _sub = cx.update(|cx| {
            cx.subscribe(&view, move |_, event: &ContinueFresh, _| {
                *sink.lock().unwrap() = Some(event.text.clone());
            })
        });
        window
            .update(cx, |view, _, cx| {
                view.user_send(false, cx);
                view.cold_continue_fresh(cx);
                assert!(!view.cold_prompt_open());
                assert!(view.input.read(cx).content.is_empty());
                view.continued_fresh(Err("offline".into()), "keep going".into(), cx);
                assert_eq!(
                    view.input.read(cx).content,
                    "keep going",
                    "restored on failure"
                );
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(seen.lock().unwrap().as_deref(), Some("keep going"));
    }
}
