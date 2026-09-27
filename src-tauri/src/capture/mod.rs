mod models;
mod platform;
mod shortcut;
mod store;

use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_opener::OpenerExt;

use crate::diagnostics::{error_code, native_state, record, OperationContext};
use serde_json::{json, Value};

pub use models::{
    Capture, CaptureDraft, CapturePermissionStatus, CaptureReferenceIndexEntry,
    CaptureShortcutStatus,
};
use models::{CaptureMethod, NewDraft};
use shortcut::{change_shortcut, validate_shortcut, ShortcutRegistry, DEFAULT_SHORTCUT};
use store::CaptureStore;

const CAPTURE_CLOSE_REQUESTED_EVENT: &str = "capture-close-requested";
const CAPTURE_SHORTCUT_CHANGED_EVENT: &str = "capture-shortcut-changed";

pub struct CaptureState {
    store: CaptureStore,
    capture_in_progress: Arc<AtomicBool>,
    app_update_active: Mutex<bool>,
    shortcut_status: Mutex<CaptureShortcutStatus>,
    shortcut_operation: Mutex<()>,
    active_shortcut_id: AtomicU32,
    shortcut_recording: AtomicBool,
    transient_error_draft: Mutex<Option<CaptureDraft>>,
}

impl CaptureState {
    pub fn open(database_path: &Path) -> Result<Self, String> {
        let store = CaptureStore::open(database_path).map_err(|error| error.to_string())?;
        let shortcut = store
            .get_shortcut()
            .map_err(|error| {
                record("error", "storage.read", None, json!({"phase": "shortcut_load", "status": "error", "errorCode": error_code(&error)}));
                error.to_string()
            })?
            .and_then(|value| {
                let validated = validate_shortcut(&value);
                if validated.is_err() {
                    record("warn", "shortcut.registration", None, json!({"phase": "saved_preference", "status": "fallback", "reason": "invalid_shortcut"}));
                }
                validated.ok().map(|(canonical, _)| canonical)
            })
            .unwrap_or_else(|| DEFAULT_SHORTCUT.to_owned());
        native_state("capture", json!({"inProgress": false, "operationId": null}));
        native_state(
            "captureShortcut",
            json!({"shortcut": shortcut, "registered": false, "recording": false}),
        );
        Ok(Self {
            store,
            capture_in_progress: Arc::new(AtomicBool::new(false)),
            app_update_active: Mutex::new(false),
            shortcut_status: Mutex::new(CaptureShortcutStatus {
                shortcut,
                available: false,
                error: Some("The capture shortcut has not been registered yet.".to_owned()),
            }),
            shortcut_operation: Mutex::new(()),
            active_shortcut_id: AtomicU32::new(0),
            shortcut_recording: AtomicBool::new(false),
            transient_error_draft: Mutex::new(None),
        })
    }

    fn shortcut_status(&self) -> CaptureShortcutStatus {
        self.shortcut_status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_else(|_| CaptureShortcutStatus {
                shortcut: DEFAULT_SHORTCUT.to_owned(),
                available: false,
                error: Some("The capture shortcut status is unavailable.".to_owned()),
            })
    }

    fn publish_shortcut_status(
        &self,
        app: &AppHandle,
        status: CaptureShortcutStatus,
        operation: Option<&OperationContext>,
    ) {
        if let Ok(mut current) = self.shortcut_status.lock() {
            *current = status.clone();
        }
        native_state(
            "captureShortcut",
            json!({"shortcut": status.shortcut, "registered": self.active_shortcut_id.load(Ordering::Acquire) != 0,
            "available": status.available, "recording": self.shortcut_recording.load(Ordering::Acquire), "hasError": status.error.is_some()}),
        );
        let started = Instant::now();
        let result = app.emit(CAPTURE_SHORTCUT_CHANGED_EVENT, status);
        log_result(
            "shortcut.registration",
            operation,
            "status_emit",
            &result,
            started,
            json!({}),
        );
    }

    fn current_draft(&self) -> Result<Option<CaptureDraft>, String> {
        match self.store.get_draft() {
            Ok(Some(draft)) => Ok(Some(draft)),
            Ok(None) => self
                .transient_error_draft
                .lock()
                .map(|draft| draft.clone())
                .map_err(|_| "The temporary capture draft is unavailable.".to_owned()),
            Err(error) => {
                let transient = self
                    .transient_error_draft
                    .lock()
                    .ok()
                    .and_then(|draft| draft.clone());
                if let Some(draft) = transient {
                    record(
                        "warn",
                        "capture.draft",
                        Some(&draft.operation),
                        json!({"phase": "read_fallback", "status": "fallback", "errorCode": error_code(&error)}),
                    );
                    Ok(Some(draft))
                } else {
                    Err(error.to_string())
                }
            }
        }
    }

    fn discard_draft(&self, draft_id: &str) -> Result<(), String> {
        let mut transient = self
            .transient_error_draft
            .lock()
            .map_err(|_| "The temporary capture draft is unavailable.".to_owned())?;
        if transient
            .as_ref()
            .is_some_and(|draft| draft.draft_id == draft_id)
        {
            *transient = None;
            return Ok(());
        }
        drop(transient);

        self.store
            .cancel_draft(draft_id)
            .map_err(|error| error.to_string())
    }

    fn ensure_operation(&self, draft_id: &str, operation: &OperationContext) -> Result<(), String> {
        let transient = self
            .transient_error_draft
            .lock()
            .map_err(|_| "The temporary capture draft is unavailable.".to_owned())?;
        if let Some(draft) = transient
            .as_ref()
            .filter(|draft| draft.draft_id == draft_id)
        {
            return if &draft.operation == operation {
                Ok(())
            } else {
                record(
                    "warn",
                    "capture.operation_mismatch",
                    Some(operation),
                    json!({"status": "rejected", "reason": "transient_operation_differs", "draftId": safe_capture_id(draft_id)}),
                );
                Err("The capture operation does not match this draft.".to_owned())
            };
        }
        drop(transient);

        self.store
            .ensure_operation(draft_id, operation)
            .map_err(|error| error.to_string())
    }
}

struct AppShortcutRegistry<'a>(&'a AppHandle);

impl ShortcutRegistry for AppShortcutRegistry<'_> {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())
    }

    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
}

/// A conflict is shown in Settings instead of preventing the app from opening.
pub fn register_capture_shortcut(app: &AppHandle) {
    let started = Instant::now();
    let state = app.state::<CaptureState>();
    let mut status = state.shortcut_status();
    if let Ok((_, shortcut)) = validate_shortcut(&status.shortcut) {
        match app.global_shortcut().register(shortcut) {
            Ok(()) => {
                state
                    .active_shortcut_id
                    .store(shortcut.id(), Ordering::Release);
                status.available = true;
                status.error = None;
            }
            Err(error) => {
                record(
                    "warn",
                    "shortcut.registration",
                    None,
                    json!({"phase": "startup_register", "status": "unavailable", "errorCode": error_code(error)}),
                );
                status.available = false;
                status.error = Some("This shortcut is unavailable. It may be used by another app. Choose another combination.".to_owned());
            }
        }
    }
    record(
        if status.available { "info" } else { "warn" },
        "shortcut.registration",
        None,
        json!({"phase": "startup", "status": if status.available { "success" } else { "unavailable" }, "shortcut": status.shortcut, "elapsedMs": started.elapsed().as_millis() as u64}),
    );
    state.publish_shortcut_status(app, status, None);

    // A recorder must never leave capture paused after the main window goes away.
    if let Some(window) = app.get_webview_window("main") {
        let lifecycle_app = app.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Focused(false)
                    | WindowEvent::CloseRequested { .. }
                    | WindowEvent::Destroyed
            ) {
                let app = lifecycle_app.clone();
                let only_if_unfocused = matches!(event, WindowEvent::Focused(false));
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = set_shortcut_recording(&app, false, only_if_unfocused, None);
                });
            }
        });
    }
}

struct CaptureProgressGuard {
    in_progress: Arc<AtomicBool>,
    operation: OperationContext,
    started: Instant,
    outcome: &'static str,
}

impl Drop for CaptureProgressGuard {
    fn drop(&mut self) {
        self.in_progress.store(false, Ordering::Release);
        native_state("capture", json!({"inProgress": false, "operationId": null}));
        record(
            if self.outcome == "interrupted" {
                "warn"
            } else {
                "info"
            },
            "capture.finished",
            Some(&self.operation),
            json!({"status": self.outcome, "elapsedMs": self.started.elapsed().as_millis() as u64}),
        );
    }
}

/// Keep the pre-created capture window alive while allowing the frontend to
/// turn its native close control into the same durable discard flow as Cancel.
pub fn install_capture_window_lifecycle(app: &AppHandle) {
    let Some(window) = app.get_webview_window("capture") else {
        record(
            "error",
            "capture.window",
            None,
            json!({"phase": "lifecycle", "status": "error", "reason": "window_unavailable"}),
        );
        return;
    };
    let capture_window = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let started = Instant::now();
            let result = capture_window.emit(CAPTURE_CLOSE_REQUESTED_EVENT, ());
            log_result(
                "capture.window",
                None,
                "close_requested_emit",
                &result,
                started,
                json!({}),
            );
        }
        WindowEvent::Focused(true) => {
            let started = Instant::now();
            let result = capture_window.set_always_on_top(true);
            log_result(
                "capture.window",
                None,
                "focused_always_on_top",
                &result,
                started,
                json!({}),
            );
        }
        _ => {}
    });
}

/// Entry point for the global-shortcut handler. Drafts containing a quotation
/// or a thought always win; an empty draft can be replaced by a fresh capture.
pub fn handle_shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let operation = OperationContext::new();
    let state = app.state::<CaptureState>();
    record(
        "info",
        "shortcut.triggered",
        Some(&operation),
        json!({"phase": "received"}),
    );
    if state.shortcut_recording.load(Ordering::Acquire) {
        record(
            "info",
            "shortcut.skipped",
            Some(&operation),
            json!({"reason": "recording"}),
        );
        return;
    }
    if state.active_shortcut_id.load(Ordering::Acquire) != shortcut.id() {
        record(
            "info",
            "shortcut.skipped",
            Some(&operation),
            json!({"reason": "inactive_shortcut"}),
        );
        return;
    }
    if state
        .capture_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let updating = state
            .app_update_active
            .try_lock()
            .is_ok_and(|active| *active);
        record(
            "info",
            "shortcut.skipped",
            Some(&operation),
            json!({"reason": if updating { "app_update" } else { "capture_in_progress" }}),
        );
        return;
    }
    let mut progress_guard = CaptureProgressGuard {
        in_progress: state.capture_in_progress.clone(),
        operation: operation.clone(),
        started: Instant::now(),
        outcome: "interrupted",
    };
    native_state(
        "capture",
        json!({"inProgress": true, "operationId": operation.operation_id}),
    );
    record(
        "info",
        "capture.started",
        Some(&operation),
        json!({"phase": "draft_check"}),
    );

    match state.current_draft() {
        Ok(Some(draft)) => {
            if capture_draft_is_empty(&draft) {
                if let Err(error) = state.discard_draft(&draft.draft_id) {
                    record(
                        "error",
                        "capture.draft",
                        Some(&operation),
                        json!({"phase": "replace_empty", "status": "error", "errorCode": error_code(error)}),
                    );
                    present_draft(app, &draft);
                    progress_guard.outcome = "existing_draft";
                    return;
                }
                record(
                    "info",
                    "capture.draft",
                    Some(&operation),
                    json!({"phase": "replace_empty", "status": "success", "draftId": safe_capture_id(&draft.draft_id)}),
                );
            } else {
                record(
                    "info",
                    "shortcut.skipped",
                    Some(&operation),
                    json!({"reason": "existing_draft", "draftId": safe_capture_id(&draft.draft_id)}),
                );
                present_draft(app, &draft);
                progress_guard.outcome = "existing_draft";
                return;
            }
        }
        Ok(None) => {}
        Err(error) => {
            record(
                "error",
                "capture.draft",
                Some(&operation),
                json!({"phase": "read", "status": "error", "errorCode": error_code(error)}),
            );
            let source = platform::snapshot_frontmost_application();
            persist_and_present_error_draft(app, &operation,
                "Bilbo could not read the current capture draft. You can still write your thought here.", Some(&source));
            progress_guard.outcome = "error_draft";
            return;
        }
    }

    // Snapshot before the capture webview changes the foreground application.
    let source_application = platform::snapshot_frontmost_application();
    record(
        "info",
        "capture.started",
        Some(&operation),
        json!({"phase": "source_snapshot", "sourceApp": source_application.bundle_id, "sourceAvailable": source_application.pid > 0}),
    );
    let worker_error_source = source_application.clone();
    let spawn_error_source = source_application.clone();
    let worker_app = app.clone();
    let spawn_error_app = app.clone();
    let worker_operation = operation.clone();
    let shortcut_key = shortcut.key;
    let spawn_result = std::thread::Builder::new().name("diary-capture".to_owned()).spawn(move || {
        let mut progress_guard = progress_guard;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let input = platform::capture(source_application, shortcut_key, worker_operation.clone());
            record("info", "capture.finished", Some(&worker_operation), json!({"phase": "context", "captureMethod": input.capture_method.as_str(),
                "hasSelection": !input.selected_text.is_empty(), "hasTitle": input.source_title.is_some(), "hasUrl": input.source_url.is_some(),
                "permissionRequired": input.permission_required, "hasError": input.capture_error.is_some()}));
            worker_app.state::<CaptureState>().store.create_draft(input)
        }));
        match result {
            Ok(Ok(draft)) => {
                present_draft(&worker_app, &draft);
                progress_guard.outcome = "draft_ready";
            }
            Ok(Err(error)) => {
                record("error", "capture.draft", Some(&worker_operation), json!({"phase": "worker", "status": "error", "errorCode": error_code(error)}));
                persist_and_present_error_draft(&worker_app, &worker_operation,
                    "Bilbo could not persist the captured context. You can still write your thought here.", Some(&worker_error_source));
                progress_guard.outcome = "error_draft";
            }
            Err(_) => {
                record("error", "capture.finished", Some(&worker_operation), json!({"phase": "worker", "status": "panic", "errorCode": "worker_panic"}));
                persist_and_present_error_draft(&worker_app, &worker_operation,
                    "The source application did not respond safely. You can still write your thought here.", Some(&worker_error_source));
                progress_guard.outcome = "error_draft";
            }
        }
    });
    if let Err(error) = spawn_result {
        record(
            "error",
            "capture.finished",
            Some(&operation),
            json!({"phase": "worker_spawn", "status": "error", "errorCode": error_code(error)}),
        );
        persist_and_present_error_draft(
            &spawn_error_app,
            &operation,
            "Bilbo could not start context capture. You can still write your thought here.",
            Some(&spawn_error_source),
        );
    }
}

fn capture_draft_is_empty(draft: &CaptureDraft) -> bool {
    draft.selected_text.trim().is_empty() && draft.note.trim().is_empty()
}

fn persist_and_present_error_draft(
    app: &AppHandle,
    operation: &OperationContext,
    message: &str,
    source: Option<&platform::FrontmostApplication>,
) {
    let input = NewDraft {
        operation: operation.clone(),
        selected_text: String::new(),
        source_app: source.and_then(|source| source.name.clone()),
        source_bundle_id: source.and_then(|source| source.bundle_id.clone()),
        source_title: None,
        source_url: None,
        capture_method: CaptureMethod::None,
        permission_required: false,
        capture_error: Some(message.to_owned()),
    };

    let state = app.state::<CaptureState>();
    match state.store.create_draft(input.clone()) {
        Ok(draft) => present_draft(app, &draft),
        Err(error) => {
            record(
                "error",
                "capture.draft",
                Some(operation),
                json!({"phase": "transient_fallback", "status": "fallback", "errorCode": error_code(error)}),
            );
            // If storage itself is unavailable, keep the error draft usable in
            // memory and visible instead of relying on an unobserved event.
            let now = now_millis();
            let draft = CaptureDraft {
                draft_id: format!("transient-error-{}", uuid::Uuid::new_v4()),
                operation: input.operation,
                selected_text: input.selected_text,
                note: String::new(),
                source_app: input.source_app,
                source_bundle_id: input.source_bundle_id,
                source_title: input.source_title,
                source_url: input.source_url,
                capture_method: input.capture_method,
                permission_required: input.permission_required,
                capture_error: input.capture_error,
                created_at: now,
                updated_at: now,
            };
            match state.transient_error_draft.lock() {
                Ok(mut transient) => *transient = Some(draft.clone()),
                Err(_) => record(
                    "error",
                    "capture.draft",
                    Some(operation),
                    json!({"phase": "transient_fallback", "status": "error", "errorCode": "lock_unavailable"}),
                ),
            }
            present_draft(app, &draft);
        }
    }
}

fn present_draft(app: &AppHandle, draft: &CaptureDraft) {
    publish_draft_state(Some(draft));
    let Some(window) = app.get_webview_window("capture") else {
        record(
            "error",
            "capture.window",
            Some(&draft.operation),
            json!({"phase": "present", "status": "error", "reason": "window_unavailable"}),
        );
        emit_capture_failure(
            app,
            &draft.operation,
            "Bilbo's capture window is unavailable.",
        );
        return;
    };
    let started = Instant::now();
    let result = window.set_always_on_top(true);
    log_result(
        "capture.window",
        Some(&draft.operation),
        "always_on_top",
        &result,
        started,
        json!({}),
    );
    let started = Instant::now();
    let result = window.emit("capture-draft-ready", draft);
    log_result(
        "capture.window",
        Some(&draft.operation),
        "draft_ready_emit",
        &result,
        started,
        json!({"draftId": safe_capture_id(&draft.draft_id)}),
    );
    let started = Instant::now();
    let positioned = center_on_cursor_monitor(&window);
    log_result(
        "capture.window",
        Some(&draft.operation),
        "position",
        &positioned,
        started,
        json!({}),
    );
    if positioned.is_err() {
        let started = Instant::now();
        let result = window.center();
        log_result(
            "capture.window",
            Some(&draft.operation),
            "center_fallback",
            &result,
            started,
            json!({}),
        );
    }
    let started = Instant::now();
    let result = window.show();
    log_result(
        "capture.window",
        Some(&draft.operation),
        "show",
        &result,
        started,
        json!({}),
    );
    let started = Instant::now();
    let result = window.set_focus();
    log_result(
        "capture.window",
        Some(&draft.operation),
        "focus",
        &result,
        started,
        json!({}),
    );
}

fn center_on_cursor_monitor(window: &WebviewWindow) -> tauri::Result<()> {
    let cursor = window.cursor_position()?;
    let Some(monitor) = window.monitor_from_point(cursor.x, cursor.y)? else {
        return window.center();
    };
    let window_size = window.outer_size()?;
    let work_area = monitor.work_area();
    let x = i64::from(work_area.position.x)
        + (i64::from(work_area.size.width) - i64::from(window_size.width)).max(0) / 2;
    let y = i64::from(work_area.position.y)
        + (i64::from(work_area.size.height) - i64::from(window_size.height)).max(0) / 2;
    window.set_position(PhysicalPosition::new(x as i32, y as i32))
}

#[derive(Clone, serde::Serialize)]
struct CaptureFailure<'a> {
    operation: &'a OperationContext,
    message: &'a str,
}

fn emit_capture_failure(app: &AppHandle, operation: &OperationContext, message: &str) {
    let started = Instant::now();
    let result = app.emit("capture-error", CaptureFailure { operation, message });
    log_result(
        "capture.window",
        Some(operation),
        "failure_emit",
        &result,
        started,
        json!({}),
    );
}

#[tauri::command]
pub fn begin_app_update(
    window: WebviewWindow,
    state: tauri::State<'_, CaptureState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("APP_UPDATE_FORBIDDEN".to_owned());
    }
    let mut active = state
        .app_update_active
        .lock()
        .map_err(|_| "CAPTURE_STATE_UNAVAILABLE".to_owned())?;
    if *active {
        return Err("APP_UPDATE_BUSY".to_owned());
    }

    // Reserve the same atomic slot as the shortcut handler so a capture cannot
    // start between the draft check and installation, including on main blur.
    state
        .capture_in_progress
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "CAPTURE_BUSY".to_owned())?;
    match state.current_draft() {
        Ok(None) => {
            *active = true;
            Ok(())
        }
        draft => {
            state.capture_in_progress.store(false, Ordering::Release);
            Err(if draft.is_ok() {
                "CAPTURE_BUSY"
            } else {
                "CAPTURE_STATE_UNAVAILABLE"
            }
            .to_owned())
        }
    }
}

#[tauri::command]
pub fn end_app_update(
    window: WebviewWindow,
    state: tauri::State<'_, CaptureState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("APP_UPDATE_FORBIDDEN".to_owned());
    }
    let mut active = state
        .app_update_active
        .lock()
        .map_err(|_| "CAPTURE_STATE_UNAVAILABLE".to_owned())?;
    if *active {
        state.capture_in_progress.store(false, Ordering::Release);
        *active = false;
    }
    Ok(())
}

#[tauri::command]
pub fn get_capture_draft(
    state: tauri::State<'_, CaptureState>,
    operation: Option<OperationContext>,
) -> Result<Option<CaptureDraft>, String> {
    let started = Instant::now();
    let result = state.current_draft();
    log_result(
        "capture.draft",
        operation.as_ref(),
        "read",
        &result,
        started,
        json!({"present": result.as_ref().ok().is_some_and(|draft| draft.is_some())}),
    );
    if let Ok(draft) = &result {
        publish_draft_state(draft.as_ref());
    }
    result
}

#[tauri::command]
pub fn update_capture_draft(
    state: tauri::State<'_, CaptureState>,
    draft_id: String,
    note: String,
    operation: OperationContext,
) -> Result<CaptureDraft, String> {
    let started = Instant::now();
    let result = (|| {
        state.ensure_operation(&draft_id, &operation)?;
        if let Ok(mut transient) = state.transient_error_draft.lock() {
            if let Some(draft) = transient
                .as_mut()
                .filter(|draft| draft.draft_id == draft_id)
            {
                draft.note = note;
                draft.updated_at = now_millis();
                return Ok(draft.clone());
            }
        }

        state
            .store
            .update_draft(&draft_id, &note)
            .map_err(|error| error.to_string())
    })();
    log_result(
        "capture.draft",
        Some(&operation),
        "update",
        &result,
        started,
        json!({"draftId": safe_capture_id(&draft_id)}),
    );
    if let Ok(draft) = &result {
        publish_draft_state(Some(draft));
    }
    result
}
#[tauri::command]
pub fn save_capture(
    state: tauri::State<'_, CaptureState>,
    draft_id: String,
    note: String,
    operation: OperationContext,
) -> Result<Capture, String> {
    let started = Instant::now();
    record(
        "info",
        "capture.save.started",
        Some(&operation),
        json!({"draftId": safe_capture_id(&draft_id)}),
    );
    let result = (|| {
        state.ensure_operation(&draft_id, &operation)?;
        let transient = state
            .transient_error_draft
            .lock()
            .ok()
            .and_then(|draft| draft.clone())
            .filter(|draft| draft.draft_id == draft_id);
        if let Some(transient) = transient {
            let durable = state
            .store
            .create_draft(NewDraft {
                operation: transient.operation,
                selected_text: transient.selected_text,
                source_app: transient.source_app,
                source_bundle_id: transient.source_bundle_id,
                source_title: transient.source_title,
                source_url: transient.source_url,
                capture_method: transient.capture_method,
                permission_required: transient.permission_required,
                capture_error: transient.capture_error,
            })
            .map_err(|error| {
                record("error", "capture.save.finished", Some(&operation), json!({"phase": "transient_recovery", "status": "error", "errorCode": error_code(error)}));
                "The capture database is unavailable. Your note remains open; try saving again."
                    .to_owned()
            })?;
            let capture = state
            .store
            .save_draft(&durable.draft_id, &note)
            .map_err(|error| {
                record("error", "capture.save.finished", Some(&operation), json!({"phase": "transient_recovery", "status": "error", "errorCode": error_code(error)}));
                "The capture database is unavailable. Your note remains open; try saving again."
                    .to_owned()
            })?;
            if let Ok(mut current) = state.transient_error_draft.lock() {
                if current
                    .as_ref()
                    .is_some_and(|draft| draft.draft_id == draft_id)
                {
                    *current = None;
                }
            }
            return Ok(capture);
        }

        state
            .store
            .save_draft(&draft_id, &note)
            .map_err(|error| error.to_string())
    })();
    log_result(
        "capture.save.finished",
        Some(&operation),
        "commit",
        &result,
        started,
        json!({"draftId": safe_capture_id(&draft_id), "committed": result.is_ok(), "captureId": result.as_ref().ok().and_then(|capture| safe_capture_id(&capture.capture_id))}),
    );
    if result.is_ok() {
        publish_draft_state(None);
    }
    result
}
#[tauri::command]
pub fn cancel_capture(
    state: tauri::State<'_, CaptureState>,
    draft_id: String,
    operation: OperationContext,
) -> Result<(), String> {
    let started = Instant::now();
    let result = state
        .ensure_operation(&draft_id, &operation)
        .and_then(|_| state.discard_draft(&draft_id));
    log_result(
        "capture.draft",
        Some(&operation),
        "discard",
        &result,
        started,
        json!({"draftId": safe_capture_id(&draft_id)}),
    );
    if result.is_ok() {
        publish_draft_state(None);
    }
    result
}

#[tauri::command]
pub fn list_captures(
    state: tauri::State<'_, CaptureState>,
    operation: Option<OperationContext>,
) -> Result<Vec<Capture>, String> {
    let started = Instant::now();
    let result = state
        .store
        .list_captures()
        .map_err(|error| error.to_string());
    log_result(
        "storage.read",
        operation.as_ref(),
        "list_captures",
        &result,
        started,
        json!({"count": result.as_ref().ok().map(Vec::len)}),
    );
    result
}

#[tauri::command]
pub fn replace_capture_reference_index(
    state: tauri::State<'_, CaptureState>,
    entries: Vec<CaptureReferenceIndexEntry>,
    operation: Option<OperationContext>,
) -> Result<(), String> {
    let started = Instant::now();
    let result = state
        .store
        .replace_capture_reference_index(&entries)
        .map_err(|error| error.to_string());
    log_result(
        "storage.write",
        operation.as_ref(),
        "capture_reference_index",
        &result,
        started,
        json!({"count": entries.len()}),
    );
    result
}

#[tauri::command]
pub fn update_capture_note(
    state: tauri::State<'_, CaptureState>,
    capture_id: String,
    note: String,
    operation: Option<OperationContext>,
) -> Result<Capture, String> {
    let started = Instant::now();
    let result = state
        .store
        .update_capture_note(&capture_id, &note)
        .map_err(|error| error.to_string());
    log_result(
        "storage.write",
        operation.as_ref(),
        "capture_note",
        &result,
        started,
        json!({"captureId": safe_capture_id(&capture_id)}),
    );
    result
}

#[tauri::command]
pub fn delete_capture(
    state: tauri::State<'_, CaptureState>,
    capture_id: String,
    operation: Option<OperationContext>,
) -> Result<(), String> {
    let started = Instant::now();
    let result = state
        .store
        .delete_capture(&capture_id)
        .map_err(|error| error.to_string());
    log_result(
        "storage.write",
        operation.as_ref(),
        "delete_capture",
        &result,
        started,
        json!({"captureId": safe_capture_id(&capture_id)}),
    );
    result
}

#[tauri::command]
pub fn open_capture_source(
    app: AppHandle,
    url: String,
    operation: Option<OperationContext>,
) -> Result<(), String> {
    let started = Instant::now();
    let result = (|| {
        let parsed =
            url::Url::parse(&url).map_err(|_| "The capture source URL is invalid.".to_owned())?;
        if !matches!(parsed.scheme(), "http" | "https" | "file") {
            return Err("Only web and local-file capture sources can be opened.".to_owned());
        }
        open_external(&app, parsed.as_str(), "capture_source", operation.as_ref())
    })();
    log_result(
        "external.open",
        operation.as_ref(),
        "capture_source",
        &result,
        started,
        json!({}),
    );
    result
}

#[tauri::command]
pub fn get_capture_permission_status(
    operation: Option<OperationContext>,
) -> CapturePermissionStatus {
    let trusted = platform::accessibility_is_trusted();
    observe_permission(trusted, operation.as_ref(), false);
    CapturePermissionStatus {
        accessibility_trusted: trusted,
    }
}

#[tauri::command]
pub fn open_accessibility_settings(
    app: AppHandle,
    operation: Option<OperationContext>,
) -> Result<(), String> {
    let started = Instant::now();
    // Register the explicit access request before opening the pane, so a fresh
    // installation can be offered by macOS. Polling remains nonprompting.
    let trusted = platform::request_accessibility_access();
    observe_permission(trusted, operation.as_ref(), false);
    let result = open_external(
        &app,
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "accessibility_settings",
        operation.as_ref(),
    );
    log_result(
        "external.open",
        operation.as_ref(),
        "accessibility_settings",
        &result,
        started,
        json!({}),
    );
    result
}

fn open_external(
    app: &AppHandle,
    url: &str,
    target: &str,
    operation: Option<&OperationContext>,
) -> Result<(), String> {
    let capture_window = app.get_webview_window("capture");
    if let Some(window) = capture_window.as_ref() {
        let started = Instant::now();
        let result = window.set_always_on_top(false);
        log_result(
            "capture.window",
            operation,
            "release_always_on_top",
            &result,
            started,
            json!({"destinationKind": target}),
        );
        result.map_err(|error| format!("Bilbo could not place the source in front: {error}"))?;
    }
    let started = Instant::now();
    let result = app
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string());
    log_result(
        "external.open",
        operation,
        "opener",
        &result,
        started,
        json!({"destinationKind": target}),
    );
    if result.is_err() {
        if let Some(window) = capture_window {
            let started = Instant::now();
            let restore = window.set_always_on_top(true);
            log_result(
                "capture.window",
                operation,
                "restore_always_on_top",
                &restore,
                started,
                json!({"destinationKind": target}),
            );
        }
    }
    result
}

#[tauri::command]
pub fn get_capture_shortcut_status(
    state: tauri::State<'_, CaptureState>,
    operation: Option<OperationContext>,
) -> CaptureShortcutStatus {
    let status = state.shortcut_status();
    record(
        "debug",
        "shortcut.registration",
        operation.as_ref(),
        json!({"phase": "read", "available": status.available, "shortcut": status.shortcut}),
    );
    status
}

#[tauri::command]
pub async fn set_capture_shortcut(
    app: AppHandle,
    shortcut: String,
    operation: Option<OperationContext>,
) -> Result<CaptureShortcutStatus, String> {
    let started = Instant::now();
    let worker_operation = operation.clone();
    record(
        "info",
        "settings.change",
        operation.as_ref(),
        json!({"phase": "requested", "setting": "capture_shortcut", "shortcut": validate_shortcut(&shortcut).ok().map(|value| value.0)}),
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CaptureState>();
        let _operation = state
            .shortcut_operation
            .lock()
            .map_err(|_| "The capture shortcut is unavailable.".to_owned())?;
        let previous_status = state.shortcut_status();
        let mut status = previous_status.clone();
        let paused = state.shortcut_recording.load(Ordering::Acquire)
            && state.active_shortcut_id.load(Ordering::Acquire) == 0;
        if paused {
            status.available = false;
        }
        let result = change_shortcut(
            &mut status,
            &shortcut,
            &mut AppShortcutRegistry(&app),
            worker_operation.as_ref(),
            |canonical| {
                state
                    .store
                    .set_shortcut(canonical)
                    .map_err(|error| error.to_string())
            },
        );
        if result.is_err() && paused {
            status = previous_status;
        } else {
            let active_id = if status.available {
                validate_shortcut(&status.shortcut)
                    .map(|(_, shortcut)| shortcut.id())
                    .unwrap_or(0)
            } else {
                0
            };
            state.active_shortcut_id.store(active_id, Ordering::Release);
        }
        state.publish_shortcut_status(&app, status.clone(), worker_operation.as_ref());
        result.map(|_| status)
    })
    .await
    .map_err(|_| {
        record(
            "error",
            "shortcut.registration",
            operation.as_ref(),
            json!({"phase": "worker", "status": "error", "errorCode": "worker_join_failed"}),
        );
        "Bilbo could not update the capture shortcut.".to_owned()
    })
    .and_then(|result| result);
    log_result(
        "settings.change",
        operation.as_ref(),
        "finished",
        &result,
        started,
        json!({"setting": "capture_shortcut", "shortcut": result.as_ref().ok().map(|status| &status.shortcut), "available": result.as_ref().ok().map(|status| status.available)}),
    );
    result
}

fn set_shortcut_recording(
    app: &AppHandle,
    recording: bool,
    only_if_unfocused: bool,
    operation: Option<&OperationContext>,
) -> Result<(), String> {
    let started = Instant::now();
    let state = app.state::<CaptureState>();
    let result = (|| {
        let _operation = state
            .shortcut_operation
            .lock()
            .map_err(|_| "The capture shortcut is unavailable.".to_owned())?;
        // A blur worker can wait behind a shortcut save. Check after taking the
        // operation lock so it cannot end a recorder started after the user returns.
        if only_if_unfocused
            && app
                .get_webview_window("main")
                .is_some_and(|window| window.is_focused().unwrap_or(false))
        {
            return Ok(());
        }
        if state.shortcut_recording.load(Ordering::Acquire) == recording {
            return Ok(());
        }
        let mut status = state.shortcut_status();
        let (_, shortcut) = validate_shortcut(&status.shortcut)?;
        if recording {
            if !app
                .get_webview_window("main")
                .is_some_and(|window| window.is_focused().unwrap_or(false))
            {
                return Err("Keep Bilbo focused while changing the shortcut.".to_owned());
            }
            state.shortcut_recording.store(true, Ordering::Release);
            if state.active_shortcut_id.load(Ordering::Acquire) != 0 {
                let unregister = app.global_shortcut().unregister(shortcut);
                log_result(
                    "shortcut.registration",
                    operation,
                    "recording_unregister",
                    &unregister,
                    started,
                    json!({}),
                );
                if unregister.is_err() {
                    state.shortcut_recording.store(false, Ordering::Release);
                    return Err(
                        "Bilbo could not start changing the shortcut. Try again.".to_owned()
                    );
                }
                state.active_shortcut_id.store(0, Ordering::Release);
            }
        } else {
            if state.active_shortcut_id.load(Ordering::Acquire) == 0 {
                let registration = app.global_shortcut().register(shortcut);
                log_result(
                    "shortcut.registration",
                    operation,
                    "recording_restore",
                    &registration,
                    started,
                    json!({}),
                );
                match registration {
                    Ok(()) => {
                        state
                            .active_shortcut_id
                            .store(shortcut.id(), Ordering::Release);
                        status.available = true;
                        status.error = None;
                    }
                    Err(_) => {
                        status.available = false;
                        status.error = Some("This shortcut is unavailable. It may be used by another app. Choose another combination.".to_owned());
                    }
                }
            }
            state.shortcut_recording.store(false, Ordering::Release);
            state.publish_shortcut_status(app, status, operation);
        }
        Ok(())
    })();
    log_result(
        "shortcut.registration",
        operation,
        "recording",
        &result,
        started,
        json!({"requestedEnabled": recording, "recording": state.shortcut_recording.load(Ordering::Acquire), "registered": state.active_shortcut_id.load(Ordering::Acquire) != 0}),
    );
    let status = state.shortcut_status();
    native_state(
        "captureShortcut",
        json!({"shortcut": status.shortcut, "registered": state.active_shortcut_id.load(Ordering::Acquire) != 0,
        "available": status.available, "recording": state.shortcut_recording.load(Ordering::Acquire), "hasError": status.error.is_some()}),
    );
    result
}
#[tauri::command]
pub async fn set_capture_shortcut_recording(
    app: AppHandle,
    recording: bool,
    operation: Option<OperationContext>,
) -> Result<(), String> {
    let worker_operation = operation.clone();
    tauri::async_runtime::spawn_blocking(move || set_shortcut_recording(&app, recording, false, worker_operation.as_ref()))
        .await
        .map_err(|_| {
            record("error", "shortcut.registration", operation.as_ref(), json!({"phase": "recording_worker", "status": "error", "errorCode": "worker_join_failed"}));
            "Bilbo could not change shortcut recording.".to_owned()
        })?
}

fn safe_capture_id(value: &str) -> Option<String> {
    let id = value.strip_prefix("transient-error-").unwrap_or(value);
    uuid::Uuid::parse_str(id).ok().map(|id| {
        if value.starts_with("transient-error-") {
            format!("transient-error-{id}")
        } else {
            id.to_string()
        }
    })
}

fn log_result<T, E: std::fmt::Display>(
    event: &str,
    operation: Option<&OperationContext>,
    phase: &str,
    result: &Result<T, E>,
    started: Instant,
    mut fields: Value,
) {
    fields["phase"] = json!(phase);
    fields["status"] = json!(if result.is_ok() { "success" } else { "error" });
    fields["elapsedMs"] = json!(started.elapsed().as_millis() as u64);
    if let Err(error) = result {
        fields["errorCode"] = json!(error_code(error));
    }
    record(
        if result.is_ok() { "info" } else { "error" },
        event,
        operation,
        fields,
    );
}

fn draft_state_fields(draft: Option<&CaptureDraft>) -> Value {
    match draft {
        Some(draft) => {
            json!({"present": true, "available": true, "transient": draft.draft_id.starts_with("transient-error-"),
            "draftId": safe_capture_id(&draft.draft_id), "operationId": draft.operation.operation_id,
            "hasSelection": !draft.selected_text.is_empty(), "hasNote": !draft.note.is_empty(),
            "captureMethod": draft.capture_method.as_str(), "permissionRequired": draft.permission_required,
            "hasError": draft.capture_error.is_some()})
        }
        None => json!({"present": false, "available": true, "draftId": null, "operationId": null,
            "transient": false, "hasSelection": false, "hasNote": false, "captureMethod": "none", "permissionRequired": false, "hasError": false}),
    }
}

fn publish_draft_state(draft: Option<&CaptureDraft>) {
    native_state("captureDraft", draft_state_fields(draft));
}

static LAST_PERMISSION: AtomicU8 = AtomicU8::new(0);

pub(crate) fn observe_permission(
    trusted: bool,
    operation: Option<&OperationContext>,
    at_capture: bool,
) {
    let current = if trusted { 2 } else { 1 };
    let previous = LAST_PERMISSION.swap(current, Ordering::AcqRel);
    native_state("permission", json!({"accessibilityTrusted": trusted}));
    if at_capture {
        record(
            "info",
            "permission.checked",
            operation,
            json!({"phase": "capture", "accessibilityTrusted": trusted}),
        );
    }
    if previous != 0 && previous != current {
        record(
            "info",
            "permission.changed",
            operation,
            json!({"accessibilityTrusted": trusted}),
        );
    }
}

/// Collect fresh metadata for an exported diagnostic report without reading note content into logs.
pub fn refresh_diagnostic_state(app: &AppHandle) {
    let state = app.state::<CaptureState>();
    native_state(
        "capture",
        json!({"inProgress": state.capture_in_progress.load(Ordering::Acquire)}),
    );
    match state.shortcut_status.lock() {
        Ok(status) => {
            let registered = validate_shortcut(&status.shortcut)
                .ok()
                .is_some_and(|(_, shortcut)| app.global_shortcut().is_registered(shortcut));
            native_state(
                "captureShortcut",
                json!({"stateKnown": true, "shortcut": status.shortcut, "registered": registered,
                "available": status.available, "recording": state.shortcut_recording.load(Ordering::Acquire), "hasError": status.error.is_some()}),
            );
        }
        Err(_) => {
            native_state(
                "captureShortcut",
                json!({"stateKnown": false, "hasError": true}),
            );
            record(
                "error",
                "diagnostics.collection_failed",
                None,
                json!({"section": "captureShortcut", "errorCode": "lock_unavailable"}),
            );
        }
    }
    match state.current_draft() {
        Ok(draft) => publish_draft_state(draft.as_ref()),
        Err(error) => {
            native_state(
                "captureDraft",
                json!({"available": false, "hasError": true, "present": null, "draftId": null, "operationId": null}),
            );
            record(
                "error",
                "diagnostics.collection_failed",
                None,
                json!({"section": "captureDraft", "errorCode": error_code(error)}),
            );
        }
    }
    observe_permission(platform::accessibility_is_trusted(), None, false);
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(selected_text: &str, note: &str) -> CaptureDraft {
        CaptureDraft {
            draft_id: "draft-id".to_owned(),
            operation: OperationContext::new(),
            selected_text: selected_text.to_owned(),
            note: note.to_owned(),
            source_app: Some("Reader".to_owned()),
            source_bundle_id: Some("example.reader".to_owned()),
            source_title: Some("A page".to_owned()),
            source_url: Some("https://example.com".to_owned()),
            capture_method: CaptureMethod::None,
            permission_required: false,
            capture_error: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn progress_guard_always_releases_capture_slot() {
        let in_progress = Arc::new(AtomicBool::new(true));
        {
            let _guard = CaptureProgressGuard {
                in_progress: in_progress.clone(),
                operation: OperationContext::new(),
                started: Instant::now(),
                outcome: "test",
            };
            assert!(in_progress.load(Ordering::Acquire));
        }
        assert!(!in_progress.load(Ordering::Acquire));
    }

    #[test]
    fn diagnostic_draft_metadata_excludes_user_content_and_rejects_non_uuid_ids() {
        let mut value = draft("private selection", "private note");
        value.source_title = Some("private title".to_owned());
        let fields = draft_state_fields(Some(&value));
        let rendered = fields.to_string();
        for private in [
            "private selection",
            "private note",
            "private title",
            "https://example.com",
            "draft-id",
        ] {
            assert!(!rendered.contains(private));
        }
        assert_eq!(fields["hasSelection"], true);
        assert_eq!(fields["hasNote"], true);
        assert_eq!(fields["draftId"], Value::Null);
        assert_eq!(safe_capture_id("note content"), None);
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            safe_capture_id(&format!("transient-error-{id}")),
            Some(format!("transient-error-{id}"))
        );
    }

    #[test]
    fn content_free_drafts_can_be_replaced() {
        assert!(capture_draft_is_empty(&draft("", "")));
        assert!(capture_draft_is_empty(&draft("  \n", "\t")));
    }

    #[test]
    fn captured_text_or_a_typed_thought_protects_the_draft() {
        assert!(!capture_draft_is_empty(&draft("quotation", "")));
        assert!(!capture_draft_is_empty(&draft("", "my thought")));
    }
}
