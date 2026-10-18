import { createSongFilter, normalizeForSearch } from "@giamat90/mps-core/hooks";
import type { Song } from "./types";

export { normalizeForSearch };

/** The songs whose title, key, tempo or folder contain every word of `query`, in the order given. */
export const filterSongs = createSongFilter<Song>();
