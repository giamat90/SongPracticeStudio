"""The frozen exe only contains what build.py tells PyInstaller to collect, and
the dev venv hides any gap (it has every package installed). These tests pin the
lazy imports that static analysis cannot see; smoke_test.py proves them against
the real binary in the release workflow."""
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent.parent


def test_resampy_is_collected_because_pitch_shift_resamples_with_kaiser_fast():
    assert 'res_type="kaiser_fast"' in (SIDECAR / "processor.py").read_text(encoding="utf-8")
    assert '"--collect-all=resampy"' in (SIDECAR / "build.py").read_text(encoding="utf-8")


def test_resampy_is_a_declared_runtime_dependency():
    lines = (SIDECAR / "requirements.txt").read_text(encoding="utf-8").splitlines()
    assert "resampy" in [line.strip() for line in lines]
