import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsStore } from "../../stores/settings";
import { cookiesSource, signInYoutube, signOutYoutube } from "@giamat90/mps-core/youtube";

function YouTubeCookiesControl() {
  const youtubeCookiesPath = useSettingsStore((s) => s.youtubeCookiesPath);
  const setYoutubeCookiesPath = useSettingsStore((s) => s.setYoutubeCookiesPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = cookiesSource(youtubeCookiesPath);

  const handleSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      setYoutubeCookiesPath(await signInYoutube());
    } catch (e) {
      console.warn("[youtube] sign-in failed:", e);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setError(null);
    try {
      await signOutYoutube();
      setYoutubeCookiesPath(null);
    } catch (e) {
      console.warn("[youtube] sign-out failed:", e);
      setError(String(e));
    }
  };

  const handleChoose = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Cookies", extensions: ["txt"] }],
    });
    if (selected) {
      setYoutubeCookiesPath(selected);
    }
  };

  return (
    <div className="youtube-cookies-control">
      <label className="youtube-cookies-control__label">YouTube account (optional)</label>
      <p className="youtube-cookies-control__desc">
        Fixes YouTube import failing with a "bot detection" error. Sign in once in a private
        window — the app keeps only the session cookies it needs, on this computer, and never
        sees your password. Sign in again if imports start failing (YouTube sessions eventually
        expire).
      </p>
      <div className="youtube-cookies-control__row">
        <span className="youtube-cookies-control__path" title={youtubeCookiesPath ?? undefined}>
          {source === "sign-in" && "Signed in to YouTube"}
          {source === "file" && youtubeCookiesPath}
          {source === "none" && "Not signed in — falls back to reading a running browser's cookies"}
        </span>
        <button className="youtube-cookies-control__btn" onClick={handleSignIn} disabled={busy}>
          {busy ? "Waiting for sign-in…" : source === "sign-in" ? "Sign in again" : "Sign in to YouTube"}
        </button>
        {source === "sign-in" && (
          <button
            className="youtube-cookies-control__btn youtube-cookies-control__btn--clear"
            onClick={handleSignOut}
            disabled={busy}
          >
            Sign out
          </button>
        )}
        {source === "file" && (
          <button
            className="youtube-cookies-control__btn youtube-cookies-control__btn--clear"
            onClick={() => setYoutubeCookiesPath(null)}
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="youtube-cookies-control__error">{error}</p>}
      {source !== "sign-in" && (
        <button
          className="youtube-cookies-control__link"
          onClick={handleChoose}
          disabled={busy}
          title="For when signing in here does not work: a cookies.txt exported from your browser"
        >
          Use a cookies.txt file instead…
        </button>
      )}
    </div>
  );
}

export default YouTubeCookiesControl;
