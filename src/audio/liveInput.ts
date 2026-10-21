import { FFT_SIZE } from "../lib/chordSpectrum";
import { loudestChannel } from "../lib/liveInput";

/** An open input: reads the newest window of sound and is closed to give the device back. */
export interface LiveSource {
  sampleRate: number;
  label: string;
  /** The newest FFT_SIZE samples of the loudest channel; the buffer is reused by the next read. */
  read(): Float32Array | null;
  /** Calls `callback` if the device goes away (unplugged, taken by another program). */
  onEnded(callback: () => void): void;
  close(): void;
}

/**
 * Opens an input to look at, not to record: no processing the browser would apply to a voice (echo cancelling,
 * noise suppression, gain control would flatten a guitar), every native channel kept so an instrument on one
 * input of a two-input interface is not halved by a mono downmix, the loudest channel read.
 */
export async function openLiveInput(deviceId: string | null): Promise<LiveSource> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
        sampleRate: 44100,
      },
      video: false,
    });
  } catch (e) {
    throw new Error("Input unavailable: " + (e instanceof Error ? e.message : String(e)));
  }
  const track = stream.getAudioTracks()[0];
  console.log("[live] track settings:", track.getSettings());

  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: 44100 });
  } catch (e) {
    console.warn("[live] AudioContext with sampleRate:44100 failed, falling back:", e);
    ctx = new AudioContext();
  }
  try {
    if (ctx.state === "suspended") await ctx.resume();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch((closeError: unknown) => console.warn("[live] AudioContext close:", closeError));
    throw new Error("Input unavailable: " + (e instanceof Error ? e.message : String(e)));
  }

  const channels = Math.max(1, track.getSettings().channelCount ?? 1);
  const source = ctx.createMediaStreamSource(stream);
  const splitter = channels > 1 ? ctx.createChannelSplitter(channels) : null;
  if (splitter) source.connect(splitter);
  const analysers = Array.from({ length: channels }, (_, channel) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0;
    if (splitter) splitter.connect(analyser, channel);
    else source.connect(analyser);
    return analyser;
  });
  const buffers = analysers.map(() => new Float32Array(FFT_SIZE));

  return {
    sampleRate: ctx.sampleRate,
    label: track.label,
    read() {
      analysers.forEach((analyser, i) => analyser.getFloatTimeDomainData(buffers[i]));
      return buffers[loudestChannel(buffers)];
    },
    onEnded(callback) {
      track.addEventListener("ended", callback);
    },
    close() {
      stream.getTracks().forEach((t) => t.stop());
      analysers.forEach((a) => a.disconnect());
      splitter?.disconnect();
      source.disconnect();
      ctx.close().catch((e: unknown) => console.warn("[live] AudioContext close:", e));
    },
  };
}
