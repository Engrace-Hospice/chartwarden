// ADR-0049 D3 — tenant slug rules. A slug is the DNS label a tenant is served at
// (`<slug>.<TENANT_BASE_DOMAIN>`), so it is an RFC 1123 label, lower-case, never punycode, and never one
// of the hosts ADR-0049 D2 reserves. The DB CHECK in migration 1144 repeats both rules; a test keeps the
// two in step.

/** Hosts under the base domain that are never tenants (ADR-0049 D2). */
export const RESERVED_TENANT_SLUGS: readonly string[] = [
  "www",
  "admin",
  "api",
  "portal",
  "storage",
  "app",
  "status",
  "docs",
  "mail",
];

/** RFC 1123 DNS label, lower-case, 1–63 characters; `validateTenantSlug` additionally requires 3+. */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const MIN_TENANT_SLUG_LENGTH = 3;

export type TenantSlugRejection = "format" | "punycode" | "reserved";
export type TenantSlugValidation = { ok: true } | { ok: false; reason: TenantSlugRejection };

export function validateTenantSlug(slug: string): TenantSlugValidation {
  if (slug.length < MIN_TENANT_SLUG_LENGTH || !TENANT_SLUG_PATTERN.test(slug)) {
    return { ok: false, reason: "format" };
  }
  if (slug.startsWith("xn--")) return { ok: false, reason: "punycode" };
  if (RESERVED_TENANT_SLUGS.includes(slug)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export type TenantHostClass =
  | { kind: "tenant"; label: string }
  | { kind: "apex" }
  | { kind: "reserved" }
  | { kind: "invalid" }
  | { kind: "outside" };

/** Where a `Host` value sits relative to the base domain. Port, case and a trailing dot are ignored. */
export function classifyTenantHost(host: string, baseDomain: string): TenantHostClass {
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (name === baseDomain) return { kind: "apex" };
  const suffix = `.${baseDomain}`;
  if (!name.endsWith(suffix)) return { kind: "outside" };
  const label = name.slice(0, -suffix.length);
  if (RESERVED_TENANT_SLUGS.includes(label)) return { kind: "reserved" };
  if (label.includes(".") || label.startsWith("xn--") || !TENANT_SLUG_PATTERN.test(label)) return { kind: "invalid" };
  return { kind: "tenant", label };
}
