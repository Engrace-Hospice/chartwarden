// @chartwarden/x12-837-client — what makes a submission THIS submission (ADR-0053 D4). Shared by the in-memory reference
// transport and the vendor adapters so the idempotency identity is defined once.
import { createHash } from "node:crypto";
import type { ClearinghouseScope, ClearinghouseSubmission } from "./types";

/** The isolation key: one platform credential, many tenants, two usage modes. */
export function scopeKey(s: ClearinghouseScope): string {
  return JSON.stringify([s.organizationId, s.providerEntityId, s.usage]);
}

/** JSON with object keys sorted, so key order never changes an identity. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The business identity an idempotency key binds: everything that makes this submission THIS submission. */
export function identityOf(s: ClearinghouseSubmission): string {
  return createHash("sha256")
    .update(
      canonical({
        kind: s.kind,
        controlNumber: s.controlNumber,
        adjustment: s.adjustment ?? null,
        payload: s.payload,
      }),
    )
    .digest("hex");
}
