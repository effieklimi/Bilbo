mod capture;
mod diagnostics;
mod launch_at_login;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    diagnostics::install_panic_reporting();
    let mut context = tauri::generate_context!();
    let login_launch =
        std::env::args_os().any(|argument| argument == launch_at_login::AUTOSTART_ARGUMENT);
    launch_at_login::configure_startup(context.config_mut(), login_launch);

    let mut app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        capture::handle_shortcut(app, shortcut);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let log_path = app.path().app_data_dir()?.join("diagnostics.sqlite3");
            diagnostics::initialize_storage(&log_path);
            let bundled = std::env::current_exe().ok().is_some_and(|p| p.components().any(|c| c.as_os_str().to_string_lossy().ends_with(".app")));
            #[cfg(target_os = "macos")]
            let os_version = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()
                .filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
            #[cfg(not(target_os = "macos"))]
            let os_version: Option<String> = None;
            let system = serde_json::json!({
                "appVersion":app.package_info().version.to_string(), "buildId":env!("DIARY_BUILD_ID"),
                "os":std::env::consts::OS, "osVersion":os_version, "arch":std::env::consts::ARCH,
                "bundleId":app.config().identifier, "bundled":bundled, "debugBuild":cfg!(debug_assertions),
                "loginArgumentPresent":std::env::args_os().any(|a| a == launch_at_login::AUTOSTART_ARGUMENT)
            });
            diagnostics::native_state("system", system.clone());
            diagnostics::record("info", "app.started", None, system);
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_autostart::Builder::new()
                    .app_name(app.config().identifier.clone())
                    .arg(launch_at_login::AUTOSTART_ARGUMENT)
                    .build(),
            )?;
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_process::init())?;
            app.manage(launch_at_login::LaunchAtLoginState::default());

            let database_path = app.path().app_data_dir()?.join("captures.sqlite3");
            let capture_state =
                capture::CaptureState::open(&database_path).map_err(std::io::Error::other)?;
            app.manage(capture_state);
            capture::install_capture_window_lifecycle(app.handle());

            capture::register_capture_shortcut(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capture::get_capture_draft,
            capture::update_capture_draft,
            capture::save_capture,
            capture::cancel_capture,
            capture::list_captures,
            capture::replace_capture_reference_index,
            capture::update_capture_note,
            capture::delete_capture,
            capture::open_capture_source,
            capture::get_capture_permission_status,
            capture::open_accessibility_settings,
            capture::get_capture_shortcut_status,
            capture::set_capture_shortcut,
            capture::set_capture_shortcut_recording,
            capture::begin_app_update,
            capture::end_app_update,
            launch_at_login::get_launch_at_login,
            launch_at_login::set_launch_at_login,
            diagnostics::record_diagnostics,
            diagnostics::publish_diagnostic_state,
            diagnostics::get_diagnostic_logs,
            diagnostics::copy_debug_report,
        ])
        .build(context)
        .unwrap_or_else(|error| {
            diagnostics::record("error", "app.setup_failed", None, serde_json::json!({"errorCode":diagnostics::error_code(&error)}));
            diagnostics::flush_persistence(std::time::Duration::from_millis(500));
            panic!("error while building tauri application: {error}");
        });

    #[cfg(target_os = "macos")]
    if login_launch {
        // Tao activates the application as its event loop starts. Suppress that
        // first activation, then restore normal Dock behavior once it is ready.
        app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    }

    app.run(move |app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            diagnostics::flush_persistence(std::time::Duration::from_millis(500));
        }
        if matches!(event, tauri::RunEvent::Ready) {
            diagnostics::record("info", "app.ready", None, serde_json::json!({}));
        }
        #[cfg(target_os = "macos")]
        if login_launch && matches!(event, tauri::RunEvent::Ready) {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Regular);
        }

        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(main_window) = app_handle.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
        }

        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}
