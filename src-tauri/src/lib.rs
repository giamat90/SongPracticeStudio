mod commands;
mod library;
mod sidecar;
mod storage;
mod takes;

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
        .invoke_handler(tauri::generate_handler![
            commands::process_song,
            commands::import_youtube,
            commands::export_stem,
            commands::export_all,
            commands::list_songs,
            commands::delete_song,
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
            commands::pitch_shift_song,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
