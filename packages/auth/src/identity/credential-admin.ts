// @chartwarden/auth · trusted credential lifecycle operations.
//
// These endpoints are Better Auth plugin endpoints marked SERVER_ONLY. They are callable only through
// the configured auth instance and never mounted at /api/auth. This keeps password hashing, adapter
// hooks and session deletion inside Better Auth without exposing an alternate public auth surface.
import { APIError, createAuthEndpoint } from "better-auth/api";

export const RESERVED_USERNAMES = new Set([
  "admin",
  "administrator",
  "root",
  "security",
  "support",
  "system",
  "wardenx",
  "chartwarden",
]);

export const USERNAME_PATTERN = /^[a-z0-9_.-]{3,32}$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isAllowedUsername(value: string): boolean {
  const normalized = normalizeUsername(value);
  return (
    USERNAME_PATTERN.test(normalized) &&
    !normalized.includes("@") &&
    !RESERVED_USERNAMES.has(normalized)
  );
}

interface ProvisionBody {
  readonly name?: unknown;
  readonly username?: unknown;
  readonly email?: unknown;
  readonly password?: unknown;
}

interface PasswordBody {
  readonly userId?: unknown;
  readonly password?: unknown;
}

function badInput(code: string): never {
  throw new APIError("BAD_REQUEST", { message: code, code });
}

function requirePassword(
  ctx: {
    context: { password: { config: { minPasswordLength: number; maxPasswordLength: number } } };
  },
  value: unknown,
): string {
  if (typeof value !== "string") badInput("INVALID_PASSWORD");
  const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
  if (value.length < minPasswordLength) badInput("PASSWORD_TOO_SHORT");
  if (value.length > maxPasswordLength) badInput("PASSWORD_TOO_LONG");
  return value;
}

/** Better Auth extension used by M02's orchestration service; none of these operations has an HTTP path. */
export const credentialAdminPlugin = () =>
  ({
    id: "chartwarden-credential-admin",
    endpoints: {
      provisionIdentityCredential: createAuthEndpoint(
        "/_chartwarden-internal/provision-identity-credential",
        { method: "POST", metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const body = (ctx.body ?? {}) as ProvisionBody;
          if (typeof body.name !== "string" || body.name.trim().length === 0)
            badInput("INVALID_NAME");
          if (typeof body.username !== "string" || !isAllowedUsername(body.username))
            badInput("INVALID_USERNAME");
          if (body.email !== null && body.email !== undefined && typeof body.email !== "string")
            badInput("INVALID_EMAIL");
          const password = requirePassword(ctx, body.password);
          // The username plugin normalizes and validates this create; password.hash is the configured
          // ChartWarden Argon2id implementation (and remains the single hashing implementation).
          const passwordHash = await ctx.context.password.hash(password);
          // Better Auth 1.7 requires a provisioning source for user validation hooks.
          const user = await ctx.context.internalAdapter.createUser(
            {
              name: body.name.trim(),
              username: body.username,
              displayUsername: body.username.trim(),
              ...(typeof body.email === "string" && body.email.trim().length > 0
                ? { email: body.email.trim().toLowerCase() }
                : { email: undefined }),
              emailVerified: false,
              credentialState: "password_change_required",
              credentialStateReason: "admin_provisioned",
              credentialVersion: 1,
            } as never,
            { method: "admin" },
          );
          try {
            await ctx.context.internalAdapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: passwordHash,
            });
          } catch (error) {
            await ctx.context.internalAdapter.deleteUser(user.id).catch(() => undefined);
            throw error;
          }
          return ctx.json({ userId: user.id });
        },
      ),
      replaceIdentityPassword: createAuthEndpoint(
        "/_chartwarden-internal/replace-identity-password",
        { method: "POST", metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const body = (ctx.body ?? {}) as PasswordBody;
          if (typeof body.userId !== "string") badInput("INVALID_USER");
          const password = requirePassword(ctx, body.password);
          const accounts = await ctx.context.internalAdapter.findAccounts(body.userId);
          if (!accounts.some((account) => account.providerId === "credential" && account.password))
            badInput("CREDENTIAL_ACCOUNT_NOT_FOUND");
          const passwordHash = await ctx.context.password.hash(password);
          await ctx.context.internalAdapter.updatePassword(body.userId, passwordHash);
          await ctx.context.internalAdapter.deleteUserSessions(body.userId);
          return ctx.json({ changed: true });
        },
      ),
      deleteProvisionedIdentity: createAuthEndpoint(
        "/_chartwarden-internal/delete-provisioned-identity",
        { method: "POST", metadata: { SERVER_ONLY: true } },
        async (ctx) => {
          const body = (ctx.body ?? {}) as { userId?: unknown };
          if (typeof body.userId !== "string") badInput("INVALID_USER");
          await ctx.context.internalAdapter.deleteUserSessions(body.userId);
          await ctx.context.internalAdapter.deleteUser(body.userId);
          return ctx.json({ deleted: true });
        },
      ),
    },
  }) as const;

export interface ProvisionIdentityCredentialInput {
  readonly name: string;
  readonly username: string;
  readonly email: string | null;
  readonly password: string;
}

export interface IdentityCredentialAdmin {
  provision(input: ProvisionIdentityCredentialInput): Promise<{ userId: string }>;
  replacePassword(userId: string, password: string): Promise<void>;
  deleteProvisionedIdentity(userId: string): Promise<void>;
  changeOwnPassword(input: {
    currentPassword: string;
    newPassword: string;
    requestHeaders: Headers;
  }): Promise<void>;
}

type ServerCall = (args: never) => Promise<unknown>;
type ChangePasswordCall = (args: {
  body: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean };
  headers: Headers;
  asResponse: true;
}) => Promise<Response>;

export interface CredentialAdminCapableAuth {
  api: {
    provisionIdentityCredential: ServerCall;
    replaceIdentityPassword: ServerCall;
    deleteProvisionedIdentity: ServerCall;
    changePassword: ChangePasswordCall;
  };
}

/** Creates the narrow service port consumed by M02; callers never receive the Better Auth instance. */
export function createIdentityCredentialAdmin(
  auth: CredentialAdminCapableAuth,
): IdentityCredentialAdmin {
  return {
    async provision(input) {
      const call = auth.api.provisionIdentityCredential as unknown as (args: {
        body: Record<string, unknown>;
      }) => Promise<unknown>;
      const result = (await call({ body: { ...input } })) as {
        userId?: unknown;
      };
      if (typeof result.userId !== "string")
        throw new Error("credential provisioning returned no user id");
      return { userId: result.userId };
    },
    async replacePassword(userId, password) {
      const call = auth.api.replaceIdentityPassword as unknown as (args: {
        body: Record<string, unknown>;
      }) => Promise<unknown>;
      await call({ body: { userId, password } });
    },
    async deleteProvisionedIdentity(userId) {
      const call = auth.api.deleteProvisionedIdentity as unknown as (args: {
        body: Record<string, unknown>;
      }) => Promise<unknown>;
      await call({ body: { userId } });
    },
    async changeOwnPassword({ currentPassword, newPassword, requestHeaders }) {
      const response = await auth.api.changePassword({
        body: { currentPassword, newPassword, revokeOtherSessions: false },
        headers: requestHeaders,
        asResponse: true,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { code?: string } | null;
        throw new APIError(response.status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST", {
          message: payload?.code ?? "PASSWORD_CHANGE_FAILED",
          code: payload?.code ?? "PASSWORD_CHANGE_FAILED",
        });
      }
    },
  };
}
