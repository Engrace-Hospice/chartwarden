// @chartwarden/telehealth-client — the scaffold-only swap adapters (M31-T05, spec §4.5 D1 / §1.1). Twilio Video
// and a native-WebRTC stack ship behind the SAME `TelehealthProvider` interface as Daily.co so the vendor can
// be swapped without touching any M31 consumer, but they are NOT enabled: every method raises a non-retryable
// {@link TelehealthDegradedError}. Their only load-bearing job today is the compile-time conformance test
// (`__tests__` — `satisfies TelehealthProvider`) that keeps all three adapters interface-identical (§4.5 note:
// "a compile-time conformance test"). Enabling either is a future task with its own BAA + credential wiring.
import { TelehealthDegradedError, type TelehealthOperation } from "./errors";
import type {
  TelehealthMintParticipantTokenInput,
  TelehealthMintRoomInput,
  TelehealthProvider,
  TelehealthProviderVendor,
} from "./provider";

/** Shared base for a not-enabled scaffold adapter: every vendor call fails non-retryable until it is wired. */
abstract class ScaffoldTelehealthProvider implements TelehealthProvider {
  abstract readonly vendor: TelehealthProviderVendor;

  async mintRoom(
    _input: TelehealthMintRoomInput,
  ): Promise<{ vendorRoomId: string; vendorRoomUrl: string }> {
    throw this.notEnabled("mintRoom");
  }

  async mintParticipantToken(
    _input: TelehealthMintParticipantTokenInput,
  ): Promise<{ token: string; expiresAt: string }> {
    throw this.notEnabled("mintParticipantToken");
  }

  async endRoom(_vendorRoomId: string): Promise<void> {
    throw this.notEnabled("endRoom");
  }

  async startRecording(_vendorRoomId: string): Promise<{ vendorRecordingId: string }> {
    throw this.notEnabled("startRecording");
  }

  async stopRecording(
    _vendorRoomId: string,
    _vendorRecordingId: string,
  ): Promise<{ recordingUrl: string; durationSec: number }> {
    throw this.notEnabled("stopRecording");
  }

  /** A disabled scaffold never verifies a webhook (there is no live vendor to have signed it). */
  verifyWebhookSignature(_headers: Record<string, string>, _rawBody: string): boolean {
    return false;
  }

  private notEnabled(operation: TelehealthOperation): TelehealthDegradedError {
    return new TelehealthDegradedError(
      this.vendor as "twilio_video" | "native_webrtc",
      operation,
      false, // permanent — the vendor is not enabled for this platform
      `Telehealth vendor '${this.vendor}' is not enabled for this platform.`,
      this.vendor,
    );
  }
}

/** §4.5 — the Twilio Video swap-path scaffold (interface conformance only). */
export class TwilioVideoTelehealthProvider extends ScaffoldTelehealthProvider {
  readonly vendor = "twilio_video" as const;
}

/** §4.5 — the native-WebRTC swap-path scaffold (interface conformance only). */
export class NativeWebrtcTelehealthProvider extends ScaffoldTelehealthProvider {
  readonly vendor = "native_webrtc" as const;
}
