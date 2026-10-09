# GAP-033 - M22 form layouts and `arch:pdf-templates`

## What was wrong

M22's renderer had 7 bespoke builders; the other 43 of 50 platform templates (including the CMS-required CTI, F2F,
notice of rights, revocation and discharge summary) drew through a generic "dump every payload field" builder. For
the six M6 documents the real blocker was upstream: `m6.cti.signed`, `m6.f2f.attested`, `m6.nor.acknowledged`,
`m6.revocation.created`, `m6.discharge.created|cosigned` and `m6.transfer.created` carried **identifiers only**, so
no layout had anything to draw. Two template registries (`@wardenx/forms` descriptors and the renderer's
`PLATFORM_TEMPLATE_TABLE`) had also drifted: M13's reconciliation worksheet render request named
`medication_reconciliation_worksheet`, which the renderer table did not hold, so every request threw
`unknown_template` and dead-lettered.

## What was built (stage 1: engine + CMS-required forms)

- **Engine** (`render-pdf/`): `fieldGrid`, `legalText` (never truncated, 2-line widow/orphan guard), `attestation`,
  `signature` (21 CFR 11.50 manifestation), `options` (drawn check boxes), `keepTogether`, `keepWithNext`
  paragraphs, a running patient header on pages 2..N, a translucent rotated page watermark (render-time; an auditor
  download overlay, Architecture line 700, is applied on the downloaded copy and does not conflict), and a disclosed
  glyph-loss footer for characters WinAnsi cannot draw (no Unicode font: residual R1).
- **FormSpec** (`render-pdf/forms/`): a form is data (`spec.ts`), compiled by `compile.ts`. The compiler enforces for
  every form: typed payload (allow-list, so unknown keys are never drawn), patient identity in the grid and header,
  constant PHI-free `/Title`/footer/document title, the 42 CFR 2.32 redisclosure notice when Part 2 content is present,
  and **fail closed on a missing or blank required signature** (`RenderPayloadError` -> retry -> DLQ).
- **Typed producer payloads** (`packages/types` render-payloads, built by M6 in the signing transaction from the
  aggregate's own rows under RLS, `apps/backend/src/modules/06-admission/render-payloads`). Names, credentials and NPI
  come from M5 `PatientReader` / M40 `MdmEntityProvider`; user names from `user`. Nothing comes from the request body.
- **Registry reconciliation**: `scripts/pdf-generic-allowlist.ts` (alias map, forms-only list with reasons, the
  reasoned generic allow-list) read by `arch:pdf-templates`.

## Decisions and residuals

- **Part 2.** The producer withholds ICD-10 F10-F19 codes from the rendering (count only; the chart keeps the code).
  Clinician-authored free text (CTI narrative, F2F attestation) cannot be classified mechanically and is rendered as
  written. `sudRedacted` on a render payload means "Part 2 content present WITH consent" (see
  `decide-document-request.ts`), not "redacted"; the form then adds the redisclosure notice.
- **SignatureRecord provenance.** There is no signature-event id in the data, so the record carries `recordId` (the
  signed artifact's id), the signer's printed name, `meaning` derived from the artifact type, `method` from the row
  (`acknowledgment_method` for the NOR, `electronic` elsewhere) and the row's own signed-at. Credentials / NPI exist only
  for M40-resolved physicians (CTI, discharge cosign NPI column); the F2F performer, NOR witness and discharge filer are
  printed by name only.
- **A source that does not resolve never fails a signature.** The producer logs ids and paths only
  (`m6.render_payload_unavailable` / `_invalid`) and publishes the event without `renderPayload`; M22 refuses it
  (retry -> DLQ). An id-only event is therefore loud and recoverable, never a blank form.
- **Deploy order / drain.** The producer and the strict consumer ship in the same release, so rows queued before it
  carry no `renderPayload` and are refused. Operators draining such rows can set
  `M22_M6_LEGACY_UNTYPED_RENDER=1` (generic render of the id-only event, the pre-GAP-033 behaviour) for the drain window and
  must unset it afterwards. Events already in the DLQ stay there; prod data is demo data, so no backfill job exists.
- **ABN / NOMNC wording is CMS-prescribed.** `abn-form.ts` ships structure only; `ABN_PRESCRIBED_TEXT` is `null` until
  compliance supplies the CMS-R-131 wording from the CMS-published form, and until then the document is a DRAFT-watermarked,
  bannered, non-deliverable structure. `nomnc` has no render path at all (`FORMS_ONLY_KEYS`).
- **Regulatory cites.** F2F `418.22(b)(4)` and the CTI `(b)(3)` narrative placement are verified against
  `docs/research/FY2027_HOSPICE_COP_RESEARCH.md`; the other paragraph cites and fixed texts (CTI prognosis/supporting
  statements, NOR rights summary, revocation statement) are template wording awaiting compliance's line-by-line review.
- **Not in stage 1:** waves 2-4 (see the stage-2 section below), the optional
  `document_version.template_version` / layout-digest columns (not needed until a re-render is planned), non-Latin
  fonts, images (logos, EVV maps, scanned signatures).

## Proof

Unit: `m22-forms-engine`, `m22-forms-wave1`, `m22-forms-golden` (`UPDATE_GOLDEN=1 bun run test:golden:m22`),
`m6-render-payload-builders`, `scripts/__tests__/check-pdf-template-coverage`. Live (real Postgres, `wardenx_app`
NOBYPASSRLS, real catalog-validating publisher, real consumer and renderer): `test:m6:cop-documents:live` reads the
stored PDF bytes back and asserts the narrative, identity and signature text, the cosign v1/v2 difference, that an
id-only legacy event is refused with the retry error, and that an unresolvable source does not fail the signature.

## Stage 2: waves 2 and 3 (what was investigated, what was built, what is blocked and why)

Every wave 2/3 key was traced to its producer before anything was written. The finding repeats stage 1's: most
producers ship identifiers (or a pointer), so "build a layout" is really "build a typed producer payload".

**Built (8 templates, all registered in `COMPILED_FORMS`):**

- `order_record` (M11) and `medication_order` (M12): typed payloads built by the owning module in the signing
  transaction (`11-orders/render-payloads`, `12-dosespot/render-payloads`), through the Foundation sources port
  (`bootstrap/render-payload-sources.ts`, shared with M6). M11 draws kind-specific lines **only** for kinds and
  versions with a published field contract (`ORDER_KIND_CONTRACT_STATUS`, `dme.v2`, `supply.v2`); `dme.v1`, `supply.v1`
  and `ancillary_service.v1` are explicitly extensible, so the page says no contract is published instead of dumping the
  open object. The M12 payload never carries the prescriber's DEA number (schedule only). The order's signer is the
  signing member's printed name; credentials / NPI are shown for the signer only when the signer IS the prescriber of
  record, and the ordering physician is printed separately. A SUD-treatment drug is stamped `isSudClass`, which makes
  M22's consent gate (D20) apply to the render - a **behaviour change**: a SUD order with no active consent is now
  refused (settled, no retry) instead of rendering.
- NOE and NOTR receipts, Medicare and Medicaid claim acknowledgment letters, the denial-appeal cover letter and the
  denial-resolution letter: their producers already shipped the content (PHI-free by design), so only the M22 side
  changed. The wording is deliberately limited to what the event proves; none of them states coverage, payment or an
  appeal deadline. They carry no patient identity (the producers' D13 contract), so the compiler's patient and document
  date are now optional.
- Consumer: `requiresRenderPayload` now means "the producer's object stamped `schemaVersion: 2`", because M11/M12
  previously shipped `renderPayload: {patientId, kind, signedAt}` - an object that passed the old "is it an object"
  test. The drain-window flag `M22_M6_LEGACY_UNTYPED_RENDER=1` therefore also covers M11/M12 rows queued before the
  release (generic render, pre-GAP-033 behaviour). `m12.medication_order.transmitted` (catalogued, no producer yet) now
  requires a typed payload with a `transmission` block.

**Not built, with the verified blocker** (the reasons are in `scripts/pdf-generic-allowlist.ts`, which `arch:pdf-templates`
ratchets):

| Key | Blocker |
|---|---|
| `encounter` | M8 ships `final = ""` by design: the narrative is sealed under the tenant DEK (#122). Needs an M22-side hydrator that opens the pin (design alternative D2), not a producer snapshot. |
| `care_plan`, `hope_summary`, `safety_incident_report`, `body_release_authorization`, `medication_reconciliation_worksheet`, `medication_administration_record`, `comfort_kit_return_receipt`, `supply_bill_of_lading` | The event carries identifiers or a pointer. Each needs the owning module's typed payload built in its transaction (the M6/M11/M12 pattern). The two M21 documents need the dispatch / reconciled-lot manifest (DEA-1304 content). |
| `aide_poc`, `msw_plan`, `spiritual_plan`, `volunteer_plan` | M15's `snapshot` is `Type.Unknown()` in the catalog with no typed schema. |
| `assessment_summary` | M9 ships scale names only, not scores or dates. |
| `patient_medication_list`, `lab_results_pdf` | M22 assembles typed content itself but with `patientId` only; per-page identity needs PatientReader hydration inside the render. The lab form also needs reference ranges (M29) for the abnormal flag / CRITICAL RESULT watermark. |
| `consent_record` | M39 has a producer, but twelve consent types need compliance-supplied 45 CFR 164.508(c) / 42 CFR 2.31 wording and the payload has no signer, purpose or scope text. |
| `patient_amendment_statement_of_disagreement` | No live consumer binding exists. |
| `cost_report_ecr` / `_pi` / `_supporting_doc` | M27 renders a data-file artifact (`payloadRef`), not a form. |

Free text residual (unchanged from stage 1): order indications, clinical justifications and lab collection notes are
clinician-authored and cannot be classified for Part 2 mechanically; they render as written.

**Proof.** Unit: `m22-forms-wave2`, `m22-order-render-payload-builders`, extended `document-render-consumer`,
`m22-every-template-renders-pdf`, goldens for all eight (`order_record` x2, `medication_order` x2, six billing letters).
Live (private pgvector container, `wardenx_app`, real publisher / dispatcher / consumer / renderer):
`test:m22:render-handshake:live` now signs a DME order, an IDG-request order and a medication order through the real
services and reads the stored PDF back (patient, ordering physician, signer manifestation, the no-contract note, the
published-contract lines), publishes the six billing letters through the catalog-validating publisher under their
modules' own schemas and reads each back; `f168` appends a transmission version onto a typed medication order.
