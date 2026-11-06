-- compat: expand
-- ADR-0109 D10 (PR 3) - M22 `document_aggregate_type`: `bereavement_library_item`, an agency-authored GRIEF LIBRARY item (a PDF leaflet, a short
-- video, an image) M16 lists in the bereaved family portal. It is ORG-LEVEL (no patient), PATIENT-FACING and NOT internal: staff upload it through
-- M22's verified (presigned) upload; families reach it only through the `OrgDocumentAccessProvider` portal mint, which admits this type alone and
-- records every mint on `document_access_log`. `video/mp4` is accepted for this type only (presigned path, larger cap, ftyp check).
-- Own migration: PG forbids using a value added earlier in the same transaction (the 1347 / 1375 precedent). Additive only.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'bereavement_library_item';
