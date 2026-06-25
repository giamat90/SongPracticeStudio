mod commands;
mod library;
mod sidecar;
mod storage;

use commands::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::process_song,
            commands::import_youtube,
            commands::export_stem,
            commands::pitch_shift_song,
            commands::list_songs,
            commands::delete_song,
            commands::save_take,
            commands::list_takes,
            commands::delete_take,
            commands::load_analysis,
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
