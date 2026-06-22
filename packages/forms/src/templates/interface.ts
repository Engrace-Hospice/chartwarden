// @wardenx/forms — the §3.1 / §4.5 `FormTemplate` contract (M22-T01).
//
// Per architecture §25.14 (the adapter mandate) this package is the ONLY place a render engine (react-pdf /
// Puppeteer) and a print-vendor SDK may live; dependency-cruiser forbids any other module — including the
// M22 backend — from importing react-pdf, Puppeteer, or a print-vendor SDK directly. The M22 backend
// consumes ONLY this contract via the boot-registered template library.
//
// M22-T01 ships the template + render contract (the layout). The 31 v1 platform-floor templates (§4.5),
// the react-pdf / Puppeteer render adapters (§3.1), the overlay-composer (D14/D16), and the golden-output
// test suite land in M22-T03/T04. This file is type-only.
//
// PHI boundary: a render payload is built from a source module's typed event payload and validated against
// `payloadSchema` at enqueue time; the rendered binary is encrypted by the caller before persist
// (`byte_payload_cipher`). The renderer never persists or logs the payload itself.

import type {
  DocumentAggregateType,
  DocumentRetentionClass,
  FormRenderEngine,
} from "@wardenx/types";

/** The §4.5 platform-floor template descriptor exported by every `packages/forms/src/templates/<key>/index.ts`
 * as `{ template, currentVersion, retentionClass }`. The platform-floor is the source of truth; tenant
 * overlays (D14) tighten only — they never remove a mandatory regulatory field. */
export interface FormTemplate<Payload = unknown> {
  /** Stable template key (e.g. `'election_statement'`); the per-`<key>/` directory name. */
  readonly key: string;
  /** The §4.5 aggregate type this template instantiates (the `m22.document.rendered` discriminator). */
  readonly aggregateType: DocumentAggregateType;
  /** The render adapter this template targets. */
  readonly engine: FormRenderEngine;
  /** The retention class auto-stamped on the rendered `document` (D23 may upgrade to `compliance_42cfr_part2`). */
  readonly retentionClass: DocumentRetentionClass;
  /** Whether the rendered document is patient-facing (portal-eligible, §4.5 column). */
  readonly patientFacing: boolean;
  /** The semver version label of this template version (e.g. `'1.0.0'`). */
  readonly currentVersion: string;
  /** The TypeBox-validated render-payload schema (opaque here; validated at enqueue, §2.3). */
  readonly payloadSchema: unknown;
  /** Render the typed payload to a binary. The impl (react-pdf / Puppeteer) lands in M22-T03/T04. */
  render(args: FormRenderArgs<Payload>): Promise<FormRenderResult>;
}

/** The typed inputs to a single render (one per `form_fill`, §2.5). */
export interface FormRenderArgs<Payload = unknown> {
  readonly organizationId: string;
  readonly payload: Payload;
  /** The resolved tenant overlay binding (branding + state addendum), or `null` for the platform floor. */
  readonly overlay: TenantOverlayBinding | null;
}

/** The resolved tenant overlay (D14/D16) handed to a render. The composer guarantees it is a strict
 * superset of the platform-floor mandatory fields before it reaches the renderer. */
export interface TenantOverlayBinding {
  readonly overlayId: string;
  readonly branding: unknown;
  readonly stateAddendum: unknown | null;
}

/** The output of a render: the binary + the content metadata persisted on the new `document_version`. */
export interface FormRenderResult {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
  /** D20/D23 — true when SUD-class content was redacted in the binary (sets `metadata.sudRedacted`). */
  readonly sudRedacted: boolean;
}
