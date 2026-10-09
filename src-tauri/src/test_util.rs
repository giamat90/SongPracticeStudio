//! Shared helpers for the Rust tests (compiled only under `cfg(test)`).

use std::path::Path;

/// Sum of sines (each `(freq_hz, amplitude)`) as mono f32 samples.
pub fn tones(partials: &[(f64, f64)], sample_rate: u32, seconds: f64) -> Vec<f32> {
    let n = (sample_rate as f64 * seconds) as usize;
    (0..n)
        .map(|i| {
            let t = i as f64 / sample_rate as f64;
            partials
                .iter()
                .map(|(f, a)| a * (2.0 * std::f64::consts::PI * f * t).sin())
                .sum::<f64>() as f32
        })
        .collect()
}

/// Mono 16-bit PCM WAV bytes.
pub fn wav_bytes(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn write_wav(path: &Path, samples: &[f32], sample_rate: u32) {
    std::fs::write(path, wav_bytes(samples, sample_rate)).expect("write wav");
}

pub struct Wav {
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// Minimal RIFF reader for the PCM-16 / float-32 files soundfile writes.
pub fn read_wav(path: &Path) -> Wav {
    let b = std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    assert_eq!(&b[0..4], b"RIFF", "not a RIFF file: {}", path.display());
    let (mut fmt, mut channels, mut sample_rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut pos = 12;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            fmt = u16::from_le_bytes(b[body..body + 2].try_into().unwrap());
            channels = u16::from_le_bytes(b[body + 2..body + 4].try_into().unwrap());
            sample_rate = u32::from_le_bytes(b[body + 4..body + 8].try_into().unwrap());
            bits = u16::from_le_bytes(b[body + 14..body + 16].try_into().unwrap());
        } else if id == b"data" {
            let data = &b[body..(body + size).min(b.len())];
            let samples = match (fmt, bits) {
                (1, 16) => data
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect(),
                (3, 32) => data
                    .chunks_exact(4)
                    .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                    .collect(),
                other => panic!("unsupported WAV format {other:?}"),
            };
            return Wav { sample_rate, channels, samples };
        }
        pos = body + size + (size & 1);
    }
    panic!("no data chunk in {}", path.display());
}

pub fn rms_dbfs(samples: &[f32]) -> f64 {
    let mean_sq = samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / samples.len().max(1) as f64;
    20.0 * mean_sq.sqrt().max(1e-12).log10()
}

/// The real sidecar needs the Python venv. By default tests that need it skip
/// (so a machine without one still gets a green run); set SPS_REQUIRE_SIDECAR=1
/// (CI does) to turn a skip into a failure.
pub fn sidecar_unavailable(reason: &str) {
    if std::env::var_os("SPS_REQUIRE_SIDECAR").is_some() {
        panic!("SPS_REQUIRE_SIDECAR is set but the sidecar is unavailable: {reason}");
    }
    eprintln!("SKIPPED (sidecar unavailable): {reason}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_round_trips_through_the_reader() {
        let dir = std::env::temp_dir().join(format!("sps-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.wav");
        let src = tones(&[(440.0, 0.5)], 22050, 0.1);
        write_wav(&path, &src, 22050);
        let back = read_wav(&path);
        assert_eq!((back.sample_rate, back.channels, back.samples.len()), (22050, 1, src.len()));
        for (a, b) in src.iter().zip(&back.samples) {
            assert!((a - b).abs() < 1e-3);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rms_of_a_full_scale_sine_is_minus_three_db() {
        let s = tones(&[(100.0, 1.0)], 44100, 1.0);
        assert!((rms_dbfs(&s) + 3.01).abs() < 0.05);
    }
}
