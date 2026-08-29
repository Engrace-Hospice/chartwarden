-- M22 `document_aggregate_type` — the seven artifact types behind six LIVE render requests M22 renders
-- nothing for. (F-099; the 0196 M21 / 0197 M33 precedent, a third time.)
--
-- M22 renders on REQUEST: a module emits a `*.document_requested` / `*.render_requested` row and M22's
-- §4.11 consumer answers with `m22.document.rendered`. Six modules have been emitting that request from a
-- PRODUCTION write path — some since they landed — and `M22_DOCUMENT_REQUEST_EVENTS` names none of them,
-- so every one of those rows has sat `pending` in `outbox_event` for the life of the deployment. Each
-- emit site says in its own comment that M22 renders it:
--
--   · m10.hope.summary_requested                    `POST /hope/assessments/:id/summary-pdf`
--   · m16.bereavement.outreach_artifact_requested   the D14 welcome-packet handshake at plan open
--   · m20.safety.incident_report_requested          "M22's renderer consumes it; M20 ships no PDF code"
--   · m25.appeal_packet.render_requested            the tier-specific appeal letter
--   · m27.artifact.render_requested                 the ECR / PI / supporting-doc submission artifacts
--   · m37.body_release.document_requested           `ipu_body_release.release_document_id` is the column
--                                                    waiting for it, commented `M22 body_release_authorization`
--
-- Adding the consumer needs a published template per artifact, and a template descriptor needs an
-- aggregate type. `bereavement_letter` already exists and M16's welcome packet files against it (one
-- aggregate type, several template keys — the letter kinds), so M16 needs no value here.
--
-- M27's three artifact kinds are three types rather than one: an ECR is the cost report itself, a PI is
-- the provider-information supplement, and a supporting doc is neither — they are separately retained and
-- separately superseded, and collapsing them would make `renderedDocumentForAggregate` treat a PI render
-- as an idempotent re-delivery of the ECR and skip it.
--
-- Additive only (no removal, no existing row affected). Own migration: PG forbids using a value added
-- earlier in the same transaction, so this stands alone ahead of any migration that reads or writes it.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'hope_summary';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'safety_incident_report';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'appeal_packet';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'cost_report_ecr';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'cost_report_pi';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'cost_report_supporting_doc';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'body_release_authorization';
