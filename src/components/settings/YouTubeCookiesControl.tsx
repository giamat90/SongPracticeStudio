import { useSettingsStore } from "../../stores/settings";
import { pickFile } from "../../lib/pickFile";
import { useYouTubeCookies } from "@giamat90/mps-core/hooks";

function YouTubeCookiesControl() {
  const youtubeCookiesPath = useSettingsStore((s) => s.youtubeCookiesPath);
  const setYoutubeCookiesPath = useSettingsStore((s) => s.setYoutubeCookiesPath);
  const { source, busy, error, signIn, signOut, choose, clear } = useYouTubeCookies({
    cookiesPath: youtubeCookiesPath,
    setCookiesPath: setYoutubeCookiesPath,
    pickFile,
  });

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
        <button className="youtube-cookies-control__btn" onClick={signIn} disabled={busy}>
          {busy ? "Waiting for sign-in…" : source === "sign-in" ? "Sign in again" : "Sign in to YouTube"}
        </button>
        {source === "sign-in" && (
          <button
            className="youtube-cookies-control__btn youtube-cookies-control__btn--clear"
            onClick={signOut}
            disabled={busy}
          >
            Sign out
          </button>
        )}
        {source === "file" && (
          <button
            className="youtube-cookies-control__btn youtube-cookies-control__btn--clear"
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>
      {error && <p className="youtube-cookies-control__error">{error}</p>}
      {source !== "sign-in" && (
        <button
          className="youtube-cookies-control__link"
          onClick={choose}
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
