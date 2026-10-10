"""A scripted stand-in for the acoustic model, so alignment is testable without torch."""

import numpy as np

import lyrics

CHARS = "abcdefghijklmnopqrstuvwxyz'"
CHAR_IDS = {c: i + 1 for i, c in enumerate(CHARS)}
FRAME_S = 0.02
SR = 16000


class ScriptedAligner:
    """Emits every lyric letter on a frame chosen by the test.

    `word_starts` is the second each *normalised* word begins; its letters occupy
    consecutive frames from there. Words with no letters take no slot.
    """

    name = "scripted"
    sample_rate = SR
    frame_seconds = FRAME_S
    blank_id = 0
    char_ids = CHAR_IDS

    def __init__(self, text, word_starts, peak=0.9, letter_frames=1, noise=0.001, extra_events=0):
        self.peak = peak
        self.noise = noise
        self.extra_events = extra_events
        self.letter_frames = letter_frames
        self.seen_audio = None
        self.seen_targets = None
        self.token_frames = []
        words = [w for line in lyrics.parse_lyrics(text) for w in line]
        starts = iter(word_starts)
        for word in words:
            norm = lyrics.normalize_word(word, set(CHARS))
            if not norm:
                continue
            frame0 = int(round(next(starts) / FRAME_S))
            for k, _ in enumerate(norm):
                # one blank frame after each held letter: CTC cannot emit "ll" back to back
                self.token_frames.append(frame0 + k * (letter_frames + 1))

    def emissions(self, audio, targets, on_progress=None):
        self.seen_audio = audio
        self.seen_targets = list(targets)
        n_frames = int(len(audio) / SR / FRAME_S)
        n_classes = len(CHARS) + 1
        rest = (1.0 - self.peak) / (n_classes - 1)
        probs = np.full((n_frames, n_classes), rest)
        probs[:, 0] = 1.0 - self.noise
        probs[:, 1:] = self.noise / (n_classes - 1)
        for frame, token in zip(self.token_frames, targets):
            for k in range(self.letter_frames):
                if frame + k < n_frames:
                    probs[frame + k, :] = rest
                    probs[frame + k, token] = self.peak
        for k in range(self.extra_events):
            frame = 3 + 2 * k
            if frame < n_frames:
                probs[frame, :] = rest
                probs[frame, 1] = self.peak
        probs = probs / probs.sum(axis=1, keepdims=True)
        if on_progress:
            on_progress(0.5, "listening")
        return np.log(probs)
