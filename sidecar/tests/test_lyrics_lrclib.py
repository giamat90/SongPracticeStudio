"""Looking lyrics up online (LRCLIB) without ever touching the network in a test."""

import urllib.error

import pytest

import lyrics

SYNCED = "[00:01.00] First line\n[00:05.50] Second line\n[00:09.00] First line\n"


def cand(id, title="Song", artist="Band", duration=200.0, plain="p1\np2", synced=None, instrumental=False):
    return {
        "id": id,
        "trackName": title,
        "artistName": artist,
        "duration": duration,
        "plainLyrics": plain,
        "syncedLyrics": synced,
        "instrumental": instrumental,
    }


class TestCleanTitle:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("Audioslave - Like a stone (HD)", "Audioslave - Like a stone"),
            ("Let It Go - Frozen lyrics (FULL SONG)", "Let It Go - Frozen"),
            ("Linkin Park -  Numb (Lyrics)", "Linkin Park - Numb"),
            ("The White Stripes - Seven Nation Army (Official Music Video)", "The White Stripes - Seven Nation Army"),
            ("Starlight - Muse [HQ]", "Starlight - Muse"),
            ("Snuff (2012 Remaster)", "Snuff"),
            ("Spiritbox - Jaded (LYRICS VIDEO - 4K)", "Spiritbox - Jaded"),
            ("Black Sabbath - Paranoid (Official Audio)", "Black Sabbath - Paranoid"),
            ("Plain Title", "Plain Title"),
        ],
    )
    def test_removes_the_noise_a_video_title_carries(self, raw, expected):
        assert lyrics.clean_title(raw) == expected

    def test_never_returns_an_empty_query_for_a_noisy_title(self):
        assert lyrics.clean_title("(Official Video)") == "(Official Video)"


class TestStripTimestamps:
    def test_keeps_every_repeat_and_drops_the_tags(self):
        assert lyrics.strip_timestamps(SYNCED) == "First line\nSecond line\nFirst line"

    def test_leaves_untagged_lines_alone(self):
        assert lyrics.strip_timestamps("no tag here") == "no tag here"


class TestPickBest:
    def test_prefers_the_candidate_whose_length_matches_the_song(self):
        best = lyrics.pick_best([cand(1, duration=250), cand(2, duration=201), cand(3, duration=190)], 200, "Song")
        assert best["id"] == 2

    def test_skips_instrumentals_and_entries_without_lyrics(self):
        pool = [
            cand(1, instrumental=True),
            cand(2, plain=None, synced=None),
            cand(3, plain="", synced=""),
            cand(4, duration=210),
        ]
        assert lyrics.pick_best(pool, 200, "Song")["id"] == 4

    def test_a_missing_duration_is_allowed_but_ranks_behind_a_close_match(self):
        pool = [cand(1, duration=None), cand(2, duration=203)]
        assert lyrics.pick_best(pool, 200, "Song")["id"] == 2
        assert lyrics.pick_best([cand(1, duration=None)], 200, "Song")["id"] == 1

    def test_a_synced_entry_beats_a_plain_one_at_the_same_length(self):
        pool = [cand(1, duration=200), cand(2, duration=200, synced=SYNCED)]
        assert lyrics.pick_best(pool, 200, "Song")["id"] == 2

    def test_nothing_is_returned_when_every_candidate_is_the_wrong_length(self):
        assert lyrics.pick_best([cand(1, duration=400), cand(2, duration=90)], 200, "Song") is None

    def test_a_non_numeric_duration_is_treated_as_unknown(self):
        pool = [cand(1, duration="3:20"), cand(2, duration=203)]
        assert lyrics.pick_best(pool, 200, "Song")["id"] == 2

    def test_without_a_known_duration_the_first_usable_entry_wins(self):
        assert lyrics.pick_best([cand(1), cand(2)], None, "Song")["id"] == 1

    def test_a_title_that_matches_beats_one_that_does_not(self):
        pool = [cand(1, title="Something Else", duration=200), cand(2, title="Like a Stone", duration=202)]
        assert lyrics.pick_best(pool, 200, "Audioslave - Like a stone")["id"] == 2


class TestFindLyrics:
    def test_returns_the_text_with_repeats_from_the_synced_version(self):
        result = lyrics.find_lyrics(
            "Band - Song (HD)", duration=200, fetch=lambda url: [cand(7, duration=200, plain="once", synced=SYNCED)]
        )
        assert result["text"] == "First line\nSecond line\nFirst line"
        assert result["synced"] is True
        assert result["source"] == "lrclib"
        assert (result["title"], result["artist"]) == ("Song", "Band")

    def test_falls_back_to_the_plain_text(self):
        result = lyrics.find_lyrics("Song", duration=200, fetch=lambda url: [cand(1, plain="a\nb")])
        assert result["text"] == "a\nb"
        assert result["synced"] is False

    def test_queries_with_the_cleaned_title_and_the_artist(self):
        urls = []
        lyrics.find_lyrics("Band - Song (Official Video)", artist="Band", duration=200,
                           fetch=lambda url: urls.append(url) or [cand(1)])
        assert "q=" in urls[0]
        assert "Official" not in urls[0]
        assert "Song" in urls[0]

    def test_not_found(self):
        with pytest.raises(lyrics.LyricsError, match="No lyrics found"):
            lyrics.find_lyrics("Song", duration=200, fetch=lambda url: [])

    def test_only_wrong_length_matches_counts_as_not_found(self):
        with pytest.raises(lyrics.LyricsError, match="No lyrics found"):
            lyrics.find_lyrics("Song", duration=200, fetch=lambda url: [cand(1, duration=500)])

    def test_a_network_failure_is_a_clear_error(self):
        def boom(url):
            raise urllib.error.URLError("no route")

        with pytest.raises(lyrics.LyricsError, match="reach"):
            lyrics.find_lyrics("Song", duration=200, fetch=boom)

    def test_a_malformed_reply_is_a_clear_error(self):
        with pytest.raises(lyrics.LyricsError, match="unexpected"):
            lyrics.find_lyrics("Song", duration=200, fetch=lambda url: {"message": "rate limited"})
