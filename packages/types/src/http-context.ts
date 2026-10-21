// @chartwarden/types — Per-request HTTP context shape (M1 Foundation §4.5; M1-T10).
//
// This is the object the M1 request-context middleware hangs on `request.context`
// (apps/backend/src/bootstrap/plugins/request-context.ts). It lives in the
// `packages/types` leaf so every module's routes can read `request.context` without a
// cross-module edge, and so the FastifyRequest augmentation (declared once, in the M1
// bootstrap, the only place that imports `fastify`) references a shared type.
//
// NAMING: `@chartwarden/tenancy` already exports a `RequestContext` — the AMBIENT
// (AsyncLocalStorage) tenant context that `withOrgContextFromRequest()` reads. This
// HTTP-layer type is named `HttpRequestContext` to avoid colliding with it; the M1
// middleware derives the tenancy `OrgContext` (organizationId + userId) from this object
// once M2's auth plugin has populated those fields.
export interface HttpRequestContext {
  /** Stitches audit events + outbox records + logs for one request (spec §4.5). */
  correlationId: string;
  /** Populated by M2's auth plugin after this middleware runs; "" on unauthenticated routes. */
  userId: string;
  organizationId: string;
  providerEntityIds: string[];
  locationIds: string[];
  roles: string[];
  attributes: Record<string, unknown>;
  ip: string;
  userAgent: string;
  /** Epoch ms at request start — for latency accounting. */
  startTime: number;
}
