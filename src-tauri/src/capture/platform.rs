use super::models::{CaptureMethod, NewDraft};
use crate::diagnostics::OperationContext;
use tauri_plugin_global_shortcut::Code;

#[derive(Debug, Clone)]
pub(crate) struct FrontmostApplication {
    pub(crate) pid: i32,
    pub(crate) name: Option<String>,
    pub(crate) bundle_id: Option<String>,
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        ffi::c_void,
        mem, ptr, thread,
        time::{Duration, Instant},
    };

    use core_foundation::{
        base::{CFGetTypeID, CFRelease, CFTypeID, CFTypeRef, TCFType},
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
        url::{CFURLRef, CFURL},
    };
    use core_graphics::{
        event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode},
        event_source::{CGEventSource, CGEventSourceStateID},
    };
    use objc2::{
        rc::{autoreleasepool, Retained},
        runtime::ProtocolObject,
    };
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSData, NSString};

    use super::{CaptureMethod, Code, FrontmostApplication, NewDraft, OperationContext};
    use crate::diagnostics::record;
    use serde_json::json;

    const AX_SUCCESS: i32 = 0;
    const MAX_AX_PARENT_DEPTH: usize = 8;
    const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 0.2;
    const MAX_CLIPBOARD_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
    const SHORTCUT_RELEASE_TIMEOUT: Duration = Duration::from_secs(1);
    const SHORTCUT_RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(10);

    type AXUIElementRef = CFTypeRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXUIElementGetTypeID() -> CFTypeID;
        fn AXUIElementCreateApplication(pid: libc::pid_t) -> AXUIElementRef;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> i32;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceKeyState(state_id: CGEventSourceStateID, key: u16) -> bool;
        fn CGEventSourceFlagsState(state_id: CGEventSourceStateID) -> u64;
    }

    struct OwnedAxElement(AXUIElementRef);

    impl OwnedAxElement {
        fn application(pid: i32, operation: &OperationContext) -> Option<Self> {
            let value = unsafe { AXUIElementCreateApplication(pid) };
            Self::from_owned_raw(value, operation)
        }

        fn copy_element(&self, attribute: &str, operation: &OperationContext) -> Option<Self> {
            let value = copy_attribute(self, attribute, operation)?;
            Self::from_owned_raw(value.into_raw(), operation)
        }

        fn from_owned_raw(value: AXUIElementRef, operation: &OperationContext) -> Option<Self> {
            if value.is_null() {
                record(
                    "debug",
                    "capture.accessibility",
                    Some(operation),
                    json!({"phase": "element", "status": "unavailable", "reason": "null_element"}),
                );
                return None;
            }

            let valid_type = unsafe { CFGetTypeID(value) == AXUIElementGetTypeID() };
            let timeout_status = valid_type.then(|| unsafe {
                AXUIElementSetMessagingTimeout(value, AX_MESSAGING_TIMEOUT_SECONDS)
            });
            if timeout_status != Some(AX_SUCCESS) {
                record(
                    "warn",
                    "capture.accessibility",
                    Some(operation),
                    json!({"phase": "messaging_timeout", "status": "error", "reason": if valid_type { "timeout_configuration_failed" } else { "unexpected_element_type" }, "axCode": timeout_status}),
                );
                unsafe { CFRelease(value) };
                return None;
            }

            Some(Self(value))
        }
    }

    impl Drop for OwnedAxElement {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    struct OwnedCfValue(CFTypeRef);

    impl OwnedCfValue {
        fn into_raw(self) -> CFTypeRef {
            let value = self.0;
            mem::forget(self);
            value
        }
    }

    impl Drop for OwnedCfValue {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    #[derive(Default)]
    struct AxContext {
        selected_text: Option<String>,
        title: Option<String>,
        url: Option<String>,
    }

    #[derive(Debug)]
    enum ClipboardSnapshot {
        OriginallyEmpty,
        Items(Vec<Vec<(String, Vec<u8>)>>),
    }

    enum PreparedClipboard {
        OriginallyEmpty,
        Items(Vec<Retained<NSPasteboardItem>>),
    }

    #[derive(Default)]
    struct ClipboardCapture {
        text: Option<String>,
        error: Option<String>,
    }

    pub(crate) fn snapshot_frontmost_application() -> FrontmostApplication {
        autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let Some(application) = workspace.frontmostApplication() else {
                return FrontmostApplication {
                    pid: 0,
                    name: None,
                    bundle_id: None,
                };
            };

            FrontmostApplication {
                pid: application.processIdentifier(),
                name: application.localizedName().map(|value| value.to_string()),
                bundle_id: application
                    .bundleIdentifier()
                    .map(|value| value.to_string()),
            }
        })
    }

    pub(crate) fn capture(
        frontmost: FrontmostApplication,
        shortcut_key: Code,
        operation: OperationContext,
    ) -> NewDraft {
        let trusted = accessibility_is_trusted();
        super::super::observe_permission(trusted, Some(&operation), true);
        if frontmost.pid <= 0 {
            record(
                "warn",
                "capture.accessibility",
                Some(&operation),
                json!({"phase": "source", "status": "skipped", "reason": "source_unavailable"}),
            );
            return NewDraft {
                operation,
                selected_text: String::new(),
                source_app: frontmost.name,
                source_bundle_id: frontmost.bundle_id,
                source_title: None,
                source_url: None,
                capture_method: CaptureMethod::None,
                permission_required: false,
                capture_error: Some(
                    "Bilbo could not identify the source application. You can still save a note-only capture."
                        .to_owned(),
                ),
            };
        }

        if !trusted {
            record(
                "info",
                "capture.accessibility",
                Some(&operation),
                json!({"phase": "permission", "status": "skipped", "reason": "permission_required"}),
            );
            return NewDraft {
                operation,
                selected_text: String::new(),
                source_app: frontmost.name,
                source_bundle_id: frontmost.bundle_id,
                source_title: None,
                source_url: None,
                capture_method: CaptureMethod::None,
                permission_required: true,
                capture_error: Some(
                    "Bilbo needs Accessibility access to capture selected text and page details. You can still save a note-only capture."
                        .to_owned(),
                ),
            };
        }

        let accessibility_started = Instant::now();
        record(
            "info",
            "capture.accessibility",
            Some(&operation),
            json!({"phase": "started", "sourceApp": frontmost.bundle_id}),
        );
        let ax_context = capture_accessibility_context(frontmost.pid, &operation);
        record(
            "info",
            "capture.accessibility",
            Some(&operation),
            json!({"phase": "finished", "status": if ax_context.selected_text.is_some() { "success" } else { "no_selection" },
            "hasSelection": ax_context.selected_text.is_some(), "hasTitle": ax_context.title.is_some(), "hasUrl": ax_context.url.is_some(), "elapsedMs": accessibility_started.elapsed().as_millis() as u64}),
        );
        if let Some(selected_text) = non_empty(ax_context.selected_text) {
            return NewDraft {
                operation,
                selected_text,
                source_app: frontmost.name,
                source_bundle_id: frontmost.bundle_id,
                source_title: non_empty(ax_context.title),
                source_url: normalized_source_url(ax_context.url),
                capture_method: CaptureMethod::Accessibility,
                permission_required: false,
                capture_error: None,
            };
        }

        let clipboard = capture_via_clipboard(frontmost.pid, shortcut_key, &operation);
        let selected_text = non_empty(clipboard.text).unwrap_or_default();
        let method = if selected_text.is_empty() {
            CaptureMethod::None
        } else {
            CaptureMethod::Clipboard
        };
        let error = clipboard.error;

        NewDraft {
            operation,
            selected_text,
            source_app: frontmost.name,
            source_bundle_id: frontmost.bundle_id,
            source_title: non_empty(ax_context.title),
            source_url: normalized_source_url(ax_context.url),
            capture_method: method,
            permission_required: false,
            capture_error: error,
        }
    }

    pub(crate) fn accessibility_is_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    /// Called only after the user asks to enable access. The system prompt is
    /// asynchronous; the return value still reports the current permission.
    pub(crate) fn request_accessibility_access() -> bool {
        if accessibility_is_trusted() {
            return true;
        }
        let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
    }

    fn capture_accessibility_context(pid: i32, operation: &OperationContext) -> AxContext {
        let Some(application) = OwnedAxElement::application(pid, operation) else {
            return AxContext::default();
        };

        let focused_window = application.copy_element("AXFocusedWindow", operation);
        let focused_element = application.copy_element("AXFocusedUIElement", operation);

        let mut context = AxContext::default();
        if let Some(window) = focused_window.as_ref() {
            context.title = copy_string_attribute(window, "AXTitle", operation);
            context.url = copy_string_attribute(window, "AXDocument", operation)
                .or_else(|| copy_string_attribute(window, "AXURL", operation));
        }

        let Some(mut element) = focused_element else {
            return context;
        };

        for _ in 0..MAX_AX_PARENT_DEPTH {
            if context.selected_text.is_none() {
                context.selected_text =
                    copy_string_attribute(&element, "AXSelectedText", operation);
            }
            if context.url.is_none() {
                context.url = copy_string_attribute(&element, "AXDocument", operation)
                    .or_else(|| copy_string_attribute(&element, "AXURL", operation));
            }
            if context.title.is_none() {
                context.title = copy_string_attribute(&element, "AXTitle", operation);
            }

            if context.selected_text.is_some() && context.title.is_some() && context.url.is_some() {
                break;
            }

            let Some(parent) = element.copy_element("AXParent", operation) else {
                break;
            };
            element = parent;
        }

        context
    }

    fn copy_attribute(
        element: &OwnedAxElement,
        attribute: &str,
        operation: &OperationContext,
    ) -> Option<OwnedCfValue> {
        let started = Instant::now();
        let attribute_name = attribute;
        let attribute = CFString::new(attribute);
        let mut value: CFTypeRef = ptr::null();
        let status = unsafe {
            AXUIElementCopyAttributeValue(element.0, attribute.as_concrete_TypeRef(), &mut value)
        };
        let outcome = ax_read_outcome(status, value.is_null());
        record(
            outcome.0,
            "capture.accessibility",
            Some(operation),
            json!({"phase": "attribute", "attribute": attribute_name,
            "status": outcome.1, "axCode": status, "elapsedMs": started.elapsed().as_millis() as u64}),
        );
        (status == AX_SUCCESS && !value.is_null()).then_some(OwnedCfValue(value))
    }

    fn copy_string_attribute(
        element: &OwnedAxElement,
        attribute: &str,
        operation: &OperationContext,
    ) -> Option<String> {
        let value = copy_attribute(element, attribute, operation)?;
        let type_id = unsafe { CFGetTypeID(value.0) };
        let raw = value.into_raw();

        if type_id == CFString::type_id() {
            let value = unsafe { CFString::wrap_under_create_rule(raw as CFStringRef) };
            non_empty(Some(value.to_string()))
        } else if type_id == CFURL::type_id() {
            let value = unsafe { CFURL::wrap_under_create_rule(raw as CFURLRef) };
            non_empty(Some(value.get_string().to_string()))
        } else {
            unsafe { CFRelease(raw) };
            None
        }
    }

    fn ax_read_outcome(status: i32, is_null: bool) -> (&'static str, &'static str) {
        match status {
            AX_SUCCESS if !is_null => ("debug", "success"),
            AX_SUCCESS | -25205 | -25212 => ("debug", "unavailable"),
            _ => ("warn", "error"),
        }
    }

    fn clipboard_step(
        operation: &OperationContext,
        phase: &str,
        status: &str,
        reason: Option<&str>,
        started: Instant,
    ) {
        let level = match status {
            "error" => "error",
            "unsafe" => "warn",
            _ => "info",
        };
        record(
            level,
            "capture.clipboard",
            Some(operation),
            json!({"phase": phase, "status": status, "reason": reason, "elapsedMs": started.elapsed().as_millis() as u64}),
        );
    }

    fn capture_via_clipboard(
        pid: i32,
        shortcut_key: Code,
        operation: &OperationContext,
    ) -> ClipboardCapture {
        let started = Instant::now();
        clipboard_step(operation, "started", "started", None, started);
        autoreleasepool(|_| {
            let pasteboard = NSPasteboard::generalPasteboard();
            let snapshot_change_count = pasteboard.changeCount();
            let snapshot = match snapshot_clipboard(&pasteboard) {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    clipboard_step(
                        operation,
                        "snapshot",
                        "unsafe",
                        Some(clipboard_snapshot_code(&error)),
                        started,
                    );
                    return ClipboardCapture {
                        text: None,
                        error: Some(error),
                    };
                }
            };
            clipboard_step(operation, "snapshot", "success", None, started);
            if pasteboard.changeCount() != snapshot_change_count {
                clipboard_step(
                    operation,
                    "snapshot",
                    "skipped",
                    Some("clipboard_changed"),
                    started,
                );
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "The clipboard changed while Bilbo was snapshotting it, so clipboard capture was skipped."
                            .to_owned(),
                    ),
                };
            }

            // Construct every restoration object before changing the clipboard.
            // If any format cannot be reconstructed, Cmd+C is never sent.
            let restoration_items = match prepare_restoration_items(&snapshot) {
                Ok(items) => items,
                Err(error) => {
                    clipboard_step(
                        operation,
                        "preparation",
                        "unsafe",
                        Some("restoration_preparation_failed"),
                        started,
                    );
                    return ClipboardCapture {
                        text: None,
                        error: Some(error),
                    };
                }
            };
            clipboard_step(operation, "preparation", "success", None, started);

            let release_started = Instant::now();
            if !wait_for_capture_shortcut_release(shortcut_key) {
                clipboard_step(
                    operation,
                    "release_wait",
                    "skipped",
                    Some("shortcut_release_timeout"),
                    release_started,
                );
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "Release the capture shortcut before Bilbo copies the selection."
                            .to_owned(),
                    ),
                };
            }
            clipboard_step(operation, "release_wait", "success", None, release_started);
            if pasteboard.changeCount() != snapshot_change_count {
                clipboard_step(
                    operation,
                    "pre_copy",
                    "skipped",
                    Some("clipboard_changed"),
                    started,
                );
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "The clipboard changed before Bilbo could copy the selection, so clipboard capture was skipped."
                            .to_owned(),
                    ),
                };
            }
            let source_is_still_frontmost = NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .is_some_and(|application| application.processIdentifier() == pid);
            clipboard_step(
                operation,
                "source_frontmost",
                if source_is_still_frontmost {
                    "success"
                } else {
                    "skipped"
                },
                if source_is_still_frontmost {
                    None
                } else {
                    Some("source_changed")
                },
                started,
            );
            if !source_is_still_frontmost {
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "The source application was no longer active, so Bilbo did not copy from another window."
                            .to_owned(),
                    ),
                };
            }
            if let Err(reason) = send_copy_to_frontmost_process() {
                clipboard_step(operation, "copy_posted", "error", Some(reason), started);
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "Bilbo could not send Copy to the source application. You can still save a note-only capture."
                            .to_owned(),
                    ),
                };
            }

            clipboard_step(operation, "copy_posted", "success", None, started);
            let mut copied_text = None;
            let mut copied_change_count = None;
            for delay in [80_u64, 80, 120, 160, 200] {
                thread::sleep(Duration::from_millis(delay));
                let current = pasteboard.changeCount();
                if current == snapshot_change_count {
                    continue;
                }

                match copied_change_count {
                    None => {
                        copied_change_count = Some(current);
                        clipboard_step(operation, "change_observed", "success", None, started);
                    }
                    Some(pinned) if current != pinned => {
                        clipboard_step(
                            operation,
                            "restore",
                            "skipped",
                            Some("clipboard_changed_again"),
                            started,
                        );
                        return ClipboardCapture {
                            text: None,
                            error: Some(
                                "The clipboard changed more than once during capture, so Bilbo left the newer clipboard content untouched."
                                    .to_owned(),
                            ),
                        };
                    }
                    Some(_) => {}
                }
                if let Some(value) = pasteboard.stringForType(unsafe { NSPasteboardTypeString }) {
                    copied_text = non_empty(Some(value.to_string()));
                    if copied_text.is_some() {
                        break;
                    }
                }
            }

            let Some(copied_change_count) = copied_change_count else {
                clipboard_step(
                    operation,
                    "change_observed",
                    "skipped",
                    Some("copy_timeout"),
                    started,
                );
                clipboard_step(
                    operation,
                    "restore",
                    "skipped",
                    Some("clipboard_unchanged"),
                    started,
                );
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "The source application did not place selected text on the clipboard. You can still save a note-only capture."
                            .to_owned(),
                    ),
                };
            };

            // Do not overwrite a clipboard write that occurred after our Copy.
            if pasteboard.changeCount() != copied_change_count {
                clipboard_step(
                    operation,
                    "restore",
                    "skipped",
                    Some("clipboard_changed_again"),
                    started,
                );
                return ClipboardCapture {
                    text: None,
                    error: Some(
                        "The clipboard changed during capture, so Bilbo left the newer clipboard content untouched."
                            .to_owned(),
                    ),
                };
            }

            let restore_started = Instant::now();
            let restore_error = restore_clipboard(&pasteboard, &restoration_items).err();
            clipboard_step(
                operation,
                "restore",
                if restore_error.is_some() {
                    "error"
                } else {
                    "success"
                },
                restore_error.as_ref().map(|_| "restore_write_failed"),
                restore_started,
            );
            record(
                if restore_error.is_some() {
                    "warn"
                } else {
                    "info"
                },
                "capture.clipboard",
                Some(operation),
                json!({"phase": "finished", "status": if copied_text.is_some() { "success" } else { "no_selection" }, "hasSelection": copied_text.is_some(), "restored": restore_error.is_none(), "elapsedMs": started.elapsed().as_millis() as u64}),
            );
            ClipboardCapture {
                text: copied_text,
                error: restore_error,
            }
        })
    }

    fn snapshot_clipboard(pasteboard: &NSPasteboard) -> Result<ClipboardSnapshot, String> {
        let Some(items) = pasteboard.pasteboardItems() else {
            let has_types = pasteboard.types().is_some_and(|types| !types.is_empty());
            if has_types {
                return Err(
                    "Bilbo could not safely snapshot every clipboard item, so clipboard capture was skipped."
                        .to_owned(),
                );
            }
            return Ok(ClipboardSnapshot::OriginallyEmpty);
        };

        if items.is_empty() {
            if pasteboard.types().is_some_and(|types| !types.is_empty()) {
                return Err(
                    "Bilbo could not safely snapshot a legacy or promised clipboard representation, so clipboard capture was skipped."
                        .to_owned(),
                );
            }
            return Ok(ClipboardSnapshot::OriginallyEmpty);
        }

        let mut snapshot_items = Vec::with_capacity(items.len());
        let mut total_bytes = 0_usize;
        for item in items.iter() {
            let types = item.types();
            if types.is_empty() {
                return Err(
                    "Bilbo could not safely snapshot an empty clipboard item, so clipboard capture was skipped."
                        .to_owned(),
                );
            }
            let mut snapshot_types = Vec::with_capacity(types.len());
            for data_type in types.iter() {
                let Some(data) = item.dataForType(&data_type) else {
                    return Err(
                        "Bilbo could not safely snapshot every clipboard format, so clipboard capture was skipped."
                            .to_owned(),
                    );
                };
                total_bytes = total_bytes
                    .checked_add(data.length())
                    .filter(|total| *total <= MAX_CLIPBOARD_SNAPSHOT_BYTES)
                    .ok_or_else(|| {
                        "The clipboard is too large to snapshot safely, so clipboard capture was skipped."
                            .to_owned()
                    })?;
                snapshot_types.push((data_type.to_string(), data.to_vec()));
            }
            snapshot_items.push(snapshot_types);
        }

        Ok(ClipboardSnapshot::Items(snapshot_items))
    }

    fn prepare_restoration_items(
        snapshot: &ClipboardSnapshot,
    ) -> Result<PreparedClipboard, String> {
        let ClipboardSnapshot::Items(snapshot_items) = snapshot else {
            return Ok(PreparedClipboard::OriginallyEmpty);
        };

        let mut items = Vec::with_capacity(snapshot_items.len());
        for snapshot_item in snapshot_items {
            let item = NSPasteboardItem::new();
            for (type_name, bytes) in snapshot_item {
                let data_type = NSString::from_str(type_name);
                let data = unsafe {
                    NSData::dataWithBytes_length(bytes.as_ptr().cast::<c_void>(), bytes.len())
                };
                if !item.setData_forType(&data, &data_type) {
                    return Err(
                        "Bilbo could not safely prepare every clipboard format, so clipboard capture was skipped."
                            .to_owned(),
                    );
                }
            }
            items.push(item);
        }

        if items.len() != snapshot_items.len() || items.is_empty() {
            return Err(
                "Bilbo could not prepare a complete clipboard restoration, so clipboard capture was skipped."
                    .to_owned(),
            );
        }
        Ok(PreparedClipboard::Items(items))
    }

    fn restore_clipboard(
        pasteboard: &NSPasteboard,
        prepared: &PreparedClipboard,
    ) -> Result<(), String> {
        let PreparedClipboard::Items(items) = prepared else {
            pasteboard.clearContents();
            return Ok(());
        };

        let protocol_items: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items
            .iter()
            .map(|item| ProtocolObject::from_ref(&**item))
            .collect();
        let array = NSArray::from_slice(&protocol_items);

        pasteboard.clearContents();
        if pasteboard.writeObjects(&array) {
            Ok(())
        } else {
            Err(
                "Bilbo captured the selection but could not restore the previous clipboard contents."
                    .to_owned(),
            )
        }
    }

    fn send_copy_to_frontmost_process() -> Result<(), &'static str> {
        let down_source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "copy_down_source_failed")?;
        let up_source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| "copy_up_source_failed")?;
        let key_down = CGEvent::new_keyboard_event(down_source, KeyCode::ANSI_C, true)
            .map_err(|_| "copy_down_event_failed")?;
        let key_up = CGEvent::new_keyboard_event(up_source, KeyCode::ANSI_C, false)
            .map_err(|_| "copy_up_event_failed")?;
        key_down.set_flags(CGEventFlags::CGEventFlagCommand);
        key_up.set_flags(CGEventFlags::CGEventFlagCommand);
        key_down.post(CGEventTapLocation::HID);
        key_up.post(CGEventTapLocation::HID);
        Ok(())
    }

    fn clipboard_snapshot_code(error: &str) -> &'static str {
        if error.contains("too large") {
            "snapshot_too_large"
        } else if error.contains("legacy or promised") {
            "snapshot_promised_format"
        } else if error.contains("every clipboard format") {
            "snapshot_format_unavailable"
        } else if error.contains("empty clipboard item") {
            "snapshot_empty_item"
        } else {
            "snapshot_unavailable"
        }
    }

    fn capture_key_code(key: Code) -> Option<u16> {
        Some(match key {
            Code::KeyA => KeyCode::ANSI_A,
            Code::KeyB => KeyCode::ANSI_B,
            Code::KeyC => KeyCode::ANSI_C,
            Code::KeyD => KeyCode::ANSI_D,
            Code::KeyE => KeyCode::ANSI_E,
            Code::KeyF => KeyCode::ANSI_F,
            Code::KeyG => KeyCode::ANSI_G,
            Code::KeyH => KeyCode::ANSI_H,
            Code::KeyI => KeyCode::ANSI_I,
            Code::KeyJ => KeyCode::ANSI_J,
            Code::KeyK => KeyCode::ANSI_K,
            Code::KeyL => KeyCode::ANSI_L,
            Code::KeyM => KeyCode::ANSI_M,
            Code::KeyN => KeyCode::ANSI_N,
            Code::KeyO => KeyCode::ANSI_O,
            Code::KeyP => KeyCode::ANSI_P,
            Code::KeyQ => KeyCode::ANSI_Q,
            Code::KeyR => KeyCode::ANSI_R,
            Code::KeyS => KeyCode::ANSI_S,
            Code::KeyT => KeyCode::ANSI_T,
            Code::KeyU => KeyCode::ANSI_U,
            Code::KeyV => KeyCode::ANSI_V,
            Code::KeyW => KeyCode::ANSI_W,
            Code::KeyX => KeyCode::ANSI_X,
            Code::KeyY => KeyCode::ANSI_Y,
            Code::KeyZ => KeyCode::ANSI_Z,
            Code::Digit0 => KeyCode::ANSI_0,
            Code::Digit1 => KeyCode::ANSI_1,
            Code::Digit2 => KeyCode::ANSI_2,
            Code::Digit3 => KeyCode::ANSI_3,
            Code::Digit4 => KeyCode::ANSI_4,
            Code::Digit5 => KeyCode::ANSI_5,
            Code::Digit6 => KeyCode::ANSI_6,
            Code::Digit7 => KeyCode::ANSI_7,
            Code::Digit8 => KeyCode::ANSI_8,
            Code::Digit9 => KeyCode::ANSI_9,
            Code::F1 => KeyCode::F1,
            Code::F2 => KeyCode::F2,
            Code::F3 => KeyCode::F3,
            Code::F4 => KeyCode::F4,
            Code::F5 => KeyCode::F5,
            Code::F6 => KeyCode::F6,
            Code::F7 => KeyCode::F7,
            Code::F8 => KeyCode::F8,
            Code::F9 => KeyCode::F9,
            Code::F10 => KeyCode::F10,
            Code::F11 => KeyCode::F11,
            Code::F12 => KeyCode::F12,
            _ => return None,
        })
    }

    fn wait_for_capture_shortcut_release(shortcut_key: Code) -> bool {
        let Some(key_code) = capture_key_code(shortcut_key) else {
            return false;
        };
        let deadline = Instant::now() + SHORTCUT_RELEASE_TIMEOUT;
        loop {
            let key_is_down =
                unsafe { CGEventSourceKeyState(CGEventSourceStateID::HIDSystemState, key_code) };
            let flags = unsafe { CGEventSourceFlagsState(CGEventSourceStateID::HIDSystemState) };
            let modifiers = CGEventFlags::CGEventFlagAlternate
                | CGEventFlags::CGEventFlagControl
                | CGEventFlags::CGEventFlagCommand
                | CGEventFlags::CGEventFlagShift;
            let modifiers_are_down = flags & modifiers.bits() != 0;

            if !key_is_down && !modifiers_are_down {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(SHORTCUT_RELEASE_POLL_INTERVAL);
        }
    }

    fn non_empty(value: Option<String>) -> Option<String> {
        value.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_owned())
        })
    }

    fn normalized_source_url(value: Option<String>) -> Option<String> {
        let value = non_empty(value)?;
        let parsed = url::Url::parse(&value).ok()?;
        matches!(parsed.scheme(), "http" | "https" | "file").then(|| parsed.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn unsupported_or_absent_attributes_are_distinct_from_ax_errors() {
            assert_eq!(ax_read_outcome(0, false), ("debug", "success"));
            for status in [0, -25205, -25212] {
                assert_eq!(ax_read_outcome(status, true), ("debug", "unavailable"));
            }
            for status in [-25202, -25204, -25211] {
                assert_eq!(ax_read_outcome(status, true), ("warn", "error"));
            }
        }

        #[test]
        fn every_allowed_capture_key_has_a_release_check() {
            for key in ('A'..='Z')
                .map(|key| format!("Key{key}"))
                .chain((0..=9).map(|key| format!("Digit{key}")))
                .chain((1..=12).map(|key| format!("F{key}")))
            {
                let (_, shortcut) =
                    crate::capture::shortcut::validate_shortcut(&format!("Alt+{key}")).unwrap();
                assert!(capture_key_code(shortcut.key).is_some(), "missing {key}");
            }
            assert_eq!(capture_key_code(Code::KeyC), Some(KeyCode::ANSI_C));
        }

        #[test]
        fn clipboard_restoration_prepares_every_item_and_format() {
            autoreleasepool(|_| {
                let snapshot = ClipboardSnapshot::Items(vec![
                    vec![("public.utf8-plain-text".to_owned(), b"first".to_vec())],
                    vec![
                        ("public.utf8-plain-text".to_owned(), b"second".to_vec()),
                        ("public.html".to_owned(), b"<b>second</b>".to_vec()),
                    ],
                ]);

                let PreparedClipboard::Items(items) = prepare_restoration_items(&snapshot).unwrap()
                else {
                    panic!("a non-empty snapshot must not become an empty restoration");
                };

                assert_eq!(items.len(), 2);
                let plain_text = NSString::from_str("public.utf8-plain-text");
                assert_eq!(
                    items[0].dataForType(&plain_text).unwrap().to_vec(),
                    b"first"
                );
                let html = NSString::from_str("public.html");
                assert_eq!(
                    items[1].dataForType(&html).unwrap().to_vec(),
                    b"<b>second</b>"
                );
            });
        }

        #[test]
        fn empty_clipboard_state_remains_explicit() {
            assert!(matches!(
                prepare_restoration_items(&ClipboardSnapshot::OriginallyEmpty).unwrap(),
                PreparedClipboard::OriginallyEmpty
            ));
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{
    accessibility_is_trusted, capture, request_accessibility_access, snapshot_frontmost_application,
};

#[cfg(not(target_os = "macos"))]
pub(crate) fn snapshot_frontmost_application() -> FrontmostApplication {
    FrontmostApplication {
        pid: 0,
        name: None,
        bundle_id: None,
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture(
    frontmost: FrontmostApplication,
    _shortcut_key: Code,
    operation: OperationContext,
) -> NewDraft {
    super::observe_permission(false, Some(&operation), true);
    crate::diagnostics::record(
        "info",
        "capture.accessibility",
        Some(&operation),
        serde_json::json!({"phase": "platform", "status": "skipped", "reason": "unsupported_platform"}),
    );
    NewDraft {
        operation,
        selected_text: String::new(),
        source_app: frontmost.name,
        source_bundle_id: frontmost.bundle_id,
        source_title: None,
        source_url: None,
        capture_method: CaptureMethod::None,
        permission_required: false,
        capture_error: Some("Context capture is currently supported on macOS only.".to_owned()),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn accessibility_is_trusted() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn request_accessibility_access() -> bool {
    false
}
