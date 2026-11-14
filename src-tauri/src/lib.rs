use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicI32, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    Manager, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

static QUITTING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct PttState {
    enabled: AtomicBool,
    virtual_key: AtomicI32,
    pressed: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PttConfiguration {
    ok: bool,
    error: Option<String>,
}

#[derive(Serialize)]
struct AutoStartStatus {
    supported: bool,
    enabled: bool,
}

fn virtual_key_for_code(code: &str) -> Option<i32> {
    let bytes = code.as_bytes();
    if bytes.len() == 4 && code.starts_with("Key") && bytes[3].is_ascii_uppercase() {
        return Some(bytes[3] as i32);
    }
    if bytes.len() == 6 && code.starts_with("Digit") && bytes[5].is_ascii_digit() {
        return Some(bytes[5] as i32);
    }
    if let Some(number) = code
        .strip_prefix("Numpad")
        .and_then(|value| value.parse::<i32>().ok())
    {
        if (0..=9).contains(&number) {
            return Some(0x60 + number);
        }
    }
    if let Some(number) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<i32>().ok())
    {
        if (1..=24).contains(&number) {
            return Some(0x6f + number);
        }
    }

    Some(match code {
        "Backspace" => 0x08,
        "Tab" => 0x09,
        "Enter" | "NumpadEnter" => 0x0d,
        "Pause" => 0x13,
        "CapsLock" => 0x14,
        "Escape" => 0x1b,
        "Space" => 0x20,
        "PageUp" => 0x21,
        "PageDown" => 0x22,
        "End" => 0x23,
        "Home" => 0x24,
        "ArrowLeft" => 0x25,
        "ArrowUp" => 0x26,
        "ArrowRight" => 0x27,
        "ArrowDown" => 0x28,
        "PrintScreen" => 0x2c,
        "Insert" => 0x2d,
        "Delete" => 0x2e,
        "MetaLeft" => 0x5b,
        "MetaRight" => 0x5c,
        "ContextMenu" => 0x5d,
        "NumpadMultiply" => 0x6a,
        "NumpadAdd" => 0x6b,
        "NumpadSubtract" => 0x6d,
        "NumpadDecimal" => 0x6e,
        "NumpadDivide" => 0x6f,
        "NumLock" => 0x90,
        "ScrollLock" => 0x91,
        "ShiftLeft" => 0xa0,
        "ShiftRight" => 0xa1,
        "ControlLeft" => 0xa2,
        "ControlRight" => 0xa3,
        "AltLeft" => 0xa4,
        "AltRight" => 0xa5,
        "Semicolon" => 0xba,
        "Equal" => 0xbb,
        "Comma" => 0xbc,
        "Minus" => 0xbd,
        "Period" => 0xbe,
        "Slash" => 0xbf,
        "Backquote" => 0xc0,
        "IntlRo" => 0xc1,
        "BracketLeft" => 0xdb,
        "Backslash" => 0xdc,
        "BracketRight" => 0xdd,
        "Quote" => 0xde,
        "IntlBackslash" => 0xe2,
        _ => return None,
    })
}

#[tauri::command]
fn configure_ptt(
    code: String,
    enabled: bool,
    state: tauri::State<'_, Arc<PttState>>,
) -> PttConfiguration {
    if !enabled {
        state.enabled.store(false, Ordering::Relaxed);
        state.pressed.store(false, Ordering::Relaxed);
        return PttConfiguration {
            ok: true,
            error: None,
        };
    }

    let Some(virtual_key) = virtual_key_for_code(&code) else {
        return PttConfiguration {
            ok: false,
            error: Some(
                "Essa tecla ainda não é compatível com o PTT global do protótipo Tauri.".into(),
            ),
        };
    };
    state.virtual_key.store(virtual_key, Ordering::Relaxed);
    state.enabled.store(true, Ordering::Relaxed);
    PttConfiguration {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn get_auto_start(app: tauri::AppHandle) -> AutoStartStatus {
    AutoStartStatus {
        supported: true,
        enabled: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

#[tauri::command]
fn set_auto_start(app: tauri::AppHandle, enabled: bool) -> AutoStartStatus {
    let manager = app.autolaunch();
    let _ = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    AutoStartStatus {
        supported: true,
        enabled: manager.is_enabled().unwrap_or(false),
    }
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_ptt_poller(app: tauri::AppHandle, state: Arc<PttState>) {
    std::thread::spawn(move || loop {
        let pressed = if state.enabled.load(Ordering::Relaxed) {
            #[cfg(windows)]
            unsafe {
                let key = state.virtual_key.load(Ordering::Relaxed);
                (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(key) as u16
                    & 0x8000)
                    != 0
            }
            #[cfg(not(windows))]
            false
        } else {
            false
        };

        if state.pressed.swap(pressed, Ordering::Relaxed) != pressed {
            if let Some(window) = app.get_webview_window("main") {
                let script = format!(
                    "window.dispatchEvent(new CustomEvent('kafcord:ptt-state', {{ detail: {} }}));",
                    pressed
                );
                let _ = window.eval(&script);
            }
        }
        std::thread::sleep(Duration::from_millis(15));
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let ptt_state = Arc::new(PttState::default());
    let managed_ptt_state = ptt_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(managed_ptt_state)
        .invoke_handler(tauri::generate_handler![
            configure_ptt,
            get_auto_start,
            set_auto_start
        ])
        .on_page_load(|window, payload| {
            let url = payload.url();
            let trusted = (url.scheme() == "https"
                && url.host_str() == Some("kafcord.kafly.com.br")
                && url.port_or_known_default() == Some(443))
                || (url.scheme() == "http"
                    && url.host_str() == Some("localhost")
                    && url.port() == Some(3001));
            if trusted {
                let _ = window.eval(include_str!("../bridge.js"));
                if payload.event() == PageLoadEvent::Finished {
                    let _ = window.show();
                }
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            let open = MenuItem::with_id(app, "open", "Abrir KCord", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Encerrar KCord", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("ícone do aplicativo ausente")
                        .clone(),
                )
                .tooltip("KCord Tauri Preview")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        QUITTING.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            start_ptt_poller(app.handle().clone(), ptt_state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("não foi possível iniciar o KCord Tauri Preview");
}
