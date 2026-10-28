// apps/backend/src/modules/02-identity/routes/public-tenant-routes.ts — the two UNAUTHENTICATED tenant-discovery routes
// (ADR-0049 Phase 4).
//
//   GET  /api/v1/public/tenant                 the organization this HOST serves: `{ status, displayName? }` so a tenant
//                                              sign-in page can show the tenant's name. Host-derived, no parameter. The
//                                              display name is present only for an active / created organization.
//   POST /api/v1/public/find-my-organization   `{ email }` -> always 202 `{ status: "sent" }` for a well-formed address.
//                                              Mails the person the sign-in link of each ACTIVE organization they belong to
//                                              (ONE email, and only when there is at least one). Nothing about membership
//                                              ever reaches the response, so this is not an account-existence oracle.
//
// Auth column: `none`. Controls: per-IP budget (429), per-sha256(lower-cased email) budget (silently suppresses the send,
// still 202, so flooding a victim's address cannot be told apart from a quiet one), the lookup + send run AFTER the
// response is scheduled so a hit and a miss take the same time, and both routes 404 unless TENANT_BASE_DOMAIN is set.
// The tenant is read off `request.hostname` (the socket Host, or X-Forwarded-Host only from a trusted proxy) - never a header.
import { createHash } from "node:crypto";
import {
  ChartWardenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  classifyTenantHost,
  tenantOriginForSlug,
} from "@chartwarden/types";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance, FastifyRequest } from "fastify";

const MAX_EMAIL_LENGTH = 254;
// Deliberately loose (no whitespace, one @, a dotted domain): the address only ever feeds a lookup, never a login.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const PublicTenantResponseSchema = Type.Object({
  status: Type.String(),
  displayName: Type.Optional(Type.String()),
});
export type PublicTenantResponse = Static<typeof PublicTenantResponseSchema>;

export const FindMyOrganizationRequestSchema = Type.Object(
  { email: Type.String({ maxLength: MAX_EMAIL_LENGTH }) },
  { additionalProperties: false },
);
export const FindMyOrganizationResponseSchema = Type.Object({ status: Type.Literal("sent") });

export interface PublicTenantRow {
  readonly status: string;
  readonly displayName: string | null;
}
export interface TenantLink {
  readonly slug: string;
  readonly displayName: string;
}
export interface PublicTenantLimiter {
  consume(
    key: string,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number; storeError?: true }>;
}
export interface PublicTenantEmailTransport {
  send(message: { to: string; subject: string; text: string }): Promise<unknown>;
}

export interface PublicTenantRouteDeps {
  /** `TENANT_BASE_DOMAIN`; null (single-host mode) makes both routes 404. */
  readonly baseDomain: string | null;
  /** `resolve_tenant_public(label)` (migration 1148). */
  resolvePublic(label: string): Promise<PublicTenantRow | null>;
  /** `tenant_links_for_email(email)` (migration 1148). */
  linksForEmail(email: string): Promise<readonly TenantLink[]>;
  readonly emailTransport?: PublicTenantEmailTransport;
  readonly ipLimiter: PublicTenantLimiter;
  readonly emailLimiter: PublicTenantLimiter;
  /** Schedules the post-response work; defaults to `setImmediate`. Tests pass a collector. */
  readonly defer?: (work: () => Promise<void>) => void;
  readonly onBackgroundError?: (err: unknown) => void;
}

const ipOf = (request: FastifyRequest): string => request.ip || "unknown";
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function parseBody(raw: unknown): Static<typeof FindMyOrganizationRequestSchema> {
  const body = raw ?? {};
  const invalid = (message: string) =>
    new ValidationError("request validation failed", [
      { field: "email", code: "INVALID", message },
    ]);
  if (!Value.Check(FindMyOrganizationRequestSchema, body))
    throw invalid("a well-formed email is required");
  const email = (body as { email: string }).email.trim();
  if (!EMAIL_PATTERN.test(email)) throw invalid("a well-formed email is required");
  return { email };
}

const MAX_DISPLAY_NAME_LENGTH = 80;
const URL_LIKE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*/gi;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** A tenant name is database text an administrator typed: one short plain line, no URLs, so it cannot carry a phishing link. */
export function sanitizeDisplayName(name: string): string {
  return name
    .replace(CONTROL_CHARS, " ")
    .replace(URL_LIKE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH)
    .trim();
}

/**
 * Plain-text body: one line per organization, with a slug-only URL. A link whose slug is not a valid tenant label is
 * omitted; null when nothing is left to send.
 */
export function buildFindMyOrganizationEmail(
  baseDomain: string,
  links: readonly TenantLink[],
): { subject: string; text: string } | null {
  const lines = links.flatMap((l) => {
    const origin = tenantOriginForSlug(l.slug, baseDomain);
    return origin ? [`  ${sanitizeDisplayName(l.displayName)}: ${origin}/`] : [];
  });
  if (lines.length === 0) return null;
  return {
    subject: "Your ChartWarden sign-in addresses",
    text: `You asked for the ChartWarden address of your organization. Sign in at:\n\n${lines.join("\n")}\n\nIf you didn't ask for this, you can ignore this email.`,
  };
}

export function registerPublicTenantRoutes(
  app: FastifyInstance,
  deps: PublicTenantRouteDeps,
): void {
  const defer =
    deps.defer ??
    ((work) => {
      setImmediate(() => void work().catch((err) => deps.onBackgroundError?.(err)));
    });

  app.get("/api/v1/public/tenant", async (request, reply) => {
    const host = deps.baseDomain ? classifyTenantHost(request.hostname, deps.baseDomain) : null;
    if (host?.kind !== "tenant") {
      throw new ChartWardenError(
        "TENANT_HOST_UNKNOWN",
        "no organization is served at this address",
        404,
      );
    }
    const row = await deps.resolvePublic(host.label);
    if (!row)
      throw new ChartWardenError(
        "TENANT_HOST_UNKNOWN",
        "no organization is served at this address",
        404,
      );
    reply.header("Cache-Control", "no-store");
    return {
      status: row.status,
      ...(row.displayName ? { displayName: row.displayName } : {}),
    } satisfies PublicTenantResponse;
  });

  app.post("/api/v1/public/find-my-organization", async (request, reply) => {
    const baseDomain = deps.baseDomain;
    if (!baseDomain) throw new NotFoundError("route");
    const { email } = parseBody(request.body);

    const ip = await deps.ipLimiter.consume(ipOf(request));
    // A limiter store outage (fail-closed limiter) is not the caller's fault: skip the send, answer the same 202.
    const budgetUnavailable = ip.storeError === true;
    if (!ip.allowed && !budgetUnavailable) {
      if (ip.retryAfterSeconds !== undefined)
        reply.header("Retry-After", String(ip.retryAfterSeconds));
      throw new RateLimitedError("too many requests from this address");
    }
    // The per-address budget never changes the answer: over budget the send is skipped, the reply is the same 202.
    const emailBudget = budgetUnavailable
      ? { allowed: false }
      : await deps.emailLimiter.consume(sha256Hex(email.toLowerCase()));

    if (emailBudget.allowed && deps.emailTransport) {
      const transport = deps.emailTransport;
      defer(async () => {
        const links = await deps.linksForEmail(email);
        if (links.length === 0) return;
        const message = buildFindMyOrganizationEmail(baseDomain, links);
        if (message) await transport.send({ to: email, ...message });
      });
    }
    reply.header("Cache-Control", "no-store");
    return reply
      .code(202)
      .send({ status: "sent" } satisfies Static<typeof FindMyOrganizationResponseSchema>);
  });
}
