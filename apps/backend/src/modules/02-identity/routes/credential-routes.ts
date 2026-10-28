import type { AuditExecutor } from "@chartwarden/audit";
import {
  isAllowedUsername,
  normalizeUsername,
  requireAbac,
  requirePermission,
  requireStepUp,
} from "@chartwarden/auth";
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CredentialLifecycleStore, UserProvisioningService } from "../credential-lifecycle";
import { generateTemporaryPassword } from "../credential-lifecycle";
import type { ActorResolver } from "../identity-ports";
import { assertOrgMatch, auditContextFor, resolveActor } from "./admin-route-kit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface CredentialRouteDeps {
  actors: ActorResolver;
  audit: AuditExecutor;
  service: UserProvisioningService;
  lifecycle: CredentialLifecycleStore;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ValidationError("invalid request body", [
      { field: "body", code: "INVALID", message: "body must be an object" },
    ]);
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, min = 1, max = 320): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max)
    throw new ValidationError(`invalid ${key}`, [
      { field: key, code: "INVALID", message: `${key} must be ${min}-${max} characters` },
    ]);
  return value.trim();
}

function stringArray(body: Record<string, unknown>, key: string, required = false): string[] {
  const value = body[key];
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
    throw new ValidationError(`invalid ${key}`, [
      { field: key, code: "INVALID", message: `${key} must be an array of identifiers` },
    ]);
  if (required && value.length === 0)
    throw new ValidationError(`invalid ${key}`, [
      { field: key, code: "REQUIRED", message: `${key} requires at least one value` },
    ]);
  return [...new Set(value as string[])];
}

function emailField(body: Record<string, unknown>): string | null {
  const value = body.email;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 320 || !EMAIL_RE.test(value.trim()))
    throw new ValidationError("invalid email", [
      { field: "email", code: "INVALID", message: "email must be null or a valid address" },
    ]);
  return value.trim().toLowerCase();
}

function passwordChoice(body: Record<string, unknown>): { value: string; generated: boolean } {
  if (body.generateTemporaryPassword === true) {
    if (body.temporaryPassword !== undefined)
      throw new ValidationError("choose one temporary-password mode", [
        {
          field: "temporaryPassword",
          code: "CONFLICT",
          message: "temporaryPassword and generateTemporaryPassword are mutually exclusive",
        },
      ]);
    return { value: generateTemporaryPassword(), generated: true };
  }
  return { value: stringField(body, "temporaryPassword", 12, 256), generated: false };
}

function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return headers;
}

const CREATE = requirePermission("user.create") as PreHandler;
const CREATE_STEP_UP = requireStepUp("user.create") as PreHandler;
const RESET = requirePermission("user.password.reset") as PreHandler;
const RESET_STEP_UP = requireStepUp("user.password.reset") as PreHandler;
const PLATFORM_RESET = requireAbac(
  "user.password.reset",
  "user_lifecycle_platform_ops",
) as PreHandler;

export function registerCredentialRoutes(app: FastifyInstance, deps: CredentialRouteDeps): void {
  app.post(
    "/api/v1/orgs/:orgId/users",
    { preHandler: [CREATE, CREATE_STEP_UP] },
    async (request, reply) => {
      const organizationId = (request.params as { orgId: string }).orgId;
      assertOrgMatch(request, organizationId);
      const actor = await resolveActor(deps, request);
      const body = objectBody(request.body);
      const username = normalizeUsername(stringField(body, "username", 3, 32));
      if (!isAllowedUsername(username))
        throw new ValidationError("invalid username", [
          {
            field: "username",
            code: "INVALID",
            message:
              "username must be 3-32 non-reserved letters, digits, underscores, periods or hyphens",
          },
        ]);
      const temporary = passwordChoice(body);
      const result = await deps.service.provision({
        organizationId,
        actorUserId: actor.userId,
        name: stringField(body, "name", 1, 200),
        username,
        email: emailField(body),
        temporaryPassword: temporary.value,
        roleIds: stringArray(body, "roleIds", true),
        defaultLocationIds: stringArray(body, "defaultLocationIds"),
        auditContext: auditContextFor(request, actor),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send({
        ...result,
        ...(temporary.generated ? { temporaryPassword: temporary.value } : {}),
      });
    },
  );

  app.post(
    "/api/v1/platform/users/:userId/password-reset",
    { preHandler: [RESET, PLATFORM_RESET, RESET_STEP_UP] },
    async (request, reply) => {
      const actor = await resolveActor(deps, request);
      const temporary = passwordChoice(objectBody(request.body));
      const result = await deps.service.resetPasswordGlobally({
        actorUserId: actor.userId,
        targetUserId: (request.params as { userId: string }).userId,
        temporaryPassword: temporary.value,
        auditContext: auditContextFor(request, actor),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send({
        ...result,
        passwordChangeRequired: true,
        ...(temporary.generated ? { temporaryPassword: temporary.value } : {}),
      });
    },
  );

  app.post(
    "/api/v1/orgs/:orgId/users/:userId/password-reset",
    { preHandler: [RESET, RESET_STEP_UP] },
    async (request, reply) => {
      const { orgId: organizationId, userId } = request.params as {
        orgId: string;
        userId: string;
      };
      assertOrgMatch(request, organizationId);
      const actor = await resolveActor(deps, request);
      const temporary = passwordChoice(objectBody(request.body));
      const result = await deps.service.resetPassword({
        organizationId,
        actorUserId: actor.userId,
        targetUserId: userId,
        temporaryPassword: temporary.value,
        auditContext: auditContextFor(request, actor),
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send({
        ...result,
        passwordChangeRequired: true,
        ...(temporary.generated ? { temporaryPassword: temporary.value } : {}),
      });
    },
  );

  app.get("/api/v1/auth/credential-status", async (request) => {
    const actor = await resolveActor(deps, request);
    const state = await deps.lifecycle.state(actor.userId);
    if (!state) throw new ChartWardenError("UNAUTHORIZED", "session identity not found", 401);
    return {
      passwordChangeRequired: state.state === "password_change_required",
      reason: state.state === "password_change_required" ? state.reason : null,
    };
  });

  app.post("/api/v1/auth/password/complete-required-change", async (request, reply) => {
    const actor = await resolveActor(deps, request);
    const body = objectBody(request.body);
    const result = await deps.service.completeRequiredChange({
      userId: actor.userId,
      currentPassword: stringField(body, "currentPassword", 1, 256),
      newPassword: stringField(body, "newPassword", 12, 256),
      requestHeaders: webHeaders(request),
      auditContext: auditContextFor(request, actor),
    });
    reply.header("cache-control", "no-store");
    // The current session was revoked. The client must discard it and perform a full sign-in/MFA flow.
    return reply.code(200).send(result);
  });
}
