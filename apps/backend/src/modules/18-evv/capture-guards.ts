// apps/backend/src/modules/18-evv/capture-guards.ts — GAP-055 (§4.7, §8.2).
//
// The SERVICE-layer twin of the route-layer capture gates. The route composes `assigned_clinician_for_visit`
// ∧ `evv_within_visit_window` ∧ `device_attestation_valid` as preHandlers (and, for the offline-sync batch,
// runs them once per event). `recordCapture` re-asserts all three itself, so a caller that is NOT a route
// (a queue replay worker, a future module) cannot record an EVV event by skipping the HTTP guards.
//
// Every fact is server-derived: the clinician is the session actor, the assignment and the window come from
// the stored visit through the {@link EvvAbacResolver} (prod: the M17 visit read path — no M17 import here),
// and the attestation is the session-bound verdict the authenticate hook stamped from the stored device
// attestation — never a field of the request body.
//
// The only exemption is the explicit, typed {@link EvvSystemCapture} marker. It is a discriminated-union
// member, never inferred from a role string, and a route can never construct one from request data.
import { ForbiddenError, ValidationError } from "@chartwarden/types";
import type { EvvAbacResolver } from "./abac-predicates";

/**
 * The server-side config flag behind the device-attestation requirement and the session-device binding
 * (GAP-055 follow-up, ADR-0035). Default OFF: no attested client exists yet, so enforcing either would make
 * every production check-in / check-out / offline-sync return 403. Read ONCE at boot from validated server
 * config (`bootstrap/env.ts` refuses a set value other than `true`/`false`) and injected into the routes and
 * the service — never read from a request header or body.
 */
export const EVV_DEVICE_ATTESTATION_ENFORCED_ENV = "EVV_DEVICE_ATTESTATION_ENFORCED";

/** True only for an explicit `EVV_DEVICE_ATTESTATION_ENFORCED=true` — anything else is "not enforced". */
export function isEvvDeviceAttestationEnforced(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[EVV_DEVICE_ATTESTATION_ENFORCED_ENV] === "true";
}

/** The session-bound device-attestation verdict (stamped by M2's authenticate hook; `null` = none). */
export interface EvvDeviceAttestationFact {
  readonly valid: boolean;
  readonly verifiedAt?: string;
  /** The M2 `device_attestation` row id the SESSION points at (server-derived; the session-bound device). */
  readonly attestationId?: string;
}

/** A capture on behalf of a human clinician: all three §8.2 guards apply. */
export interface EvvClinicianCapture {
  readonly kind: "clinician";
  readonly deviceAttestation: EvvDeviceAttestationFact | null;
}

/** An internal/system capture (e.g. an offline-queue replay worker): guards are not applied. */
export interface EvvSystemCapture {
  readonly kind: "system";
  /** Why the system is capturing; for the audit trail, never an authorization input. */
  readonly reason: string;
}

export type EvvCaptureAuthority = EvvClinicianCapture | EvvSystemCapture;

/** Build the explicit system-actor marker (never derive it from a role or a request field). */
export const systemCapture = (reason: string): EvvSystemCapture => ({ kind: "system", reason });

/** The slice of an `evv_device` row the session binding needs. */
export interface EvvDeviceCandidate {
  readonly id: string;
  readonly membershipId: string;
  readonly status: string;
  /** `evv_device.m2_device_attestation_id`. */
  readonly attestationId: string | null;
  /** Approval instant (epoch ms; any monotonic ordinal for a fixture) — orders "most recently approved". */
  readonly approvedAtMs: number;
}

/**
 * Resolve the device a clinician capture records against.
 *
 * ENFORCED (`deviceAttestationEnforced`): bind to the device that SENT the request — the one approved
 * `evv_device` of the acting membership whose M2 attestation is the session's. Fail-closed: no attestation id
 * on the session, or no matching approved device, denies; a claimed id must equal that device.
 *
 * NOT enforced (the default): the session attestation is not consulted. A clinician with several approved
 * devices may capture from any of them, so a claimed `evvDeviceId` is accepted when it is an approved device
 * of the SAME membership (the event records against it); with no claim, the membership's most-recently-approved
 * device (ties broken by smallest id, matching the SQL `ORDER BY approved_at DESC NULLS LAST, id`). A claim that
 * is not an approved device of the acting membership (another member's, unknown, not approved) denies.
 *
 * Returns the id to record on the event, or `null` for the typed system marker (no session device — the
 * caller keeps its own device rule). In BOTH modes a client-supplied `claimedDeviceId` can never widen the
 * result beyond the acting membership's own approved devices.
 */
export function selectBoundDevice(
  authority: EvvCaptureAuthority,
  membershipId: string,
  claimedDeviceId: string | undefined,
  candidates: readonly EvvDeviceCandidate[],
  deviceAttestationEnforced: boolean,
): string | null {
  if (authority.kind === "system") return null;
  if (deviceAttestationEnforced) {
    const bound = sessionBoundDevice(authority, membershipId, candidates);
    if (claimedDeviceId !== undefined && claimedDeviceId !== bound.id)
      throw new ForbiddenError("the claimed evvDeviceId is not the session-bound device");
    return bound.id;
  }
  const latest = mostRecentApprovedDevice(membershipId, candidates);
  if (claimedDeviceId === undefined) return latest.id;
  const claimed = candidates.find(
    (c) => c.id === claimedDeviceId && c.membershipId === membershipId && c.status === "approved",
  );
  if (!claimed)
    throw new ForbiddenError("the claimed evvDeviceId is not an approved device of the clinician");
  return claimed.id;
}

function sessionBoundDevice(
  authority: EvvClinicianCapture,
  membershipId: string,
  candidates: readonly EvvDeviceCandidate[],
): EvvDeviceCandidate {
  const attestationId = authority.deviceAttestation?.attestationId;
  if (!attestationId) throw new ForbiddenError("the session is bound to no EVV device");
  const bound = candidates.find(
    (c) =>
      c.membershipId === membershipId &&
      c.status === "approved" &&
      c.attestationId === attestationId,
  );
  if (!bound)
    throw new ForbiddenError("the session device is not an approved device of the clinician");
  return bound;
}

function mostRecentApprovedDevice(
  membershipId: string,
  candidates: readonly EvvDeviceCandidate[],
): EvvDeviceCandidate {
  const approved = candidates
    .filter((c) => c.membershipId === membershipId && c.status === "approved")
    .reduce<EvvDeviceCandidate | null>(
      (best, c) =>
        best === null ||
        c.approvedAtMs > best.approvedAtMs ||
        (c.approvedAtMs === best.approvedAtMs && c.id < best.id)
          ? c
          : best,
      null,
    );
  if (!approved)
    throw new ValidationError(
      "the posting clinician has no approved EVV device to capture with",
      [],
    );
  return approved;
}

/** Build the clinician authority from the session-stamped attestation attribute (unknown shape → none). */
export function clinicianCapture(rawAttestation: unknown): EvvClinicianCapture {
  if (
    typeof rawAttestation !== "object" ||
    rawAttestation === null ||
    typeof (rawAttestation as { valid?: unknown }).valid !== "boolean"
  )
    return { kind: "clinician", deviceAttestation: null };
  const raw = rawAttestation as { valid: boolean; verifiedAt?: unknown; attestationId?: unknown };
  return {
    kind: "clinician",
    deviceAttestation: {
      valid: raw.valid,
      ...(typeof raw.verifiedAt === "string" ? { verifiedAt: raw.verifiedAt } : {}),
      ...(typeof raw.attestationId === "string" && raw.attestationId.length > 0
        ? { attestationId: raw.attestationId }
        : {}),
    },
  };
}

/**
 * Assert the §8.2 capture guards for one event. Fail-closed: an unknown visit / assignment / window denies.
 * `membershipId` is the posting membership (the session actor). `deviceAttestationEnforced` gates ONLY the
 * attestation check; the assignment and window checks always apply to a clinician capture.
 */
export async function assertCaptureAllowed(
  resolver: EvvAbacResolver,
  orgId: string,
  membershipId: string,
  input: { readonly visitId: string; readonly capturedAt: string },
  authority: EvvCaptureAuthority,
  deviceAttestationEnforced: boolean,
): Promise<void> {
  if (authority.kind === "system") return;
  if (deviceAttestationEnforced && authority.deviceAttestation?.valid !== true)
    throw new ForbiddenError("device_attestation_valid denied for the EVV capture");
  const assigned = await resolver.assignedMembershipForVisit(orgId, input.visitId);
  if (assigned === null || assigned !== membershipId)
    throw new ForbiddenError("assigned_clinician_for_visit denied for the EVV capture");
  const window = await resolver.visitWindowForVisit(orgId, input.visitId);
  const captured = Date.parse(input.capturedAt);
  const start = window ? Date.parse(window.scheduledStartedAt) : Number.NaN;
  const end = window ? Date.parse(window.scheduledEndedAt) : Number.NaN;
  if (Number.isNaN(captured) || Number.isNaN(start) || Number.isNaN(end))
    throw new ForbiddenError("evv_within_visit_window denied for the EVV capture");
  const policy = await resolver.captureWindow(orgId);
  if (captured < start - policy.beforeMs || captured > end + policy.afterMs)
    throw new ForbiddenError("evv_within_visit_window denied for the EVV capture");
}
