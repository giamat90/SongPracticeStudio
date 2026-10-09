import os

import pytest
import yt_dlp

import yt_importer

DownloadError = yt_dlp.utils.DownloadError


class Script:
    """Drives a fake yt_dlp.YoutubeDL: each construction pops the next outcome."""

    def __init__(self, outcomes, create_files=None, writes_wav=True):
        self.outcomes = list(outcomes)
        self.opts = []
        self.create_files = create_files or {}
        self.writes_wav = writes_wav

    def factory(self, output_dir):
        script = self

        class FakeYDL:
            def __init__(self, opts):
                script.opts.append(opts)
                self.opts = opts
                self.index = len(script.opts) - 1

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, url, download=True):
                outcome = script.outcomes[self.index]
                for name in script.create_files.get(self.index, []):
                    with open(os.path.join(output_dir, name), "w") as f:
                        f.write("x")
                for hook in self.opts["progress_hooks"]:
                    hook({"status": "downloading", "downloaded_bytes": 50, "total_bytes": 100})
                    hook({"status": "finished"})
                if isinstance(outcome, Exception):
                    raise outcome
                if script.writes_wav:
                    with open(os.path.join(output_dir, "source.wav"), "w") as f:
                        f.write("x")
                return outcome

        return FakeYDL


@pytest.fixture
def run(tmp_path, monkeypatch):
    out = tmp_path / "out"

    def go(outcomes, *, cookies_path=None, files=None, source_wav=True, **kw):
        script = Script(outcomes, files, writes_wav=source_wav)
        go.last_script = script
        monkeypatch.setattr(yt_importer.yt_dlp, "YoutubeDL", script.factory(str(out)))
        calls = {}

        def fake_process(path, output_dir, stems_to_extract=None, high_quality=False, on_progress=None):
            calls["path"] = path
            calls["high_quality"] = high_quality
            calls["stems"] = stems_to_extract
            for v, s in ((0.0, "a"), (0.5, "b"), (1.0, "complete")):
                on_progress(v, s)
            return {"duration": 1.0}

        monkeypatch.setattr(yt_importer, "process", fake_process)
        events = []
        result = yt_importer.import_yt(
            "https://youtu.be/abc", str(out), on_progress=lambda v, s: events.append((round(v, 4), s)), cookies_path=cookies_path, **kw
        )
        return result, script, calls, events

    go.out = out
    return go


INFO = {"title": "My Song"}
BOT = DownloadError("ERROR: Sign in to confirm you're not a bot")


class TestVersionHelpers:
    def test_version_tuple(self):
        assert yt_importer._version_tuple("2026.8.19") == (2026, 8, 19)
        assert yt_importer._version_tuple("2026.08.19.post1") == (2026, 8, 19, 1)
        assert yt_importer._version_tuple("2026.x.19") == (2026, 0, 19)

    def test_ordering_is_numeric_not_lexical(self):
        assert yt_importer._version_tuple("2026.10.1") > yt_importer._version_tuple("2026.9.30")

    def test_outdated_detection(self, monkeypatch):
        floor = yt_importer._MIN_YT_DLP_VERSION
        monkeypatch.setattr(yt_dlp.version, "__version__", "2020.1.1")
        assert yt_importer._yt_dlp_is_outdated()
        monkeypatch.setattr(yt_dlp.version, "__version__", floor)
        assert not yt_importer._yt_dlp_is_outdated()
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        assert not yt_importer._yt_dlp_is_outdated()

    def test_a_broken_version_attribute_counts_as_up_to_date(self, monkeypatch):
        monkeypatch.delattr(yt_dlp.version, "__version__")
        assert yt_importer._yt_dlp_is_outdated() is False

    def test_old_yt_dlp_plus_a_download_error_is_explained(self, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2020.1.1")
        with pytest.raises(RuntimeError, match="known-good floor") as e:
            yt_importer._raise_import_error(DownloadError("nsig extraction failed"))
        assert "nsig extraction failed" in str(e.value)

    def test_current_yt_dlp_re_raises_the_original(self, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        err = DownloadError("Video unavailable")
        with pytest.raises(DownloadError) as e:
            yt_importer._raise_import_error(err)
        assert e.value is err

    def test_other_exception_types_are_never_rewrapped(self, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2020.1.1")
        with pytest.raises(ValueError):
            yt_importer._raise_import_error(ValueError("x"))


class TestImportFlow:
    def test_succeeds_on_the_first_attempt_without_cookies(self, run):
        result, script, calls, _ = run([INFO])
        assert result["title"] == "My Song" and result["duration"] == 1.0
        assert len(script.opts) == 1
        assert "cookiefile" not in script.opts[0] and "cookiesfrombrowser" not in script.opts[0]
        assert calls["path"].endswith("source.wav")

    def test_requests_best_audio_as_wav(self, run):
        _, script, _, _ = run([INFO])
        o = script.opts[0]
        assert o["format"] == "bestaudio/best"
        assert o["postprocessors"][0]["preferredcodec"] == "wav"
        assert o["outtmpl"].endswith("source.%(ext)s")

    def test_passes_quality_and_stem_selection_to_the_pipeline(self, run):
        _, _, calls, _ = run([INFO], high_quality=True, stems_to_extract=["vocals", "bass"])
        assert calls["high_quality"] is True and calls["stems"] == ["vocals", "bass"]

    def test_a_user_cookies_file_is_tried_first(self, run, tmp_path):
        cookies = tmp_path / "cookies.txt"
        cookies.write_text("# Netscape")
        _, script, _, _ = run([INFO], cookies_path=str(cookies))
        assert script.opts[0]["cookiefile"] == str(cookies)
        assert len(script.opts) == 1

    def test_a_missing_cookies_file_is_skipped_and_the_normal_path_continues(self, run, tmp_path, capsys):
        _, script, _, _ = run([INFO], cookies_path=str(tmp_path / "gone.txt"))
        assert "cookiefile" not in script.opts[0]
        assert "cookies file not found" in capsys.readouterr().out

    def test_a_bot_check_walks_the_browser_cascade_in_order(self, run):
        _, script, _, _ = run([BOT, BOT, DownloadError("403"), INFO])
        kinds = [o.get("cookiesfrombrowser") for o in script.opts]
        assert kinds == [None, ("chrome",), ("firefox",), ("edge",)]

    @pytest.mark.parametrize("message", ["HTTP Error 403: Forbidden", "Sign in to confirm", "this looks like a bot", "FORBIDDEN"])
    def test_cookie_fixable_errors_trigger_the_cascade(self, run, message):
        _, script, _, _ = run([DownloadError(message), INFO])
        assert len(script.opts) == 2

    @pytest.mark.parametrize("message", ["Video unavailable", "Private video", "This video has been removed", "Unsupported URL"])
    def test_other_errors_fail_fast_instead_of_retrying_with_cookies(self, run, message, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        with pytest.raises(DownloadError, match=message.split()[0]):
            run([DownloadError(message), INFO])

    def test_the_word_both_is_not_mistaken_for_a_bot_check(self, run, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        with pytest.raises(DownloadError, match="merge both"):
            run([DownloadError("Could not merge both audio and video streams"), INFO])
        assert len(run.last_script.opts) == 1, "an unrelated error must not trigger five browser-cookie retries"

    def test_a_non_download_error_on_the_plain_attempt_fails_fast(self, run, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        with pytest.raises(OSError):
            run([OSError("disk"), INFO])

    def test_a_failing_cookie_attempt_always_moves_on_whatever_the_error(self, run, tmp_path):
        cookies = tmp_path / "c.txt"
        cookies.write_text("x")
        _, script, _, _ = run([RuntimeError("pywin32 missing"), INFO], cookies_path=str(cookies))
        assert len(script.opts) == 2 and "cookiefile" not in script.opts[1]

    def test_when_every_attempt_fails_the_last_error_surfaces(self, run, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2999.1.1")
        outcomes = [BOT] + [DownloadError(f"final-{i}") for i in range(5)]
        with pytest.raises(DownloadError, match="final-4"):
            run(outcomes)

    def test_exhaustion_with_an_old_yt_dlp_explains_the_likely_cause(self, run, monkeypatch):
        monkeypatch.setattr(yt_dlp.version, "__version__", "2020.1.1")
        with pytest.raises(RuntimeError, match="known-good floor"):
            run([BOT] * 6)

    def test_partial_downloads_are_removed_before_the_next_attempt(self, run):
        _, script, _, _ = run([BOT, INFO], files={0: ["source.webm.part", "source.f251.webm"]})
        leftovers = [f for f in os.listdir(run.out) if f.startswith("source.") and f != "source.wav"]
        assert leftovers == []

    def test_unrelated_files_in_the_output_directory_survive_cleanup(self, run):
        os.makedirs(run.out, exist_ok=True)
        (run.out / "keep.txt").write_text("k")
        run([BOT, INFO])
        assert (run.out / "keep.txt").exists()
        assert (run.out / "source.wav").exists()

    def test_a_non_wav_source_is_used_when_the_wav_postprocess_was_skipped(self, run):
        _, _, calls, _ = run([INFO], source_wav=False, files={0: ["source.m4a"]})
        assert calls["path"].endswith("source.m4a")

    def test_no_output_at_all_is_an_error(self, run):
        with pytest.raises(FileNotFoundError):
            run([INFO], source_wav=False)

    def test_a_missing_title_defaults_to_unknown(self, run):
        result, _, _, _ = run([{}])
        assert result["title"] == "Unknown"

    def test_progress_download_occupies_the_first_15_percent_and_the_pipeline_the_rest(self, run):
        _, _, _, events = run([INFO])
        by_stage = [(v, s) for v, s in events if s == "downloading"]
        assert by_stage[0] == (0.0, "downloading")
        assert (0.075, "downloading") in by_stage and (0.15, "downloading") in by_stage
        assert (0.15, "a") in events and (0.575, "b") in events and events[-1] == (1.0, "complete")
        values = [v for v, _ in events]
        assert values == sorted(values)

    def test_creates_the_output_directory(self, run, tmp_path, monkeypatch):
        target = tmp_path / "fresh" / "dir"
        script = Script([INFO])
        monkeypatch.setattr(yt_importer.yt_dlp, "YoutubeDL", script.factory(str(target)))
        monkeypatch.setattr(yt_importer, "process", lambda *a, **k: {})
        yt_importer.import_yt("u", str(target))
        assert target.is_dir()
