import { describe, it, expect } from "vitest";
import { MANAGED_COOKIES_FILE, cookiesSource } from "./youtubeCookies";

describe("cookiesSource", () => {
  it("is none when nothing is configured", () => {
    expect(cookiesSource(null)).toBe("none");
    expect(cookiesSource("")).toBe("none");
  });

  it("recognises the file the in-app sign-in writes, on either path style", () => {
    expect(cookiesSource(`C:\\Users\\a\\.vps\\${MANAGED_COOKIES_FILE}`)).toBe("sign-in");
    expect(cookiesSource(`/home/a/.vps/${MANAGED_COOKIES_FILE}`)).toBe("sign-in");
  });

  it("treats any other file as one the user chose", () => {
    expect(cookiesSource("C:\\Users\\a\\Downloads\\www.youtube.com_cookies.txt")).toBe("file");
    expect(cookiesSource("C:\\x\\not_youtube_cookies.txt")).toBe("file");
  });
});
