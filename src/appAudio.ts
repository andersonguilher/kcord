// Turns the shared app's audio, captured by the KCord desktop helper as 48 kHz
// stereo float PCM, into a MediaStreamTrack that rides along with the screen share.

const SAMPLE_RATE = 48_000;

// Small jitter buffer: starts after 20 ms of audio, trims back to 60 ms when more
// than 150 ms piles up, and plays silence when the app goes quiet.
const workletSource = `
class KcordAppAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = ${SAMPLE_RATE};
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.primed = false;
    this.port.onmessage = (event) => this.push(event.data);
  }
  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i += 1) {
      this.left[this.writeIndex] = samples[2 * i];
      this.right[this.writeIndex] = samples[2 * i + 1];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.size += frames;
    if (this.size > this.capacity) {
      this.size = this.capacity;
      this.readIndex = this.writeIndex;
    }
    if (this.size > ${SAMPLE_RATE * 0.15}) {
      const skip = this.size - ${SAMPLE_RATE * 0.06};
      this.readIndex = (this.readIndex + skip) % this.capacity;
      this.size -= skip;
    }
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1];
    const frames = left.length;
    if (!this.primed) {
      if (this.size < ${SAMPLE_RATE * 0.02}) return true;
      this.primed = true;
    }
    if (this.size < frames) {
      this.primed = false;
      return true;
    }
    for (let i = 0; i < frames; i += 1) {
      left[i] = this.left[this.readIndex];
      if (right) right[i] = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    this.size -= frames;
    return true;
  }
}
registerProcessor("kcord-app-audio", KcordAppAudio);
`;

export type AppAudioCapture = {
  track: MediaStreamTrack;
  stop: () => void;
};

type AppAudioBridge = Required<Pick<KafcordDesktopBridge, "startAppAudio" | "stopAppAudio" | "onAppAudio">>;

export function appAudioBridge(bridge: KafcordDesktopBridge | undefined): AppAudioBridge | null {
  if (!bridge?.startAppAudio || !bridge.stopAppAudio || !bridge.onAppAudio) return null;
  return bridge as AppAudioBridge;
}

function createContext() {
  // No output device needed: the audio only feeds the WebRTC track.
  try {
    return new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive", sinkId: { type: "none" } } as AudioContextOptions);
  } catch {
    return new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  }
}

// Resolves with the track, or throws with the reason (old Windows, app gone…).
export async function startAppAudio(bridge: AppAudioBridge, sourceId: string): Promise<AppAudioCapture> {
  const context = createContext();
  const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
  let unsubscribe = () => {};
  let started = false;
  try {
    await context.audioWorklet.addModule(moduleUrl);
    const node = new AudioWorkletNode(context, "kcord-app-audio", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const destination = context.createMediaStreamDestination();
    node.connect(destination);

    unsubscribe = bridge.onAppAudio((chunk) => {
      const samples = chunk.byteOffset % 4 === 0
        ? new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 2)
        : new Float32Array(chunk.slice().buffer);
      node.port.postMessage(samples);
    }, () => undefined);

    const result = await bridge.startAppAudio(sourceId);
    if (!result.ok) throw new Error(result.error || "Captura de áudio indisponível.");
    started = true;
    await context.resume().catch(() => undefined);

    const track = destination.stream.getAudioTracks()[0];
    track.contentHint = "music";
    let stopped = false;
    return {
      track,
      stop: () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        bridge.stopAppAudio();
        track.stop();
        node.disconnect();
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    unsubscribe();
    if (started) bridge.stopAppAudio();
    void context.close().catch(() => undefined);
    throw error;
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}
