//! The in-app YouTube sign-in lives in mps-core's `mps-youtube-signin` crate
//! (shared with VPS). This file only binds it to this app's data directory and
//! to the two commands the frontend calls.

use tauri::AppHandle;

use crate::storage;

#[tauri::command]
pub async fn sign_in_youtube(app: AppHandle) -> Result<String, String> {
    let path = mps_youtube_signin::sign_in(&app, &storage::app_data_dir()).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn sign_out_youtube() -> Result<(), String> {
    mps_youtube_signin::sign_out(&storage::app_data_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;

    #[test]
    fn signing_out_removes_the_cookies_file_from_this_apps_data_dir() {
        let home = TestHome::new();
        let path = mps_youtube_signin::cookies_path(home.path());
        std::fs::write(&path, "x").unwrap();
        tauri::async_runtime::block_on(sign_out_youtube()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn signing_out_leaves_a_cookies_file_the_user_chose_alone() {
        let home = TestHome::new();
        let theirs = home.path().join("www.youtube.com_cookies.txt");
        std::fs::write(&theirs, "mine").unwrap();
        tauri::async_runtime::block_on(sign_out_youtube()).unwrap();
        assert!(theirs.exists());
    }
}
