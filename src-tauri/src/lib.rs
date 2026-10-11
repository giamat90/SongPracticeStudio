mod commands;
mod library;
mod lyrics;
mod sidecar;
mod storage;
mod takes;
mod windows;

#[cfg(test)]
mod integration_tests;
#[cfg(test)]
mod test_util;

use commands::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SidecarState(std::sync::Mutex::new(None)))
        .manage(windows::WindowMemory::load())
        .invoke_handler(tauri::generate_handler![
            commands::process_song,
            commands::import_youtube,
            commands::export_stem,
            commands::export_all,
            commands::list_songs,
            commands::delete_song,
            commands::rename_song,
            commands::set_song_loops,
            commands::set_metronome_offset,
            commands::list_folders,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::reorder_folders,
            commands::move_songs,
            commands::save_take,
            commands::list_takes,
            commands::delete_take,
            commands::rename_take,
            commands::set_take_manual_offset,
            commands::export_take,
            commands::export_mix,
            commands::read_song_chords,
            commands::read_bass_tab,
            commands::export_file,
            commands::pitch_shift_song,
            commands::load_lyrics,
            commands::sync_lyrics,
            commands::find_lyrics,
            commands::delete_lyrics,
            windows::detach_panel,
            windows::dock_panel,
            windows::close_detached_panel,
            windows::cursor_over_main,
            windows::close_detached_windows,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Panels detached from the main window must not outlive it.
            if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                        windows::close_all(&handle);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
