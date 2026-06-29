use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

/// Messages received from the Python sidecar (JSON lines on stdout).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum SidecarMessage {
    #[serde(rename = "ready")]
    Ready,
    #[serde(rename = "progress")]
    Progress {
        cmd: Option<String>,
        value: f32,
        stage: String,
    },
    #[serde(rename = "result")]
    Result {
        cmd: String,
        data: serde_json::Value,
    },
    #[serde(rename = "error")]
    Error {
        cmd: Option<String>,
        message: String,
        traceback: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "bye")]
    Bye,
}

/// Manages the Python sidecar subprocess.
pub struct SidecarManager {
    child: Child,
    stdin: Mutex<std::process::ChildStdin>,
    rx: mpsc::Receiver<SidecarMessage>,
}

impl SidecarManager {
    /// Spawn the Python sidecar and wait for the "ready" message.
    ///
    /// Resolution order:
    ///   1. `python main.py` via venv — dev / local `cargo build` run
    ///   2. PyInstaller binary next to the exe — installed NSIS/DMG app
    pub fn spawn() -> Result<Self, String> {
        let mut cmd = if let Ok(sidecar_dir) = Self::find_sidecar_dir() {
            // Dev / local build: run `python main.py` from the source tree.
            let main_py = sidecar_dir.join("main.py");
            let python = Self::find_python(&sidecar_dir);
            log::info!("Spawning sidecar: {} {}", python.display(), main_py.display());
            let mut c = Command::new(&python);
            c.arg(&main_py).current_dir(&sidecar_dir);
            c
        } else if let Some(binary) = Self::find_sidecar_binary() {
            // Installed app: run the self-contained PyInstaller binary.
            log::info!("Spawning sidecar binary: {}", binary.display());
            let mut c = Command::new(&binary);
            if let Some(dir) = binary.parent() {
                c.current_dir(dir);
            }
            c
        } else {
            return Err("Sidecar not found: no main.py in source tree and no song-analyzer-sidecar binary next to exe".to_string());
        };

        // Suppress the console window that would otherwise flash on Windows.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

        let stdout = child.stdout.take().ok_or("No stdout from sidecar")?;
        let child_stdin = child.stdin.take().ok_or("No stdin to sidecar")?;

        let (tx, rx) = mpsc::channel();

        // Reader thread: parse JSON lines from stdout and send through channel
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::error!("Sidecar stdout read error: {e}");
                        break;
                    }
                };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<SidecarMessage>(trimmed) {
                    Ok(msg) => {
                        if tx.send(msg).is_err() {
                            break; // receiver dropped
                        }
                    }
                    Err(e) => {
                        log::warn!("Sidecar sent unparseable JSON: {trimmed} ({e})");
                    }
                }
            }
            log::info!("Sidecar reader thread exiting");
        });

        let manager = Self {
            child,
            stdin: Mutex::new(child_stdin),
            rx,
        };

        // Wait for "ready" message
        let msg = manager
            .recv_timeout(Duration::from_secs(30))
            .map_err(|e| format!("Sidecar did not send ready: {e}"))?;

        match msg {
            SidecarMessage::Ready => {
                log::info!("Sidecar is ready");
                Ok(manager)
            }
            other => Err(format!("Expected ready, got: {other:?}")),
        }
    }

    /// Send a JSON command to the sidecar's stdin.
    pub fn send_command(&self, cmd: &serde_json::Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|e| format!("stdin lock: {e}"))?;
        let json = serde_json::to_string(cmd).map_err(|e| format!("JSON serialize: {e}"))?;
        writeln!(stdin, "{json}").map_err(|e| format!("stdin write: {e}"))?;
        stdin.flush().map_err(|e| format!("stdin flush: {e}"))?;
        Ok(())
    }

    /// Receive the next message from the sidecar (blocking with timeout).
    pub fn recv_timeout(&self, timeout: Duration) -> Result<SidecarMessage, String> {
        self.rx
            .recv_timeout(timeout)
            .map_err(|e| format!("recv: {e}"))
    }

    /// Gracefully shut down the sidecar.
    pub fn shutdown(&mut self) {
        let _ = self.send_command(&serde_json::json!({"cmd": "quit"}));
        std::thread::sleep(Duration::from_millis(500));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// Look for the PyInstaller binary next to the running exe (installed-app path).
    /// Tauri strips the target-triple suffix when bundling, so the installed name is
    /// just `song-analyzer-sidecar[.exe]`. We also check the triple-suffixed name as a fallback.
    fn find_sidecar_binary() -> Option<std::path::PathBuf> {
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let candidates: &[&str] = if cfg!(windows) {
            &[
                "song-analyzer-sidecar.exe",
                "song-analyzer-sidecar-x86_64-pc-windows-msvc.exe",
            ]
        } else if cfg!(target_os = "macos") {
            &[
                "song-analyzer-sidecar",
                "song-analyzer-sidecar-aarch64-apple-darwin",
                "song-analyzer-sidecar-x86_64-apple-darwin",
            ]
        } else {
            &[
                "song-analyzer-sidecar",
                "song-analyzer-sidecar-x86_64-unknown-linux-gnu",
            ]
        };
        candidates.iter().map(|n| exe_dir.join(n)).find(|p| p.exists())
    }

    /// Return the venv Python when present, otherwise fall back to the system `python`.
    /// Used only on the dev / local-build path (when no PyInstaller binary is found).
    fn find_python(sidecar_dir: &std::path::Path) -> std::path::PathBuf {
        let candidates = if cfg!(windows) {
            vec![sidecar_dir.join(".venv/Scripts/python.exe")]
        } else {
            vec![
                sidecar_dir.join(".venv/bin/python3"),
                sidecar_dir.join(".venv/bin/python"),
            ]
        };
        for p in candidates {
            if p.exists() {
                log::info!("Using venv Python: {}", p.display());
                return p;
            }
        }
        std::path::PathBuf::from("python")
    }

    /// Find the sidecar source directory containing `main.py`.
    /// Used only on the dev / local-build path.
    fn find_sidecar_dir() -> Result<std::path::PathBuf, String> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(target_dir) = exe.parent() {
                let candidates = [
                    target_dir.join("../../../sidecar"), // from target/debug/
                    target_dir.join("../../sidecar"),    // from target/
                    target_dir.join("../sidecar"),       // from src-tauri/
                    target_dir.join("sidecar"),          // next to exe
                ];
                for candidate in &candidates {
                    let resolved = candidate
                        .canonicalize()
                        .unwrap_or_else(|_| candidate.clone());
                    if resolved.join("main.py").exists() {
                        return Ok(resolved);
                    }
                }
            }
        }

        let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
        for rel in ["sidecar", "../sidecar"] {
            let p = cwd.join(rel);
            if p.join("main.py").exists() {
                return p.canonicalize().map_err(|e| format!("canonicalize: {e}"));
            }
        }

        Err("Could not find sidecar directory".to_string())
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}
