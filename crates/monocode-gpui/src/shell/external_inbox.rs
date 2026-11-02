//! Delivers requests from the local external inbox (`monocode-gpui inbox ...`):
//! messages to existing sessions and new sessions on a named account.
use super::*;
use monocode_core::{agent::Settings, external_inbox as inbox};
use std::time::Duration;

/// How often the inbox is checked.
const TICK: Duration = Duration::from_secs(2);
/// A message that cannot be delivered for this long fails instead of waiting.
const GIVE_UP_MS: u64 = 6 * 60 * 60 * 1000;

impl Shell {
    pub(super) fn start_external_inbox(&mut self, cx: &mut Context<Self>) {
        if cfg!(test) {
            return;
        }
        let root = inbox::root();
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                let root = root.clone();
                let items = cx
                    .background_executor()
                    .spawn(async move { inbox::pending_in(&root) })
                    .await;
                if this
                    .update(cx, |this, cx| {
                        this.process_external_inbox(&inbox::root(), items, cx)
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    pub(super) fn process_external_inbox(
        &mut self,
        root: &std::path::Path,
        items: Vec<(std::path::PathBuf, inbox::Request)>,
        cx: &mut Context<Self>,
    ) {
        for (path, request) in items {
            let result = match request.action.as_str() {
                "send" => self.external_send(&request, cx),
                "start" => self.external_start(&request, cx),
                _ => Some(Err("Unknown inbox action".into())),
            };
            let result = match result {
                // Not deliverable yet; give up only after a long wait.
                None if monocode_core::time::now_ms().saturating_sub(request.created_at)
                    > GIVE_UP_MS =>
                {
                    Some(Err("The session did not become ready within 6 hours".into()))
                }
                other => other,
            };
            if let Some(result) = result {
                let outcome = match result {
                    Ok((session, account)) => inbox::Outcome {
                        id: request.id.clone(),
                        ok: true,
                        session_id: Some(session),
                        account,
                        error: None,
                        at: monocode_core::time::now_ms(),
                    },
                    Err(error) => inbox::Outcome {
                        id: request.id.clone(),
                        ok: false,
                        session_id: request.session,
                        account: None,
                        error: Some(error),
                        at: monocode_core::time::now_ms(),
                    },
                };
                let _ = inbox::finish_in(root, &path, &outcome);
            }
        }
    }

    /// `None` while the session is busy or has unsent text; it is retried.
    fn external_send(
        &mut self,
        request: &inbox::Request,
        cx: &mut Context<Self>,
    ) -> Option<Result<(i64, Option<String>), String>> {
        let id = request.session?;
        if !self.session_summaries.contains_key(&id) && !self.sessions.contains_key(&id) {
            return Some(Err(format!("Session {id} was not found; run inbox list")));
        }
        if self.orchestration_worker(id)
            || self
                .monos
                .as_ref()
                .is_some_and(|m| m.read(cx).hidden_session(id))
        {
            return Some(Err(
                "That session is managed by MonoCode and cannot take messages".into(),
            ));
        }
        let view = self.ensure_session(id, cx)?;
        view.update(cx, |v, cx| v.load(cx));
        let ready = {
            let v = view.read(cx);
            v.ready_for_external(cx) && !v.has_saved_draft()
        };
        if !ready {
            return None;
        }
        let text = inbox::message(request);
        view.update(cx, |v, cx| {
            v.install_transfer(v.settings.clone(), Some(text), cx)
        });
        Some(Ok((id, None)))
    }

    fn external_start(
        &mut self,
        request: &inbox::Request,
        cx: &mut Context<Self>,
    ) -> Option<Result<(i64, Option<String>), String>> {
        Some(self.external_start_inner(request, cx))
    }

    fn external_start_inner(
        &mut self,
        request: &inbox::Request,
        cx: &mut Context<Self>,
    ) -> Result<(i64, Option<String>), String> {
        let project = request.project.clone().ok_or("start needs a project")?;
        if !std::path::Path::new(&project).is_dir() {
            return Err(format!("Project folder {project} does not exist"));
        }
        let harness = request.harness.clone().unwrap_or_else(|| "claude".into());
        let kind = Kind::parse(&harness).ok_or("Unknown harness")?;
        let mut settings = Settings::default();
        settings.account = crate::accounts::get(cx)
            .map(|center| center.read(cx).selected(kind, &project))
            .unwrap_or_default();
        let mut input = serde_json::json!({"prompt": request.text});
        if let Some(account) = &request.account {
            input["account"] = account.clone().into();
        }
        if let Some(model) = &request.model {
            input["model"] = model.clone().into();
        }
        if let Some(mode) = &request.runtime_mode {
            input["runtimeMode"] = mode.clone().into();
        }
        let label = crate::accounts::apply_launch_account(&input, kind, &mut settings, cx)?;
        // Model discovery may run the provider CLI; cached models are enough
        // unless a model was named.
        let models = if request.model.is_some() {
            monocode_core::catalog::models_for(kind, &settings.account)?
        } else {
            monocode_core::catalog::cached_models_for(kind, &settings.account).unwrap_or_default()
        };
        let mut settings =
            monocode_core::app_access::launch_settings(&input, kind.id(), settings, kind, &models)?;
        settings.revision = 0;
        let title: String = request
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| request.text.trim().chars().take(80).collect())
            .chars()
            .take(160)
            .collect();
        let summary = {
            let db = locked(&self.store)?;
            let mut summary = db.create(kind.id(), &project)?;
            db.title(summary.id, &title)?;
            db.configure_agent(summary.id, kind.id(), &settings)?;
            summary.title = title;
            summary
        };
        let id = summary.id;
        self.add(summary, cx);
        if let Some(view) = self.sessions.get(&id) {
            let text = inbox::message(request);
            view.update(cx, |v, cx| v.install_transfer(settings, Some(text), cx));
        }
        cx.notify();
        Ok((id, Some(label)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    fn scratch() -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("native-inbox-{}", monocode_core::mono::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn queue(root: &std::path::Path, request: inbox::Request) -> String {
        inbox::submit_in(root, request).unwrap()
    }

    #[gpui::test]
    fn inbox_messages_wait_for_a_ready_session_then_arrive_labelled(cx: &mut TestAppContext) {
        let (window, other, _) = crate::shell::tests::window(cx);
        let dir = scratch();
        let root = dir.join("external-inbox");
        let sent = queue(
            &root,
            inbox::Request {
                action: "send".into(),
                session: Some(other),
                text: "status?".into(),
                from: Some("Grok Bot".into()),
                ..Default::default()
            },
        );
        let missing = queue(
            &root,
            inbox::Request {
                action: "send".into(),
                session: Some(424242),
                text: "x".into(),
                ..Default::default()
            },
        );
        window
            .update(cx, |shell, _, cx| {
                shell.sessions[&other].update(cx, |v, cx| {
                    v.summary.provider = "fixture".into();
                    // Unsent text in the composer holds the message.
                    v.input.update(cx, |i, cx| i.set_text("typing".into(), cx));
                });
                shell.process_external_inbox(&root, inbox::pending_in(&root), cx);
                assert!(
                    inbox::outcome_in(&root, &sent).is_none(),
                    "held while the user types"
                );
                let failed = inbox::outcome_in(&root, &missing).unwrap();
                assert!(!failed.ok && failed.error.unwrap().contains("not found"));
                shell.sessions[&other].update(cx, |v, cx| {
                    v.input.update(cx, |i, cx| i.set_text(String::new(), cx))
                });
            })
            .unwrap();
        // The history load started by the first attempt finishes in the background.
        cx.run_until_parked();
        window
            .update(cx, |shell, _, cx| {
                shell.process_external_inbox(&root, inbox::pending_in(&root), cx);
                let delivered = inbox::outcome_in(&root, &sent).unwrap();
                assert!(delivered.ok);
                assert_eq!(delivered.session_id, Some(other));
                assert!(inbox::pending_in(&root).is_empty());
            })
            .unwrap();
        cx.run_until_parked();
        window
            .update(cx, |shell, _, _| {
                let rows = locked(&shell.store).unwrap().load(other).unwrap().rows;
                assert!(
                    rows.iter()
                        .any(|r| r.text.contains("[From Grok Bot]\nstatus?"))
                );
            })
            .unwrap();
    }

    #[gpui::test]
    fn inbox_starts_refuse_unknown_accounts_and_folders(cx: &mut TestAppContext) {
        let (window, _, _) = crate::shell::tests::window(cx);
        let dir = scratch();
        let root = dir.join("external-inbox");
        let project = dir.to_string_lossy().to_string();
        let account = queue(
            &root,
            inbox::Request {
                action: "start".into(),
                project: Some(project.clone()),
                harness: Some("claude".into()),
                account: Some("Claude Alt 9".into()),
                text: "x".into(),
                ..Default::default()
            },
        );
        let folder = queue(
            &root,
            inbox::Request {
                action: "start".into(),
                project: Some(format!("{project}/missing")),
                text: "x".into(),
                ..Default::default()
            },
        );
        window
            .update(cx, |shell, _, cx| {
                let before = shell.session_summaries.len();
                shell.process_external_inbox(&root, inbox::pending_in(&root), cx);
                let a = inbox::outcome_in(&root, &account).unwrap();
                assert!(!a.ok && a.error.unwrap().contains("Unknown claude account"));
                let f = inbox::outcome_in(&root, &folder).unwrap();
                assert!(!f.ok && f.error.unwrap().contains("does not exist"));
                assert_eq!(shell.session_summaries.len(), before, "nothing was created");
            })
            .unwrap();
    }
    #[gpui::test]
    fn inbox_launch_settings_mark_workers_even_with_operator_project_default(
        cx: &mut TestAppContext,
    ) {
        let (window, _, _) = crate::shell::tests::window(cx);
        window
            .update(cx, |shell, _, _| {
                let settings = monocode_core::app_access::launch_settings(
                    &serde_json::json!({"prompt":"Review"}),
                    "codex",
                    Settings {
                        operator_enabled: true,
                        ..Default::default()
                    },
                    Kind::Codex,
                    &[],
                )
                .unwrap();
                assert!(settings.operator_worker);
                assert!(!settings.operator_enabled);
                let _ = shell;
            })
            .unwrap();
    }
}
