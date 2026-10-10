"""Model plumbing: the atomic download and the windowed inference, both model-free."""

import io

import numpy as np
import pytest

import lyrics


class FakeResponse(io.BytesIO):
    def __init__(self, payload, declared=None):
        super().__init__(payload)
        self.headers = {"Content-Length": str(len(payload) if declared is None else declared)}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener_for(payload, declared=None, calls=None):
    def opener(request, timeout=None):
        if calls is not None:
            calls.append(request.full_url)
        return FakeResponse(payload, declared)

    return opener


class TestDownloadFile:
    def test_writes_the_file_and_reports_progress_up_to_one(self, tmp_path):
        dest = tmp_path / "models" / "m.pth"
        seen = []
        lyrics.download_file("http://x/m.pth", str(dest), seen.append, opener_for(b"a" * 3_000_000))
        assert dest.read_bytes() == b"a" * 3_000_000
        assert seen == sorted(seen) and seen[-1] == 1.0
        assert not (tmp_path / "models" / "m.pth.part").exists()

    def test_an_existing_file_is_not_downloaded_again(self, tmp_path):
        dest = tmp_path / "m.pth"
        dest.write_bytes(b"cached")
        calls = []
        lyrics.download_file("http://x/m.pth", str(dest), None, opener_for(b"new", calls=calls))
        assert calls == [] and dest.read_bytes() == b"cached"

    def test_a_truncated_download_leaves_nothing_behind(self, tmp_path):
        dest = tmp_path / "m.pth"
        with pytest.raises(lyrics.LyricsError, match="incomplete"):
            lyrics.download_file("http://x/m.pth", str(dest), None, opener_for(b"1234", declared=10))
        assert not dest.exists() and not (tmp_path / "m.pth.part").exists()

    def test_an_empty_leftover_file_is_replaced(self, tmp_path):
        dest = tmp_path / "m.pth"
        dest.write_bytes(b"")
        lyrics.download_file("http://x/m.pth", str(dest), None, opener_for(b"fresh"))
        assert dest.read_bytes() == b"fresh"

    def test_a_connection_dropped_mid_download_is_a_readable_message(self, tmp_path):
        import http.client

        class Dropping(FakeResponse):
            def read(self, n=-1):
                raise http.client.IncompleteRead(b"abc")

        def opener(request, timeout=None):
            return Dropping(b"x" * 10)

        dest = tmp_path / "m.pth"
        with pytest.raises(lyrics.LyricsError, match="download"):
            lyrics.download_file("http://x/m.pth", str(dest), None, opener)
        assert not dest.exists() and not (tmp_path / "m.pth.part").exists()

    def test_a_network_error_becomes_a_readable_message(self, tmp_path):
        import urllib.error

        def broken(request, timeout=None):
            raise urllib.error.URLError("offline")

        with pytest.raises(lyrics.LyricsError, match="download"):
            lyrics.download_file("http://x/m.pth", str(tmp_path / "m.pth"), None, broken)


class TestChunkedEmissions:
    SR = 16000

    @staticmethod
    def ramp_forward(chunk):
        """A model whose frame f reports the sample at its own start, so position is observable."""
        n = (len(chunk) - 400) // 320 + 1
        return chunk[np.arange(n) * 320][:, None].astype(np.float64)

    def test_stitching_preserves_absolute_time_across_chunk_boundaries(self):
        n = 16000 * 75 + 123
        audio = np.arange(n, dtype=np.float32)
        out = lyrics.chunked_emissions(audio, self.ramp_forward, chunk_s=20.0, context_s=2.0)
        positions = out[:, 0]
        assert np.array_equal(positions, np.arange(len(positions)) * 320.0)

    def test_covers_the_whole_recording(self):
        n = 16000 * 61
        out = lyrics.chunked_emissions(np.zeros(n, dtype=np.float32), self.ramp_forward)
        assert abs(out.shape[0] - (n - 400) // 320) <= 2

    def test_a_clip_shorter_than_one_chunk_is_one_call(self):
        calls = []

        def forward(chunk):
            calls.append(len(chunk))
            return self.ramp_forward(chunk)

        lyrics.chunked_emissions(np.zeros(16000 * 5, dtype=np.float32), forward)
        assert calls == [16000 * 5]

    def test_progress_runs_from_zero_to_one(self):
        seen = []
        lyrics.chunked_emissions(np.zeros(16000 * 70, dtype=np.float32), self.ramp_forward, on_progress=seen.append)
        assert seen == sorted(seen) and seen[-1] == 1.0 and len(seen) == 4

    def test_audio_shorter_than_the_receptive_field_is_rejected(self):
        with pytest.raises(lyrics.LyricsError, match="too short"):
            lyrics.chunked_emissions(np.zeros(100, dtype=np.float32), self.ramp_forward)

    def test_windows_must_be_whole_frames(self):
        with pytest.raises(ValueError):
            lyrics.chunked_emissions(np.zeros(16000 * 3, dtype=np.float32), self.ramp_forward, chunk_s=20.001)


class TestDefaultEngine:
    def test_the_test_engine_is_opt_in_through_the_environment(self, monkeypatch):
        monkeypatch.delenv("SPS_LYRICS_ENGINE", raising=False)
        assert isinstance(lyrics.default_aligner("m"), lyrics.Wav2Vec2Aligner)
        monkeypatch.setenv("SPS_LYRICS_ENGINE", "uniform")
        assert isinstance(lyrics.default_aligner("m"), lyrics.UniformAligner)

    def test_the_english_alphabet_covers_letters_and_apostrophe_only(self):
        ids = lyrics.Wav2Vec2Aligner.char_ids
        assert set(ids) == set("abcdefghijklmnopqrstuvwxyz'")
        assert 0 not in ids.values()  # 0 is the CTC blank

    def test_constructing_the_engine_has_no_side_effects(self, tmp_path):
        lyrics.Wav2Vec2Aligner(str(tmp_path / "models"))
        assert not (tmp_path / "models").exists()


class TestDamagedModelFile:
    def test_a_model_file_that_will_not_load_is_removed_so_the_next_try_redownloads(self, tmp_path, monkeypatch):
        torchaudio = pytest.importorskip("torchaudio")
        import os

        class Bundle:
            @staticmethod
            def get_labels():
                return lyrics._W2V2_LABELS

            @staticmethod
            def get_model(dl_kwargs=None):
                raise RuntimeError("PytorchStreamReader failed reading zip archive")

        monkeypatch.setattr(torchaudio.pipelines, lyrics._W2V2_BUNDLE, Bundle, raising=True)
        weights = tmp_path / os.path.basename(lyrics._W2V2_URL)
        weights.write_bytes(b"truncated")

        aligner = lyrics.Wav2Vec2Aligner(str(tmp_path))
        with pytest.raises(lyrics.LyricsError, match="damaged"):
            aligner.emissions(np.zeros(16000, dtype=np.float32), [1])
        assert not weights.exists()

    def test_an_unexpected_alphabet_is_refused(self, tmp_path, monkeypatch):
        torchaudio = pytest.importorskip("torchaudio")

        class Bundle:
            @staticmethod
            def get_labels():
                return ("-", "a", "b")

        monkeypatch.setattr(torchaudio.pipelines, lyrics._W2V2_BUNDLE, Bundle, raising=True)
        with pytest.raises(lyrics.LyricsError, match="alphabet"):
            lyrics.Wav2Vec2Aligner(str(tmp_path)).emissions(np.zeros(16000, dtype=np.float32), [1])
