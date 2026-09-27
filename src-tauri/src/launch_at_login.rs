use crate::diagnostics::{error_code, native_state, record, OperationContext};
use serde_json::json;
use std::{sync::Mutex, time::Instant};

use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

pub const AUTOSTART_ARGUMENT: &str = "--autostart";

// Keep reads and changes ordered without blocking the app's main thread.
#[derive(Default)]
pub struct LaunchAtLoginState(Mutex<()>);

pub fn configure_startup(config: &mut tauri::Config, launch_at_login: bool) {
    if launch_at_login {
        if let Some(main_window) = config
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
        {
            main_window.visible = false;
            main_window.focus = false;
        }
    }
}

#[tauri::command]
pub async fn get_launch_at_login(
    app: AppHandle,
    operation: Option<OperationContext>,
) -> Result<bool, String> {
    let started = Instant::now();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LaunchAtLoginState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "Could not read Launch at login.".to_string())?;
        read_registration(&app)
    })
    .await
    .map_err(|_| "Could not read Launch at login: worker failed.".to_owned())
    .and_then(|result| result);
    report_result("read", operation.as_ref(), None, &result, started);
    result
}

#[tauri::command]
pub async fn set_launch_at_login(
    app: AppHandle,
    enabled: bool,
    operation: Option<OperationContext>,
) -> Result<bool, String> {
    let started = Instant::now();
    let worker_operation = operation.clone();
    record(
        "info",
        "settings.change",
        operation.as_ref(),
        json!({"phase": "requested", "setting": "launch_at_login", "requestedEnabled": enabled}),
    );
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<LaunchAtLoginState>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "Could not change Launch at login.".to_string())?;

        #[cfg(desktop)]
        {
            if enabled {
                #[cfg(target_os = "macos")]
                {
                    let executable = std::env::current_exe()
                        .and_then(|path| path.canonicalize())
                        .map_err(|error| format!("Could not locate Bilbo: {error}"))?;
                    if !is_bundled_executable(&executable) {
                        return Err("Open the Bilbo app to enable Launch at login.".to_string());
                    }
                }

                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            }
            .map_err(|error| format!("Could not change Launch at login: {error}"))?;

            let readback = read_registration(&app);
            report_result(
                "readback",
                worker_operation.as_ref(),
                Some(enabled),
                &readback,
                started,
            );
            let registered = readback?;
            if registered != enabled {
                return Err("Launch at login did not change. Please try again.".to_string());
            }
            Ok(registered)
        }

        #[cfg(not(desktop))]
        {
            let _ = enabled;
            Err("Launch at login is not available on this device.".to_string())
        }
    })
    .await
    .map_err(|_| "Could not change Launch at login: worker failed.".to_owned())
    .and_then(|result| result);
    report_result(
        "finished",
        operation.as_ref(),
        Some(enabled),
        &result,
        started,
    );
    result
}

fn read_registration(app: &AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        app.autolaunch()
            .is_enabled()
            .map_err(|error| format!("Could not read Launch at login: {error}"))
    }

    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("Launch at login is not available on this device.".to_string())
    }
}

fn report_result(
    phase: &str,
    operation: Option<&OperationContext>,
    requested: Option<bool>,
    result: &Result<bool, String>,
    started: Instant,
) {
    if let Ok(enabled) = result {
        native_state(
            "launchAtLogin",
            json!({"enabled": enabled, "stateKnown": true}),
        );
    }
    record(
        if result.is_err() {
            "error"
        } else if requested.is_some() {
            "info"
        } else {
            "debug"
        },
        "settings.change",
        operation,
        json!({"setting": "launch_at_login", "phase": phase, "status": if result.is_ok() { "success" } else { "error" },
            "requestedEnabled": requested, "actualEnabled": result.as_ref().ok(), "errorCode": result.as_ref().err().map(error_code),
            "elapsedMs": started.elapsed().as_millis() as u64}),
    );
}

pub fn refresh_diagnostic_state(app: &AppHandle) {
    let state = app.state::<LaunchAtLoginState>();
    let Ok(_guard) = state.0.try_lock() else {
        native_state(
            "launchAtLogin",
            json!({"enabled": null, "stateKnown": false}),
        );
        record(
            "warn",
            "diagnostics.collection_failed",
            None,
            json!({"section": "launchAtLogin", "errorCode": "registration_busy"}),
        );
        return;
    };
    match read_registration(app) {
        Ok(enabled) => native_state(
            "launchAtLogin",
            json!({"enabled": enabled, "stateKnown": true}),
        ),
        Err(error) => {
            native_state(
                "launchAtLogin",
                json!({"enabled": null, "stateKnown": false}),
            );
            record(
                "error",
                "diagnostics.collection_failed",
                None,
                json!({"section": "launchAtLogin", "errorCode": error_code(error)}),
            );
        }
    }
}

#[cfg(target_os = "macos")]
fn is_bundled_executable(executable: &std::path::Path) -> bool {
    let Some(macos) = executable.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|extension| extension == "app")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window_config() -> tauri::Config {
        let mut config = tauri::Config::default();
        config.app.windows = vec![
            tauri::utils::config::WindowConfig {
                label: "main".to_string(),
                ..Default::default()
            },
            tauri::utils::config::WindowConfig {
                label: "capture".to_string(),
                visible: false,
                ..Default::default()
            },
        ];
        config
    }

    #[test]
    fn login_launch_starts_hidden_without_changing_capture() {
        let mut config = window_config();
        configure_startup(&mut config, true);
        assert!(!config.app.windows[0].visible);
        assert!(!config.app.windows[0].focus);
        assert!(!config.app.windows[1].visible);
    }

    #[test]
    fn manual_launch_keeps_main_visible() {
        let mut config = window_config();
        configure_startup(&mut config, false);
        assert!(config.app.windows[0].visible);
        assert!(config.app.windows[0].focus);
        assert!(!config.app.windows[1].visible);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn autostart_requires_an_app_bundle_instead_of_a_dev_binary() {
        use std::path::Path;

        assert!(is_bundled_executable(Path::new(
            "/Applications/Bilbo.app/Contents/MacOS/diary"
        )));
        assert!(!is_bundled_executable(Path::new(
            "/project/src-tauri/target/debug/diary"
        )));
        assert!(!is_bundled_executable(Path::new(
            "/project/app.data/Contents/MacOS/diary"
        )));
        assert!(!is_bundled_executable(Path::new(
            "/project/Bilbo.app/other/MacOS/diary"
        )));
    }
}
