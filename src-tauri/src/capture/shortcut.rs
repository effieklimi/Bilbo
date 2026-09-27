use crate::diagnostics::{error_code, record, OperationContext};
use serde_json::json;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use super::models::CaptureShortcutStatus;

pub(crate) const DEFAULT_SHORTCUT: &str = "Alt+KeyC";

/// Keep persisted shortcuts independent of aliases and modifier ordering.
pub(crate) fn validate_shortcut(value: &str) -> Result<(String, Shortcut), String> {
    let mut modifiers = Modifiers::empty();
    let mut key = None;
    for token in value.split('+').map(str::trim) {
        if key.is_some() || token.is_empty() {
            return Err("Use modifiers followed by one letter, number, or F1–F12 key.".to_owned());
        }
        let modifier = match token.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => Some(Modifiers::CONTROL),
            "alt" | "option" => Some(Modifiers::ALT),
            "shift" => Some(Modifiers::SHIFT),
            "super" | "meta" | "cmd" | "command" => Some(Modifiers::SUPER),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if modifiers.contains(modifier) {
                return Err("Each modifier can only appear once.".to_owned());
            }
            modifiers.insert(modifier);
        } else {
            let normalized = token.to_ascii_uppercase();
            let letter = normalized.strip_prefix("KEY").unwrap_or(&normalized);
            let digit = normalized.strip_prefix("DIGIT").unwrap_or(&normalized);
            let code = if letter.len() == 1 && letter.as_bytes()[0].is_ascii_uppercase() {
                format!("Key{letter}")
            } else if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
                format!("Digit{digit}")
            } else if normalized
                .strip_prefix('F')
                .and_then(|number| number.parse::<u8>().ok())
                .is_some_and(|number| (1..=12).contains(&number))
            {
                normalized
            } else {
                return Err("Use a letter, number, or F1–F12 key.".to_owned());
            };
            key = Some(
                code.parse::<Shortcut>()
                    .map_err(|_| "Use a letter, number, or F1–F12 key.".to_owned())?
                    .key,
            );
        }
    }
    let key = key.ok_or_else(|| "Add a letter, number, or F1–F12 key.".to_owned())?;
    if !modifiers.intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER) {
        return Err("Include Control, Option, or Command in the shortcut.".to_owned());
    }
    if modifiers.intersects(Modifiers::CONTROL | Modifiers::SUPER)
        && (matches!(key, Code::KeyK)
            || (!modifiers.contains(Modifiers::ALT)
                && matches!(
                    key,
                    Code::KeyQ
                        | Code::KeyW
                        | Code::KeyA
                        | Code::KeyC
                        | Code::KeyV
                        | Code::KeyX
                        | Code::KeyZ
                )))
    {
        return Err("That shortcut is reserved. Choose another combination.".to_owned());
    }
    let mut tokens = Vec::new();
    for (modifier, name) in [
        (Modifiers::CONTROL, "Control"),
        (Modifiers::ALT, "Alt"),
        (Modifiers::SHIFT, "Shift"),
        (Modifiers::SUPER, "Super"),
    ] {
        if modifiers.contains(modifier) {
            tokens.push(name.to_owned());
        }
    }
    tokens.push(key.to_string());
    Ok((tokens.join("+"), Shortcut::new(Some(modifiers), key)))
}

pub(crate) trait ShortcutRegistry {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}

/// Reserve the candidate before releasing the working shortcut. If saving fails,
/// restore the previous registration and leave its persisted preference intact.
pub(crate) fn change_shortcut(
    status: &mut CaptureShortcutStatus,
    value: &str,
    registry: &mut impl ShortcutRegistry,
    operation: Option<&OperationContext>,
    persist: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let (canonical, candidate) = validate_shortcut(value).map_err(|error| {
        record(
            "warn",
            "shortcut.registration",
            operation,
            json!({"phase": "validate", "status": "rejected", "reason": "invalid_shortcut"}),
        );
        error
    })?;
    let previous = status
        .available
        .then(|| validate_shortcut(&status.shortcut).map(|(_, shortcut)| shortcut))
        .transpose()?;
    if previous == Some(candidate) {
        record(
            "info",
            "shortcut.registration",
            operation,
            json!({"phase": "change", "status": "unchanged", "shortcut": canonical}),
        );
        return Ok(());
    }
    registry.register(candidate).map_err(|error| {
        record("warn", "shortcut.registration", operation, json!({"phase": "candidate_register", "status": "unavailable", "shortcut": canonical, "errorCode": error_code(error)}));
        "That shortcut is unavailable. It may be used by another app. Choose another combination."
            .to_owned()
    })?;
    record(
        "info",
        "shortcut.registration",
        operation,
        json!({"phase": "candidate_register", "status": "success", "shortcut": canonical}),
    );
    if let Some(previous) = previous {
        if let Err(error) = registry.unregister(previous) {
            let cleanup = registry.unregister(candidate);
            record(
                "error",
                "shortcut.registration",
                operation,
                json!({"phase": "previous_unregister", "status": "error", "errorCode": error_code(error), "cleanedUp": cleanup.is_ok()}),
            );
            return Err(if cleanup.is_ok() {
                "Bilbo could not change the shortcut. Your previous shortcut is still active."
                    .to_owned()
            } else {
                "Bilbo could not finish changing the shortcut. Restart Bilbo before trying again."
                    .to_owned()
            });
        }
    }
    if let Err(error) = persist(&canonical) {
        let restored = previous.is_none_or(|previous| registry.register(previous).is_ok());
        let cleaned_up = registry.unregister(candidate).is_ok();
        record(
            "error",
            "shortcut.registration",
            operation,
            json!({"phase": "persist_rollback", "status": "error", "errorCode": error_code(error), "restored": restored, "cleanedUp": cleaned_up}),
        );
        if !restored {
            status.available = false;
            status.error = Some("Restart Bilbo to restore the capture shortcut.".to_owned());
        }
        return Err(if restored && cleaned_up {
            "Bilbo could not save the shortcut. Your previous setting was kept.".to_owned()
        } else {
            "Bilbo could not save the shortcut. Restart Bilbo to restore your previous setting."
                .to_owned()
        });
    }
    record(
        "info",
        "shortcut.registration",
        operation,
        json!({"phase": "persist", "status": "success", "shortcut": canonical}),
    );
    *status = CaptureShortcutStatus {
        shortcut: canonical,
        available: true,
        error: None,
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[derive(Default)]
    struct Registry {
        registered: HashSet<Shortcut>,
        blocked: HashSet<Shortcut>,
        cannot_unregister: HashSet<Shortcut>,
    }

    impl ShortcutRegistry for Registry {
        fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
            if self.blocked.contains(&shortcut) || !self.registered.insert(shortcut) {
                Err("conflict".to_owned())
            } else {
                Ok(())
            }
        }

        fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
            if self.cannot_unregister.contains(&shortcut) {
                Err("cannot unregister".to_owned())
            } else {
                self.registered.remove(&shortcut);
                Ok(())
            }
        }
    }

    fn current() -> (CaptureShortcutStatus, Registry) {
        let (_, shortcut) = validate_shortcut(DEFAULT_SHORTCUT).unwrap();
        (
            CaptureShortcutStatus {
                shortcut: DEFAULT_SHORTCUT.to_owned(),
                available: true,
                error: None,
            },
            Registry {
                registered: HashSet::from([shortcut]),
                ..Registry::default()
            },
        )
    }

    #[test]
    fn aliases_and_order_normalize_to_stable_keys() {
        assert_eq!(validate_shortcut("Option+C").unwrap().0, DEFAULT_SHORTCUT);
        assert_eq!(
            validate_shortcut("Cmd+Shift+Ctrl+Alt+d").unwrap().0,
            "Control+Alt+Shift+Super+KeyD"
        );
        assert_eq!(
            validate_shortcut("Meta+Alt+1").unwrap().0,
            "Alt+Super+Digit1"
        );
        assert_eq!(validate_shortcut("Ctrl+F12").unwrap().0, "Control+F12");
    }

    #[test]
    fn rejects_incomplete_unsupported_or_reserved_shortcuts() {
        for value in [
            "",
            "C",
            "Shift+C",
            "Alt",
            "Alt+Alt+C",
            "Alt+C+D",
            "C+Alt",
            "Alt+Enter",
            "Alt+F13",
            "Control+K",
            "Alt+Super+K",
            "Super+Q",
            "Control+Shift+C",
            "Super+Shift+Z",
        ] {
            assert!(validate_shortcut(value).is_err(), "accepted {value}");
        }
        assert!(validate_shortcut("Alt+Super+C").is_ok());
    }

    #[test]
    fn former_zoom_reset_chords_can_be_capture_shortcuts() {
        for value in ["Super+0", "Super+Shift+0", "Control+0", "Control+Shift+0"] {
            assert!(validate_shortcut(value).is_ok(), "rejected {value}");
        }
    }

    #[test]
    fn conflict_keeps_previous_registration_and_does_not_save() {
        let (mut status, mut registry) = current();
        let old_status = status.clone();
        registry
            .blocked
            .insert(validate_shortcut("Alt+D").unwrap().1);
        assert!(
            change_shortcut(&mut status, "Alt+D", &mut registry, None, |_| {
                panic!("a conflicting shortcut must not be saved")
            })
            .is_err()
        );
        assert_eq!(status, old_status);
        assert_eq!(registry.registered.len(), 1);
        assert!(registry
            .registered
            .contains(&validate_shortcut(DEFAULT_SHORTCUT).unwrap().1));
    }

    #[test]
    fn persistence_failure_restores_the_working_shortcut() {
        let (mut status, mut registry) = current();
        let old_status = status.clone();
        assert!(
            change_shortcut(&mut status, "Alt+D", &mut registry, None, |_| {
                Err("disk full".to_owned())
            })
            .is_err()
        );
        assert_eq!(status, old_status);
        assert_eq!(
            registry.registered,
            HashSet::from([validate_shortcut(DEFAULT_SHORTCUT).unwrap().1])
        );
    }

    #[test]
    fn unregister_failure_keeps_previous_registration_without_saving() {
        let (mut status, mut registry) = current();
        let old_status = status.clone();
        registry
            .cannot_unregister
            .insert(validate_shortcut(DEFAULT_SHORTCUT).unwrap().1);
        assert!(
            change_shortcut(&mut status, "Alt+D", &mut registry, None, |_| {
                panic!("a failed registration change must not be saved")
            })
            .is_err()
        );
        assert_eq!(status, old_status);
        assert_eq!(registry.registered.len(), 1);
    }

    #[test]
    fn successful_change_replaces_registration_and_persists_canonical_value() {
        let (mut status, mut registry) = current();
        let mut saved = None;
        change_shortcut(&mut status, "Shift+Alt+d", &mut registry, None, |value| {
            saved = Some(value.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(saved.as_deref(), Some("Alt+Shift+KeyD"));
        assert_eq!(status.shortcut, "Alt+Shift+KeyD");
        assert!(status.available);
        assert_eq!(
            registry.registered,
            HashSet::from([validate_shortcut("Alt+Shift+D").unwrap().1])
        );
    }

    #[test]
    fn unavailable_saved_shortcut_can_be_retried() {
        let (mut status, _) = current();
        status.available = false;
        status.error = Some("unavailable".to_owned());
        let mut registry = Registry::default();
        change_shortcut(&mut status, DEFAULT_SHORTCUT, &mut registry, None, |_| {
            Ok(())
        })
        .unwrap();
        assert!(status.available);
        assert!(status.error.is_none());
    }
}
