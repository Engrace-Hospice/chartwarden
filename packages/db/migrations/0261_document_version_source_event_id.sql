-- F-168 (#248) — the m22 `handlers-unbound` group's standing "idempotency-key-granularity collision"
-- (first found F-162, re-confirmed F-166): `decideDocumentRequest`'s `alreadyRendered` fact was resolved
-- from `renderedDocumentForAggregate({aggregateType, aggregateId})` — "does ANY document exist for this
-- aggregate" — never from the specific REQUEST (outbox event) that asked for it, despite the file's own
-- header comment naming `(sourceEvent, aggregateId)` as the intended design. That made every SECOND
-- render request against an aggregate that already has one document silently `idempotent_skip`, correct
-- for a genuine crash-and-retry redelivery of the SAME outbox row and wrong for a second, different
-- request event that needs a new document VERSION (`m14.minutes.amended` after `.signed`,
-- `m8.encounter.addendum_signed` after `.signed`, `m12.medication_order.transmitted` after
-- `.document_requested` — all collide on the identical aggregate id under the old key).
--
-- `document_version.source_event_id` is the specific delivered `outbox_event.id` that produced this
-- version (nullable — most versions are NOT outbox-request-driven: manual uploads, DSAR/tenant-export
-- renders, and every version written before this migration). Plain UNIQUE on
-- `(organization_id, source_event_id)`, no partial WHERE clause needed — migration 0250's
-- `level_of_care_period_source_order_id_uq` / migration 0259's `comfort_kit_deployment_m21_dispatch_uq`
-- precedent: Postgres treats every NULL as distinct from every other NULL by default (NULLS DISTINCT), so
-- the many NULL-keyed historical/non-request rows coexist freely and only the request-linked ones are
-- ever constrained against each other. This is what makes the fix genuinely crash-safe rather than
-- introducing a NEW crash window: the source-event identity is written in the SAME insert as the version
-- row itself (inside `upsertRenderedDocument`'s existing transaction), not a separate receipt table that
-- could itself be lost between "the version was written" and "the receipt was written".
--
-- No FK to `outbox_event.id` deliberately, the same reason `document.created_by_membership_id` and
-- `document_version.render_form_fill_id` carry none (see this table's own header comment): `outbox_event`
-- rows in `dispatched` status are purged past the retention window (`outbox-dispatcher.ts`'s own
-- documented retention policy), and a version's provenance must outlive the row that requested it — an
-- app-validated plain uuid, not a referential constraint that would either block the purge or null out
-- history it should keep.
ALTER TABLE "document_version" ADD COLUMN "source_event_id" uuid;

ALTER TABLE "document_version"
ADD CONSTRAINT "document_version_source_event_uq" UNIQUE ("organization_id", "source_event_id");
