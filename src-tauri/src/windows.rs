//! Detached panels: a panel dragged out of the main window gets a window of its
//! own. The window handling (allowlist check, remembered position, docking) is
//! in mps-core's `mps-detached-windows` crate, shared with SPS; this module is
//! SPS's list of panels and its Tauri commands.

use mps_detached_windows::{PanelSpec, WindowMemory};
use tauri::{AppHandle, WebviewWindow};

use crate::storage;

/// Mirrors `DETACHABLE_PANELS` in src/windows/protocol.ts (a contract test compares them).
const PANELS: &[PanelSpec] = &[
    PanelSpec { id: "chords", title: "Chords", width: 620.0, height: 260.0 },
    PanelSpec { id: "lyrics", title: "Lyrics", width: 560.0, height: 640.0 },
    PanelSpec { id: "takes", title: "Takes", width: 420.0, height: 560.0 },
];

/// Where each panel window last was, read from SPS's data directory.
pub fn load_memory() -> WindowMemory {
    WindowMemory::load(PANELS, &storage::app_data_dir())
}

pub fn close_all(app: &AppHandle) {
    mps_detached_windows::close_all(app, PANELS);
    mps_youtube_signin::close(app);
}

/// `x` and `y` are where the user let go (logical, screen coordinates). Without
/// them the window goes where it was last, if that is still on a monitor.
#[tauri::command]
pub async fn detach_panel(
    app: AppHandle,
    panel_id: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    mps_detached_windows::detach_panel(&app, PANELS, panel_id, x, y).await
}

/// Closes the window that asked, which docks its panel again in the main window.
#[tauri::command]
pub async fn dock_panel(window: WebviewWindow) -> Result<(), String> {
    mps_detached_windows::dock_panel(PANELS, window).await
}

/// Closes one panel's window from the main window (hiding the panel in the menu).
#[tauri::command]
pub async fn close_detached_panel(app: AppHandle, panel_id: String) -> Result<(), String> {
    mps_detached_windows::close_detached_panel(&app, PANELS, &panel_id).await
}

/// Is the mouse pointer over the main window right now? Asked of the OS in
/// physical screen pixels, so a drag that ends over the main window docks the
/// panel without any DPI conversion of coordinates the webview reports.
#[tauri::command]
pub async fn cursor_over_main(app: AppHandle) -> Result<bool, String> {
    mps_detached_windows::cursor_over_main(&app).await
}

/// Close every detached window (leaving the analyzer page ends them).
#[tauri::command]
pub async fn close_detached_windows(app: AppHandle) -> Result<(), String> {
    close_all(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mps_detached_windows::{is_detached_label, plan, MIN_HEIGHT, MIN_WIDTH};

    #[test]
    fn plans_a_window_for_each_panel_of_the_analyzer() {
        for spec in PANELS {
            let p = plan(PANELS, spec.id).unwrap();
            assert_eq!(p.label, format!("detached-{}", spec.id));
            assert!(p.width >= f64::from(MIN_WIDTH) && p.height >= f64::from(MIN_HEIGHT), "{}", spec.id);
        }
    }

    #[test]
    fn refuses_anything_else_so_a_caller_cannot_choose_a_label() {
        for bad in ["", "waveform", "main", "Chords", "chords ", "../main", "chords/../x", "detached-chords"] {
            assert!(plan(PANELS, bad).is_err(), "{bad:?} must not be detachable");
        }
    }

    #[test]
    fn only_our_own_labels_count_as_detached() {
        for spec in PANELS {
            assert!(is_detached_label(PANELS, &format!("detached-{}", spec.id)));
        }
        for other in ["main", "detached-", "detached-waveform", "xdetached-lyrics", "detached-lyrics-2"] {
            assert!(!is_detached_label(PANELS, other), "{other:?}");
        }
    }

    #[test]
    fn the_panel_ids_are_unique() {
        let mut ids: Vec<&str> = PANELS.iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), PANELS.len());
    }
}
