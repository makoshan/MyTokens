use std::io::Cursor;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

pub struct VoiceAudioRecorder {
    #[cfg(target_os = "macos")]
    stream: cpal::Stream,
    #[cfg(target_os = "macos")]
    buffer_mono: Arc<Mutex<Vec<f32>>>,
    #[cfg(target_os = "macos")]
    sample_rate: u32,
    #[cfg(target_os = "macos")]
    channels: u16,
}

impl VoiceAudioRecorder {
    #[cfg(target_os = "macos")]
    pub fn start() -> Result<Self, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default input device".to_string())?;
        let cfg = device
            .default_input_config()
            .map_err(|e| format!("Failed to query input config: {}", e))?;

        let sample_rate = cfg.sample_rate().0;
        let channels = cfg.channels();
        let buffer_mono: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let buf = Arc::clone(&buffer_mono);

        let err_fn = |err| {
            log::warn!("Voice recorder stream error: {}", err);
        };

        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => device
                .build_input_stream(
                    &cfg.into(),
                    move |data: &[f32], _| {
                        push_mono_samples(&buf, data, channels);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build input stream: {}", e))?,
            cpal::SampleFormat::I16 => device
                .build_input_stream(
                    &cfg.into(),
                    move |data: &[i16], _| {
                        push_mono_samples_i16(&buf, data, channels);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build input stream: {}", e))?,
            cpal::SampleFormat::U16 => device
                .build_input_stream(
                    &cfg.into(),
                    move |data: &[u16], _| {
                        push_mono_samples_u16(&buf, data, channels);
                    },
                    err_fn,
                    None,
                )
                .map_err(|e| format!("Failed to build input stream: {}", e))?,
            other => {
                return Err(format!("Unsupported sample format: {:?}", other));
            }
        };

        stream
            .play()
            .map_err(|e| format!("Failed to start input stream: {}", e))?;

        Ok(Self {
            stream,
            buffer_mono,
            sample_rate,
            channels,
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn start() -> Result<Self, String> {
        Err("Voice recorder currently supports macOS only".to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn stop(self, target_sample_rate: u32) -> Result<Vec<u8>, String> {
        drop(self.stream);
        let samples = self
            .buffer_mono
            .lock()
            .map_err(|_| "Failed to lock audio buffer".to_string())?
            .clone();

        if samples.is_empty() {
            return Err("No audio captured".to_string());
        }

        let resampled = if self.sample_rate == target_sample_rate {
            samples
        } else {
            resample_linear(&samples, self.sample_rate, target_sample_rate)
        };

        encode_wav_pcm16le_mono(&resampled, target_sample_rate)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn stop(self, _target_sample_rate: u32) -> Result<Vec<u8>, String> {
        let _ = self;
        Err("Voice recorder currently supports macOS only".to_string())
    }
}

#[cfg(target_os = "macos")]
fn push_mono_samples(buf: &Arc<Mutex<Vec<f32>>>, data: &[f32], channels: u16) {
    let channels = channels.max(1) as usize;
    let mut out = match buf.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    for frame in data.chunks(channels) {
        let mut sum = 0.0f32;
        for &v in frame {
            sum += v;
        }
        out.push(sum / channels as f32);
    }
}

#[cfg(target_os = "macos")]
fn push_mono_samples_i16(buf: &Arc<Mutex<Vec<f32>>>, data: &[i16], channels: u16) {
    let channels = channels.max(1) as usize;
    let mut out = match buf.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    for frame in data.chunks(channels) {
        let mut sum = 0.0f32;
        for &v in frame {
            sum += (v as f32) / (i16::MAX as f32);
        }
        out.push(sum / channels as f32);
    }
}

#[cfg(target_os = "macos")]
fn push_mono_samples_u16(buf: &Arc<Mutex<Vec<f32>>>, data: &[u16], channels: u16) {
    let channels = channels.max(1) as usize;
    let mut out = match buf.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    for frame in data.chunks(channels) {
        let mut sum = 0.0f32;
        for &v in frame {
            let centered = v as f32 - 32768.0;
            sum += centered / 32768.0;
        }
        out.push(sum / channels as f32);
    }
}

fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == 0 || to_rate == 0 || samples.is_empty() {
        return Vec::new();
    }

    let from_rate_f = from_rate as f64;
    let to_rate_f = to_rate as f64;
    let ratio = from_rate_f / to_rate_f;
    let out_len = ((samples.len() as f64) / ratio).floor() as usize;
    let out_len = out_len.max(1);

    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = (i as f64) * ratio;
        let idx0 = src_pos.floor() as usize;
        let idx1 = (idx0 + 1).min(samples.len() - 1);
        let frac = (src_pos - idx0 as f64) as f32;
        let v0 = samples[idx0];
        let v1 = samples[idx1];
        out.push(v0 + (v1 - v0) * frac);
    }
    out
}

fn encode_wav_pcm16le_mono(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    let mut writer = hound::WavWriter::new(&mut cursor, spec)
        .map_err(|e| format!("Failed to create WAV writer: {}", e))?;
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        writer
            .write_sample(v)
            .map_err(|e| format!("Failed to write WAV sample: {}", e))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize WAV: {}", e))?;
    Ok(cursor.into_inner())
}
