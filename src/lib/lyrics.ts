/**
 * Lyrics are placed on the vocals stem, and SPS lets a song be imported
 * without it, so the tab explains instead of failing when it is absent.
 */
export function canSyncLyrics(stems: readonly string[]): boolean {
  return stems.includes("vocals");
}
