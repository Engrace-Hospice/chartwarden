-- M28 FHIR Gateway §164.528 — `fhir_read_disclosure`, the served-read disclosure ledger (F-035, #95).
--
-- WHY THIS TABLE DID NOT EXIST, AND WHY IT MUST NOW. Phase 1 mounted the FHIR-spec surface with its
-- disclosure-audit port UNBOUND, which was defensible only for exactly as long as the surface served
-- nothing: `registerFhirR4Routes` answered every single-resource read `404` and every search an empty
-- Bundle, so there was no disclosure to account for and `disclosureMetricsForOrg` reported a real zero.
-- The moment the read path serves an actual resource to an external client, that arrangement inverts:
-- 45 CFR §164.528 gives an individual the right to an accounting of disclosures of their PHI, a FHIR
-- gateway read IS such a disclosure, and a gateway that serves PHI while its accounting seam answers
-- zero is not "fail-closed" — it is a false compliance statement, published to M30's disclosure
-- scorecard, on a surface whose entire purpose is handing PHI to a third party.
--
-- APPEND-ONLY BY GRANT, not by convention. `wardenx_app` gets SELECT + INSERT and NOTHING ELSE: no
-- UPDATE and no DELETE. The rows ARE the §164.528 evidence, so the §3.7 eraser SHREDS in place
-- elsewhere in this module rather than deleting, and here there is nothing to shred — the ledger holds
-- no narrative, no payload and no cipher, only WHO read WHAT and WHEN. `patient_id` is the disclosed
-- subject and is the whole point of the record (an accounting no one can filter by patient is not an
-- accounting), so it is retained rather than scrubbed; the retention class is `compliance` (six years,
-- §164.530(j)), NOT the `operational` 90 days `fhir_client_session` carries.
--
-- DELIBERATELY NOT PARTITIONED, unlike its sibling `fhir_client_session`. That table is partitioned
-- monthly because it is high-volume and routinely PURGED past 90 days; this one is never purged, so
-- partitioning would buy nothing and would cost the composite-PK + generated-audit-function complexity
-- 0135 documents (a partitioned write stamps `TG_TABLE_NAME` = the dated partition, so the audit trail
-- renames itself every month — the M32 `ai_token_ledger` lesson).
--
-- `query_parameters` is the NORMALIZED parameter map the route assembled, never the raw query string:
-- the envelope (`FhirReadDisclosureEnvelope`) is built from parsed, validated search parameters, so a
-- bearer token or a secret smuggled in the query line cannot reach this column.
CREATE TABLE IF NOT EXISTS "fhir_read_disclosure" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  -- Logical uuid → `fhir_client.id`. No FK on purpose, matching `fhir_client_session.client_id`: a
  -- disclosure record must OUTLIVE the client that made it (a revoked, and later erased, partner does
  -- not erase the accounting owed to the patients whose records it read).
  "fhir_client_id" uuid NOT NULL,
  "resource_type" text NOT NULL,
  -- NULL for a type-level search that named no patient; set for every instance read and `$everything`.
  "patient_id" uuid,
  "query_parameters" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result_count" integer NOT NULL,
  "served_at" timestamptz NOT NULL,
  -- The membership behind an operator-initiated read (a bulk export a staff member kicked off); NULL
  -- when the FHIR client itself is the actor, which is the ordinary case.
  "initiated_by_membership_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- The three questions §164.528 and the M30 scorecard actually ask: everything this org disclosed in a
-- quarter; everything one client read; everything read ABOUT one patient (the individual's own request,
-- which is the right the statute grants and the only one with a legally-bounded response time).
CREATE INDEX IF NOT EXISTS "fhir_read_disclosure_org_served_idx"
  ON "fhir_read_disclosure" ("organization_id", "served_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_read_disclosure_client_idx"
  ON "fhir_read_disclosure" ("organization_id", "fhir_client_id", "served_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_read_disclosure_patient_idx"
  ON "fhir_read_disclosure" ("organization_id", "patient_id", "served_at" DESC)
  WHERE "patient_id" IS NOT NULL;--> statement-breakpoint

-- ============================================================================================
-- RLS (§3.5 / ADR-0010 D2) — tenant-scoped, canonical app.org_id, no UPDATE and no DELETE.
-- ============================================================================================
ALTER TABLE "fhir_read_disclosure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "fhir_read_disclosure_org" ON "fhir_read_disclosure";--> statement-breakpoint
CREATE POLICY "fhir_read_disclosure_org" ON "fhir_read_disclosure"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "fhir_read_disclosure" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "fhir_read_disclosure" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- M4 write-audit trigger (§3.6). Empty denylist, unpartitioned ⇒ M1's baseline trigger unchanged
-- (the `fhir_client` / `fhir_bulk_export_job` precedent in 0137). The ledger is append-only, so in
-- practice this stamps one INSERT audit row per disclosure — which is the point: the accounting and
-- the audit trail corroborate each other, and a row that appeared in one but not the other is the
-- tampering signal neither could raise alone.
-- ============================================================================================
DROP TRIGGER IF EXISTS "fhir_read_disclosure_audit" ON fhir_read_disclosure;--> statement-breakpoint
CREATE TRIGGER "fhir_read_disclosure_audit" AFTER INSERT OR UPDATE OR DELETE ON fhir_read_disclosure
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
--> statement-breakpoint

-- ============================================================================================
-- THE TENANT-RESOLUTION PROBLEM, AND WHY IT IS TWO SECURITY DEFINER FUNCTIONS (F-035, #95).
-- ============================================================================================
-- Every other surface on this platform learns its tenant from the WardenX session before it touches a
-- row, so `withOrgContext` can set `app.org_id` and RLS does the rest. The FHIR-spec surface cannot:
-- a SMART Backend Services client presents a `client_id` (at the token endpoint) or a bearer `jti` (on
-- every read) and NOTHING ELSE — no session, no tenant, by design, because the SMART profile has no
-- tenant parameter. The org is a FACT ABOUT the credential, and it must be read before an org context
-- can exist.
--
-- Phase 1 shipped this as an unscoped `SELECT` on the tenant pool. With no `app.org_id` set,
-- `current_setting('app.org_id', true)::uuid` is NULL, the policy predicate is NULL, and the read
-- returns zero rows — so `resolveBearer` answered null for every token that will ever be presented, and
-- its own comment said so ("returns nothing until a platform-bypass read path is bound"). That is not a
-- bootstrap that can be completed by supplying a credential: it is the whole FHIR surface, dead.
--
-- The alternative considered and rejected was the `DATABASE_PLATFORM_URL` login (M35's cross-tenant
-- admin idiom). It carries BYPASSRLS, which is far more authority than this needs, and its grants are
-- enumerated OUTSIDE migrations in deployment config — so the gateway would work only on deployments
-- that had also been granted `fhir_client` and `fhir_client_session`, and would fail as "invalid
-- credential" on the ones that had not. A capability the schema cannot state is a capability nobody can
-- verify.
--
-- These two functions are the minimum instead. Each takes ONE unguessable uuid the caller must already
-- possess and returns ONE uuid: the tenant to enter. No PHI, no scope set, no status, no credential
-- material — nothing that advances an attacker who does not hold the credential, and nothing the
-- application can use except as an argument to `withOrgContext`, after which ordinary RLS applies to
-- every subsequent statement. `SECURITY DEFINER` + a pinned `search_path`, EXECUTE revoked from PUBLIC
-- and granted only to `wardenx_app`.
CREATE OR REPLACE FUNCTION fhir_resolve_client_org(p_client_id uuid)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT organization_id FROM fhir_client WHERE id = p_client_id;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fhir_resolve_client_org(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION fhir_resolve_client_org(uuid) TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION fhir_resolve_session_org(p_jti uuid)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT organization_id FROM fhir_client_session WHERE jti = p_jti;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fhir_resolve_session_org(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION fhir_resolve_session_org(uuid) TO wardenx_app;
