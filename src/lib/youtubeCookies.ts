/** Name of the cookies file the in-app YouTube sign-in writes (src-tauri/src/youtube_signin.rs). */
export const MANAGED_COOKIES_FILE = "youtube_cookies.txt";

export type CookiesSource = "none" | "sign-in" | "file";

export function cookiesSource(path: string | null): CookiesSource {
  if (!path) return "none";
  const name = path.split(/[\\/]/).pop();
  return name === MANAGED_COOKIES_FILE ? "sign-in" : "file";
}
