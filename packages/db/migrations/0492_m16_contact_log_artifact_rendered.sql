-- GAP-130 — M16 §4.5 `m22.document.rendered` → `handleDocumentRendered`: for the three auto-complete
-- kinds (sympathy_card / sympathy_letter / anniversary_letter, `AUTO_COMPLETE_ON_RENDER_KINDS`) the render
-- callback completes the outreach, and §2.4 requires a `bereavement_contact_log` row behind every
-- completion. None of the ten existing outcomes is true of a system-rendered letter — every one of them
-- describes how the SURVIVOR responded, which nobody knows when M22 hands back a PDF — so the row records
-- exactly what happened: the artifact was rendered (its `artifact_document_id` names the document).
-- Its own migration: a new enum value must be committed before anything uses it.
ALTER TYPE "public"."bereavement_contact_log_outcome" ADD VALUE IF NOT EXISTS 'artifact_rendered';
