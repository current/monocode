//! "Continue in a fresh chat": start a new session from a cheap handoff of a
//! conversation whose prompt cache has expired.
use super::*;
use monocode_core::agent::Settings;
use std::sync::{Arc, atomic::AtomicBool};

/// What the fresh session keeps: who it runs as, how it thinks and where it
/// works. Transports, Mono context and turn history stay behind.
pub(super) fn fresh_settings(from: &Settings) -> Settings {
    Settings {
        account: from.account.clone(),
        model: from.model.clone(),
        effort: from.effort.clone(),
        access: from.access,
        fast: from.fast,
        service_tier: from.service_tier.clone(),
        thinking: from.thinking,
        model_settings: from.model_settings.clone(),
        operator_enabled: from.operator_enabled,
        worktree_cwd: from.worktree_cwd.clone(),
        worktree_base: from.worktree_base.clone(),
        disable_claude_hooks: from.disable_claude_hooks,
        ..Default::default()
    }
}

impl Shell {
    pub(super) fn continue_fresh(&mut self, from: i64, text: String, cx: &mut Context<Self>) {
        let Some(view) = self.sessions.get(&from).cloned() else {
            return;
        };
        let (provider, cwd, title, settings) = {
            let v = view.read(cx);
            (
                v.summary.provider.clone(),
                v.summary.cwd.clone(),
                v.summary.title.clone(),
                fresh_settings(&v.settings),
            )
        };
        let store = self.store.clone();
        let message = text.clone();
        let work = cx.background_executor().spawn(async move {
            let rows = locked(&store)?.load(from)?.rows;
            let workdir = settings.worktree_cwd.clone().unwrap_or_else(|| cwd.clone());
            let handoff = monocode_core::handoff::generate(
                Kind::from_id(&provider),
                std::path::Path::new(&workdir),
                settings.account.clone(),
                &title,
                &rows,
                Arc::new(AtomicBool::new(false)),
            );
            let seed = monocode_core::handoff::seed(&title, from, &handoff, &message);
            let db = locked(&store)?;
            let mut summary = db.create(&provider, &cwd)?;
            summary.title = format!("{title} (continued)").chars().take(160).collect();
            db.title(summary.id, &summary.title)?;
            db.configure_agent(summary.id, &provider, &settings)?;
            Ok::<_, String>((summary, settings, seed))
        });
        cx.spawn(async move |this, cx| {
            let result = work.await;
            let _ = this.update(cx, |this, cx| {
                let outcome = match result {
                    Ok((summary, settings, seed)) => {
                        let id = summary.id;
                        this.session_worktrees
                            .insert(id, settings.worktree_cwd.clone());
                        this.add(summary, cx);
                        if let Some(fresh) = this.sessions.get(&id) {
                            fresh.update(cx, |v, cx| v.install_transfer(settings, Some(seed), cx));
                        }
                        this.pending_open = Some(id);
                        Ok(())
                    }
                    Err(error) => Err(error),
                };
                view.update(cx, |v, cx| v.continued_fresh(outcome, text, cx));
                cx.notify();
            });
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_chats_keep_identity_and_checkout_but_not_transport_or_history() {
        let mut from = Settings {
            account: monocode_core::accounts::Profile {
                id: "t3-claude-alt-3".into(),
                root: None,
            },
            model: Some("opus".into()),
            effort: Some("high".into()),
            operator_enabled: true,
            worktree_cwd: Some("/work/tree".into()),
            internal_message: true,
            revision: 9,
            ..Default::default()
        };
        from.environment.insert("TOKEN".into(), "secret".into());
        from.handoff = Some(monocode_core::agent::Handoff {
            from: "codex".into(),
            brief: "old".into(),
        });
        let fresh = fresh_settings(&from);
        assert_eq!(fresh.account.id, "t3-claude-alt-3");
        assert_eq!(fresh.model.as_deref(), Some("opus"));
        assert_eq!(fresh.effort.as_deref(), Some("high"));
        assert!(fresh.operator_enabled);
        assert_eq!(fresh.worktree_cwd.as_deref(), Some("/work/tree"));
        assert!(fresh.environment.is_empty());
        assert!(fresh.handoff.is_none());
        assert!(!fresh.internal_message);
        assert_eq!(fresh.revision, 0);
    }
}
