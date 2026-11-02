//! Completion reports for /operator leads.
//!
//! A lead that starts sessions through the app CLI ends its turn instead of
//! polling. When the lead is idle and every session it started (and has not
//! yet heard back from) has stopped, it receives one message with their final
//! answers, so a batch of workers costs the lead a single turn.
use super::*;
use std::time::{Duration, Instant};

/// Characters of each worker's final answer included in a report.
const REPORT_CHARS: usize = 12_000;
/// How often a report waiting on a busy lead or an unsent composer retries.
const RETRY: Duration = Duration::from_secs(10);
const START_GRACE: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct OperatorReports {
    /// Child session to the lead awaiting its report. Persisted.
    pending: Option<HashMap<i64, i64>>,
    /// Children seen working since launch. A child that never showed as busy
    /// in this run (for example after a restart) counts as stopped.
    seen_busy: HashSet<i64>,
    /// Children launched in this run that have not started their turn yet,
    /// with their launch time. One that never starts counts as stopped after
    /// `START_GRACE`, so a failed launch cannot hold a report forever.
    starting: HashMap<i64, Instant>,
    /// Leads whose report is being assembled.
    assembling: HashSet<i64>,
    retry: Option<gpui::Task<()>>,
}

impl Shell {
    pub(super) fn operator_pending(&mut self) -> &mut HashMap<i64, i64> {
        if self.operator_reports.pending.is_none() {
            let saved = locked(&self.store)
                .and_then(|db| db.operator_reports())
                .unwrap_or_default();
            self.operator_reports.pending = Some(saved);
        }
        self.operator_reports.pending.as_mut().unwrap()
    }

    fn save_operator_pending(&mut self, cx: &mut Context<Self>) {
        let pending = self.operator_pending().clone();
        let store = self.store.clone();
        cx.background_executor()
            .spawn(async move {
                let _ = locked(&store).and_then(|db| db.save_operator_reports(&pending));
            })
            .detach();
    }

    /// Record a session an /operator lead started so its result is reported back.
    pub(super) fn track_operator_launch(&mut self, child: i64, lead: i64, cx: &mut Context<Self>) {
        self.operator_pending().insert(child, lead);
        self.operator_reports.starting.insert(child, Instant::now());
        self.save_operator_pending(cx);
    }

    /// The lead stopped, archived or deleted a child itself; it already knows.
    pub(super) fn dismiss_operator_launch(&mut self, child: i64, cx: &mut Context<Self>) {
        if self.operator_pending().remove(&child).is_some() {
            self.operator_reports.starting.remove(&child);
            self.save_operator_pending(cx);
            self.check_operator_reports(cx);
        }
    }

    fn operator_child_stopped(&self, child: i64, cx: &App) -> bool {
        let Some(view) = self.sessions.get(&child) else {
            // Removed, or not loaded in this run: nothing is working on it.
            return !self.operator_reports.starting.contains_key(&child)
                || !self.session_summaries.contains_key(&child);
        };
        let view = view.read(cx);
        if view.busy {
            return false;
        }
        self.operator_reports.seen_busy.contains(&child)
            || self
                .operator_reports
                .starting
                .get(&child)
                .is_none_or(|at| at.elapsed() >= START_GRACE)
    }

    /// Called whenever a session changes: note working children and deliver
    /// any report whose whole batch has stopped.
    pub(super) fn check_operator_reports(&mut self, cx: &mut Context<Self>) {
        let pending = self.operator_pending().clone();
        if pending.is_empty() {
            return;
        }
        for child in pending.keys() {
            if let Some(view) = self.sessions.get(child)
                && view.read(cx).busy
            {
                self.operator_reports.seen_busy.insert(*child);
                self.operator_reports.starting.remove(child);
            }
        }
        let leads: HashSet<i64> = pending.values().copied().collect();
        let mut waiting = false;
        for lead in leads {
            if self.operator_reports.assembling.contains(&lead) {
                continue;
            }
            let children: Vec<i64> = pending
                .iter()
                .filter(|(_, l)| **l == lead)
                .map(|(c, _)| *c)
                .collect();
            if !self.session_summaries.contains_key(&lead) && !self.sessions.contains_key(&lead) {
                // The lead was deleted; nobody is waiting for these reports.
                for child in &children {
                    self.operator_pending().remove(child);
                }
                self.save_operator_pending(cx);
                continue;
            }
            if !children.iter().all(|c| self.operator_child_stopped(*c, cx)) {
                // A child that has not started yet is re-checked by timer.
                waiting |= children
                    .iter()
                    .any(|c| self.operator_reports.starting.contains_key(c));
                continue;
            }
            let Some(view) = self.ensure_session(lead, cx) else {
                continue;
            };
            view.update(cx, |v, cx| v.load(cx));
            let ready = {
                let v = view.read(cx);
                v.ready_for_external(cx) && !v.has_saved_draft()
            };
            if !ready {
                waiting = true;
                continue;
            }
            self.deliver_operator_report(lead, children, view, cx);
        }
        if waiting && self.operator_reports.retry.is_none() {
            self.operator_reports.retry = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(RETRY).await;
                let _ = this.update(cx, |this, cx| {
                    this.operator_reports.retry = None;
                    this.check_operator_reports(cx);
                });
            }));
        }
    }

    fn deliver_operator_report(
        &mut self,
        lead: i64,
        children: Vec<i64>,
        view: Entity<Conversation>,
        cx: &mut Context<Self>,
    ) {
        self.operator_reports.assembling.insert(lead);
        let titles: Vec<(i64, String)> = children
            .iter()
            .map(|c| {
                let title = self
                    .session_summaries
                    .get(c)
                    .map(|s| s.title.clone())
                    .or_else(|| {
                        self.sessions
                            .get(c)
                            .map(|v| v.read(cx).summary.title.clone())
                    })
                    .unwrap_or_default();
                (*c, title)
            })
            .collect();
        let store = self.store.clone();
        let work = cx.background_executor().spawn(async move {
            titles
                .into_iter()
                .map(|(id, title)| {
                    let answer = locked(&store)
                        .and_then(|db| db.load(id))
                        .map(|t| monocode_core::response::prose(&t.rows))
                        .unwrap_or_else(|_| "Session was removed".into());
                    format!(
                        "Session {id}: {title}\n{}",
                        monocode_core::response::limit(&answer, REPORT_CHARS)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        });
        cx.spawn(async move |this, cx| {
            let report = work.await;
            let _ = this.update(cx, |this, cx| {
                this.operator_reports.assembling.remove(&lead);
                // Re-check: the lead may have become busy while assembling.
                let ready = {
                    let v = view.read(cx);
                    v.ready_for_external(cx) && !v.has_saved_draft()
                };
                if !ready {
                    this.check_operator_reports(cx);
                    return;
                }
                for child in &children {
                    this.operator_pending().remove(child);
                    this.operator_reports.seen_busy.remove(child);
                }
                this.save_operator_pending(cx);
                let count = children.len();
                let message = format!(
                    "[Delegated work completed]\n{} you started {} stopped. Inspect the results below and give an integrated update; use sessions.read for more detail.\n\n{report}",
                    if count == 1 { "The session" } else { "All sessions" },
                    if count == 1 { "has" } else { "have" },
                );
                view.update(cx, |v, cx| v.install_transfer(v.settings.clone(), Some(message), cx));
            });
        })
        .detach();
    }
}
