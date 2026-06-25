export class VocalRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private _isRecording = false;

  async init(deviceId?: string | null): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { ideal: deviceId } } : true,
    });
  }

  start(): void {
    if (!this.stream) throw new Error("Recorder not initialized — call init() first");

    // Pick the best supported mimeType — WebView2 may not support opus
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = (e) => {
      console.error("[recorder] MediaRecorder error:", e);
      this._isRecording = false;
    };
    this.recorder.start(100);
    this._isRecording = true;
    console.log("[recorder] started with mimeType:", this.recorder.mimeType);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder || this.recorder.state !== "recording") {
        reject(new Error(`Not recording (state: ${this.recorder?.state ?? "no recorder"})`));
        return;
      }
      const mimeType = this.recorder.mimeType;
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        this._isRecording = false;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  getStream(): MediaStream | null {
    return this.stream;
  }

  // Stop mic tracks to release the OS audio session (restores Windows default device).
  // Call this after stop() resolves, before restoring audio output routing.
  releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose(): void {
    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.releaseStream();
    this.recorder = null;
    this._isRecording = false;
  }
}
