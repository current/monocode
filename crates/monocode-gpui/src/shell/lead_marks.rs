//! Sidebar identity for /orchestrator and /operator leads and their agents.
//! A lead row keeps its mode's colour (the prompt bubble burst's palette) as a
//! left edge, faint border and fill; while one of its agents works, a slow
//! sheen crosses the row, and the first dispatch replays the bubble's burst
//! over it. An agent row carries a small mark that leads back to its lead.
use super::*;
use crate::pulse::{self, Rate};
use crate::transcript::burst::{self as fx, Bubble, Burst, Kind as Mode, Palette};
use std::time::{Duration, Instant};

/// One sheen crosses a working lead's row this often.
pub(super) const SWEEP_PERIOD: Duration = Duration::from_millis(4_000);
/// How long the sheen takes to cross; the rest of the period is quiet.
const SWEEP_MS: f32 = 1_400.;

#[derive(Default)]
pub(crate) struct LeadMarks {
    /// Every session that has been a lead since the sidebar first looked.
    known: HashSet<i64>,
    primed: bool,
    /// The dispatch burst a lead replays once, the first time it leads.
    bursts: HashMap<i64, Burst>,
}

fn corners() -> gpui::Corners<Pixels> {
    gpui::Corners::all(px(6.))
}

impl Shell {
    /// The mode a lead row wears: an orchestrator's agents, or the sessions
    /// a thread started (as an orchestrator when it is in that mode).
    pub(super) fn lead_mode(&self, id: i64, cx: &App) -> Option<Mode> {
        if self
            .orchestration_summaries
            .get(&id)
            .is_some_and(|summary| !summary.tasks.is_empty())
        {
            return Some(Mode::Orchestrator);
        }
        let started = if self.workspace.classic_layout {
            // The original sidebar leaves started sessions in the list.
            self.started_by
                .iter()
                .any(|(child, lead)| *lead == id && *child != id)
        } else {
            self.rails.started.get(&id).is_some_and(|c| !c.is_empty())
        };
        started.then(|| {
            if self
                .sessions
                .get(&id)
                .is_some_and(|view| view.read(cx).settings.orchestrator)
            {
                Mode::Orchestrator
            } else {
                Mode::Operator
            }
        })
    }

    /// The lead whose agent this session is.
    pub(super) fn agent_lead(&self, id: i64) -> Option<i64> {
        if let Some((lead, _)) = self
            .orchestration_summaries
            .iter()
            .find(|(_, s)| s.tasks.iter().any(|t| t.session == Some(id)))
        {
            return Some(*lead);
        }
        if self.rails.children.contains(&id)
            && let Some((lead, _)) = self.rails.started.iter().find(|(_, c)| c.contains(&id))
        {
            return Some(*lead);
        }
        self.started_by.get(&id).copied().filter(|lead| *lead != id)
    }

    /// One of the lead's agents is working.
    fn lead_working(&self, lead: i64, cx: &App) -> bool {
        let responding = |id: i64| {
            self.sessions
                .get(&id)
                .is_some_and(|view| view.read(cx).responding())
        };
        self.orchestration_summaries.get(&lead).is_some_and(|s| {
            s.live
                && s.tasks
                    .iter()
                    .any(|t| t.status == "running" || t.session.is_some_and(responding))
        }) || self
            .started_by
            .iter()
            .any(|(child, of)| *of == lead && *child != lead && responding(*child))
    }

    /// Notes leads that appear while the app runs, so each replays the
    /// dispatch burst once. Leads already there when the sidebar first looks
    /// stay still.
    pub(super) fn sync_lead_marks(&mut self, cx: &App) {
        let leads: HashSet<i64> = self
            .orchestration_summaries
            .iter()
            .filter(|(_, s)| !s.tasks.is_empty())
            .map(|(id, _)| *id)
            .chain(
                self.started_by
                    .iter()
                    .filter(|(child, lead)| child != lead)
                    .map(|(_, lead)| *lead),
            )
            .collect();
        let marks = &mut self.rails.leads;
        let now = Instant::now();
        marks.bursts.retain(|_, burst| burst.active(now));
        if !marks.primed {
            marks.primed = true;
            marks.known = leads;
            return;
        }
        let reduced = cx.reduce_motion();
        for lead in leads {
            if marks.known.insert(lead) && !reduced {
                marks
                    .bursts
                    .insert(lead, Burst::new(lead as usize, Mode::Orchestrator));
            }
        }
    }

    /// A lead row's tint and edge, drawn under its content, and its sheen
    /// and dispatch burst, drawn over it. Reduced motion keeps the tint.
    pub(super) fn lead_layers(
        &self,
        id: i64,
        mode: Mode,
        cx: &App,
    ) -> (AnyElement, Option<AnyElement>) {
        let palette = Palette::new(mode, crate::theme::is_light());
        let color = palette.color;
        let under = div()
            .debug_selector(move || format!("sidebar-lead-{id}"))
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .rounded_md()
            .border_1()
            .border_color(fx::mix(color, 0.22))
            .bg(fx::mix(color, 0.05))
            .child(
                div()
                    .absolute()
                    .top(px(4.))
                    .bottom(px(4.))
                    .left_0()
                    .w(px(2.))
                    .rounded_full()
                    .bg(color),
            )
            .into_any_element();
        if cx.reduce_motion() {
            return (under, None);
        }
        let now = Instant::now();
        let burst = self
            .rails
            .leads
            .bursts
            .get(&id)
            .copied()
            .filter(|b| b.active(now));
        let working = self.lead_working(id, cx);
        if burst.is_none() && !working {
            return (under, None);
        }
        let sheen = palette.sheen;
        let over = div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .when(working, |d| {
                d.child(
                    div()
                        .debug_selector(move || format!("sidebar-lead-sheen-{id}"))
                        .absolute()
                        .top_0()
                        .left_0()
                        .size_full()
                        .child(pulse::looping(
                            ("sidebar-lead-sheen", id as usize),
                            SWEEP_PERIOD,
                            Rate::Smooth,
                            move |phase| {
                                let p = phase * SWEEP_PERIOD.as_millis() as f32 / SWEEP_MS;
                                canvas(
                                    |_, _, _| {},
                                    move |bounds, _, window, _| {
                                        let row = Bubble {
                                            bounds,
                                            corners: corners(),
                                        };
                                        fx::paint_sweep(&row, p, &sheen, window);
                                    },
                                )
                                .size_full()
                            },
                        )),
                )
            })
            .when_some(burst, |d, burst| {
                d.child(
                    canvas(
                        |_, _, _| {},
                        move |bounds, _, window, cx| {
                            let now = Instant::now();
                            if burst.active(now) && pulse::request(Rate::Smooth, window, cx) {
                                burst.paint(bounds, corners(), now, window, cx);
                            }
                        },
                    )
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full(),
                )
            })
            .into_any_element();
        (under, Some(over))
    }

    /// An agent row's mark in its lead's colour; clicking it opens the lead.
    pub(super) fn agent_marker(&self, id: i64, cx: &mut Context<Self>) -> Option<AnyElement> {
        let lead = self.agent_lead(id)?;
        let mode = self.lead_mode(lead, cx).unwrap_or(Mode::Operator);
        let color = Palette::new(mode, crate::theme::is_light()).color;
        let title =
            if self.sessions.contains_key(&lead) || self.session_summaries.contains_key(&lead) {
                self.session_metadata(lead, cx).display_title()
            } else {
                "its lead".to_owned()
            };
        let label = format!("Agent of {title}");
        let tooltip = label.clone();
        Some(
            div()
                .id(("sidebar-agent-of", id as usize))
                .debug_selector(move || format!("sidebar-agent-of-{id}"))
                .role(Role::Button)
                .aria_label(label.clone())
                .aria_description(label)
                .h(px(16.))
                .px(px(2.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .gap(px(2.))
                .rounded(px(4.))
                .cursor_pointer()
                .hover(|s| s.bg(content(0.1)))
                .child(icon("corner-down-right", 11.).text_color(color))
                .child(div().size(px(4.)).rounded_full().bg(color))
                .tooltip(move |_, cx| {
                    cx.new(|_| project_rail::ProjectTooltip(tooltip.clone()))
                        .into()
                })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, window, cx| {
                    cx.stop_propagation();
                    this.open(lead, window, cx);
                }))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
impl Shell {
    pub(super) fn lead_bursting(&self, id: i64) -> bool {
        self.rails
            .leads
            .bursts
            .get(&id)
            .is_some_and(|b| b.active(Instant::now()))
    }
}
