use serde::{Deserialize, Serialize};

use crate::diagnostics::OperationContext;

/// How Bilbo obtained the quoted text for a capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMethod {
    Accessibility,
    Clipboard,
    None,
}

impl CaptureMethod {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::Clipboard => "clipboard",
            Self::None => "none",
        }
    }

    pub(crate) fn from_db(value: &str) -> rusqlite::Result<Self> {
        match value {
            "accessibility" => Ok(Self::Accessibility),
            "clipboard" => Ok(Self::Clipboard),
            "none" => Ok(Self::None),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid capture method: {other}").into(),
            )),
        }
    }
}

/// The durable, editable object displayed by the capture window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDraft {
    pub draft_id: String,
    pub operation: OperationContext,
    pub selected_text: String,
    pub note: String,
    pub source_app: Option<String>,
    pub source_bundle_id: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub capture_method: CaptureMethod,
    pub permission_required: bool,
    pub capture_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A completed capture returned by the archive commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub capture_id: String,
    pub selected_text: String,
    pub note: String,
    pub source_app: Option<String>,
    pub source_bundle_id: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub capture_method: CaptureMethod,
    pub created_at: i64,
    pub updated_at: i64,
    pub saved_at: i64,
    /// Canonical diary dates (`YYYY-MM-DD`) whose Markdown references this capture.
    pub assigned_dates: Vec<String>,
}

/// The complete set of capture references found in one dated diary file.
///
/// The reference index command accepts a complete collection of these entries
/// and atomically replaces its rebuildable SQLite index from that snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReferenceIndexEntry {
    pub diary_date: String,
    pub capture_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewDraft {
    pub operation: OperationContext,
    pub selected_text: String,
    pub source_app: Option<String>,
    pub source_bundle_id: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub capture_method: CaptureMethod,
    pub permission_required: bool,
    pub capture_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureShortcutStatus {
    pub shortcut: String,
    pub available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePermissionStatus {
    pub accessibility_trusted: bool,
}
