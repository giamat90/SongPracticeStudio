"""The yt-dlp floor is one constant in mps-core; each app's requirement files
must carry the same number, and the installed yt-dlp must meet it."""

import re
from pathlib import Path

import pytest

from mps_core.version_check import MIN_YT_DLP_VERSION

ROOT = Path(__file__).resolve().parents[1]


def floor_in(filename):
    text = (ROOT / filename).read_text(encoding="utf-8")
    m = re.search(r"^yt-dlp>=([\d.]+)", text, re.M)
    assert m, f"no yt-dlp floor in {filename}"
    return m.group(1)


@pytest.mark.parametrize("filename", ["requirements.txt", "requirements-test.txt"])
def test_requirement_files_carry_the_packages_floor(filename):
    assert floor_in(filename) == MIN_YT_DLP_VERSION


def test_the_installed_yt_dlp_meets_the_floor():
    import yt_dlp

    import yt_importer

    assert yt_importer._version_tuple(yt_dlp.version.__version__) >= yt_importer._version_tuple(MIN_YT_DLP_VERSION)
