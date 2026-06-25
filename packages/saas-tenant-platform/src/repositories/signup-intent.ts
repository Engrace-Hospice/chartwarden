// @wardenx/saas-tenant-platform · repositories — signup-intent data port: `tenant_signup_intent` +
// `tenant_signup_token` (M34 §3.9).
//
// The Phase-3 self-serve / platform-ops-manual PRE-PROVISION funnel. Both tables are DELIBERATELY
// org-less (M34-F02 / ADR-0010, §3.10): they are genuinely pre-organization — the org/tenant_account
// does not exist until the intent is provisioned, the one legitimate org-less exemption. RLS denies
// `wardenx_app` SELECT entirely; only `tenant_platform_writer` reads/writes them. Because they are
// org-less, the signup-intent service wraps every call here in `withPlatformContext` (the M1 RLS-bypass
// helper, allowlisted per M01-F05), NOT `withOrgContext` — there is no org to scope to yet. On
// provisioning the resulting `tenant_account.organization_id` is bridged via `tenant_account_id`.
//
// `token_hash` stores only the SHA256 of the issued token (the raw token is never persisted; it is
// returned once to the caller and value-capture-denylisted in the audit projection, §3.10). The
// platform 24h floor (`expires_at <= issued_at + interval '24 hours'`) is a DB CHECK (migration 0051);
// the service must not issue a longer TTL.
import { type DbClient, schema } from "@wardenx/db";
import { desc, eq } from "drizzle-orm";

const I = schema.tenantSignupIntent;
const TK = schema.tenantSignupToken;

/** Data port for the org-less pre-provision signup intent + its single-use token (§3.9). */
export class SignupIntentRepository {
  constructor(private readonly db: DbClient) {}

  // ── tenant_signup_intent ─────────────────────────────────────────────────────────────────────

  /** Create a signup intent (status 'new'). Caller must hold `withPlatformContext` (org-less). */
  async createIntent(values: schema.NewTenantSignupIntent): Promise<schema.TenantSignupIntent> {
    const [row] = await this.db.insert(I).values(values).returning();
    if (!row) throw new Error("tenant_signup_intent insert returned no row");
    return row;
  }

  /** Fetch an intent by id, or `null`. */
  async findIntentById(id: string): Promise<schema.TenantSignupIntent | null> {
    const [row] = await this.db.select().from(I).where(eq(I.id, id)).limit(1);
    return row ?? null;
  }

  /** All signup intents, newest-first (the platform-ops triage queue). */
  async listIntents(): Promise<readonly schema.TenantSignupIntent[]> {
    return this.db.select().from(I).orderBy(desc(I.receivedAt));
  }

  /** Patch an intent's status / processing fields (qualify, reject, abandon, provision-bridge). */
  async updateIntent(
    id: string,
    patch: Partial<
      Pick<
        schema.NewTenantSignupIntent,
        "intentStatus" | "rejectionReason" | "processedAt" | "tenantAccountId"
      >
    >,
  ): Promise<schema.TenantSignupIntent> {
    const [row] = await this.db.update(I).set(patch).where(eq(I.id, id)).returning();
    if (!row) throw new Error(`tenant_signup_intent ${id} not found for update`);
    return row;
  }

  // ── tenant_signup_token ──────────────────────────────────────────────────────────────────────

  /** Issue a single-use token row (stores only the hash; raw token is the caller's to return once). */
  async createToken(values: schema.NewTenantSignupToken): Promise<schema.TenantSignupToken> {
    const [row] = await this.db.insert(TK).values(values).returning();
    if (!row) throw new Error("tenant_signup_token insert returned no row");
    return row;
  }

  /** Resolve a token by its SHA256 hash (acceptance lookup), or `null`. */
  async findTokenByHash(tokenHash: string): Promise<schema.TenantSignupToken | null> {
    const [row] = await this.db.select().from(TK).where(eq(TK.tokenHash, tokenHash)).limit(1);
    return row ?? null;
  }

  /** Stamp a token consumed (single-use). */
  async markTokenConsumed(id: string, consumedAt: Date): Promise<schema.TenantSignupToken> {
    const [row] = await this.db.update(TK).set({ consumedAt }).where(eq(TK.id, id)).returning();
    if (!row) throw new Error(`tenant_signup_token ${id} not found for update`);
    return row;
  }
}
