//! A local inbox through which other tools on this computer (for example an
//! assistant that runs shell commands for the user) can post a message to a
//! session or start one, the way `t3 thread send` works for T3 Code.
//!
//! The CLI writes one request file into `<data>/inbox/pending` (owner-only
//! permissions); the running app picks it up, delivers it, and writes the
//! outcome to `<data>/inbox/done`. Only the local user can write there, which
//! is the same trust boundary as the provider CLIs themselves.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Largest message accepted, in characters.
pub const MAX_TEXT: usize = 200_000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Request {
    pub id: String,
    /// "send" posts `text` to `session`; "start" creates a session in `project`.
    pub action: String,
    pub session: Option<i64>,
    pub project: Option<String>,
    pub harness: Option<String>,
    pub account: Option<String>,
    pub model: Option<String>,
    pub title: Option<String>,
    /// Permission mode for a started session, as in sessions.start runtimeMode.
    #[serde(rename = "runtimeMode")]
    pub runtime_mode: Option<String>,
    pub text: String,
    /// Who sent it, shown before the message (for example "Grok Bot").
    pub from: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Outcome {
    pub id: String,
    pub ok: bool,
    #[serde(rename = "sessionId")]
    pub session_id: Option<i64>,
    pub account: Option<String>,
    pub error: Option<String>,
    pub at: u64,
}

pub fn root() -> PathBuf {
    crate::store::monocode_database()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
        .join("external-inbox")
}

fn private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub fn validate(request: &Request) -> Result<(), String> {
    if request.text.trim().is_empty() {
        return Err("Message text is empty".into());
    }
    if request.text.chars().count() > MAX_TEXT {
        return Err(format!("Message is longer than {MAX_TEXT} characters"));
    }
    match request.action.as_str() {
        "send" if request.session.is_some() => Ok(()),
        "send" => Err("send needs --session".into()),
        "start"
            if request
                .project
                .as_deref()
                .is_some_and(|p| !p.trim().is_empty()) =>
        {
            Ok(())
        }
        "start" => Err("start needs --project".into()),
        _ => Err("Unknown inbox action".into()),
    }
}

/// Queue a request for the running app. Returns its ID.
pub fn submit_in(root: &Path, mut request: Request) -> Result<String, String> {
    if request.id.is_empty() {
        request.id = format!("{}-{}", crate::time::now_ms(), crate::mono::new_id());
    }
    if request.created_at == 0 {
        request.created_at = crate::time::now_ms();
    }
    validate(&request)?;
    let pending = root.join("pending");
    private_dir(root)?;
    private_dir(&pending)?;
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    write_private(&pending.join(format!("{}.json", request.id)), &bytes)?;
    Ok(request.id)
}

/// Requests waiting for the app, oldest first. Unreadable files are skipped.
pub fn pending_in(root: &Path) -> Vec<(PathBuf, Request)> {
    let Ok(entries) = fs::read_dir(root.join("pending")) else {
        return Vec::new();
    };
    let mut items: Vec<(PathBuf, Request)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let request = serde_json::from_slice(&fs::read(&p).ok()?).ok()?;
            Some((p, request))
        })
        .collect();
    items.sort_by_key(|(_, r)| (r.created_at, r.id.clone()));
    items
}

/// Record the outcome and remove the pending file.
pub fn finish_in(root: &Path, path: &Path, outcome: &Outcome) -> Result<(), String> {
    let done = root.join("done");
    private_dir(&done)?;
    let bytes = serde_json::to_vec(outcome).map_err(|e| e.to_string())?;
    write_private(&done.join(format!("{}.json", outcome.id)), &bytes)?;
    let _ = fs::remove_file(path);
    Ok(())
}

pub fn outcome_in(root: &Path, id: &str) -> Option<Outcome> {
    serde_json::from_slice(&fs::read(root.join("done").join(format!("{id}.json"))).ok()?).ok()
}

fn wait_in(root: &Path, id: &str, timeout: Duration) -> Option<Outcome> {
    let start = Instant::now();
    loop {
        if let Some(outcome) = outcome_in(root, id) {
            return Some(outcome);
        }
        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The text a session receives: the sender's label, then the message.
pub fn message(request: &Request) -> String {
    match request
        .from
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(from) => format!("[From {from}]\n{}", request.text.trim()),
        None => request.text.trim().to_owned(),
    }
}

const USAGE: &str = "usage:
  monocode-gpui inbox send  --session ID (--text TEXT | --file PATH | --stdin) [--from NAME] [--wait SECONDS]
  monocode-gpui inbox start --project PATH (--text TEXT | --file PATH | --stdin) [--harness claude|codex]
                            [--account LABEL] [--model ID] [--title TITLE] [--mode read-only|supervised|auto|full-access]
                            [--from NAME] [--wait SECONDS]
  monocode-gpui inbox list  [--project PATH] [--limit N]
  monocode-gpui inbox read  --session ID [--limit N] [--max-chars N]
  monocode-gpui inbox status --id REQUEST_ID
Messages are delivered by the running Monocode Native app. A message to a busy session, or one with unsent text in
its composer, waits until the session is ready. --wait (default 20) waits for the app to accept the request.";

fn flags(args: &[String]) -> Result<std::collections::HashMap<String, String>, String> {
    let mut map = std::collections::HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .ok_or_else(|| format!("Unexpected argument {}\n{USAGE}", args[i]))?;
        if key == "stdin" {
            map.insert(key.to_owned(), String::new());
            i += 1;
            continue;
        }
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("--{key} needs a value\n{USAGE}"))?;
        map.insert(key.to_owned(), value.clone());
        i += 2;
    }
    Ok(map)
}

fn text(map: &std::collections::HashMap<String, String>) -> Result<String, String> {
    if let Some(text) = map.get("text") {
        return Ok(text.clone());
    }
    if let Some(path) = map.get("file") {
        return fs::read_to_string(path).map_err(|e| format!("Cannot read {path}: {e}"));
    }
    if map.contains_key("stdin") {
        let mut buffer = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)
            .map_err(|e| e.to_string())?;
        return Ok(buffer);
    }
    Err(format!(
        "Give the message with --text, --file or --stdin\n{USAGE}"
    ))
}

fn number(
    map: &std::collections::HashMap<String, String>,
    key: &str,
) -> Result<Option<i64>, String> {
    map.get(key)
        .map(|v| {
            v.trim()
                .parse::<i64>()
                .map_err(|_| format!("--{key} must be a number"))
        })
        .transpose()
}

/// `monocode-gpui inbox ...`
pub fn client(args: &[String]) -> Result<Value, String> {
    client_in(&root(), &crate::store::monocode_database(), args)
}

pub fn client_in(root: &Path, database: &Path, args: &[String]) -> Result<Value, String> {
    let Some(command) = args.first() else {
        return Err(USAGE.into());
    };
    let map = flags(&args[1..])?;
    match command.as_str() {
        "send" | "start" => {
            let request = Request {
                action: command.clone(),
                session: number(&map, "session")?,
                project: map.get("project").cloned(),
                harness: map.get("harness").cloned(),
                account: map.get("account").cloned(),
                model: map.get("model").cloned(),
                title: map.get("title").cloned(),
                runtime_mode: map.get("mode").cloned(),
                from: map.get("from").cloned(),
                text: text(&map)?,
                ..Default::default()
            };
            let wait = number(&map, "wait")?.unwrap_or(20).max(0) as u64;
            let id = submit_in(root, request)?;
            match wait_in(root, &id, Duration::from_secs(wait)) {
                Some(outcome) => Ok(json!({"ok":outcome.ok,"requestId":id,"result":outcome})),
                None => Ok(json!({"ok":true,"requestId":id,"queued":true,
                    "note":"Queued; Monocode Native delivers it when running. Check with: inbox status --id <requestId>"})),
            }
        }
        "status" => {
            let id = map.get("id").ok_or("status needs --id")?;
            Ok(match outcome_in(root, id) {
                Some(outcome) => json!({"ok":outcome.ok,"result":outcome}),
                None if root.join("pending").join(format!("{id}.json")).exists() => {
                    json!({"ok":true,"queued":true})
                }
                None => json!({"ok":false,"error":"Unknown request ID"}),
            })
        }
        "list" => {
            let store = crate::store::Store::read_monocode(database)?;
            let limit = number(&map, "limit")?.unwrap_or(30).clamp(1, 500) as usize;
            let project = map.get("project").map(|p| crate::files::path_key(p));
            let mut sessions: Vec<_> = store
                .sessions()?
                .into_iter()
                .filter(|s| !s.archived)
                .filter(|s| {
                    project
                        .as_ref()
                        .is_none_or(|p| crate::files::path_key(&s.cwd) == *p)
                })
                .collect();
            sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
            sessions.truncate(limit);
            Ok(json!({"ok":true,"sessions":sessions.iter().map(|s| json!({
                "sessionId": s.id, "title": s.title, "harness": s.provider, "project": s.cwd,
                "updatedAt": s.updated_at,
            })).collect::<Vec<_>>()}))
        }
        "read" => {
            let session = number(&map, "session")?.ok_or("read needs --session")?;
            let limit = number(&map, "limit")?.unwrap_or(6).clamp(1, 100) as usize;
            let max = number(&map, "max-chars")?
                .unwrap_or(4_000)
                .clamp(200, 100_000) as usize;
            let store = crate::store::Store::read_monocode(database)?;
            let rows = store.load(session)?.rows;
            let mut messages: Vec<(String, String)> = Vec::new();
            for row in rows {
                if !matches!(row.role.as_str(), "user" | "assistant") {
                    continue;
                }
                match messages.last_mut() {
                    Some((role, text)) if *role == row.role && !row.first => {
                        text.push_str(&row.text)
                    }
                    _ => messages.push((row.role.clone(), row.text.clone())),
                }
            }
            let skip = messages.len().saturating_sub(limit);
            Ok(
                json!({"ok":true,"sessionId":session,"messages":messages.into_iter().skip(skip).map(|(role,text)| json!({
                "role": role, "text": crate::response::limit(text.trim(), max),
            })).collect::<Vec<_>>()}),
            )
        }
        "help" | "--help" | "-h" => Ok(json!({"ok":true,"usage":USAGE})),
        _ => Err(USAGE.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn requests_are_private_ordered_and_finished_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("inbox");
        let first = submit_in(
            &root,
            Request {
                action: "send".into(),
                session: Some(7),
                text: "hi".into(),
                created_at: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let second = submit_in(
            &root,
            Request {
                action: "start".into(),
                project: Some("/p".into()),
                text: "go".into(),
                created_at: 2,
                ..Default::default()
            },
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&root.join("pending")), 0o700);
            assert_eq!(
                mode(&root.join("pending").join(format!("{first}.json"))),
                0o600
            );
        }
        let items = pending_in(&root);
        assert_eq!(
            items.iter().map(|(_, r)| r.id.clone()).collect::<Vec<_>>(),
            vec![first.clone(), second]
        );
        finish_in(
            &root,
            &items[0].0,
            &Outcome {
                id: first.clone(),
                ok: true,
                session_id: Some(7),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(pending_in(&root).len(), 1);
        assert_eq!(outcome_in(&root, &first).unwrap().session_id, Some(7));
    }
    #[test]
    fn invalid_requests_are_rejected_before_queueing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("inbox");
        for request in [
            Request {
                action: "send".into(),
                text: "x".into(),
                ..Default::default()
            },
            Request {
                action: "start".into(),
                text: "x".into(),
                ..Default::default()
            },
            Request {
                action: "send".into(),
                session: Some(1),
                text: "  ".into(),
                ..Default::default()
            },
            Request {
                action: "delete".into(),
                session: Some(1),
                text: "x".into(),
                ..Default::default()
            },
        ] {
            assert!(submit_in(&root, request).is_err());
        }
        assert!(pending_in(&root).is_empty());
    }
    #[test]
    fn cli_queues_without_a_running_app_and_labels_the_sender() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("inbox");
        let db = dir.path().join("missing.db");
        let value = client_in(
            &root,
            &db,
            &args(&[
                "send",
                "--session",
                "42",
                "--text",
                "status?",
                "--from",
                "Grok Bot",
                "--wait",
                "0",
            ]),
        )
        .unwrap();
        assert_eq!(value["queued"], true);
        let (_, request) = pending_in(&root).pop().unwrap();
        assert_eq!(request.session, Some(42));
        assert_eq!(message(&request), "[From Grok Bot]\nstatus?");
        let id = value["requestId"].as_str().unwrap();
        assert_eq!(
            client_in(&root, &db, &args(&["status", "--id", id])).unwrap()["queued"],
            true
        );
        assert!(client_in(
            &root,
            &db,
            &args(&["send", "--session", "x", "--text", "a"])
        )
        .is_err());
    }
}
