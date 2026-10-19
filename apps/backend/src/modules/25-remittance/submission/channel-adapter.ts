// M25 milestone 6a - the filing-channel adapter PORT. Pure types. The guided manual adapter is the default and the
// fallback; an electronic adapter that is not bound for the org makes the attempt go straight to `needs_manual`
// (it never sits queued). `transmit` and `poll` exist in the type for 6b but have NO live implementation in 6a, so
// nothing can be sent anywhere. 6a invents no esMD, MAC or QIC specification: every vendor field is 6b's job and
// must be sandbox-verified first.
import type {
  GuidedStep,
  SubmissionAdapterKind,
  SubmissionChannel,
  SubmissionPurpose,
} from "../domain";

export type AdapterMode = "guided_manual" | "electronic";

/** Operator-facing and PHI-free. */
export interface AdapterAvailability {
  readonly bound: boolean;
  readonly reason: string;
}

export interface GuideContext {
  readonly purpose: SubmissionPurpose;
  readonly macName: string | null;
  readonly deadline: string | null;
}

export type TransmitResult =
  | { readonly ok: true; readonly providerRef: string; readonly acceptedAt: Date }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: string };

export type AckResult =
  | { readonly state: "pending" }
  | { readonly state: "acknowledged"; readonly confirmationRef: string; readonly receiptAt: Date }
  | { readonly state: "rejected"; readonly reason: string };

export interface TransmitRequest {
  readonly idempotencyKey: string;
  readonly purpose: SubmissionPurpose;
  readonly destination: string | null;
}

export interface FilingChannelAdapter {
  readonly kind: SubmissionAdapterKind;
  readonly mode: AdapterMode;
  /** Channels this adapter can serve (the manual one serves all). */
  readonly channels: readonly SubmissionChannel[];
  availability(organizationId: string): AdapterAvailability;
  /** Always works, no network. */
  guide(ctx: GuideContext): readonly GuidedStep[];
  /** 6b only. A vendor refusal is a result, never a throw. */
  transmit?(req: TransmitRequest): Promise<TransmitResult>;
  poll?(providerRef: string): Promise<AckResult>;
}
