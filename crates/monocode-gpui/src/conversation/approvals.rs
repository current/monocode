//! Permission requests use the queued-message shelf and its upward reveal.
use super::*;
use std::cell::RefCell;

#[derive(Default)]
pub(super) struct State {
    current: RefCell<Option<String>>,
    motion: composer_shelf::Motion,
}

impl State {
    fn sync(&self, id: Option<&str>, animate: bool) {
        let mut current = self.current.borrow_mut();
        if current.as_deref() != id {
            *current = id.map(str::to_owned);
            if let Some(id) = id {
                self.motion.insert(id, true, animate);
            }
        }
        self.motion.retain(id.into_iter(), animate);
    }
}

impl Conversation {
    pub(super) fn approval_shelf(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let width = self.composer_anchor.get().map(|bounds| bounds.size.width);
        self.approval_ui.sync(
            self.approvals.front().map(|approval| approval.id.as_str()),
            !cx.reduce_motion() && width.is_some(),
        );
        let Some(approval) = self.approvals.front() else {
            return div().into_any_element();
        };
        let mut ink = shell_fill();
        ink.a = 1.;
        let deny_id = approval.id.clone();
        let session_id = approval.id.clone();
        let allow_id = approval.id.clone();
        let actions = div()
            .flex_shrink_0()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                approval_button("approval-deny", "Deny")
                    .text_color(content(0.5))
                    .hover(|s| s.bg(content(0.08)).text_color(content(0.9)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.decide_notification_request(&deny_id, Decision::Deny, cx);
                    })),
            )
            .when(approval.can_remember, |d| {
                d.child(
                    approval_button("approval-session", "Allow for this session")
                        .bg(content(0.06))
                        .hover(|s| s.bg(content(0.1)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.decide_notification_request(&session_id, Decision::Session, cx);
                        })),
                )
            })
            .child(
                approval_button("approval-allow", "Allow once")
                    .bg(content(1.))
                    .text_color(ink)
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .hover(move |s| s.bg(content(0.85)).text_color(ink))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.decide_notification_request(&allow_id, Decision::Allow, cx);
                    })),
            );
        // The question and its answers share one row; any detail follows below.
        let card = composer_shelf::card("approval-request", self.classic_layout)
            .role(Role::Group)
            .aria_label(approval.title.clone())
            .child(
                div()
                    .debug_selector(|| "approval-header".into())
                    .min_h(px(32.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(icon("square-lock", 14.).text_color(gpui::rgb(0xfbbf24)))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .py_1()
                            .text_color(content(0.75))
                            .child(approval.title.clone()),
                    )
                    .child(actions),
            )
            .when(!approval.detail.is_empty(), |card| {
                card.child(
                    div()
                        .id("approval-detail")
                        .role(Role::Label)
                        .aria_label(approval.detail.clone())
                        .border_t_1()
                        .border_color(content(0.05))
                        .py_1()
                        .max_h(px(180.))
                        .overflow_y_scroll()
                        .font_family(crate::fonts::mono())
                        .text_size(px(12.))
                        .line_height(px(18.))
                        .text_color(content(0.75))
                        .child(approval.detail.clone()),
                )
            });
        let card_width = (width.unwrap_or_default() - px(16.)).max(px(0.));
        composer_shelf::shelf("approval-shelf")
            .debug_selector(|| "approval-shelf".into())
            .child(self.approval_ui.motion.card(card, card_width, window))
            .into_any_element()
    }
}

fn approval_button(id: &'static str, label: &'static str) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .debug_selector(move || id.into())
        .role(Role::Button)
        .aria_label(label)
        .cursor_pointer()
        .flex_shrink_0()
        .h(px(26.))
        .px(px(10.))
        .rounded_md()
        .flex()
        .items_center()
        .text_size(px(12.))
        .child(label)
        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
}

impl Conversation {
    pub(crate) fn request_operator(&mut self, reason: String, cx: &mut Context<Self>) {
        if self.settings.operator_worker || self.settings.operator_enabled || self.is_remote() {
            return;
        }
        self.operator_request = Some(reason);
        cx.emit(SessionChanged);
        cx.notify();
    }
    pub(crate) fn decide_operator(&mut self, enable: bool, cx: &mut Context<Self>) {
        if self.operator_request.take().is_none() || self.settings.operator_worker {
            return;
        }
        if enable {
            self.settings.operator_enabled = true;
            self.save_settings(cx);
            self.enqueue_follow_up("Operator enabled; continue.".into(), None, cx);
        }
        cx.emit(SessionChanged);
        cx.notify();
    }
    pub(super) fn operator_grant_card(&self, cx: &mut Context<Self>) -> AnyElement {
        let Some(reason) = &self.operator_request else {
            return div().into_any_element();
        };
        let mut ink = shell_fill();
        ink.a = 1.;
        composer_shelf::shelf("operator-grant-shelf")
            .child(
                composer_shelf::card("operator-grant-card", self.classic_layout)
                    .debug_selector(|| "operator-grant-card".into())
                    .role(Role::Group)
                    .aria_label("This chat wants to start and manage agents")
                    .child(
                        div()
                            .min_h(px(32.))
                            .py_1()
                            .text_color(content(0.75))
                            .child("This chat wants to start and manage agents"),
                    )
                    .child(
                        div()
                            .id("operator-reason")
                            .max_h(px(180.))
                            .overflow_y_scroll()
                            .border_t_1()
                            .border_color(content(0.05))
                            .py_1()
                            .text_color(content(0.75))
                            .child(reason.clone()),
                    )
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(px(6.))
                            .py_1()
                            .child(
                                approval_button("operator-not-now", "Not now")
                                    .text_color(content(0.5))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.decide_operator(false, cx)
                                    })),
                            )
                            .child(
                                approval_button("operator-enable", "Enable Operator")
                                    .bg(content(1.))
                                    .text_color(ink)
                                    .font_weight(gpui::FontWeight::MEDIUM)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.decide_operator(true, cx)
                                        }),
                                    ),
                            ),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext, WindowHandle};
    use monocode_core::store::Store;
    use std::{sync::Mutex, time::Duration};

    fn conversation(cx: &mut TestAppContext) -> WindowHandle<Conversation> {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let summary = store.create("codex", "/tmp").unwrap();
        cx.update(|cx| {
            input::bind(cx);
            cx.set_global(crate::settings::Preferences {
                composer_mascot: false,
                follow_up: "queue".into(),
                ..Default::default()
            });
            cx.open_window(Default::default(), |_, cx| {
                cx.new(|cx| {
                    let mut view = Conversation::new(summary, Arc::new(Mutex::new(store)), cx);
                    view.loaded = true;
                    view.summary.has_messages = true;
                    view.busy = true;
                    view.follow_ups.state.paused = true;
                    view
                })
            })
            .unwrap()
        })
    }

    #[gpui::test]
    fn operator_grant_persists_and_queues_follow_up(cx: &mut TestAppContext) {
        let window = conversation(cx);
        window
            .update(cx, |v, _, cx| {
                v.request_operator("Parallel review".into(), cx);
                v.decide_operator(false, cx);
                assert!(!v.settings.operator_enabled);
                v.request_operator("Parallel review".into(), cx);
                v.decide_operator(true, cx);
                assert!(v.settings.operator_enabled);
                assert!(v.operator_request.is_none());
                assert_eq!(
                    v.follow_ups.state.messages.last().unwrap().text,
                    "Operator enabled; continue."
                );
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |v, _, _| {
                assert!(
                    locked(&v.store)
                        .unwrap()
                        .agent_settings(v.summary.id)
                        .unwrap()
                        .unwrap()
                        .operator_enabled
                );
            })
            .unwrap();
    }

    #[gpui::test]
    fn operator_card_buttons_stay_inside_card(cx: &mut TestAppContext) {
        let window = conversation(cx);
        window
            .update(cx, |v, _, cx| {
                v.request_operator(
                    "Review the implementation and tests in parallel.".into(),
                    cx,
                )
            })
            .unwrap();
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        for width in [680., 358.] {
            visual.simulate_resize(gpui::size(px(width), px(600.)));
            visual.refresh().unwrap();
            let card = visual.debug_bounds("operator-grant-card").unwrap();
            for id in ["operator-enable", "operator-not-now"] {
                let button = visual.debug_bounds(id).unwrap();
                assert!(button.left() >= card.left());
                assert!(button.right() <= card.right());
                assert!(button.bottom() <= card.bottom());
            }
        }
    }

    fn request(id: &str, can_remember: bool) -> Approval {
        Approval {
            id: id.into(),
            title: "Run a command?".into(),
            detail: "git status --short".into(),
            can_remember,
        }
    }

    #[gpui::test]
    fn approval_shelf_slides_up_without_moving_the_composer_or_replaying_on_redraw(
        cx: &mut TestAppContext,
    ) {
        let window = conversation(cx);
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        visual.refresh().unwrap();
        let input = visual.debug_bounds("composer-box").unwrap();
        for queued in [false, true] {
            window
                .update(visual, |view, _, cx| {
                    view.approvals.clear();
                    if queued {
                        view.enqueue_follow_up("A queued follow-up".into(), None, cx);
                        view.follow_ups.motion.elapsed(Duration::from_secs(1));
                    }
                    cx.notify();
                })
                .unwrap();
            visual.refresh().unwrap();
            window
                .update(visual, |view, _, cx| {
                    view.approvals
                        .push_back(request(if queued { "second" } else { "first" }, true));
                    cx.notify();
                })
                .unwrap();
            visual.refresh().unwrap();
            let start = visual.debug_bounds("approval-shelf").unwrap();
            assert!((start.top() - input.top()).abs() < px(1.));
            assert_eq!(visual.debug_bounds("composer-box").unwrap(), input);

            window
                .update(visual, |view, _, cx| {
                    view.approval_ui.motion.elapsed(Duration::from_millis(40));
                    cx.notify();
                })
                .unwrap();
            visual.refresh().unwrap();
            let middle = visual.debug_bounds("approval-shelf").unwrap();
            assert!(middle.top() < start.top() - px(5.));
            assert_eq!(visual.debug_bounds("composer-box").unwrap(), input);

            window
                .update(visual, |view, _, cx| {
                    view.approval_ui.motion.elapsed(Duration::from_secs(1));
                    cx.notify();
                })
                .unwrap();
            visual.refresh().unwrap();
            let settled = visual.debug_bounds("approval-shelf").unwrap();
            assert!(settled.top() < middle.top() - px(5.));
            assert_eq!(settled.bottom(), input.top());
            assert_eq!(visual.debug_bounds("composer-box").unwrap(), input);
            window.update(visual, |_, _, cx| cx.notify()).unwrap();
            visual.refresh().unwrap();
            assert_eq!(visual.debug_bounds("approval-shelf").unwrap(), settled);
        }
        visual.update(|_, cx| cx.set_reduce_motion(true));
        window
            .update(visual, |view, _, cx| {
                view.approvals.clear();
                view.approvals.push_back(request("reduced-motion", true));
                cx.notify();
            })
            .unwrap();
        visual.refresh().unwrap();
        assert!(visual.debug_bounds("approval-shelf").unwrap().size.height > px(60.));
        assert_eq!(visual.debug_bounds("composer-box").unwrap(), input);
    }

    #[gpui::test]
    fn approval_shelf_buttons_resolve_each_request_with_the_selected_decision(
        cx: &mut TestAppContext,
    ) {
        let window = conversation(cx);
        cx.update(|cx| cx.set_reduce_motion(true));
        let (send, receive) = std::sync::mpsc::channel();
        window
            .update(cx, |view, _, cx| {
                view.controls = Some(send);
                view.approvals.extend([
                    request("once", true),
                    request("session", true),
                    request("denied", false),
                ]);
                cx.notify();
            })
            .unwrap();
        let visual = &mut VisualTestContext::from_window(window.into(), cx);
        visual.refresh().unwrap();
        let header = visual.debug_bounds("approval-header").unwrap();
        for button in ["approval-deny", "approval-session", "approval-allow"] {
            let bounds = visual.debug_bounds(button).unwrap();
            assert!(
                bounds.top() >= header.top() && bounds.bottom() <= header.bottom(),
                "{button} shares the title row"
            );
        }
        for (button, id) in [
            ("approval-allow", "once"),
            ("approval-session", "session"),
            ("approval-deny", "denied"),
        ] {
            if id == "denied" {
                assert!(visual.debug_bounds("approval-session").is_none());
            }
            let bounds = visual.debug_bounds(button).unwrap();
            visual.simulate_click(bounds.center(), Default::default());
            visual.refresh().unwrap();
            let control = receive.try_recv().unwrap();
            assert_eq!(control.id, id);
            assert!(matches!(
                (id, control.decision),
                ("once", Decision::Allow)
                    | ("session", Decision::Session)
                    | ("denied", Decision::Deny)
            ));
            assert!(receive.try_recv().is_err());
        }
        assert!(visual.debug_bounds("approval-shelf").is_none());
        window
            .read_with(visual, |view, _| assert!(view.approvals.is_empty()))
            .unwrap();
    }
}
