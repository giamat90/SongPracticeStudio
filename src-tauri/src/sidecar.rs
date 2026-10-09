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
    Ready {
        #[serde(default)]
        advisory: Option<String>,
    },
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
            return Err("Sidecar not found: no main.py in source tree and no song-practice-studio-sidecar binary next to exe".to_string());
        };

        // Force UTF-8 on the sidecar's stdio. Rust writes the JSON-lines protocol
        // as UTF-8; without this Python decodes stdin using the Windows console
        // codepage (e.g. cp1252), which mangles any non-ASCII character in a file
        // path and makes ffprobe fail with a misleading "ffmpeg was not found".
        cmd.env("PYTHONUTF8", "1").env("PYTHONIOENCODING", "utf-8");

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
            SidecarMessage::Ready { advisory } => {
                log::info!("Sidecar is ready");
                if let Some(advisory) = advisory {
                    log::warn!("{advisory}");
                }
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
    /// just `song-practice-studio-sidecar[.exe]`. We also check the triple-suffixed name as a fallback.
    fn find_sidecar_binary() -> Option<std::path::PathBuf> {
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let candidates: &[&str] = if cfg!(windows) {
            &[
                "song-practice-studio-sidecar.exe",
                "song-practice-studio-sidecar-x86_64-pc-windows-msvc.exe",
            ]
        } else if cfg!(target_os = "macos") {
            &[
                "song-practice-studio-sidecar",
                "song-practice-studio-sidecar-aarch64-apple-darwin",
                "song-practice-studio-sidecar-x86_64-apple-darwin",
            ]
        } else {
            &[
                "song-practice-studio-sidecar",
                "song-practice-studio-sidecar-x86_64-unknown-linux-gnu",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;
    use crate::test_util::sidecar_unavailable;

    fn parse(line: &str) -> Result<SidecarMessage, serde_json::Error> {
        serde_json::from_str(line)
    }

    // ── wire format ───────────────────────────────────────────────────────

    #[test]
    fn parses_ready_with_and_without_an_advisory() {
        assert!(matches!(parse(r#"{"type":"ready"}"#).unwrap(), SidecarMessage::Ready { advisory: None }));
        assert!(matches!(parse(r#"{"type":"ready","advisory":null}"#).unwrap(), SidecarMessage::Ready { advisory: None }));
        match parse(r#"{"type":"ready","advisory":"yt-dlp is old"}"#).unwrap() {
            SidecarMessage::Ready { advisory } => assert_eq!(advisory.as_deref(), Some("yt-dlp is old")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_progress() {
        match parse(r#"{"type":"progress","cmd":"process","stage":"stem-separation","value":0.25}"#).unwrap() {
            SidecarMessage::Progress { cmd, value, stage } => {
                assert_eq!(cmd.as_deref(), Some("process"));
                assert_eq!(stage, "stem-separation");
                assert!((value - 0.25).abs() < 1e-6);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_result_with_arbitrary_data() {
        match parse(r#"{"type":"result","cmd":"process","data":{"stems":{"vocals":"/v.wav"},"duration":3.5}}"#).unwrap() {
            SidecarMessage::Result { cmd, data } => {
                assert_eq!(cmd, "process");
                assert_eq!(data["duration"], 3.5);
                assert_eq!(data["stems"]["vocals"], "/v.wav");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_errors_with_optional_command_and_traceback() {
        match parse(r#"{"type":"error","message":"Invalid JSON: x"}"#).unwrap() {
            SidecarMessage::Error { cmd, message, traceback } => {
                assert!(cmd.is_none() && traceback.is_none());
                assert_eq!(message, "Invalid JSON: x");
            }
            other => panic!("{other:?}"),
        }
        match parse(r#"{"type":"error","cmd":"process","message":"boom","traceback":"Traceback..."}"#).unwrap() {
            SidecarMessage::Error { cmd, traceback, .. } => {
                assert_eq!(cmd.as_deref(), Some("process"));
                assert_eq!(traceback.as_deref(), Some("Traceback..."));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn parses_pong_and_bye() {
        assert!(matches!(parse(r#"{"type":"pong"}"#).unwrap(), SidecarMessage::Pong));
        assert!(matches!(parse(r#"{"type":"bye"}"#).unwrap(), SidecarMessage::Bye));
    }

    #[test]
    fn rejects_unknown_types_and_malformed_lines() {
        assert!(parse(r#"{"type":"mystery"}"#).is_err());
        assert!(parse(r#"{"no_type":1}"#).is_err());
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"type":"progress","stage":"x"}"#).is_err(), "value is required");
    }

    #[test]
    fn every_message_the_python_side_sends_is_known_to_rust() {
        let main_py = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/main.py")).unwrap();
        let mut sent: Vec<String> = main_py
            .split("\"type\": \"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap().to_string())
            .collect();
        sent.sort();
        sent.dedup();
        assert!(!sent.is_empty());
        for kind in sent {
            let line = match kind.as_str() {
                "progress" => r#"{"type":"progress","value":0.0,"stage":"s"}"#.to_string(),
                "result" => r#"{"type":"result","cmd":"c","data":{}}"#.to_string(),
                "error" => r#"{"type":"error","message":"m"}"#.to_string(),
                other => format!(r#"{{"type":"{other}"}}"#),
            };
            assert!(parse(&line).is_ok(), "Rust cannot parse the \"{kind}\" message main.py sends");
        }
    }

    #[test]
    fn messages_survive_a_serde_round_trip() {
        let m = SidecarMessage::Progress { cmd: None, value: 0.5, stage: "x".into() };
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains(r#""type":"progress""#));
        assert!(matches!(parse(&json).unwrap(), SidecarMessage::Progress { .. }));
    }

    // ── interpreter discovery ─────────────────────────────────────────────

    #[test]
    fn find_python_prefers_the_venv_interpreter() {
        let home = TestHome::new();
        let bin = if cfg!(windows) { home.path().join(".venv/Scripts") } else { home.path().join(".venv/bin") };
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join(if cfg!(windows) { "python.exe" } else { "python3" });
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(SidecarManager::find_python(home.path()), exe);
    }

    #[test]
    fn find_python_falls_back_to_the_system_interpreter() {
        let home = TestHome::new();
        assert_eq!(SidecarManager::find_python(home.path()), std::path::PathBuf::from("python"));
    }

    #[test]
    fn the_source_tree_sidecar_is_found_from_the_test_binary() {
        let dir = SidecarManager::find_sidecar_dir().expect("sidecar dir");
        assert!(dir.join("main.py").exists());
    }

    // ── live process ──────────────────────────────────────────────────────

    fn next_non_progress(m: &SidecarManager, secs: u64) -> SidecarMessage {
        loop {
            match m.recv_timeout(Duration::from_secs(secs)).expect("sidecar reply") {
                SidecarMessage::Progress { .. } => continue,
                other => return other,
            }
        }
    }

    fn send_raw(m: &SidecarManager, line: &str) {
        let mut stdin = m.stdin.lock().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    #[test]
    fn the_real_sidecar_speaks_the_protocol_and_survives_bad_input() {
        let home = TestHome::new();
        // The sidecar caches its yt-dlp freshness check under ~; keep it out of the real home.
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOME", home.path());

        let m = match SidecarManager::spawn() {
            Ok(m) => m,
            Err(e) => return sidecar_unavailable(&e),
        };

        m.send_command(&serde_json::json!({"cmd": "ping"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Pong));

        send_raw(&m, "this is not json");
        match next_non_progress(&m, 30) {
            SidecarMessage::Error { message, .. } => assert!(message.contains("Invalid JSON"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }

        m.send_command(&serde_json::json!({"cmd": "definitely_not_a_command"})).unwrap();
        match next_non_progress(&m, 30) {
            SidecarMessage::Error { message, .. } => assert!(message.contains("Unknown command"), "{message}"),
            other => panic!("expected an error, got {other:?}"),
        }

        // A command that raises inside Python comes back as an error with the command name and a traceback,
        // and does not take the loop down.
        m.send_command(&serde_json::json!({"cmd": "convert_take", "recordingPath": "/no/such/file.webm", "outputPath": "/x.wav"})).unwrap();
        match next_non_progress(&m, 60) {
            SidecarMessage::Error { cmd, traceback, .. } => {
                assert_eq!(cmd.as_deref(), Some("convert_take"));
                assert!(traceback.is_some());
            }
            other => panic!("expected an error, got {other:?}"),
        }

        m.send_command(&serde_json::json!({"cmd": "convert_take"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Error { .. }), "missing argument is an error, not a crash");

        m.send_command(&serde_json::json!({"cmd": "ping"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Pong), "still alive after the errors");

        m.send_command(&serde_json::json!({"cmd": "quit"})).unwrap();
        assert!(matches!(next_non_progress(&m, 30), SidecarMessage::Bye));
    }

    #[test]
    fn non_ascii_paths_reach_the_sidecar_intact() {
        let home = TestHome::new();
        std::env::set_var("USERPROFILE", home.path());
        std::env::set_var("HOME", home.path());
        let m = match SidecarManager::spawn() {
            Ok(m) => m,
            Err(e) => return sidecar_unavailable(&e),
        };
        let dir = home.path().join("Música – 日本語");
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("tono.wav");
        crate::test_util::write_wav(&wav, &crate::test_util::tones(&[(440.0, 0.5)], 22050, 1.0), 22050);
        let out = dir.join("salida.wav");

        m.send_command(&serde_json::json!({
            "cmd": "convert_take", "recordingPath": wav.to_string_lossy(), "outputPath": out.to_string_lossy(),
        }))
        .unwrap();
        match next_non_progress(&m, 120) {
            SidecarMessage::Result { data, .. } => assert_eq!(data["path"], out.to_string_lossy().to_string()),
            other => panic!("a UTF-8 path must round-trip (PYTHONUTF8 is forced by spawn): {other:?}"),
        }
        assert!(out.exists());
    }
}
