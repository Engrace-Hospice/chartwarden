-- M28 FHIR Gateway §3.2/§3.3 — the ten enum types (Phase A) and SIX of the module's eight owned tables
-- (Phase B, the unpartitioned half; Phase E indexes inline). The two partitioned tables
-- (`fhir_client_session` on issued_at, `fhir_inbound_resource` on proposed_at) land in 0135 and 0136,
-- each in its OWN file: check-ddl-legality rule 1 derives one partition column per FILE and then requires
-- every UNIQUE/PK in that file to contain it, and the six tables here are keyed on `id` (or organization_id
-- for tenant_fhir_config) alone. RLS, grants and the M4 write-audit triggers land in 0137.
--
-- TENANCY (ARCH-011 / ADR-0010), the shape of the module:
--   • SEVEN TENANT-SCOPED tables carry organization_id on canonical app.org_id RLS. `tenant_fhir_config`
--     is the extreme case — organization_id IS its primary key (one FHIR config per tenant) with a REAL
--     FK to `organization`. The other six here (fhir_client, fhir_client_credential, fhir_bulk_export_job,
--     fhir_bulk_export_artifact) plus the two partitioned tables carry organization_id NOT NULL.
--   • ONE PLATFORM-SHARED table: `fhir_capability_snapshot`, no organization_id BY DESIGN — a
--     CapabilityStatement is the same conformance contract for every tenant, so it is read-all within any
--     tenant and written only by wardenx_admin (0137; the M32 ai_capability / M38 code_system precedent).
--     It is listed in check-tenancy.ts's NON_ORG_SCOPED set with that justification.
--
-- NONE OF THE M28 TABLES IS PHI-BEARING BY THE TENANCY GATE'S HEURISTIC (no patient_id / observation
-- column): the only PHI a consumer ever sees is PROJECTED read-time from the owner modules' rows, never
-- stored here. `fhir_inbound_resource.payload` (0136) can carry PHI fragments before an owner module
-- accepts the proposal, which is why §3.6 denylists it to its sha256 until decision time — but the column
-- is an opaque jsonb, so the three-column rule (provider_entity_id + location_id) does not attach.
--
-- FK POLICY: organization (M1 spine) and the intra-M28 parents (`fhir_client`, `fhir_bulk_export_job`,
-- both unpartitioned) carry REAL FKs. `fhir_client.credential_id` is a LOGICAL uuid — the reverse
-- constraint (credential.client_id → client) already ties the pair, and a second real FK would be a
-- circular pair. Every M2 membership id (`approved_by_*`, `initiated_by_membership_id`,
-- `decided_by_membership_id`) and every reference to a partitioned table is a LOGICAL uuid validated at
-- the write boundary.

-- ============================================================================================
-- §3.2 Phase A — the ten enum types.
-- ============================================================================================
CREATE TYPE "public"."fhir_client_type" AS ENUM('smart_backend_services', 'api_key');--> statement-breakpoint
CREATE TYPE "public"."fhir_client_tier" AS ENUM('tier-1', 'tier-2', 'tier-3');--> statement-breakpoint
CREATE TYPE "public"."fhir_client_status" AS ENUM('pending_approval', 'active', 'suspended', 'revoked', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."fhir_client_credential_kind" AS ENUM('api_key', 'jwks_pin');--> statement-breakpoint
CREATE TYPE "public"."fhir_client_credential_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."fhir_bulk_export_status" AS ENUM('accepted', 'in_progress', 'completed', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."fhir_bulk_export_request_kind" AS ENUM('system', 'group', 'patient');--> statement-breakpoint
CREATE TYPE "public"."fhir_inbound_status" AS ENUM('pending', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."fhir_inbound_owner_module" AS ENUM('m5', 'm12');--> statement-breakpoint
CREATE TYPE "public"."fhir_version_enum" AS ENUM('4.0.1', '5.0.0', '6.0.0');--> statement-breakpoint

-- ============================================================================================
-- §3.3 `tenant_fhir_config` — one row per tenant (organization_id IS the PK).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "tenant_fhir_config" (
	"organization_id" uuid NOT NULL,
	"tenant_fhir_host" text NOT NULL,
	"identifier_uri_base" text NOT NULL,
	"cursor_signing_key_cipher" bytea NOT NULL,
	"capability_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inbound_review_sla_hours" integer DEFAULT 72 NOT NULL,
	"export_dedup_window_minutes" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_fhir_config_pkey" PRIMARY KEY ("organization_id"),
	CONSTRAINT "tenant_fhir_config_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint

-- ============================================================================================
-- §3.3 `fhir_client` — one row per external FHIR consumer (§2.2 onboarding FSM in `status`).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "fhir_client" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "fhir_client_type" NOT NULL,
	"jwks_uri" text,
	"credential_id" uuid,
	"allowed_scopes" jsonb NOT NULL,
	"tier" "fhir_client_tier" NOT NULL,
	"rate_limit_rps" integer NOT NULL,
	"ip_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"baa_contract_reference" text NOT NULL,
	"status" "fhir_client_status" DEFAULT 'pending_approval' NOT NULL,
	"approved_by_admin_membership_id" uuid,
	"approved_by_compliance_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fhir_client_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_client_org_idx" ON "fhir_client" ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "fhir_client_org_name_uq" ON "fhir_client" ("organization_id","name");--> statement-breakpoint

-- ============================================================================================
-- §3.3 `fhir_client_credential` — API-key / JWKS-pin material for a client (revocation cascade W-FHIR-12).
-- The §3.4 partial index on (secret_digest_sha256) WHERE status='active' is the constant-time validate path.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "fhir_client_credential" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "fhir_client_credential_kind" NOT NULL,
	"secret_cipher" bytea,
	"secret_digest_sha256" text,
	"fingerprint" text NOT NULL,
	"status" "fhir_client_credential_status" DEFAULT 'active' NOT NULL,
	"rotated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fhir_client_credential_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "fhir_client_credential_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."fhir_client"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_client_credential_client_idx" ON "fhir_client_credential" ("client_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_client_credential_digest_idx" ON "fhir_client_credential" ("secret_digest_sha256","status") WHERE status = 'active';--> statement-breakpoint

-- ============================================================================================
-- §3.3 `fhir_bulk_export_job` — one row per $export (§2.2 async-export FSM; §2.5 concurrency lock).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "fhir_bulk_export_job" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"request_kind" "fhir_bulk_export_request_kind" NOT NULL,
	"group_id" uuid,
	"patient_ids" jsonb,
	"resource_types" jsonb NOT NULL,
	"since_iso" timestamp with time zone,
	"request_envelope_sha256" text NOT NULL,
	"status" "fhir_bulk_export_status" DEFAULT 'accepted' NOT NULL,
	"total_resources" integer,
	"artifact_count" integer,
	"failure_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"initiated_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fhir_bulk_export_job_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_client_idx" ON "fhir_bulk_export_job" ("client_id","status") WHERE status IN ('accepted','in_progress');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_org_idx" ON "fhir_bulk_export_job" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_expiry_idx" ON "fhir_bulk_export_job" ("expires_at") WHERE status = 'completed';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_dedup_idx" ON "fhir_bulk_export_job" ("client_id","request_envelope_sha256","created_at");--> statement-breakpoint

-- ============================================================================================
-- §3.3 `fhir_bulk_export_artifact` — one row per NDJSON output object of a completed job.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "fhir_bulk_export_artifact" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"minio_object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"row_count" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fhir_bulk_export_artifact_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "fhir_bulk_export_artifact_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."fhir_bulk_export_job"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_bulk_export_artifact_job_idx" ON "fhir_bulk_export_artifact" ("job_id");--> statement-breakpoint

-- ============================================================================================
-- §3.3 `fhir_capability_snapshot` — the platform-singleton CapabilityStatement (D11), no organization_id.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "fhir_capability_snapshot" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"fhir_version" "fhir_version_enum" NOT NULL,
	"release_tag" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"capability_statement" jsonb NOT NULL,
	"checksum_sha256" text NOT NULL,
	"signature" bytea NOT NULL,
	CONSTRAINT "fhir_capability_snapshot_pkey" PRIMARY KEY ("id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fhir_capability_release_idx" ON "fhir_capability_snapshot" ("fhir_version","release_tag");
