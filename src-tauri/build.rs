fn main() {
    // Ensure the sidecar placeholder exists so tauri_build doesn't error on externalBin.
    // CI overwrites this with the real PyInstaller binary before cargo runs.
    // Local dev never reaches this binary at runtime (find_sidecar_dir finds main.py first).
    let bin_dir = std::path::Path::new("binaries");
    if !bin_dir.exists() {
        std::fs::create_dir_all(bin_dir).ok();
    }
    let sidecar_name = if cfg!(target_os = "windows") {
        "song-analyzer-sidecar-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_arch = "aarch64") {
        "song-analyzer-sidecar-aarch64-apple-darwin"
    } else {
        "song-analyzer-sidecar-x86_64-unknown-linux-gnu"
    };
    let sidecar_path = bin_dir.join(sidecar_name);
    if !sidecar_path.exists() {
        std::fs::write(&sidecar_path, b"").ok();
    }

    tauri_build::build()
}
