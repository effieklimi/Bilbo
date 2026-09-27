use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use uuid::Uuid;

use crate::diagnostics::{error_code, native_state, record, OperationContext};
use serde_json::json;

use super::models::{Capture, CaptureDraft, CaptureMethod, CaptureReferenceIndexEntry, NewDraft};

const SCHEMA_VERSION: i64 = 4;

#[derive(Debug)]
pub(crate) struct StoreError(String);

impl StoreError {
    fn message(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

pub(crate) type StoreResult<T> = Result<T, StoreError>;

pub(crate) struct CaptureStore {
    connection: Mutex<Connection>,
}

impl CaptureStore {
    pub(crate) fn open(path: &Path) -> StoreResult<Self> {
        let started = Instant::now();
        record(
            "info",
            "storage.open",
            None,
            json!({"phase": "started", "storage": "capture"}),
        );
        let result: StoreResult<Self> = (|| {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let connection = Connection::open(path)?;
            Self::configure(&connection)?;
            Self::migrate(&connection)?;
            Ok(Self {
                connection: Mutex::new(connection),
            })
        })();
        record(
            if result.is_ok() { "info" } else { "error" },
            "storage.open",
            None,
            json!({"phase": "finished", "storage": "capture", "status": if result.is_ok() { "success" } else { "error" },
                "elapsedMs": started.elapsed().as_millis() as u64,
                "errorCode": result.as_ref().err().map(error_code)}),
        );
        native_state(
            "captureStorage",
            json!({"available": result.is_ok(), "schemaVersion": SCHEMA_VERSION}),
        );
        result
    }

    #[cfg(test)]
    fn in_memory() -> StoreResult<Self> {
        let connection = Connection::open_in_memory()?;
        Self::configure(&connection)?;
        Self::migrate(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn configure(connection: &Connection) -> StoreResult<()> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(())
    }

    fn migrate(connection: &Connection) -> StoreResult<()> {
        let started = Instant::now();
        let version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .ok();
        record(
            "info",
            "storage.migrate",
            None,
            json!({"phase": "started", "fromVersion": version, "toVersion": SCHEMA_VERSION}),
        );
        let result = Self::migrate_schema(connection);
        record(
            if result.is_ok() { "info" } else { "error" },
            "storage.migrate",
            None,
            json!({"phase": "finished", "fromVersion": version, "toVersion": SCHEMA_VERSION,
                "status": if result.is_ok() { "success" } else { "error" },
                "elapsedMs": started.elapsed().as_millis() as u64,
                "errorCode": result.as_ref().err().map(error_code)}),
        );
        result
    }

    fn migrate_schema(connection: &Connection) -> StoreResult<()> {
        let mut version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::message(format!(
                "capture database schema {version} is newer than supported schema {SCHEMA_VERSION}"
            )));
        }

        while version < SCHEMA_VERSION {
            if version == 0 {
                connection.execute_batch(
                    "BEGIN IMMEDIATE;
                 CREATE TABLE captures (
                    capture_id          TEXT PRIMARY KEY NOT NULL,
                    workspace_path      TEXT,
                    selected_text       TEXT NOT NULL DEFAULT '',
                    note                TEXT NOT NULL DEFAULT '',
                    source_app          TEXT,
                    source_bundle_id    TEXT,
                    source_title        TEXT,
                    source_url          TEXT,
                    capture_method      TEXT NOT NULL CHECK (
                        capture_method IN ('accessibility', 'clipboard', 'none')
                    ),
                    permission_required INTEGER NOT NULL DEFAULT 0 CHECK (
                        permission_required IN (0, 1)
                    ),
                    capture_error       TEXT,
                    state               TEXT NOT NULL CHECK (state IN ('draft', 'saved')),
                    created_at          INTEGER NOT NULL,
                    updated_at          INTEGER NOT NULL,
                    saved_at            INTEGER
                 );
                 CREATE UNIQUE INDEX one_active_capture_draft
                    ON captures(state) WHERE state = 'draft';
                 CREATE INDEX captures_saved_newest
                    ON captures(saved_at DESC) WHERE state = 'saved';
                 PRAGMA user_version = 1;
                 COMMIT;",
                )?;
                version = 1;
            } else if version == 1 {
                connection.execute_batch(
                    "BEGIN IMMEDIATE;
                 CREATE TABLE capture_date_assignments (
                    capture_id TEXT NOT NULL REFERENCES captures(capture_id) ON DELETE CASCADE,
                    diary_date TEXT NOT NULL CHECK (
                        length(diary_date) = 10 AND
                        diary_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                    ),
                    assigned_at INTEGER NOT NULL,
                    PRIMARY KEY (capture_id, diary_date)
                 );
                 CREATE INDEX capture_assignments_by_date
                    ON capture_date_assignments(diary_date, assigned_at, capture_id);
                 CREATE TRIGGER capture_assignments_require_saved_capture
                    BEFORE INSERT ON capture_date_assignments
                    WHEN COALESCE(
                        (SELECT state FROM captures WHERE capture_id = NEW.capture_id),
                        ''
                    ) <> 'saved'
                    BEGIN
                        SELECT RAISE(ABORT, 'capture assignments require a saved capture');
                    END;
                 CREATE TRIGGER capture_assignment_updates_require_saved_capture
                    BEFORE UPDATE OF capture_id ON capture_date_assignments
                    WHEN COALESCE(
                        (SELECT state FROM captures WHERE capture_id = NEW.capture_id),
                        ''
                    ) <> 'saved'
                    BEGIN
                        SELECT RAISE(ABORT, 'capture assignments require a saved capture');
                    END;
                 PRAGMA user_version = 2;
                 COMMIT;",
                )?;
                version = 2;
            } else if version == 2 {
                connection.execute_batch(
                    "BEGIN IMMEDIATE;
                 CREATE TABLE capture_settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                 );
                 PRAGMA user_version = 3;
                 COMMIT;",
                )?;
                version = 3;
            } else if version == 3 {
                let transaction = connection.unchecked_transaction()?;
                transaction.execute_batch("ALTER TABLE captures ADD COLUMN operation_id TEXT;")?;
                // There is at most one active draft. Give a legacy draft one
                // durable context without changing its ID or historical captures.
                transaction.execute(
                    "UPDATE captures SET operation_id = ?1 WHERE state = 'draft'",
                    [OperationContext::new().operation_id.to_string()],
                )?;
                transaction.execute_batch("PRAGMA user_version = 4;")?;
                transaction.commit()?;
                version = 4;
            } else {
                return Err(StoreError::message(format!(
                    "capture database schema {version} has no migration path"
                )));
            }
        }

        Ok(())
    }

    fn lock(&self) -> StoreResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| StoreError::message("capture database lock is unavailable"))
    }

    pub(crate) fn get_shortcut(&self) -> StoreResult<Option<String>> {
        let connection = self.lock()?;
        Ok(connection
            .query_row(
                "SELECT value FROM capture_settings WHERE key = 'shortcut'",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub(crate) fn set_shortcut(&self, shortcut: &str) -> StoreResult<()> {
        let connection = self.lock()?;
        connection.execute(
            "INSERT INTO capture_settings (key, value) VALUES ('shortcut', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [shortcut],
        )?;
        Ok(())
    }

    pub(crate) fn get_draft(&self) -> StoreResult<Option<CaptureDraft>> {
        let connection = self.lock()?;
        get_draft_from_connection(&connection)
    }

    /// Reject a stale or unrelated context before a draft mutation. Missing
    /// rows remain valid for idempotent cancellation, and legacy saved rows
    /// have no operation context to compare.
    pub(crate) fn ensure_operation(
        &self,
        capture_id: &str,
        operation: &OperationContext,
    ) -> StoreResult<()> {
        let connection = self.lock()?;
        let stored: Option<Option<String>> = connection
            .query_row(
                "SELECT operation_id FROM captures WHERE capture_id = ?1",
                [capture_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(Some(stored)) = stored {
            if stored != operation.operation_id.to_string() {
                record(
                    "warn",
                    "capture.operation_mismatch",
                    Some(operation),
                    json!({"status": "rejected", "reason": "stored_operation_differs"}),
                );
                return Err(StoreError::message("capture operation does not match"));
            }
        }
        Ok(())
    }

    /// Insert a new draft unless one already exists. The unique partial index
    /// is the final guard against two rapidly repeated shortcuts replacing a
    /// thought that is already being edited.
    pub(crate) fn create_draft(&self, input: NewDraft) -> StoreResult<CaptureDraft> {
        let started = Instant::now();
        let operation = input.operation.clone();
        let result = self.create_draft_inner(input);
        record(
            if result.is_ok() { "info" } else { "error" },
            "capture.draft",
            Some(&operation),
            json!({"phase": "persist", "status": if result.is_ok() { "success" } else { "error" },
                "draftId": result.as_ref().ok().map(|draft| &draft.draft_id),
                "elapsedMs": started.elapsed().as_millis() as u64,
                "errorCode": result.as_ref().err().map(error_code)}),
        );
        result
    }

    fn create_draft_inner(&self, input: NewDraft) -> StoreResult<CaptureDraft> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;

        if let Some(existing) = get_draft_from_connection(&transaction)? {
            record(
                "info",
                "capture.draft",
                Some(&input.operation),
                json!({"phase": "persist", "status": "reused", "draftId": existing.draft_id, "sameOperation": existing.operation == input.operation}),
            );
            transaction.commit()?;
            return Ok(existing);
        }

        let draft_id = Uuid::new_v4().to_string();
        let now = now_millis();
        transaction.execute(
            "INSERT INTO captures (
                capture_id, selected_text, note, source_app, source_bundle_id,
                source_title, source_url, capture_method, permission_required,
                capture_error, state, created_at, updated_at, operation_id
             ) VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', ?10, ?10, ?11)",
            params![
                draft_id,
                input.selected_text,
                input.source_app,
                input.source_bundle_id,
                input.source_title,
                input.source_url,
                input.capture_method.as_str(),
                input.permission_required,
                input.capture_error,
                now,
                input.operation.operation_id.to_string(),
            ],
        )?;

        let draft = get_draft_from_connection(&transaction)?.ok_or_else(|| {
            StoreError::message("capture draft was not available after it was created")
        })?;
        transaction.commit()?;
        Ok(draft)
    }

    pub(crate) fn update_draft(&self, draft_id: &str, note: &str) -> StoreResult<CaptureDraft> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE captures
             SET note = ?1, updated_at = ?2
             WHERE capture_id = ?3 AND state = 'draft'",
            params![note, now_millis(), draft_id],
        )?;

        if changed == 0 {
            return Err(StoreError::message("capture draft was not found"));
        }

        get_draft_by_id(&connection, draft_id)?.ok_or_else(|| {
            StoreError::message("capture draft was not available after it was updated")
        })
    }

    /// Transition a draft to saved inside one transaction. Retrying the same
    /// ID after a committed save simply returns the saved row, making the
    /// acknowledgement boundary idempotent.
    pub(crate) fn save_draft(&self, draft_id: &str, note: &str) -> StoreResult<Capture> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let existing = get_state(&transaction, draft_id)?;

        match existing.as_deref() {
            Some("saved") => {
                let capture = get_capture_by_id(&transaction, draft_id)?
                    .ok_or_else(|| StoreError::message("saved capture could not be loaded"))?;
                transaction.commit()?;
                Ok(capture)
            }
            Some("draft") => {
                let now = now_millis();
                transaction.execute(
                    "UPDATE captures
                     SET note = ?1, state = 'saved', updated_at = ?2, saved_at = ?2,
                         permission_required = 0, capture_error = NULL
                     WHERE capture_id = ?3 AND state = 'draft'",
                    params![note, now, draft_id],
                )?;
                let capture = get_capture_by_id(&transaction, draft_id)?.ok_or_else(|| {
                    StoreError::message("capture was not available after it was saved")
                })?;
                transaction.commit()?;
                Ok(capture)
            }
            _ => Err(StoreError::message("capture draft was not found")),
        }
    }

    pub(crate) fn cancel_draft(&self, draft_id: &str) -> StoreResult<()> {
        let connection = self.lock()?;
        connection.execute(
            "DELETE FROM captures WHERE capture_id = ?1 AND state = 'draft'",
            params![draft_id],
        )?;
        Ok(())
    }

    pub(crate) fn list_captures(&self) -> StoreResult<Vec<Capture>> {
        let connection = self.lock()?;
        list_captures_from_connection(&connection)
    }

    /// Atomically rebuild the complete capture-to-diary-date index from the
    /// references currently present in every dated Markdown file.
    ///
    /// Every diary date is validated before the transaction mutates the old
    /// index. Duplicate date entries are merged in input order, repeated IDs
    /// are ignored, and dangling or draft capture IDs are skipped because the
    /// Markdown remains the source of truth even when a capture no longer
    /// exists in the archive.
    pub(crate) fn replace_capture_reference_index(
        &self,
        entries: &[CaptureReferenceIndexEntry],
    ) -> StoreResult<()> {
        let mut normalized: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        let mut seen_references = HashSet::new();

        for entry in entries {
            validate_diary_date(&entry.diary_date)?;
            let capture_ids = normalized.entry(entry.diary_date.as_str()).or_default();
            for capture_id in &entry.capture_ids {
                let reference = (entry.diary_date.as_str(), capture_id.as_str());
                if seen_references.insert(reference) {
                    capture_ids.push(capture_id);
                }
            }
        }

        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM capture_date_assignments", [])?;

        let assigned_at = now_millis();
        for (diary_date, capture_ids) in normalized {
            for capture_id in capture_ids {
                transaction.execute(
                    "INSERT INTO capture_date_assignments (
                        capture_id, diary_date, assigned_at
                     )
                     SELECT capture_id, ?2, ?3
                     FROM captures
                     WHERE capture_id = ?1 AND state = 'saved'",
                    params![capture_id, diary_date, assigned_at],
                )?;
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn update_capture_note(&self, capture_id: &str, note: &str) -> StoreResult<Capture> {
        let connection = self.lock()?;
        let changed = connection.execute(
            "UPDATE captures
             SET note = ?1, updated_at = ?2
             WHERE capture_id = ?3 AND state = 'saved'",
            params![note, now_millis(), capture_id],
        )?;
        if changed == 0 {
            return Err(StoreError::message("saved capture was not found"));
        }
        get_capture_by_id(&connection, capture_id)?
            .ok_or_else(|| StoreError::message("capture was not available after it was updated"))
    }

    pub(crate) fn delete_capture(&self, capture_id: &str) -> StoreResult<()> {
        let connection = self.lock()?;
        connection.execute(
            "DELETE FROM captures WHERE capture_id = ?1 AND state = 'saved'",
            params![capture_id],
        )?;
        Ok(())
    }
}

const DRAFT_COLUMNS: &str = "capture_id, selected_text, note, source_app,
    source_bundle_id, source_title, source_url, capture_method,
    permission_required, capture_error, created_at, updated_at, operation_id";

const CAPTURE_COLUMNS: &str = "capture_id, selected_text, note, source_app,
    source_bundle_id, source_title, source_url, capture_method,
    created_at, updated_at, saved_at";

fn list_captures_from_connection(connection: &Connection) -> StoreResult<Vec<Capture>> {
    let mut captures = {
        let mut statement = connection.prepare(&format!(
            "SELECT {CAPTURE_COLUMNS}
             FROM captures
             WHERE state = 'saved'
             ORDER BY saved_at DESC, created_at DESC"
        ))?;
        let rows = statement.query_map([], capture_from_row)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    hydrate_capture_assignments(connection, &mut captures)?;
    Ok(captures)
}

fn hydrate_capture_assignments(
    connection: &Connection,
    captures: &mut [Capture],
) -> StoreResult<()> {
    if captures.is_empty() {
        return Ok(());
    }

    let capture_indexes: HashMap<String, usize> = captures
        .iter()
        .enumerate()
        .map(|(index, capture)| (capture.capture_id.clone(), index))
        .collect();
    let mut statement = connection.prepare(
        "SELECT capture_id, diary_date
         FROM capture_date_assignments
         ORDER BY diary_date ASC, capture_id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    for row in rows {
        let (capture_id, diary_date) = row?;
        if let Some(index) = capture_indexes.get(capture_id.as_str()) {
            captures[*index].assigned_dates.push(diary_date);
        }
    }

    Ok(())
}

fn get_draft_from_connection(connection: &Connection) -> StoreResult<Option<CaptureDraft>> {
    connection
        .query_row(
            &format!("SELECT {DRAFT_COLUMNS} FROM captures WHERE state = 'draft' LIMIT 1"),
            [],
            draft_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn get_draft_by_id(connection: &Connection, draft_id: &str) -> StoreResult<Option<CaptureDraft>> {
    connection
        .query_row(
            &format!(
                "SELECT {DRAFT_COLUMNS}
                 FROM captures WHERE capture_id = ?1 AND state = 'draft'"
            ),
            params![draft_id],
            draft_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn get_capture_by_id(connection: &Connection, capture_id: &str) -> StoreResult<Option<Capture>> {
    let mut capture = connection
        .query_row(
            &format!(
                "SELECT {CAPTURE_COLUMNS}
                 FROM captures WHERE capture_id = ?1 AND state = 'saved'"
            ),
            params![capture_id],
            capture_from_row,
        )
        .optional()
        .map_err(StoreError::from)?;

    if let Some(capture) = capture.as_mut() {
        let mut statement = connection.prepare(
            "SELECT diary_date
             FROM capture_date_assignments
             WHERE capture_id = ?1
             ORDER BY diary_date ASC",
        )?;
        let rows = statement.query_map(params![capture_id], |row| row.get(0))?;
        capture.assigned_dates = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    }

    Ok(capture)
}

fn validate_diary_date(diary_date: &str) -> StoreResult<()> {
    let bytes = diary_date.as_bytes();
    let canonical_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if !canonical_shape {
        return Err(StoreError::message(
            "diary date must be a real date in YYYY-MM-DD format",
        ));
    }

    let year = diary_date[0..4].parse::<u16>().unwrap_or_default();
    let month = diary_date[5..7].parse::<u8>().unwrap_or_default();
    let day = diary_date[8..10].parse::<u8>().unwrap_or_default();
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => 0,
    };

    if year == 0 || day == 0 || day > maximum_day {
        return Err(StoreError::message(
            "diary date must be a real date in YYYY-MM-DD format",
        ));
    }

    Ok(())
}

fn get_state(transaction: &Transaction<'_>, capture_id: &str) -> StoreResult<Option<String>> {
    transaction
        .query_row(
            "SELECT state FROM captures WHERE capture_id = ?1",
            params![capture_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn draft_from_row(row: &Row<'_>) -> rusqlite::Result<CaptureDraft> {
    let operation_id = Uuid::parse_str(&row.get::<_, String>(12)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(CaptureDraft {
        draft_id: row.get(0)?,
        operation: OperationContext { operation_id },
        selected_text: row.get(1)?,
        note: row.get(2)?,
        source_app: row.get(3)?,
        source_bundle_id: row.get(4)?,
        source_title: row.get(5)?,
        source_url: row.get(6)?,
        capture_method: CaptureMethod::from_db(&row.get::<_, String>(7)?)?,
        permission_required: row.get(8)?,
        capture_error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn capture_from_row(row: &Row<'_>) -> rusqlite::Result<Capture> {
    Ok(Capture {
        capture_id: row.get(0)?,
        selected_text: row.get(1)?,
        note: row.get(2)?,
        source_app: row.get(3)?,
        source_bundle_id: row.get(4)?,
        source_title: row.get(5)?,
        source_url: row.get(6)?,
        capture_method: CaptureMethod::from_db(&row.get::<_, String>(7)?)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        saved_at: row.get(10)?,
        assigned_dates: Vec::new(),
    })
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

    fn new_draft(text: &str) -> NewDraft {
        NewDraft {
            operation: OperationContext::new(),
            selected_text: text.to_owned(),
            source_app: Some("Test Reader".to_owned()),
            source_bundle_id: Some("example.reader".to_owned()),
            source_title: Some("A page".to_owned()),
            source_url: Some("https://example.com/page".to_owned()),
            capture_method: CaptureMethod::Accessibility,
            permission_required: false,
            capture_error: None,
        }
    }

    fn save_capture(store: &CaptureStore, text: &str) -> Capture {
        let draft = store.create_draft(new_draft(text)).unwrap();
        store.save_draft(&draft.draft_id, "a thought").unwrap()
    }

    fn capture_with_id<'a>(captures: &'a [Capture], capture_id: &str) -> &'a Capture {
        captures
            .iter()
            .find(|capture| capture.capture_id == capture_id)
            .unwrap()
    }

    fn reference_entry(diary_date: &str, capture_ids: &[&str]) -> CaptureReferenceIndexEntry {
        CaptureReferenceIndexEntry {
            diary_date: diary_date.to_owned(),
            capture_ids: capture_ids
                .iter()
                .map(|capture_id| (*capture_id).to_owned())
                .collect(),
        }
    }

    fn replace_index(store: &CaptureStore, entries: &[CaptureReferenceIndexEntry]) -> Vec<Capture> {
        store.replace_capture_reference_index(entries).unwrap();
        store.list_captures().unwrap()
    }

    #[test]
    fn draft_is_durable_and_only_one_can_be_active() {
        let store = CaptureStore::in_memory().unwrap();
        let first_input = new_draft("first");
        let second_input = new_draft("second");
        assert_ne!(first_input.operation, second_input.operation);
        let original_operation = first_input.operation.clone();
        let first = store.create_draft(first_input).unwrap();
        let second = store.create_draft(second_input).unwrap();
        assert_eq!(first.draft_id, second.draft_id);
        assert_eq!(second.selected_text, "first");
        assert_eq!(first.operation, original_operation);
        assert_eq!(second.operation, original_operation);
        assert_ne!(first.draft_id, first.operation.operation_id.to_string());

        let updated = store.update_draft(&first.draft_id, "my thought").unwrap();
        assert_eq!(updated.note, "my thought");
        assert_eq!(updated.operation, original_operation);
        assert_eq!(store.get_draft().unwrap(), Some(updated));
    }

    #[test]
    fn operation_is_preserved_across_reopen_update_and_save() {
        let directory = std::env::temp_dir().join(format!("diary-operation-{}", Uuid::new_v4()));
        let database = directory.join("captures.sqlite3");
        let draft = {
            let store = CaptureStore::open(&database).unwrap();
            store.create_draft(new_draft("quotation")).unwrap()
        };
        {
            let store = CaptureStore::open(&database).unwrap();
            assert_eq!(store.get_draft().unwrap(), Some(draft.clone()));
            let updated = store.update_draft(&draft.draft_id, "thought").unwrap();
            assert_eq!(updated.operation, draft.operation);
            let saved = store.save_draft(&draft.draft_id, "thought").unwrap();
            assert_eq!(saved.capture_id, draft.draft_id);
            assert_eq!(store.save_draft(&draft.draft_id, "retry").unwrap(), saved);
            let json = serde_json::to_value(saved).unwrap();
            assert!(json.get("operation").is_none());
        }
        {
            let store = CaptureStore::open(&database).unwrap();
            assert!(store.get_draft().unwrap().is_none());
            store
                .ensure_operation(&draft.draft_id, &draft.operation)
                .unwrap();
            assert!(store
                .ensure_operation(&draft.draft_id, &OperationContext::new())
                .is_err());
            let next = store.create_draft(new_draft("next")).unwrap();
            assert_ne!(next.draft_id, draft.draft_id);
            assert_ne!(next.operation, draft.operation);
            assert_ne!(next.draft_id, next.operation.operation_id.to_string());
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn operation_validation_rejects_mismatches_and_allows_missing_rows() {
        let store = CaptureStore::in_memory().unwrap();
        let draft = store.create_draft(new_draft("quotation")).unwrap();
        store
            .ensure_operation(&draft.draft_id, &draft.operation)
            .unwrap();
        assert!(store
            .ensure_operation(&draft.draft_id, &OperationContext::new())
            .is_err());
        store.cancel_draft(&draft.draft_id).unwrap();
        store
            .ensure_operation(&draft.draft_id, &draft.operation)
            .unwrap();

        // SQL failures must not be treated as missing operation contexts.
        store
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE captures;")
            .unwrap();
        assert!(store
            .ensure_operation(&draft.draft_id, &draft.operation)
            .is_err());
    }

    #[test]
    fn save_is_acknowledged_and_idempotent() {
        let store = CaptureStore::in_memory().unwrap();
        let draft = store.create_draft(new_draft("quotation")).unwrap();

        let saved = store.save_draft(&draft.draft_id, "note").unwrap();
        let retry = store.save_draft(&draft.draft_id, "note").unwrap();
        assert_eq!(saved, retry);
        assert!(store.get_draft().unwrap().is_none());
        assert_eq!(store.list_captures().unwrap(), vec![saved]);
    }

    #[test]
    fn archive_note_update_and_delete_are_saved_only() {
        let store = CaptureStore::in_memory().unwrap();
        let draft = store.create_draft(new_draft("")).unwrap();
        assert!(store
            .update_capture_note(&draft.draft_id, "not yet")
            .is_err());

        store.save_draft(&draft.draft_id, "initial").unwrap();
        let updated = store
            .update_capture_note(&draft.draft_id, "revised")
            .unwrap();
        assert_eq!(updated.note, "revised");
        store.delete_capture(&draft.draft_id).unwrap();
        assert!(store.list_captures().unwrap().is_empty());
    }

    #[test]
    fn cancel_is_idempotent() {
        let store = CaptureStore::in_memory().unwrap();
        let draft = store.create_draft(new_draft("quotation")).unwrap();
        store.cancel_draft(&draft.draft_id).unwrap();
        store.cancel_draft(&draft.draft_id).unwrap();
        assert!(store.get_draft().unwrap().is_none());
    }

    #[test]
    fn diary_dates_are_canonical_and_calendar_valid() {
        for valid in [
            "0001-01-01",
            "1904-02-29",
            "2000-02-29",
            "2026-08-11",
            "9999-12-31",
        ] {
            validate_diary_date(valid).unwrap();
        }

        for invalid in [
            "",
            "2026-8-11",
            "11-08-2026",
            "0000-01-01",
            "1900-02-29",
            "2025-02-29",
            "2026-00-01",
            "2026-13-01",
            "2026-04-31",
            "2026-01-00",
            "2026-01-32",
            "2026-01-01Z",
            "2026-a1-01",
        ] {
            assert!(
                validate_diary_date(invalid).is_err(),
                "{invalid} should be rejected"
            );
        }
    }

    #[test]
    fn reference_index_is_a_full_replacement() {
        let store = CaptureStore::in_memory().unwrap();
        let first = save_capture(&store, "first");
        let second = save_capture(&store, "second");

        store
            .replace_capture_reference_index(&[
                reference_entry("2026-08-09", &[&first.capture_id]),
                reference_entry("2026-08-10", &[&second.capture_id]),
            ])
            .unwrap();

        let captures = replace_index(
            &store,
            &[
                reference_entry("2026-08-11", &[&first.capture_id]),
                reference_entry("2026-08-12", &[&second.capture_id]),
            ],
        );
        assert_eq!(
            capture_with_id(&captures, &first.capture_id).assigned_dates,
            ["2026-08-11"]
        );
        assert_eq!(
            capture_with_id(&captures, &second.capture_id).assigned_dates,
            ["2026-08-12"]
        );
    }

    #[test]
    fn reference_index_clears_dates_omitted_from_the_snapshot() {
        let store = CaptureStore::in_memory().unwrap();
        let first = save_capture(&store, "first");
        let second = save_capture(&store, "second");

        store
            .replace_capture_reference_index(&[
                reference_entry("2026-08-11", &[&first.capture_id]),
                reference_entry("2026-08-12", &[&second.capture_id]),
            ])
            .unwrap();
        let captures = replace_index(
            &store,
            &[reference_entry("2026-08-12", &[&second.capture_id])],
        );

        assert!(capture_with_id(&captures, &first.capture_id)
            .assigned_dates
            .is_empty());
        assert_eq!(
            capture_with_id(&captures, &second.capture_id).assigned_dates,
            ["2026-08-12"]
        );

        let captures = replace_index(&store, &[]);
        assert!(captures
            .iter()
            .all(|capture| capture.assigned_dates.is_empty()));
    }

    #[test]
    fn reference_index_allows_many_dates_for_one_capture() {
        let store = CaptureStore::in_memory().unwrap();
        let capture = save_capture(&store, "quotation");

        let captures = replace_index(
            &store,
            &[
                reference_entry("2026-08-10", &[&capture.capture_id]),
                reference_entry("2026-08-11", &[&capture.capture_id]),
                reference_entry("2026-08-12", &[&capture.capture_id]),
            ],
        );
        assert_eq!(
            capture_with_id(&captures, &capture.capture_id).assigned_dates,
            ["2026-08-10", "2026-08-11", "2026-08-12"]
        );
    }

    #[test]
    fn reference_index_merges_duplicate_dates_and_ids() {
        let store = CaptureStore::in_memory().unwrap();
        let first = save_capture(&store, "first");
        let second = save_capture(&store, "second");

        let captures = replace_index(
            &store,
            &[
                reference_entry("2026-08-11", &[&first.capture_id, &first.capture_id]),
                reference_entry(
                    "2026-08-11",
                    &[&first.capture_id, &second.capture_id, &second.capture_id],
                ),
            ],
        );
        assert_eq!(
            capture_with_id(&captures, &first.capture_id).assigned_dates,
            ["2026-08-11"]
        );
        assert_eq!(
            capture_with_id(&captures, &second.capture_id).assigned_dates,
            ["2026-08-11"]
        );

        let connection = store.lock().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM capture_date_assignments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn reference_index_skips_missing_and_unsaved_capture_ids() {
        let store = CaptureStore::in_memory().unwrap();
        let saved = save_capture(&store, "saved");
        let draft = store.create_draft(new_draft("draft")).unwrap();

        let captures = replace_index(
            &store,
            &[reference_entry(
                "2026-08-11",
                &[&saved.capture_id, "missing-capture", &draft.draft_id],
            )],
        );
        assert_eq!(
            capture_with_id(&captures, &saved.capture_id).assigned_dates,
            ["2026-08-11"]
        );

        let connection = store.lock().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM capture_date_assignments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn invalid_reference_index_date_preserves_the_previous_index() {
        let store = CaptureStore::in_memory().unwrap();
        let first = save_capture(&store, "first");
        let second = save_capture(&store, "second");
        store
            .replace_capture_reference_index(&[reference_entry("2026-08-11", &[&first.capture_id])])
            .unwrap();

        assert!(store
            .replace_capture_reference_index(&[
                reference_entry("2026-08-12", &[&second.capture_id]),
                reference_entry("2026-02-30", &[&second.capture_id]),
            ])
            .is_err());

        let captures = store.list_captures().unwrap();
        assert_eq!(
            capture_with_id(&captures, &first.capture_id).assigned_dates,
            ["2026-08-11"]
        );
        assert!(capture_with_id(&captures, &second.capture_id)
            .assigned_dates
            .is_empty());
    }

    #[test]
    fn deleting_a_capture_cascades_its_assignments() {
        let store = CaptureStore::in_memory().unwrap();
        let capture = save_capture(&store, "quotation");
        store
            .replace_capture_reference_index(&[reference_entry(
                "2026-08-11",
                &[&capture.capture_id],
            )])
            .unwrap();

        store.delete_capture(&capture.capture_id).unwrap();
        let connection = store.lock().unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM capture_date_assignments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn fresh_schema_is_current_and_serializes_assigned_dates_as_camel_case() {
        let store = CaptureStore::in_memory().unwrap();
        let capture = save_capture(&store, "quotation");
        let captures = replace_index(
            &store,
            &[reference_entry("2026-08-11", &[&capture.capture_id])],
        );

        let connection = store.lock().unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(connection);

        let json = serde_json::to_value(capture_with_id(&captures, &capture.capture_id)).unwrap();
        assert_eq!(json["assignedDates"], serde_json::json!(["2026-08-11"]));
        assert!(json.get("assigned_dates").is_none());
    }

    #[test]
    fn v1_database_migrates_without_losing_captures() {
        let connection = Connection::open_in_memory().unwrap();
        CaptureStore::configure(&connection).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE captures (
                    capture_id          TEXT PRIMARY KEY NOT NULL,
                    workspace_path      TEXT,
                    selected_text       TEXT NOT NULL DEFAULT '',
                    note                TEXT NOT NULL DEFAULT '',
                    source_app          TEXT,
                    source_bundle_id    TEXT,
                    source_title        TEXT,
                    source_url          TEXT,
                    capture_method      TEXT NOT NULL CHECK (
                        capture_method IN ('accessibility', 'clipboard', 'none')
                    ),
                    permission_required INTEGER NOT NULL DEFAULT 0 CHECK (
                        permission_required IN (0, 1)
                    ),
                    capture_error       TEXT,
                    state               TEXT NOT NULL CHECK (state IN ('draft', 'saved')),
                    created_at          INTEGER NOT NULL,
                    updated_at          INTEGER NOT NULL,
                    saved_at            INTEGER
                 );
                 CREATE UNIQUE INDEX one_active_capture_draft
                    ON captures(state) WHERE state = 'draft';
                 CREATE INDEX captures_saved_newest
                    ON captures(saved_at DESC) WHERE state = 'saved';
                 INSERT INTO captures (
                    capture_id, selected_text, note, capture_method, state,
                    created_at, updated_at, saved_at
                 ) VALUES (
                    'legacy-capture', 'legacy quote', 'legacy thought', 'none',
                    'saved', 1, 2, 2
                 );
                 PRAGMA user_version = 1;",
            )
            .unwrap();

        CaptureStore::migrate(&connection).unwrap();
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let store = CaptureStore {
            connection: Mutex::new(connection),
        };
        let before = store.list_captures().unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].capture_id, "legacy-capture");
        assert!(before[0].assigned_dates.is_empty());

        let after = replace_index(
            &store,
            &[reference_entry("2024-02-29", &["legacy-capture"])],
        );
        assert_eq!(after[0].assigned_dates, ["2024-02-29"]);
    }

    #[test]
    fn v2_migration_preserves_captures_references_and_drafts() {
        let store = CaptureStore::in_memory().unwrap();
        let capture = save_capture(&store, "existing quotation");
        replace_index(
            &store,
            &[reference_entry("2026-09-13", &[&capture.capture_id])],
        );
        let mut draft = store.create_draft(new_draft("draft quotation")).unwrap();
        let before = store.list_captures().unwrap();
        let connection = store.lock().unwrap();
        connection
            .execute_batch(
                "DROP TABLE capture_settings;
                 ALTER TABLE captures DROP COLUMN operation_id;
                 PRAGMA user_version = 2;",
            )
            .unwrap();
        CaptureStore::migrate(&connection).unwrap();
        drop(connection);
        assert_eq!(store.list_captures().unwrap(), before);
        draft.operation = store.get_draft().unwrap().unwrap().operation;
        assert_eq!(store.get_draft().unwrap(), Some(draft));
        assert_eq!(store.get_shortcut().unwrap(), None);
        store.set_shortcut("Alt+Shift+KeyD").unwrap();
        assert_eq!(
            store.get_shortcut().unwrap().as_deref(),
            Some("Alt+Shift+KeyD")
        );
    }

    #[test]
    fn v3_migration_gives_only_the_active_draft_a_durable_context() {
        let directory = std::env::temp_dir().join(format!("diary-migration-{}", Uuid::new_v4()));
        let database = directory.join("captures.sqlite3");
        let (mut legacy_draft, legacy_capture) = {
            let store = CaptureStore::open(&database).unwrap();
            let saved = save_capture(&store, "saved quotation");
            let draft = store.create_draft(new_draft("draft quotation")).unwrap();
            store
                .lock()
                .unwrap()
                .execute_batch(
                    "ALTER TABLE captures DROP COLUMN operation_id;
                 PRAGMA user_version = 3;",
                )
                .unwrap();
            (draft, saved)
        };
        let migrated_draft = {
            let store = CaptureStore::open(&database).unwrap();
            let draft = store.get_draft().unwrap().unwrap();
            assert_ne!(draft.draft_id, draft.operation.operation_id.to_string());
            legacy_draft.operation = draft.operation.clone();
            assert_eq!(draft, legacy_draft);
            assert_eq!(store.list_captures().unwrap(), vec![legacy_capture.clone()]);
            let saved_operation: Option<String> = store
                .lock()
                .unwrap()
                .query_row(
                    "SELECT operation_id FROM captures WHERE capture_id = ?1",
                    [&legacy_capture.capture_id],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(saved_operation.is_none());
            store
                .ensure_operation(&legacy_capture.capture_id, &OperationContext::new())
                .unwrap();
            draft
        };
        {
            let store = CaptureStore::open(&database).unwrap();
            assert_eq!(store.get_draft().unwrap(), Some(migrated_draft));
            assert_eq!(store.list_captures().unwrap(), vec![legacy_capture]);
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shortcut_setting_survives_reopening_and_can_be_replaced() {
        let directory = std::env::temp_dir().join(format!("diary-shortcut-{}", Uuid::new_v4()));
        let database = directory.join("captures.sqlite3");
        {
            let store = CaptureStore::open(&database).unwrap();
            assert_eq!(store.get_shortcut().unwrap(), None);
            store.set_shortcut("Alt+Shift+KeyD").unwrap();
        }
        {
            let store = CaptureStore::open(&database).unwrap();
            assert_eq!(
                store.get_shortcut().unwrap().as_deref(),
                Some("Alt+Shift+KeyD")
            );
            store.set_shortcut("Control+F2").unwrap();
            assert_eq!(store.get_shortcut().unwrap().as_deref(), Some("Control+F2"));
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
