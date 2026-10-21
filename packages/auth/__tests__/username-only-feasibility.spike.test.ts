import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { username } from "better-auth/plugins";
import * as z from "zod";
import { argon2idHash, argon2idVerify } from "../src/identity/password-hash";

/**
 * PR0 feasibility spike: Better Auth 1.6.25 username-only identity on real PostgreSQL.
 *
 * Run only against a disposable database:
 *
 *   CHARTWARDEN_USERNAME_SPIKE_DATABASE_URL=postgres://postgres:postgres@localhost:55491/postgres \
 *     bunx vitest run packages/auth/__tests__/username-only-feasibility.spike.test.ts
 *
 * This intentionally does not use ChartWarden's production schema or migration runner. The local table
 * declarations contain only Better Auth's core models plus the official username plugin fields, with
 * `user.email` nullable—the compatibility question this spike exists to answer.
 */
const DATABASE_URL = process.env.CHARTWARDEN_USERNAME_SPIKE_DATABASE_URL;

const users = pgTable(
  "spike_user",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    username: text("username"),
    displayUsername: text("display_username"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    emailUnique: uniqueIndex("spike_user_email_uq").on(table.email),
    usernameUnique: uniqueIndex("spike_user_username_uq").on(table.username),
  }),
);

const accounts = pgTable("spike_account", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const sessions = pgTable(
  "spike_session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull(),
  },
  (table) => ({ tokenUnique: uniqueIndex("spike_session_token_uq").on(table.token) }),
);

const verifications = pgTable("spike_verification", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

const schema = {
  user: users,
  account: accounts,
  session: sessions,
  verification: verifications,
};

function spikeProvisioningPlugin() {
  return {
    id: "wardenx-username-feasibility-provisioning",
    endpoints: {
      provisionUsernameOnly: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({
            name: z.string(),
            username: z.string(),
            password: z.string(),
          }),
        },
        async (ctx) => {
          const password = await ctx.context.password.hash(ctx.body.password);
          const created = await ctx.context.internalAdapter.createUser({
            name: ctx.body.name,
            username: ctx.body.username,
            displayUsername: ctx.body.username,
            // Deliberately absent. No placeholder and no empty string.
            email: undefined as unknown as string,
            emailVerified: false,
          });
          await ctx.context.internalAdapter.linkAccount({
            userId: created.id,
            providerId: "credential",
            accountId: created.id,
            password,
          });
          return ctx.json({ userId: created.id });
        },
      ),
    },
  } as const;
}

function buildSpikeAuth(db: ReturnType<typeof drizzle<typeof schema>>) {
  return betterAuth({
    secret: "username-spike-secret-at-least-32-characters",
    baseURL: "http://localhost:3000",
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      password: {
        hash: argon2idHash,
        verify: ({ hash, password }) => argon2idVerify(hash, password),
      },
    },
    plugins: [username(), spikeProvisioningPlugin()],
  });
}
type SpikeAuth = ReturnType<typeof buildSpikeAuth>;

describe.skipIf(!DATABASE_URL)("PR0 username-only Better Auth feasibility", () => {
  let pool: Pool;
  let auth: SpikeAuth;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`
      DROP TABLE IF EXISTS spike_session, spike_account, spike_verification, spike_user CASCADE;
      CREATE TABLE spike_user (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        email text NULL,
        email_verified boolean NOT NULL DEFAULT false,
        image text NULL,
        username text NULL,
        display_username text NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX spike_user_email_uq ON spike_user(email);
      CREATE UNIQUE INDEX spike_user_username_uq ON spike_user(username);
      CREATE TABLE spike_account (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES spike_user(id) ON DELETE CASCADE,
        account_id text NOT NULL,
        provider_id text NOT NULL,
        access_token text NULL,
        refresh_token text NULL,
        id_token text NULL,
        access_token_expires_at timestamptz NULL,
        refresh_token_expires_at timestamptz NULL,
        scope text NULL,
        password text NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE spike_session (
        id uuid PRIMARY KEY,
        expires_at timestamptz NOT NULL,
        token text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        ip_address text NULL,
        user_agent text NULL,
        user_id uuid NOT NULL REFERENCES spike_user(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX spike_session_token_uq ON spike_session(token);
      CREATE TABLE spike_verification (
        id uuid PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
    `);
    const db = drizzle(pool, { schema });
    auth = buildSpikeAuth(db);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DROP TABLE IF EXISTS spike_session, spike_account, spike_verification, spike_user CASCADE");
    await pool.end();
  });

  it("keeps email sign-in working while username-only sign-in creates a normal session", async () => {
    const legacyEmail = `legacy-${crypto.randomUUID()}@example.test`;
    const legacyPassword = `Legacy-${crypto.randomUUID()}-Password!`;
    const legacy = (await auth.api.signUpEmail({
      body: { email: legacyEmail, password: legacyPassword, name: "Legacy Email User" },
      asResponse: true,
    })) as Response;
    expect(legacy.status).toBe(200);
    const legacySignIn = (await auth.api.signInEmail({
      body: { email: legacyEmail, password: legacyPassword },
      asResponse: true,
    })) as Response;
    expect(legacySignIn.status).toBe(200);

    const temporaryPassword = `Temporary-${crypto.randomUUID()}!`;
    const provisioned = await auth.api.provisionUsernameOnly({
      body: { name: "Jane Smith", username: "JSmith", password: temporaryPassword },
    });
    const storedUser = await pool.query(
      "SELECT email, username FROM spike_user WHERE id = $1",
      [provisioned.userId],
    );
    expect(storedUser.rows[0]).toEqual({ email: null, username: "jsmith" });
    const storedAccount = await pool.query(
      "SELECT password FROM spike_account WHERE user_id = $1 AND provider_id = 'credential'",
      [provisioned.userId],
    );
    expect(storedAccount.rows[0].password).toMatch(/^\$argon2id\$/);

    const signIn = (await auth.api.signInUsername({
      body: { username: "JSMITH", password: temporaryPassword },
      asResponse: true,
    })) as Response;
    expect(signIn.status).toBe(200);
    const payload = (await signIn.json()) as { token: string; user: { id: string; email?: string | null } };
    expect(payload.user.id).toBe(provisioned.userId);
    expect(payload.user.email ?? null).toBeNull();
    const session = await pool.query(
      "SELECT user_id FROM spike_session WHERE token = $1",
      [payload.token],
    );
    expect(session.rows[0].user_id).toBe(provisioned.userId);
  });

  it("normalizes usernames, rejects case-insensitive duplicates, and returns one generic bad-credential error", async () => {
    const password = `Duplicate-${crypto.randomUUID()}!`;
    await auth.api.provisionUsernameOnly({
      body: { name: "First", username: "CaseUser", password },
    });
    await expect(
      auth.api.provisionUsernameOnly({
        body: { name: "Second", username: "CASEUSER", password },
      }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });

    for (const candidate of ["missing.user", "caseuser"] as const) {
      const response = (await auth.api.signInUsername({
        body: { username: candidate, password: "Definitely-Wrong-Password!" },
        asResponse: true,
      })) as Response;
      expect(response.status).toBe(401);
      const body = (await response.json()) as { code?: string; message?: string };
      expect(body.code).toBe("INVALID_USERNAME_OR_PASSWORD");
    }
  });
});
