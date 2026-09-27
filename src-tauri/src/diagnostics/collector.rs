use super::OperationContext;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use std::{
    sync::{
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    thread,
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

const MAX_RECORDS: usize = 5_000;
// Accommodates every retained pre-initialization record without blocking the startup caller.
const PERSISTENCE_QUEUE_CAPACITY: usize = MAX_RECORDS;
const PERSISTENCE_BATCH_SIZE: usize = 100;
const MAX_FIELDS: usize = 32;
const MAX_FIELD_BYTES: usize = 2_048;
const EVENTS: &[&str] = &[
    "app.started",
    "app.ready",
    "app.setup_failed",
    "storage.open",
    "storage.migrate",
    "storage.read",
    "storage.write",
    "shortcut.registration",
    "shortcut.triggered",
    "shortcut.skipped",
    "permission.checked",
    "permission.changed",
    "capture.started",
    "capture.finished",
    "capture.accessibility",
    "capture.clipboard",
    "capture.draft",
    "capture.backup",
    "capture.window",
    "capture.received",
    "capture.save.started",
    "capture.save.finished",
    "capture.operation_mismatch",
    "capture.references",
    "capture.note_action",
    "capture.archive",
    "workspace.open",
    "workspace.watch",
    "note.open",
    "note.create",
    "note.save.started",
    "note.save.finished",
    "note.action_blocked",
    "search.load",
    "settings.change",
    "external.open",
    "editor.failed",
    "runtime.failed",
    "runtime.mount",
    "diagnostics.collection_failed",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    id: String,
    timestamp: u64,
    level: String,
    event: String,
    origin: String,
    session_id: String,
    operation_id: Option<String>,
    fields: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingRecord {
    level: String,
    event: String,
    operation: Option<OperationContext>,
    #[serde(default)]
    fields: Value,
    timestamp: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotSection {
    collected_at: u64,
    fields: Value,
}

struct Collector {
    session_id: String,
    records: VecDeque<LogRecord>,
    persistence: Option<Persistence>,
    storage_error: Option<String>,
    sections: BTreeMap<String, SnapshotSection>,
    replies: BTreeMap<String, String>,
}

static COLLECTOR: OnceLock<Mutex<Collector>> = OnceLock::new();
fn collector() -> &'static Mutex<Collector> {
    COLLECTOR.get_or_init(|| {
        Mutex::new(Collector {
            session_id: Uuid::new_v4().to_string(),
            records: VecDeque::new(),
            persistence: None,
            storage_error: None,
            sections: BTreeMap::new(),
            replies: BTreeMap::new(),
        })
    })
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// Only deliberately selected metadata may enter storage or a debug report.
/// In particular, exception messages and arbitrary nested objects are discarded.
fn safe_fields(value: &Value) -> Value {
    let mut out = Map::new();
    let Some(fields) = value.as_object() else {
        return Value::Object(out);
    };
    for (key, value) in fields.iter().take(100) {
        if out.len() >= MAX_FIELDS {
            break;
        }
        let allowed = match value {
            Value::Null => is_state_key(key),
            Value::Bool(_) => {
                is_state_key(key)
                    || matches!(
                        key.as_str(),
                        "sameOperation"
                            | "sourceAvailable"
                            | "committed"
                            | "cleanedUp"
                            | "trusted"
                            | "accessibilityTrusted"
                            | "registered"
                            | "recording"
                            | "inProgress"
                            | "present"
                            | "transient"
                            | "hasSelection"
                            | "hasNote"
                            | "hasText"
                            | "hasTitle"
                            | "hasUrl"
                            | "permissionRequired"
                            | "hasError"
                            | "sourceFrontmost"
                            | "restored"
                            | "stateKnown"
                            | "requestedEnabled"
                            | "actualEnabled"
                            | "enabled"
                            | "markdownSaved"
                            | "newerEditPending"
                            | "bundled"
                            | "debugBuild"
                            | "loginArgumentPresent"
                            | "supported"
                            | "success"
                            | "available"
                            | "focusedWindow"
                            | "focusedElement"
                            | "changed"
                            | "copyPosted"
                            | "clipboardChanged"
                            | "hasSelectedDocument"
                            | "usedBackup"
                            | "retry"
                            | "fileCreated"
                            | "previouslyReady"
                            | "usedSelectedEditorSnapshot"
                            | "captureWarningPresent"
                            | "dirtyAtRemoval"
                            | "sameDraft"
                            | "markdownCreated"
                            | "persisted"
                            | "tagsAvailable"
                            | "captureReferencesAvailable"
                            | "native"
                            | "loading"
                            | "ready"
                            | "shortcutAvailable"
                            | "hasShortcutError"
                            | "folderSelected"
                            | "choosingFolder"
                            | "logsVisible"
                    )
            }
            Value::Number(n) => {
                (key.ends_with("Count")
                    || key.ends_with("Ms")
                    || key.ends_with("At")
                    || matches!(
                        key.as_str(),
                        "count"
                            | "fromVersion"
                            | "toVersion"
                            | "schemaVersion"
                            | "queueDepth"
                            | "parentDepth"
                            | "axCode"
                            | "requestedReads"
                            | "successfulReads"
                            | "failedReads"
                            | "cacheHits"
                            | "flushIterations"
                    ))
                    && n.as_f64()
                        .is_some_and(|n| n.is_finite() && n.abs() <= 9_007_199_254_740_991.0)
            }
            Value::String(s) => safe_string(key, s),
            _ => false,
        };
        if allowed {
            out.insert(key.clone(), value.clone());
        }
    }
    while serde_json::to_vec(&out).map_or(true, |v| v.len() > MAX_FIELD_BYTES) {
        let Some(key) = out.keys().next_back().cloned() else {
            break;
        };
        out.remove(&key);
    }
    Value::Object(out)
}
fn is_state_key(key: &str) -> bool {
    matches!(
        key,
        "dirty"
            | "pendingSaveCount"
            | "lastSaveAt"
            | "lastTriggerAt"
            | "draftId"
            | "captureId"
            | "operationId"
            | "noteId"
            | "workspaceId"
            | "status"
            | "fileCount"
            | "initialized"
            | "present"
            | "inProgress"
            | "enabled"
            | "accessibilityTrusted"
    )
}
fn safe_string(key: &str, s: &str) -> bool {
    if s.len() > 128 {
        return false;
    }
    match key {
        "draftId" | "captureId" | "operationId" => {
            Uuid::parse_str(s).is_ok()
                || s.strip_prefix("transient-error-")
                    .is_some_and(|id| Uuid::parse_str(id).is_ok())
        }
        "noteId" | "workspaceId" => {
            s.len() <= 48 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }
        "sourceApp" | "bundleId" => {
            s.contains('.')
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
        }
        "shortcut" | "requestedShortcut" | "previousShortcut" => {
            s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+_-".contains(&b))
        }
        "event" => EVENTS.contains(&s),
        "phase" | "status" | "outcome" | "reason" | "errorCode" | "action" | "stage" | "method"
        | "captureMethod" | "trigger" | "source" | "surface" | "section" | "boundary"
        | "scheme" | "mode" | "setting" | "destinationKind" | "cancelReason" | "skipReason"
        | "storage" | "attribute" | "valueType" | "errorClass" | "os" | "arch" | "appVersion"
        | "buildId" | "osVersion" | "origin" | "window" | "themeId" | "previousThemeId"
        | "permissionStatus" => {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        }
        _ => false,
    }
}

pub fn error_code(error: impl std::fmt::Display) -> &'static str {
    let s = error.to_string().to_ascii_lowercase();
    if s.contains("not allowed") || s.contains("permission") || s.contains("access denied") {
        "PERMISSION_DENIED"
    } else if s.contains("database is locked") || s.contains("database is busy") {
        "SQLITE_BUSY"
    } else if s.contains("disk") && (s.contains("full") || s.contains("space")) {
        "DISK_FULL"
    } else if s.contains("read-only") || s.contains("readonly") {
        "READ_ONLY"
    } else if s.contains("no such file") || s.contains("not found") {
        "NOT_FOUND"
    } else if s.contains("corrupt") || s.contains("malformed") {
        "CORRUPT_DATA"
    } else if s.contains("timeout") || s.contains("timed out") {
        "TIMEOUT"
    } else if s.contains("operation") && s.contains("match") {
        "OPERATION_MISMATCH"
    } else if s.contains("poison") {
        "STATE_UNAVAILABLE"
    } else {
        "UNEXPECTED_ERROR"
    }
}

#[derive(Default)]
struct StorageHealth {
    pending_count: usize,
    dropped_count: u64,
    error: Option<String>,
    writer_running: bool,
}

struct Persistence {
    sender: SyncSender<LogRecord>,
    health: Arc<Mutex<StorageHealth>>,
}

/// The caller may hold the collector lock. Queueing never waits for SQLite or queue space.
fn append(c: &mut Collector, record: LogRecord) {
    c.records.push_back(record.clone());
    while c.records.len() > MAX_RECORDS {
        c.records.pop_front();
    }
    if let Some(persistence) = &c.persistence {
        // Increment while holding health so a fast worker cannot decrement first.
        if let Ok(mut health) = persistence.health.lock() {
            match persistence.sender.try_send(record) {
                Ok(()) => health.pending_count += 1,
                Err(TrySendError::Full(_)) => {
                    health.dropped_count = health.dropped_count.saturating_add(1);
                    health.error = Some("PERSISTENCE_QUEUE_FULL".to_owned());
                }
                Err(TrySendError::Disconnected(_)) => {
                    health.dropped_count = health.dropped_count.saturating_add(1);
                    health.writer_running = false;
                    health.error = Some("PERSISTENCE_WRITER_STOPPED".to_owned());
                }
            }
        }
    }
}

fn persist_batch(connection: &mut Connection, records: &[LogRecord]) -> Result<(), String> {
    let transaction = connection.transaction().map_err(error_code)?;
    {
        let mut insert = transaction
            .prepare("INSERT INTO diagnostic_events (record) VALUES (?1)")
            .map_err(error_code)?;
        for record in records {
            let serialized = serde_json::to_string(record).map_err(|_| "SERIALIZATION_FAILED")?;
            insert.execute([serialized]).map_err(error_code)?;
        }
    }
    transaction.execute("DELETE FROM diagnostic_events WHERE id <= (SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT 1 OFFSET ?1)", [MAX_RECORDS as i64]).map_err(error_code)?;
    transaction
        .commit()
        .map_err(|error| error_code(error).to_owned())
}

fn persistence_worker(
    mut connection: Connection,
    receiver: Receiver<LogRecord>,
    health: Arc<Mutex<StorageHealth>>,
) {
    while let Ok(first) = receiver.recv() {
        let mut batch = Vec::with_capacity(PERSISTENCE_BATCH_SIZE);
        batch.push(first);
        let deadline = Instant::now() + Duration::from_millis(20);
        while batch.len() < PERSISTENCE_BATCH_SIZE {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receiver.recv_timeout(remaining) {
                Ok(record) => batch.push(record),
                Err(_) => break,
            }
        }
        // Retry this bounded batch; queue and in-memory retention stay bounded during disk failures.
        let mut outcome = Err("PERSISTENCE_WRITE_FAILED".to_owned());
        for delay in [0, 25, 100] {
            if delay > 0 {
                thread::sleep(Duration::from_millis(delay));
            }
            outcome = persist_batch(&mut connection, &batch);
            if outcome.is_ok() {
                break;
            }
            if let Ok(mut state) = health.lock() {
                state.error = outcome.as_ref().err().cloned();
            }
        }
        if let Ok(mut state) = health.lock() {
            state.pending_count = state.pending_count.saturating_sub(batch.len());
            match outcome {
                Ok(()) => state.error = None,
                Err(error) => {
                    state.error = Some(error);
                    state.dropped_count = state.dropped_count.saturating_add(batch.len() as u64);
                }
            }
        }
    }
    if let Ok(mut state) = health.lock() {
        state.writer_running = false;
    }
}

fn start_persistence(connection: Connection) -> Result<Persistence, String> {
    let (sender, receiver) = mpsc::sync_channel(PERSISTENCE_QUEUE_CAPACITY);
    let health = Arc::new(Mutex::new(StorageHealth {
        writer_running: true,
        ..StorageHealth::default()
    }));
    let worker_health = health.clone();
    thread::Builder::new()
        .name("diary-diagnostics".to_owned())
        .spawn(move || persistence_worker(connection, receiver, worker_health))
        .map_err(|_| "PERSISTENCE_WORKER_START_FAILED".to_owned())?;
    Ok(Persistence { sender, health })
}

fn storage_error(c: &Collector) -> Option<String> {
    if let Some(error) = &c.storage_error {
        return Some(error.clone());
    }
    let persistence = c.persistence.as_ref()?;
    match persistence.health.lock() {
        Ok(health) => health
            .error
            .clone()
            .or_else(|| (!health.writer_running).then(|| "PERSISTENCE_WRITER_STOPPED".to_owned()))
            .or_else(|| (health.dropped_count > 0).then(|| "PERSISTENCE_DROPPED".to_owned())),
        Err(_) => Some("PERSISTENCE_STATE_UNAVAILABLE".to_owned()),
    }
}

fn persistence_snapshot(c: &Collector) -> Value {
    let Some(persistence) = &c.persistence else {
        return json!({"available": false, "pendingCount": 0, "droppedCount": 0, "storageError": c.storage_error});
    };
    match persistence.health.lock() {
        Ok(health) => {
            let error = health
                .error
                .clone()
                .or_else(|| {
                    (!health.writer_running).then(|| "PERSISTENCE_WRITER_STOPPED".to_owned())
                })
                .or_else(|| (health.dropped_count > 0).then(|| "PERSISTENCE_DROPPED".to_owned()));
            json!({"available": health.writer_running, "pendingCount": health.pending_count,
                "droppedCount": health.dropped_count, "storageError": error})
        }
        Err(_) => json!({"available": false, "storageError": "PERSISTENCE_STATE_UNAVAILABLE"}),
    }
}

fn wait_for_persistence(health: &Arc<Mutex<StorageHealth>>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match health.lock() {
            Ok(health) if health.pending_count == 0 => return health.dropped_count == 0,
            Err(_) => return false,
            _ => {}
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

/// A bounded shutdown drain. No collector lock is held while waiting for the disk worker.
pub fn flush_persistence(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(c) = collector().try_lock() {
            let health = c.persistence.as_ref().map(|p| p.health.clone());
            drop(c);
            return health.is_some_and(|health| {
                wait_for_persistence(&health, deadline.saturating_duration_since(Instant::now()))
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        thread::sleep(remaining.min(Duration::from_millis(5)));
    }
}

fn record_from(
    origin: &str,
    level: &str,
    event: &str,
    operation: Option<&OperationContext>,
    fields: Value,
    timestamp: Option<u64>,
) {
    if !EVENTS.contains(&event) || !matches!(level, "debug" | "info" | "warn" | "error") {
        return;
    }
    let Ok(mut c) = collector().lock() else {
        return;
    };
    let record = LogRecord {
        id: Uuid::new_v4().to_string(),
        timestamp: timestamp
            .filter(|t| t.abs_diff(now()) < 300_000)
            .unwrap_or_else(now),
        level: level.to_owned(),
        event: event.to_owned(),
        origin: origin.to_owned(),
        session_id: c.session_id.clone(),
        operation_id: operation.map(|o| o.operation_id.to_string()),
        fields: safe_fields(&fields),
    };
    append(&mut c, record);
}
pub fn record(level: &str, event: &str, operation: Option<&OperationContext>, fields: Value) {
    record_from("rust", level, event, operation, fields, None);
}

fn open_storage(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(error_code)?;
    }
    let connection = Connection::open(path).map_err(error_code)?;
    connection
        .busy_timeout(Duration::from_millis(100))
        .map_err(error_code)?;
    connection.execute_batch("PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS diagnostic_events (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL);").map_err(error_code)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(error_code)?;
    }
    Ok(connection)
}

fn load_history(connection: &Connection) -> Result<VecDeque<LogRecord>, String> {
    let mut statement = connection.prepare("SELECT record FROM (SELECT id, record FROM diagnostic_events ORDER BY id DESC LIMIT ?1) ORDER BY id").map_err(error_code)?;
    let rows = statement
        .query_map([MAX_RECORDS as i64], |row| row.get::<_, String>(0))
        .map_err(error_code)?;
    let mut records = VecDeque::new();
    for row in rows {
        let text = row.map_err(error_code)?;
        if let Ok(mut record) = serde_json::from_str::<LogRecord>(&text) {
            // Revalidate historical data, including records modified outside the app.
            if !EVENTS.contains(&record.event.as_str())
                || !matches!(record.origin.as_str(), "rust" | "main" | "capture")
                || !matches!(record.level.as_str(), "debug" | "info" | "warn" | "error")
                || Uuid::parse_str(&record.id).is_err()
                || Uuid::parse_str(&record.session_id).is_err()
            {
                continue;
            }
            record.fields = safe_fields(&record.fields);
            record.operation_id = record.operation_id.filter(|id| Uuid::parse_str(id).is_ok());
            records.push_back(record);
        }
    }
    Ok(records)
}

fn install_persistence(c: &mut Collector, history: VecDeque<LogRecord>, persistence: Persistence) {
    let pending = std::mem::replace(&mut c.records, history);
    c.persistence = Some(persistence);
    c.storage_error = None;
    for record in pending {
        append(c, record);
    }
}

pub fn initialize_storage(path: &Path) {
    // Open, migrate, and load SQLite before taking the shared logger lock.
    let result = (|| {
        let connection = open_storage(path)?;
        let history = load_history(&connection)?;
        let persistence = start_persistence(connection)?;
        Ok::<_, String>((history, persistence))
    })();
    let Ok(mut c) = collector().lock() else {
        return;
    };
    match result {
        Ok((history, persistence)) => install_persistence(&mut c, history, persistence),
        Err(error) => c.storage_error = Some(error),
    }
}

fn update_section(c: &mut Collector, key: String, fields: Value) {
    let section = c.sections.entry(key).or_insert_with(|| SnapshotSection {
        collected_at: now(),
        fields: json!({}),
    });
    if let (Some(old), Some(new)) = (
        section.fields.as_object_mut(),
        safe_fields(&fields).as_object(),
    ) {
        old.extend(new.clone());
    }
    section.collected_at = now();
}
pub fn native_state(section: &str, fields: Value) {
    if section.len() > 48 || !section.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return;
    }
    if let Ok(mut c) = collector().lock() {
        update_section(&mut c, format!("rust.{section}"), fields);
    }
}

#[tauri::command]
pub fn record_diagnostics(window: WebviewWindow, entries: Vec<IncomingRecord>) {
    let origin = window.label();
    if !matches!(origin, "main" | "capture") {
        return;
    }
    for entry in entries.into_iter().take(100) {
        record_from(
            origin,
            &entry.level,
            &entry.event,
            entry.operation.as_ref(),
            entry.fields,
            entry.timestamp,
        );
    }
}
#[tauri::command]
pub fn publish_diagnostic_state(
    window: WebviewWindow,
    sections: BTreeMap<String, Value>,
    request_id: Option<String>,
) {
    if !matches!(window.label(), "main" | "capture") {
        return;
    }
    if let Ok(mut c) = collector().lock() {
        for (section, fields) in sections.into_iter().take(12) {
            if section.len() <= 48 && section.bytes().all(|b| b.is_ascii_alphanumeric()) {
                update_section(&mut c, format!("{}.{section}", window.label()), fields);
            }
        }
        if let Some(id) = request_id.filter(|id| Uuid::parse_str(id).is_ok()) {
            c.replies.insert(window.label().to_owned(), id);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    records: Vec<LogRecord>,
    total: usize,
    retained_limit: usize,
    storage_error: Option<String>,
}
#[tauri::command]
pub fn get_diagnostic_logs(include_debug: bool) -> LogPage {
    match collector().lock() {
        Ok(c) => {
            let mut records: Vec<_> = c
                .records
                .iter()
                .filter(|r| include_debug || r.level != "debug")
                .cloned()
                .collect();
            records.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
            records.truncate(300);
            LogPage {
                records,
                total: c.records.len(),
                retained_limit: MAX_RECORDS,
                storage_error: storage_error(&c),
            }
        }
        Err(_) => LogPage {
            records: vec![],
            total: 0,
            retained_limit: MAX_RECORDS,
            storage_error: Some("STATE_UNAVAILABLE".into()),
        },
    }
}

pub fn install_panic_reporting() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Never acquire the logger recursively if a panic occurred while logging.
        if let Ok(mut c) = collector().try_lock() {
            let record = LogRecord {
                id: Uuid::new_v4().to_string(),
                timestamp: now(),
                level: "error".into(),
                event: "runtime.failed".into(),
                origin: "rust".into(),
                session_id: c.session_id.clone(),
                operation_id: None,
                fields: json!({"boundary":"panic","errorCode":"RUST_PANIC"}),
            };
            append(&mut c, record);
        }
        previous(info);
    }));
}

fn comparison(a: Option<&Value>, b: Option<&Value>) -> &'static str {
    match (a, b) {
        (Some(Value::Null), Some(Value::Null)) => "not_applicable",
        (Some(Value::String(_)), Some(Value::Null))
        | (Some(Value::Null), Some(Value::String(_))) => "mismatch",
        (Some(Value::String(a)), Some(Value::String(b))) => {
            if a == b {
                "match"
            } else {
                "mismatch"
            }
        }
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => {
            if a == b {
                "match"
            } else {
                "mismatch"
            }
        }
        _ => "unknown",
    }
}
async fn build_report(app: &AppHandle) -> Result<String, String> {
    let request_id = Uuid::new_v4().to_string();
    let requested_at = now();
    let expected: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|w| matches!(w.as_str(), "main" | "capture"))
        .cloned()
        .collect();
    let sent = app
        .emit("diagnostics-snapshot-request", &request_id)
        .is_ok();
    if !sent {
        record(
            "warn",
            "diagnostics.collection_failed",
            None,
            json!({"section":"frontend","errorCode":"SNAPSHOT_REQUEST_FAILED"}),
        );
    }
    // Yield while each webview flushes its events and acknowledges fresh state.
    if sent {
        for _ in 0..20 {
            let complete = collector()
                .lock()
                .map(|c| {
                    expected
                        .iter()
                        .all(|w| c.replies.get(w) == Some(&request_id))
                })
                .unwrap_or(false);
            if complete {
                break;
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(50)))
                .await
                .map_err(|_| "Could not collect current app state.".to_owned())?;
        }
    }
    crate::capture::refresh_diagnostic_state(app);
    crate::launch_at_login::refresh_diagnostic_state(app);
    let missing = {
        let c = collector()
            .lock()
            .map_err(|_| "Diagnostics are unavailable.".to_owned())?;
        expected
            .iter()
            .filter(|w| c.replies.get(*w) != Some(&request_id))
            .cloned()
            .collect::<Vec<_>>()
    };
    for window in &missing {
        record(
            "warn",
            "diagnostics.collection_failed",
            None,
            json!({"section":window,"errorCode":"SNAPSHOT_UNAVAILABLE"}),
        );
    }
    let c = collector()
        .lock()
        .map_err(|_| "Diagnostics are unavailable.".to_owned())?;
    let fresh_section = |name: &str| {
        c.sections.get(name).filter(|s| {
            s.collected_at >= requested_at
                && s.fields.get("stateKnown") != Some(&Value::Bool(false))
        })
    };
    let backend = fresh_section("rust.captureDraft")
        .filter(|s| s.fields.get("available") != Some(&Value::Bool(false)));
    let frontend = fresh_section("capture.captureFrontend")
        .filter(|_| !missing.iter().any(|s| s == "capture"));
    let field = |section: Option<&SnapshotSection>, key: &str| {
        section.and_then(|s| s.fields.get(key)).cloned()
    };
    let draft_match = comparison(
        field(backend, "draftId").as_ref(),
        field(frontend, "draftId").as_ref(),
    );
    let operation_match = comparison(
        field(backend, "operationId").as_ref(),
        field(frontend, "operationId").as_ref(),
    );
    let permission = fresh_section("rust.permission");
    let shortcut = fresh_section("rust.captureShortcut");
    let capture = fresh_section("rust.capture");
    let mut blockers = Vec::new();
    let trusted = field(permission, "accessibilityTrusted").and_then(|v| v.as_bool());
    let registered = field(shortcut, "registered").and_then(|v| v.as_bool());
    let recording = field(shortcut, "recording").and_then(|v| v.as_bool());
    let in_progress = field(capture, "inProgress").and_then(|v| v.as_bool());
    if trusted == Some(false) {
        blockers.push("accessibility_not_granted");
    }
    if registered == Some(false) {
        blockers.push("shortcut_not_registered");
    }
    if recording == Some(true) {
        blockers.push("shortcut_recorder_active");
    }
    if in_progress == Some(true) {
        blockers.push("capture_in_progress");
    }
    let readiness = if !blockers.is_empty() {
        "blocked"
    } else if [trusted, registered, recording, in_progress]
        .iter()
        .any(Option::is_none)
    {
        "unknown"
    } else {
        "ready"
    };
    let unavailable_sections: Vec<&str> = [
        "rust.capture",
        "rust.captureShortcut",
        "rust.captureDraft",
        "rust.permission",
        "rust.launchAtLogin",
    ]
    .into_iter()
    .filter(|name| {
        fresh_section(name).is_none() || (*name == "rust.captureDraft" && backend.is_none())
    })
    .collect();
    let recent_ui_permission = c.sections.get("main.capturePermission").filter(|s| {
        s.fields
            .get("checkedAt")
            .and_then(Value::as_u64)
            .is_some_and(|t| t >= requested_at.saturating_sub(2500))
    });
    let permission_match = comparison(
        field(permission, "accessibilityTrusted").as_ref(),
        field(recent_ui_permission, "accessibilityTrusted").as_ref(),
    );
    let mut events: Vec<_> = c.records.iter().cloned().collect();
    events.sort_by_key(|e| e.timestamp);
    let report = json!({
        "reportVersion": 1, "generatedAt": now(), "sessionId":c.session_id,
        "retention":{"maximumRecords":MAX_RECORDS,"retainedRecords":c.records.len()},
        "collection":{"requestedAt":requested_at,"unavailableWindows":missing,"unavailableSections":unavailable_sections,"persistence":persistence_snapshot(&c)},
        "state":c.sections,
        "checks":{"activeDraftIdentity":draft_match,"activeOperationIdentity":operation_match,"recentPermissionAgreement":permission_match,
            "contextCapture":{"status":readiness,"blockingReasons":blockers}},
        "events":events,
    });
    serde_json::to_string_pretty(&report)
        .map(|s| format!("=== BILBO DEBUG REPORT ===\n{s}\n"))
        .map_err(|_| "Could not format the debug report.".to_owned())
}

#[tauri::command]
pub async fn copy_debug_report(app: AppHandle) -> Result<(), String> {
    let report = build_report(&app).await?;
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            use objc2::rc::autoreleasepool;
            use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
            use objc2_foundation::NSString;
            let result = autoreleasepool(|_| {
                let clipboard = NSPasteboard::generalPasteboard();
                clipboard.clearContents();
                if clipboard.setString_forType(&NSString::from_str(&report), unsafe {
                    NSPasteboardTypeString
                }) {
                    Ok(())
                } else {
                    Err("Could not copy the debug report.".to_owned())
                }
            });
            let _ = tx.send(result);
        })
        .map_err(|_| "Could not access the clipboard.".to_owned())?;
        return tauri::async_runtime::spawn_blocking(move || {
            rx.recv()
                .map_err(|_| "Could not access the clipboard.".to_owned())
        })
        .await
        .map_err(|_| "Could not copy the debug report.".to_owned())??;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = report;
        Err("Copying reports is currently supported on macOS.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sensitive_values_and_nested_payloads_never_reach_records() {
        let fields = safe_fields(
            &json!({"note":"private","message":"secret","sourceUrl":"https://private.example", "path":"/Users/person/diary", "reason":"secret@example.com", "sourceApp":"com.apple.Safari", "errorCode":"SQLITE_BUSY", "hasSelection":true,"durationMs":12,"details":{"token":"secret"}}),
        );
        assert_eq!(
            fields,
            json!({"sourceApp":"com.apple.Safari","errorCode":"SQLITE_BUSY","hasSelection":true,"durationMs":12})
        );
        assert_eq!(
            safe_fields(
                &json!({"draftId":"private text","operationId":"bad","noteId":"/private/file"})
            ),
            json!({})
        );
    }
    #[test]
    fn native_stage_outcomes_survive_metadata_sanitization() {
        let fields = json!({"sameOperation": true, "sourceAvailable": false, "committed": true, "cleanedUp": false,
            "axCode": -25204, "elapsedMs": 42, "requestedEnabled": true, "actualEnabled": false,
            "phase": "persist_rollback", "storage": "capture", "destinationKind": "capture_source"});
        assert_eq!(safe_fields(&fields), fields);
    }
    #[test]
    fn errors_are_classified_without_returning_their_contents() {
        assert_eq!(
            error_code("open /Users/private/foo not allowed"),
            "PERMISSION_DENIED"
        );
        assert_eq!(error_code("database is locked"), "SQLITE_BUSY");
        assert_eq!(error_code("private novel error"), "UNEXPECTED_ERROR");
    }
    fn test_collector() -> Collector {
        Collector {
            session_id: Uuid::new_v4().to_string(),
            records: VecDeque::new(),
            persistence: None,
            storage_error: None,
            sections: BTreeMap::new(),
            replies: BTreeMap::new(),
        }
    }
    fn test_record(timestamp: u64) -> LogRecord {
        LogRecord {
            id: Uuid::new_v4().to_string(),
            timestamp,
            level: "info".into(),
            event: "app.ready".into(),
            origin: "rust".into(),
            session_id: Uuid::new_v4().to_string(),
            operation_id: None,
            fields: json!({}),
        }
    }
    #[test]
    fn retention_is_bounded_and_ordered_on_disk() {
        let mut c = test_collector();
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE diagnostic_events (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL)").unwrap();
        let records: Vec<_> = (0..MAX_RECORDS + 3)
            .map(|n| test_record(n as u64))
            .collect();
        for batch in records.chunks(PERSISTENCE_BATCH_SIZE) {
            persist_batch(&mut connection, batch).unwrap();
        }
        for record in records {
            append(&mut c, record);
        }
        assert_eq!(c.records.len(), MAX_RECORDS);
        assert_eq!(c.records.front().unwrap().timestamp, 3);
        let history = load_history(&connection).unwrap();
        assert_eq!(history.len(), MAX_RECORDS);
        assert_eq!(history.front().unwrap().timestamp, 3);
    }
    #[test]
    fn restart_recovers_history_and_persists_records_emitted_before_initialization() {
        let path =
            std::env::temp_dir().join(format!("diary-diagnostics-test-{}.sqlite", Uuid::new_v4()));
        let mut connection = open_storage(&path).unwrap();
        persist_batch(&mut connection, &[test_record(1)]).unwrap();
        let history = load_history(&connection).unwrap();
        let mut c = test_collector();
        append(&mut c, test_record(2));
        install_persistence(&mut c, history, start_persistence(connection).unwrap());
        assert_eq!(
            c.records.iter().map(|r| r.timestamp).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(wait_for_persistence(
            &c.persistence.as_ref().unwrap().health,
            Duration::from_secs(2)
        ));
        let reopened = open_storage(&path).unwrap();
        assert_eq!(
            load_history(&reopened)
                .unwrap()
                .iter()
                .map(|r| r.timestamp)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        drop(reopened);
        drop(c);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn failed_persistence_keeps_memory_and_reports_dropped_records() {
        // A missing table simulates a persistent writer failure, without changing global logger state.
        let connection = Connection::open_in_memory().unwrap();
        let mut c = test_collector();
        c.persistence = Some(start_persistence(connection).unwrap());
        append(&mut c, test_record(1));
        assert!(!wait_for_persistence(
            &c.persistence.as_ref().unwrap().health,
            Duration::from_secs(2)
        ));
        assert_eq!(c.records.len(), 1);
        assert!(storage_error(&c).is_some());
        let snapshot = persistence_snapshot(&c);
        assert_eq!(snapshot["pendingCount"], 0);
        assert_eq!(snapshot["droppedCount"], 1);
    }
    #[test]
    fn bounded_queue_never_discards_the_in_memory_record() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let health = Arc::new(Mutex::new(StorageHealth {
            writer_running: true,
            ..Default::default()
        }));
        let mut c = test_collector();
        c.persistence = Some(Persistence { sender, health });
        append(&mut c, test_record(1));
        append(&mut c, test_record(2));
        assert_eq!(c.records.len(), 2);
        assert_eq!(persistence_snapshot(&c)["pendingCount"], 1);
        assert_eq!(persistence_snapshot(&c)["droppedCount"], 1);
        assert_eq!(storage_error(&c).as_deref(), Some("PERSISTENCE_QUEUE_FULL"));
    }
    #[test]
    fn enqueue_does_not_wait_for_a_locked_database() {
        let path =
            std::env::temp_dir().join(format!("diary-diagnostics-busy-{}.sqlite", Uuid::new_v4()));
        let writer = open_storage(&path).unwrap();
        writer.busy_timeout(Duration::from_secs(2)).unwrap();
        let locker = open_storage(&path).unwrap();
        locker.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let persistence = start_persistence(writer).unwrap();
        let health = persistence.health.clone();
        let (done_sender, done_receiver) = mpsc::channel();
        let producer = thread::spawn(move || {
            let c = Mutex::new(test_collector());
            let mut c = c.lock().unwrap();
            c.persistence = Some(persistence);
            append(&mut c, test_record(1));
            done_sender.send(c.records.len()).unwrap();
        });
        assert_eq!(
            done_receiver
                .recv_timeout(Duration::from_millis(500))
                .unwrap(),
            1
        );
        locker.execute_batch("ROLLBACK").unwrap();
        producer.join().unwrap();
        assert!(wait_for_persistence(&health, Duration::from_secs(2)));
        drop(locker);
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn snapshot_comparison_does_not_treat_missing_as_matching() {
        assert_eq!(comparison(None, None), "unknown");
        assert_eq!(comparison(None, Some(&json!(null))), "unknown");
        assert_eq!(
            comparison(Some(&json!(null)), Some(&json!(null))),
            "not_applicable"
        );
        assert_eq!(
            comparison(Some(&json!(null)), Some(&json!(Uuid::new_v4().to_string()))),
            "mismatch"
        );
        assert_eq!(
            comparison(Some(&json!(Uuid::new_v4().to_string())), Some(&json!(null))),
            "mismatch"
        );
        assert_eq!(comparison(Some(&json!("a")), Some(&json!("b"))), "mismatch");
        assert_eq!(comparison(Some(&json!("a")), Some(&json!("a"))), "match");
    }
}
