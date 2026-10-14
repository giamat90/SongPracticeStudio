//! Signing in to YouTube inside the app, so the user never has to export a
//! cookies.txt by hand. A throwaway private-mode window shows Google's own
//! sign-in page; once the session cookies exist they are written in the
//! Netscape format yt-dlp reads, and the window is closed.
//!
//! The window loads a remote page, so it is treated as untrusted: it may only
//! navigate to Google's own domains (including its country domains), and `may_invoke` keeps it away from every
//! command of this app (the app has no per-command ACL of its own).

use std::path::Path;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::storage;

pub const LABEL: &str = "youtube-signin";
/// The cookies file this module writes, inside the app data directory.
pub const COOKIES_FILE: &str = "youtube_cookies.txt";

const SIGN_IN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";
const POLL: Duration = Duration::from_secs(1);
/// After the session appears, YouTube is still setting its own cookies for a moment.
const SETTLE: Duration = Duration::from_secs(2);
const TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_READ_FAILURES: u32 = 5;

/// Hosts the sign-in window may navigate to: the sign-in flow, YouTube, and the
/// static hosts they pull pages from. Anything else is refused.
const NAVIGATION_SUFFIXES: [&str; 7] = [
    "google.com",
    "youtube.com",
    "gstatic.com",
    "googleusercontent.com",
    "googleapis.com",
    "ggpht.com",
    "ytimg.com",
];
/// Only these domains' cookies are kept; yt-dlp needs nothing else.
const COOKIE_SUFFIXES: [&str; 2] = ["google.com", "youtube.com"];

/// One cookie, reduced to what the Netscape file needs.
#[derive(Debug, Clone, PartialEq)]
pub struct CookieRecord {
    pub domain: String,
    pub path: String,
    pub name: String,
    pub value: String,
    pub secure: bool,
    pub http_only: bool,
    /// Unix seconds; `None` for a session cookie.
    pub expires: Option<i64>,
}

fn host_matches(host: &str, suffixes: &[&str]) -> bool {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    suffixes.iter().any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn is_country_code(label: &str) -> bool {
    label.len() == 2 && label.bytes().all(|b| b.is_ascii_lowercase())
}

/// Google sends sign-in to the user's country domain (accounts.google.it,
/// www.google.co.uk, google.com.br). Only the shapes Google really uses are
/// accepted: the brand followed by `cc`, `com.cc` or `co.cc`.
fn is_country_domain(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    ["google", "youtube"].iter().any(|brand| {
        labels.iter().enumerate().any(|(i, label)| {
            label == brand
                && match &labels[i + 1..] {
                    [cc] => is_country_code(cc),
                    ["com" | "co", cc] => is_country_code(cc),
                    _ => false,
                }
        })
    })
}

pub fn host_allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| host_matches(h, &NAVIGATION_SUFFIXES) || is_country_domain(h))
}

/// The sign-in window runs someone else's page, so none of this app's commands are open to it.
pub fn may_invoke(webview_label: &str) -> bool {
    webview_label != LABEL
}

pub fn keep_cookie(c: &CookieRecord) -> bool {
    host_matches(&c.domain, &COOKIE_SUFFIXES)
}

/// A real Google session on YouTube: the login marker plus one of the session
/// cookies. An anonymous visit sets only visitor cookies (`PREF`, `YSC`, ...).
pub fn is_signed_in(cookies: &[CookieRecord]) -> bool {
    let on_youtube = |name: &str| {
        cookies
            .iter()
            .any(|c| c.name == name && host_matches(&c.domain, &["youtube.com"]) && !c.value.is_empty())
    };
    on_youtube("LOGIN_INFO")
        && ["SAPISID", "__Secure-3PAPISID", "__Secure-3PSID", "SID"].iter().any(|n| on_youtube(n))
}

fn is_clean(field: &str) -> bool {
    !field.contains(['\t', '\n', '\r'])
}

/// yt-dlp's cookie file. A cookie whose fields would break the one-line,
/// tab-separated format is left out rather than written in a corrupt form.
pub fn to_netscape(cookies: &[CookieRecord]) -> String {
    let mut out = String::from(
        "# Netscape HTTP Cookie File\n\
         # Written by Vocal Practice Studio's YouTube sign-in. It holds a live Google session: do not share it.\n",
    );
    for c in cookies {
        if ![&c.domain, &c.path, &c.name, &c.value].iter().all(|f| is_clean(f)) {
            log::warn!("Left out a cookie whose fields cannot be written to a cookies file");
            continue;
        }
        let prefix = if c.http_only { "#HttpOnly_" } else { "" };
        let subdomains = if c.domain.starts_with('.') { "TRUE" } else { "FALSE" };
        let secure = if c.secure { "TRUE" } else { "FALSE" };
        out.push_str(&format!(
            "{prefix}{}\t{subdomains}\t{}\t{secure}\t{}\t{}\t{}\n",
            c.domain,
            c.path,
            c.expires.unwrap_or(0),
            c.name,
            c.value,
        ));
    }
    out
}

fn record_from(c: &tauri::webview::Cookie<'_>) -> Option<CookieRecord> {
    Some(CookieRecord {
        domain: c.domain()?.to_string(),
        path: c.path().unwrap_or("/").to_string(),
        name: c.name().to_string(),
        value: c.value().to_string(),
        secure: c.secure().unwrap_or(false),
        http_only: c.http_only().unwrap_or(false),
        expires: c.expires_datetime().map(|d| d.unix_timestamp()),
    })
}

fn read_cookies(window: &WebviewWindow) -> Result<Vec<CookieRecord>, String> {
    let all = window.cookies().map_err(|e| format!("Read the sign-in cookies: {e}"))?;
    Ok(all.iter().filter_map(record_from).filter(keep_cookie).collect())
}

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("Write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Move {} into place: {e}", path.display()))
}

fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

fn wait_for_sign_in(app: &AppHandle, window: &WebviewWindow, path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + TIMEOUT;
    let mut failures = 0;
    loop {
        if !is_open(app) {
            return Err("Sign-in cancelled.".to_string());
        }
        if Instant::now() > deadline {
            return Err("Sign-in timed out. Try again.".to_string());
        }
        match read_cookies(window) {
            Ok(cookies) if is_signed_in(&cookies) => {
                std::thread::sleep(SETTLE);
                let settled = read_cookies(window)?;
                write_atomic(path, &to_netscape(&settled))?;
                log::info!("YouTube sign-in saved {} cookies", settled.len());
                return Ok(());
            }
            Ok(_) => failures = 0,
            Err(e) => {
                if !is_open(app) {
                    return Err("Sign-in cancelled.".to_string());
                }
                failures += 1;
                log::warn!("{e}");
                if failures >= MAX_READ_FAILURES {
                    return Err(e);
                }
            }
        }
        std::thread::sleep(POLL);
    }
}

/// Opens the sign-in window and returns the path of the cookies file once the
/// user has signed in. Async because reading cookies deadlocks on Windows when
/// done from the main thread.
#[tauri::command]
pub async fn sign_in_youtube(app: AppHandle) -> Result<String, String> {
    if let Some(existing) = app.get_webview_window(LABEL) {
        if let Err(e) = existing.set_focus() {
            log::warn!("Could not focus the sign-in window: {e}");
        }
        return Err("The YouTube sign-in window is already open.".to_string());
    }
    let url: Url = SIGN_IN_URL.parse().map_err(|e| format!("Sign-in address: {e}"))?;
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Sign in to YouTube")
        .inner_size(520.0, 720.0)
        .incognito(true)
        .on_navigation(|url| {
            let allowed = host_allowed(url);
            if !allowed {
                log::warn!("Refused the sign-in window's navigation to {}", url.host_str().unwrap_or("?"));
            }
            allowed
        })
        .build()
        .map_err(|e| format!("Open the sign-in window: {e}"))?;

    let path = storage::app_data_dir().join(COOKIES_FILE);
    let watcher = app.clone();
    let handle = window.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || wait_for_sign_in(&watcher, &handle, &path))
        .await
        .map_err(|e| format!("Sign-in task: {e}"))?;

    if let Err(e) = window.destroy() {
        log::warn!("Could not close the sign-in window: {e}");
    }
    outcome?;
    Ok(storage::app_data_dir().join(COOKIES_FILE).to_string_lossy().to_string())
}

/// Forgets the signed-in session: deletes the cookies file this module wrote.
/// A cookies file the user picked themselves is never touched.
#[tauri::command]
pub async fn sign_out_youtube() -> Result<(), String> {
    remove_cookies_file(&storage::app_data_dir().join(COOKIES_FILE))
}

fn remove_cookies_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Delete {}: {e}", path.display())),
    }
}

/// Closes the sign-in window if it is open (the main window is going away).
pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if let Err(e) = window.destroy() {
            log::warn!("Could not close the sign-in window: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::TestHome;

    fn cookie(domain: &str, name: &str, value: &str) -> CookieRecord {
        CookieRecord {
            domain: domain.into(),
            path: "/".into(),
            name: name.into(),
            value: value.into(),
            secure: true,
            http_only: false,
            expires: Some(1_900_000_000),
        }
    }

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn google_and_youtube_pages_may_be_navigated_to() {
        for ok in [
            "https://accounts.google.com/v3/signin/identifier",
            "https://www.youtube.com/",
            "https://consent.youtube.com/m",
            "https://youtube.com/",
            "https://ssl.gstatic.com/a.js",
        ] {
            assert!(host_allowed(&url(ok)), "{ok}");
        }
    }

    #[test]
    fn the_country_domains_google_redirects_sign_in_to_are_allowed() {
        for ok in [
            "https://accounts.google.it/v3/signin",
            "https://www.google.co.uk/",
            "https://accounts.google.com.br/",
            "https://accounts.google.co.jp/",
            "https://consent.youtube.it/",
        ] {
            assert!(host_allowed(&url(ok)), "{ok}");
        }
    }

    #[test]
    fn lookalikes_of_country_domains_are_refused() {
        for bad in [
            "https://accounts.google.it.evil.com/",
            "https://google.evil/",
            "https://google.xyz/",
            "https://accounts.google.itx/",
            "https://notgoogle.it/",
            "https://google.net.br/",
            "http://accounts.google.it/",
        ] {
            assert!(!host_allowed(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn nothing_else_may_be_navigated_to() {
        for bad in [
            "http://accounts.google.com/",
            "https://google.com.evil.net/",
            "https://evilgoogle.com/",
            "https://accounts.google.com.evil.com/",
            "https://youtube.com@evil.com/",
            "file:///C:/Windows/win.ini",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
        ] {
            assert!(!host_allowed(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn the_sign_in_window_cannot_call_the_apps_commands() {
        assert!(!may_invoke(LABEL));
        assert!(may_invoke("main"));
        assert!(may_invoke("detached-pianoRoll"));
    }

    #[test]
    fn only_google_and_youtube_cookies_are_kept() {
        assert!(keep_cookie(&cookie(".youtube.com", "SID", "x")));
        assert!(keep_cookie(&cookie("accounts.google.com", "SID", "x")));
        assert!(keep_cookie(&cookie(".google.com", "SID", "x")));
        for other in ["evilgoogle.com", "google.com.evil.net", ".doubleclick.net", "notyoutube.com"] {
            assert!(!keep_cookie(&cookie(other, "SID", "x")), "{other}");
        }
    }

    #[test]
    fn an_anonymous_visit_is_not_a_sign_in() {
        let anon = [
            cookie(".youtube.com", "PREF", "f6=40000000"),
            cookie(".youtube.com", "YSC", "abc"),
            cookie(".youtube.com", "VISITOR_INFO1_LIVE", "v"),
        ];
        assert!(!is_signed_in(&anon));
        assert!(!is_signed_in(&[]));
    }

    #[test]
    fn a_google_session_that_has_not_reached_youtube_yet_is_not_enough() {
        let google_only = [cookie(".google.com", "SID", "s"), cookie(".google.com", "__Secure-3PSID", "s")];
        assert!(!is_signed_in(&google_only));
    }

    #[test]
    fn the_login_marker_alone_is_not_enough() {
        assert!(!is_signed_in(&[cookie(".youtube.com", "LOGIN_INFO", "l")]));
    }

    #[test]
    fn the_login_marker_with_a_session_cookie_is_a_sign_in() {
        let signed_in = [cookie(".youtube.com", "LOGIN_INFO", "l"), cookie(".youtube.com", "__Secure-3PSID", "s")];
        assert!(is_signed_in(&signed_in));
    }

    #[test]
    fn empty_values_do_not_count() {
        let empty = [cookie(".youtube.com", "LOGIN_INFO", ""), cookie(".youtube.com", "SID", "")];
        assert!(!is_signed_in(&empty));
    }

    #[test]
    fn a_domain_cookie_is_written_with_the_subdomain_flag() {
        let text = to_netscape(&[cookie(".youtube.com", "SID", "abc")]);
        assert!(text.contains(".youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tabc\n"), "{text}");
    }

    #[test]
    fn a_host_only_cookie_is_written_without_the_subdomain_flag() {
        let text = to_netscape(&[cookie("www.youtube.com", "X", "1")]);
        assert!(text.contains("www.youtube.com\tFALSE\t/\tTRUE\t"), "{text}");
    }

    #[test]
    fn http_only_cookies_carry_the_prefix_yt_dlp_expects() {
        let mut c = cookie(".youtube.com", "SID", "abc");
        c.http_only = true;
        assert!(to_netscape(&[c]).contains("\n#HttpOnly_.youtube.com\tTRUE\t"));
    }

    #[test]
    fn a_session_cookie_has_expiry_zero_and_insecure_is_false() {
        let mut c = cookie(".youtube.com", "S", "1");
        c.expires = None;
        c.secure = false;
        assert!(to_netscape(&[c]).contains("\t/\tFALSE\t0\tS\t1\n"));
    }

    #[test]
    fn the_file_starts_with_the_header_yt_dlp_requires() {
        assert!(to_netscape(&[]).starts_with("# Netscape HTTP Cookie File\n"));
    }

    #[test]
    fn a_cookie_that_would_break_the_format_is_left_out() {
        let evil = cookie(".youtube.com", "A", "x\n.evil.com\tTRUE\t/\tTRUE\t0\tB\tC");
        let tabbed = cookie(".youtube.com", "T\tX", "1");
        let good = cookie(".youtube.com", "SID", "ok");
        let text = to_netscape(&[evil, tabbed, good]);
        assert_eq!(text.lines().filter(|l| !l.starts_with('#')).count(), 1, "{text}");
        assert!(text.contains("\tSID\tok"));
    }

    #[test]
    fn the_cookies_file_is_replaced_atomically_and_leaves_no_temp_file() {
        let home = TestHome::new();
        let path = home.path().join(COOKIES_FILE);
        write_atomic(&path, "first").unwrap();
        write_atomic(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        let leftovers: Vec<_> = std::fs::read_dir(home.path()).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn signing_out_deletes_the_file_and_is_fine_when_there_is_none() {
        let home = TestHome::new();
        let path = home.path().join(COOKIES_FILE);
        std::fs::write(&path, "x").unwrap();
        remove_cookies_file(&path).unwrap();
        assert!(!path.exists());
        remove_cookies_file(&path).unwrap();
    }
}
