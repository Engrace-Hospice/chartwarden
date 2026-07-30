-- M24 Billing — Medicaid §3.3 — the 11 m24_-prefixed ENUM types (the M23 0074 / M25 / M26 0085 convention:
-- every DB enum is module-prefixed so it can never collide cross-module; check-ddl-legality rule 3 forbids
-- redeclaring a pgEnum). No tables here — tables land in 0093 (non-partitioned) / 0094 (PE-partitioned) /
-- 0095 (org-partitioned). No PHI, no seed.

CREATE TYPE "m24_claim_state" AS ENUM (
  'DRAFT', 'VALIDATING', 'FAILED_VALIDATION', 'READY',
  'AWAITING_MEDICARE_PRIMARY', 'FAILED_MEDICARE_PRIMARY',
  'SUBMITTED', 'POLLING', 'ACK_PENDING', 'ACK_TIMEOUT',
  'ACK_ACCEPTED', 'ACK_REJECTED', 'ACK_PARTIAL',
  'PAID', 'DENIED', 'REPLACED', 'VOIDED', 'ABANDONED'
);--> statement-breakpoint
CREATE TYPE "m24_claim_kind" AS ENUM ('combined_hospice_rb', 'hospice_only', 'rb_only');--> statement-breakpoint
CREATE TYPE "m24_claim_line_loc" AS ENUM ('RHC', 'CHC', 'IRC', 'GIP', 'NF_RB');--> statement-breakpoint
CREATE TYPE "m24_submission_result" AS ENUM (
  'pending', 'accepted_sync', 'pending_async', 'rejected_sync', 'transport_failure', 'timeout', 'cancelled'
);--> statement-breakpoint
CREATE TYPE "m24_acknowledgment_kind" AS ENUM ('sync_999', 'sync_277ca', 'async_state_specific');--> statement-breakpoint
CREATE TYPE "m24_acknowledgment_outcome" AS ENUM ('accepted', 'rejected', 'partial');--> statement-breakpoint
CREATE TYPE "m24_validation_outcome" AS ENUM ('pass', 'fail', 'warn', 'info', 'skip_not_applicable');--> statement-breakpoint
CREATE TYPE "m24_eligibility_outcome" AS ENUM ('active', 'inactive', 'unknown', 'mco_assignment', 'error');--> statement-breakpoint
CREATE TYPE "m24_rb_arrangement_state" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "m24_rb_day_status" AS ENUM ('pending', 'billable', 'excluded', 'voided', 'billed');--> statement-breakpoint
CREATE TYPE "m24_channel" AS ENUM ('direct_mmis', 'cco_clearinghouse', 'sftp', 'portal', 'state_proprietary');--> statement-breakpoint
