"""
The neural chord engine: audio in, the app's chord segments out.

    NeuralChords.load().detect(mix)      # mix: mono float32 at 22050 Hz

Features are the log constant-Q transform BTC was trained on (144 bins, 24 per
octave, hop 2048), taken in 10 s pieces as in the original, normalised with the
mean and standard deviation stored in the checkpoint. The model reads 108 frames
(10 s) at a time. Its class probabilities are folded onto the app's chords
(`labels.py`), which also gives each segment its confidence and alternatives.

The pretrained weights are not in the repository: `fetch_btc.py` downloads them
at a pinned upstream commit and this module refuses a file whose SHA-256 differs
(a checkpoint is a pickle; loading an unverified one would run its code).
"""

import hashlib
import os
import sys
from pathlib import Path

import numpy as np

from . import labels

MODEL_ID = "btc-large-voca-2019"
SOURCE_URL = "https://github.com/jayg996/BTC-ISMIR19"
SOURCE_COMMIT = "2682317be668032e6e4b269ded36adaa2ad57df0"
WEIGHTS_NAME = "btc_model_large_voca.pt"
WEIGHTS_SHA256 = "1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51"
WEIGHTS_URL = f"https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/{SOURCE_COMMIT}/test/{WEIGHTS_NAME}"

SAMPLE_RATE = 22050
CHUNK_SECONDS = 10.0
TIMESTEP = 108
FRAME_SECONDS = CHUNK_SECONDS / TIMESTEP
HOP = 2048
BATCH = 16


class WeightsNotFound(FileNotFoundError):
    pass


def weights_search_paths() -> list:
    """Where the weights are looked for, in order: an explicit file, the frozen app's bundle, the source tree's vendor folder."""
    paths = []
    explicit = os.environ.get("SPS_BTC_WEIGHTS")
    if explicit:
        paths.append(Path(explicit))
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        paths.append(Path(bundle) / "btc" / WEIGHTS_NAME)
    paths.append(Path(__file__).resolve().parent.parent / "vendor" / "btc" / WEIGHTS_NAME)
    return paths


def find_weights() -> Path:
    for path in weights_search_paths():
        if path.is_file():
            return path
    raise WeightsNotFound(
        f"The neural chord model's weights were not found ({WEIGHTS_NAME}). Run `python fetch_btc.py` in the sidecar "
        f"folder, or point SPS_BTC_WEIGHTS at the file. Looked in: " + ", ".join(str(p) for p in weights_search_paths())
    )


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def features(y: np.ndarray) -> np.ndarray:
    """Log constant-Q features, (frames, 144), for a mono signal at 22050 Hz."""
    import librosa

    piece = int(SAMPLE_RATE * CHUNK_SECONDS)
    parts, start = [], 0
    while len(y) > start + piece:
        parts.append(librosa.cqt(y[start:start + piece], sr=SAMPLE_RATE, n_bins=144, bins_per_octave=24, hop_length=HOP))
        start += piece
    if len(y) - start >= HOP:
        parts.append(librosa.cqt(y[start:], sr=SAMPLE_RATE, n_bins=144, bins_per_octave=24, hop_length=HOP))
    if not parts:
        return np.zeros((0, 144), dtype=np.float32)
    return np.log(np.abs(np.concatenate(parts, axis=1)) + 1e-6).T.astype(np.float32)


class NeuralChords:
    def __init__(self, model, mean, std):
        self.model = model
        self.mean = np.asarray(mean, dtype=np.float32)
        self.std = np.asarray(std, dtype=np.float32)

    @classmethod
    def load(cls, path=None) -> "NeuralChords":
        explicit = path is not None or bool(os.environ.get("SPS_BTC_WEIGHTS"))
        weights = Path(path) if path is not None else find_weights()
        if not explicit:
            found = sha256_of(weights)
            if found != WEIGHTS_SHA256:
                raise ValueError(f"{weights} is not the expected neural chord model (SHA-256 {found}); refusing to load it.")

        import torch

        from .btc import BTC

        # weights_only=False because the checkpoint stores numpy scalars (mean, std); the file was just
        # checked against the pinned SHA-256, or the caller named it explicitly.
        checkpoint = torch.load(weights, map_location="cpu", weights_only=False)
        model = BTC()
        model.load_state_dict(checkpoint["model"], strict=True)
        model.eval()
        return cls(model, checkpoint["mean"], checkpoint["std"])

    def probabilities(self, y: np.ndarray) -> np.ndarray:
        """Per-frame class probabilities, (frames, 170)."""
        import torch

        feats = features(y)
        frames = len(feats)
        if frames == 0:
            return np.zeros((0, labels.NUM_CLASSES), dtype=np.float32)
        feats = (feats - self.mean) / self.std
        pad = (-frames) % TIMESTEP
        feats = np.pad(feats, ((0, pad), (0, 0)), mode="constant")
        blocks = torch.from_numpy(feats.reshape(-1, TIMESTEP, feats.shape[1]).astype(np.float32))
        out = []
        with torch.no_grad():
            for i in range(0, len(blocks), BATCH):
                out.append(torch.softmax(self.model(blocks[i:i + BATCH]), dim=-1).reshape(-1, labels.NUM_CLASSES).numpy())
        return np.concatenate(out, axis=0)[:frames]

    def detect(self, y: np.ndarray) -> list:
        return labels.segments_from_probabilities(self.probabilities(y), FRAME_SECONDS)
