"""Turning pasted lyrics into the words the aligner will be asked to place."""

import pytest

import lyrics


class TestParseLyrics:
    def test_one_entry_per_non_empty_line_with_the_words_as_written(self):
        text = "Hello darkness, my old friend\n\nI've come to talk with you again\n"
        assert lyrics.parse_lyrics(text) == [
            ["Hello", "darkness,", "my", "old", "friend"],
            ["I've", "come", "to", "talk", "with", "you", "again"],
        ]

    def test_section_markers_in_square_brackets_are_not_sung(self):
        text = "[Verse 1]\nFirst line\n[Chorus]\nSecond line"
        assert lyrics.parse_lyrics(text) == [["First", "line"], ["Second", "line"]]

    def test_lrc_timestamp_tags_are_dropped_so_a_pasted_lrc_file_works(self):
        text = "[00:12.34] Hello there\n[01:02.5]General Kenobi"
        assert lyrics.parse_lyrics(text) == [["Hello", "there"], ["General", "Kenobi"]]

    def test_lrc_metadata_lines_vanish(self):
        text = "[ar:Someone]\n[ti:Something]\n[00:01.00] Words"
        assert lyrics.parse_lyrics(text) == [["Words"]]

    def test_parenthesised_backing_vocals_are_kept_because_they_are_sung(self):
        assert lyrics.parse_lyrics("(Ooh) go on") == [["(Ooh)", "go", "on"]]

    def test_a_line_that_is_only_a_marker_disappears_entirely(self):
        assert lyrics.parse_lyrics("[Instrumental]\n\n[Solo]") == []

    def test_windows_line_endings_and_surrounding_whitespace(self):
        assert lyrics.parse_lyrics("  one two \r\n\r\n three\r\n") == [["one", "two"], ["three"]]

    def test_empty_and_whitespace_only_input(self):
        assert lyrics.parse_lyrics("") == []
        assert lyrics.parse_lyrics("   \n\t\n") == []


class TestNormalizeWord:
    ALPHABET = set("abcdefghijklmnopqrstuvwxyz'")

    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("Hello,", "hello"),
            ("DON'T", "don't"),
            ("(Ooh)", "ooh"),
            ("café", "cafe"),
            ("Señor", "senor"),
            ("naïve", "naive"),
            ("Straße", "strasse"),
            ("'cause", "cause"),
            ("rock'n'roll", "rock'n'roll"),
            ("goin'", "goin"),
            ("—", ""),
            ("1999", ""),
            ("!!!", ""),
        ],
    )
    def test_reduces_a_word_to_the_letters_the_model_can_emit(self, raw, expected):
        assert lyrics.normalize_word(raw, self.ALPHABET) == expected

    def test_a_model_without_apostrophe_loses_only_the_apostrophe(self):
        assert lyrics.normalize_word("don't", set("abcdefghijklmnopqrstuvwxyz")) == "dont"


class TestTokenize:
    CHAR_IDS = {c: i + 1 for i, c in enumerate("abcdefghijklmnopqrstuvwxyz'")}

    def test_flattens_words_to_ids_and_remembers_which_word_each_came_from(self):
        lines = [["ab", "c"], ["a"]]
        tokens = lyrics.tokenize(lines, self.CHAR_IDS)
        assert tokens.ids == [1, 2, 3, 1]
        assert tokens.word_of == [0, 0, 1, 2]
        assert tokens.n_words == 3

    def test_words_with_no_letters_get_no_tokens_but_keep_their_slot(self):
        tokens = lyrics.tokenize([["go", "—", "on"]], self.CHAR_IDS)
        assert tokens.ids == [self.CHAR_IDS["g"], self.CHAR_IDS["o"], self.CHAR_IDS["o"], self.CHAR_IDS["n"]]
        assert tokens.word_of == [0, 0, 2, 2]
        assert tokens.n_words == 3

    def test_line_word_offsets_index_into_the_flat_word_list(self):
        tokens = lyrics.tokenize([["a", "b"], ["c"], ["d", "e", "f"]], self.CHAR_IDS)
        assert tokens.line_first_word == [0, 2, 3]
