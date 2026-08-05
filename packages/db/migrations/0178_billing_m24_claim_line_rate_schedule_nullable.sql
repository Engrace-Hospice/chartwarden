-- M24 Billing — Medicaid (WX-PR-011 follow-up, per-line assembly) — fixes audit finding M24-F02 (BLOCKER):
-- `medicaid_claim_line.state_rate_schedule_id_snapshot` was unconditionally NOT NULL, but a Room & Board
-- (is_rb=true) line prices off `rb_arrangement`/`rb_day.per_diem_cents_snapshot` (a facility-specific
-- contracted per-diem, ≥95% of the NF's own Medicaid per-diem per SSA §1902(a)(13)(B)/§1905(o)), NOT a
-- per-county state rate schedule — so no schedule row exists to reference for an R&B line, ever. A
-- schedule-only line (is_rb=false: RHC/CHC/IRC/GIP) still REQUIRES one. Mirrors the existing
-- `rb_line_requires_rb_day` CHECK's symmetric shape exactly.
ALTER TABLE "medicaid_claim_line" ALTER COLUMN "state_rate_schedule_id_snapshot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medicaid_claim_line" ADD CONSTRAINT "medicaid_claim_line_rate_schedule_requires_non_rb"
  CHECK ((is_rb = true) OR (is_rb = false AND state_rate_schedule_id_snapshot IS NOT NULL));
