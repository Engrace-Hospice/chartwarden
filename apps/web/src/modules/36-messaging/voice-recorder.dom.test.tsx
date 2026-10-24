// M36 WP 6.3 (ADR-0094 decision 1): the composer's voice-note recorder. MediaRecorder and getUserMedia are faked; the real component,
// hook, flag gate and attachment hand-off run.
import { FeatureFlagProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorderButton } from "./voice-recorder";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm;codecs=opus");
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  payload = new Blob(["opus-bytes"], { type: "audio/webm" });
  constructor(
    readonly stream: unknown,
    readonly options: { mimeType: string },
  ) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: this.payload });
    this.onstop?.();
  }
}

const trackStop = vi.fn();
let endTrack: () => void = () => undefined;
const getUserMedia = vi.fn();
const addFiles = vi.fn();

function grantMicrophone() {
  getUserMedia.mockImplementation(async () => ({
    getTracks: () => [{ stop: trackStop }],
    getAudioTracks: () => [
      {
        addEventListener: (_type: string, listener: () => void) => {
          endTrack = listener;
        },
      },
    ],
  }));
}

const mount = (flagOn = true) =>
  render(
    <FeatureFlagProvider flags={{ "messaging.voice_notes": flagOn }}>
      <VoiceRecorderButton uploads={{ addFiles }} disabled={false} />
    </FeatureFlagProvider>,
  );

const click = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const recorder = () => FakeRecorder.instances.at(-1) as FakeRecorder;

async function startRecording() {
  await click("Record voice note");
  await click("Record");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  FakeRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:voice-1"),
    revokeObjectURL: vi.fn(),
  });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  grantMicrophone();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("voice note recorder", () => {
  it("is not offered while the tenant flag is off, or when the browser cannot record", () => {
    mount(false);
    expect(screen.queryByRole("button", { name: "Record voice note" })).toBeNull();
    cleanup();
    vi.stubGlobal("MediaRecorder", undefined);
    mount(true);
    expect(screen.queryByRole("button", { name: "Record voice note" })).toBeNull();
  });

  it("asks for the microphone only when Record is pressed", async () => {
    mount();
    await click("Record voice note");
    expect(getUserMedia).not.toHaveBeenCalled();
    await click("Record");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(recorder().options.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("shows a text timer that excludes paused time, then Listen and Attach hand a webm file to the upload pipeline", async () => {
    mount();
    await startRecording();
    await tick(42_000);
    expect(screen.getByRole("timer").textContent).toBe("Recording, 0:42 of 5:00");
    await click("Pause");
    await tick(30_000);
    expect(screen.getByRole("timer").textContent).toBe("Paused, 0:42 of 5:00");
    await click("Resume");
    await tick(3_000);
    expect(screen.getByRole("timer").textContent).toBe("Recording, 0:45 of 5:00");
    await click("Stop");
    expect(screen.getByLabelText("Listen to your recording")).toBeTruthy();
    expect(trackStop).toHaveBeenCalled();
    await click("Attach voice note");
    expect(addFiles).toHaveBeenCalledTimes(1);
    const [files] = addFiles.mock.calls[0] as [File[]];
    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe("audio/webm");
    expect(files[0]?.name).toMatch(/^voice-note-\d{8}-\d{6}\.webm$/);
    expect(screen.queryByRole("region", { name: "Voice note" })).toBeNull();
  });

  it("stops itself at the 5 minute limit and says so", async () => {
    mount();
    await startRecording();
    await tick(300_000);
    expect(recorder().state).toBe("inactive");
    expect(screen.getByLabelText("Listen to your recording")).toBeTruthy();
    expect(screen.getByText(/Stopped at the 5:00 limit/)).toBeTruthy();
  });

  it("Discard throws the recording away without attaching anything", async () => {
    mount();
    await startRecording();
    await click("Stop");
    await click("Discard");
    expect(addFiles).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Listen to your recording")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-1");
  });

  it("a blocked microphone is a text message and no recorder is created", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    mount();
    await startRecording();
    expect(screen.getByText(/Microphone access is blocked/)).toBeTruthy();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Record" })).toBeTruthy();
  });

  it("a recording interrupted by the page being hidden is discarded, never kept as a success", async () => {
    mount();
    await startRecording();
    await tick(5_000);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText(/Recording stopped because the page was hidden/)).toBeTruthy();
    expect(screen.queryByLabelText("Listen to your recording")).toBeNull();
    expect(trackStop).toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("a microphone that disappears mid-recording is discarded too", async () => {
    mount();
    await startRecording();
    await act(async () => endTrack());
    expect(screen.getByText(/Recording was interrupted/)).toBeTruthy();
    expect(screen.queryByLabelText("Listen to your recording")).toBeNull();
  });

  it("an empty recording and an oversize one (over 8 MB) are refused with a message", async () => {
    mount();
    await startRecording();
    recorder().payload = new Blob([], { type: "audio/webm" });
    await click("Stop");
    expect(screen.getByText("Nothing was recorded.")).toBeTruthy();
    await click("Record");
    recorder().payload = new Blob([new Uint8Array(8_000_001)], { type: "audio/webm" });
    await click("Stop");
    expect(screen.getByText(/too large to send/)).toBeTruthy();
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("closing the panel mid-recording releases the microphone and keeps nothing", async () => {
    mount();
    await startRecording();
    await click("Discard");
    expect(trackStop).toHaveBeenCalled();
    expect(addFiles).not.toHaveBeenCalled();
  });
});
