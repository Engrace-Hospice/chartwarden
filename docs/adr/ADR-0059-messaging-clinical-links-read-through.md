# ADR-0059 — Clinical links in messages are stored pointers in M36's own `clinical_link` table, resolved read-through against the owning module at open time

- **Status:** **Accepted** (2026-10-14, by the user delegating the decision: "use your decade of experience to close them"). The open
  questions on WP 3.2 are closed by this ADR; no clinical-lead or privacy sign-off is recorded.
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.2, clinical links).
- **Supersedes:** one sentence of `docs/messaging-hub/01-baseline-and-gap-matrix.md` (row 7, line 26), which proposed widening
  `message_entity_reference.reference_kind` for clinical links. That sentence is superseded by decision 1 below; the hub doc is
  not edited here.
- **Extends:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (seam interfaces live in `packages/types`),
  [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no direct cross-module table access).
- **Related:** ADR-0055 (revisions and redaction), ADR-0058 (search re-checks access at query time, the same posture as here).

## Context

The hub plan (`02-architecture-and-domain.md`, `clinical_link` row; `03-phases-0-to-3.md`, WP 3.2) wants a message to carry a chip that
points at a medication, order, care plan, assessment, visit, document or IDG meeting. The acceptance text is: a link cannot modify its
source, opening re-checks the source permission, and the link shows current state rather than a snapshot.

Three facts shape the design:

- `message_entity_reference` stores text-range mentions (`@staff`, `@patient`) with NOT NULL offsets. A clinical link is attached to a
  message, not to a character range.
- Any title, label, status or snapshot copied into M36 becomes a second PHI store that drifts from the source and outlives its erasure.
- Chat access and chart access are different grants. A channel member may not be allowed to see the chart record a colleague links to.

## Decision

1. **A link is a stored pointer, in a new table.** `clinical_link(id, org_id, message_id, kind, source_id, patient_id, created_by,
   created_at)`, owned by M36, with the three-column tenancy rule, RLS enabled and FORCEd. `kind` is one of `medication`, `order`,
   `care_plan`, `assessment`, `visit`, `document`, `idg_meeting`. It is **not** a widening of `message_entity_reference`. **No title,
   label, status or snapshot is ever stored**; the row is the pointer and nothing else.
2. **Read-through at open time.** The chip's label and status come from the owning module's `linkSummary(orgId, id)` seam when the
   viewer opens or renders it, after M36 re-checks the viewer's permission **and patient scope on that record** with the owning module's
   own permission (the same check the chart uses). **Break-glass is not honoured** on this path. The link survives source edits and
   shows current state. An unauthorised viewer, a missing source, an erased source and a seam that throws all render the **same**
   `unavailable` chip, so the chip is not an existence oracle.
3. **Write-time validation.** The author must themselves pass the same permission and scope check on the source at link time. Any
   failure (no permission, out of scope, not found, cross-tenant) returns one uniform, generic 422. Sources with no patient are
   refused, **except `idg_meeting`**, whose summary carries no patient data. `patient_id` is taken from the source, never from the client.
4. **A link can never modify its source.** M36 has no code path to any source write method: it depends only on the seven read
   `linkSummary` seams, the resolve route is GET-only, and a static test fails the build if M36 code imports or calls a source write
   method or registers a non-GET resolve route.
5. **The summary contract is ids, status and time only.** `ClinicalLinkSummary` carries no free text and no title (`documents.title`
   is on the PHI denylist). Part 2 / SUD records are handled by the owning module's seam, which decides what its summary may say or
   whether it answers at all; M36 adds no disclosure of its own and no Part 2 bypass.
6. **Feature flag `messaging.clinical_links`, default off** per tenant. With it off the link routes and picker are absent and existing
   rows are not resolved.
7. **Retention, erasure and audit.** Rows are deleted with their message (`ON DELETE CASCADE`), so retention and legal-hold handling of
   messages (ADR-0055) governs links; M36 adds no separate retention clock. If the source is erased, the chip becomes `unavailable`;
   nothing in M36 needs to be scrubbed. The table carries the PHI write-audit trigger, and every resolve writes a read-audit event
   with a `resourceIdParam` (so the event's resource id is not empty).

## Alternatives considered

- **Widen `message_entity_reference`** (the earlier suggestion). Its offsets are NOT NULL and its CHECK models text mentions;
  relaxing both weakens a working table and mixes two concepts. Rejected.
- **Store a label/status/snapshot on the link.** Fast to render and no cross-module call, but it is a stale second copy of PHI that
  survives source erasure and edits, contradicting "shows current state". Rejected.
- **Honour break-glass on open.** A chat chip would silently open an emergency-access path with no justification prompt and no
  post-review. Rejected; a user who needs the record uses the chart's break-glass flow.
- **Distinct errors for forbidden / not found / erased.** Helpful to users, but an existence oracle for chart records by anyone in
  any channel. Rejected in favour of one `unavailable` and one generic 422.
- **Let M36 query source tables or hold a cross-module read model.** Violates ADR-0011 and duplicates ownership. Rejected.
- **Allow patient-less sources.** Their access cannot be scoped to a caseload, so the check would degrade to a bare permission.
  Refused except `idg_meeting`, which carries no patient data.

## Consequences

- **Seven seam additions**, one `linkSummary(orgId, id)` per owning module: medication (M12), order, care plan, assessment, visit
  (M17), document, IDG meeting (M14), each returning the shared `ClinicalLinkSummary` and each owning its permission and scope rule.
  A link kind ships only when its seam is bound; an unbound seam yields `unavailable`, never an error to the viewer.
- **Known limits (accepted).** A channel member who lacks access to the source sees only `unavailable`, and therefore learns that a
  link exists. The existence of a link in a message is visible to every member who can read that message. Authors should not rely on a
  link to hide that a record was discussed.
- **Part 2 / lifecycle (as built).** The seam is the place Part 2 is fenced: an assessment with `sud_context` and a medication order with
  `is_sud_treatment` return `null` (same as missing) because the M39 consent join is not wired in the seam, and a destroyed or
  legal-hold document returns `null`. Other kinds rely on the owning module's permission plus caseload scope, so a SUD-context
  order, visit or care plan still resolves to status, time and a deep link (no content) for a user with that scope. Wiring the consent
  decision into the seams is the upgrade path.
- **Rollback is a one-way door.** The `clinicalLink` node is added to rich-body schema v1 (no bump), so an older build rejects a stored body
  that carries it and shows it empty in previews. The tenant flag gates new writes only. Keep the flag off until every instance runs the
  build that knows the node, and do not roll the build back after links exist.
- Opening a chip costs one cross-module call plus a permission check; the list view of a message may batch these per kind.
- Edits and redactions of a message (ADR-0055) do not change its links; redacting a message removes it from view, and its links with it.
- A source seam outage degrades chips to `unavailable`; it never blocks sending or reading the message.

## Migration / rollout

1. Add the `clinical_link` migration (check `arch:migration-numbering` against `main` first), mirrors in `packages/db` and
   `packages/types`, and the manifest entry in both `.ts` and `.cjs`.
2. Land the seven `linkSummary` seams in their owning modules, each with a deny-stub that makes the chip `unavailable` until bound.
3. Land the M36 write, resolve and picker behind `messaging.clinical_links`, default off.

## Verification

- Route tests: link creation fails with the uniform 422 for no-permission, out-of-scope, missing and cross-tenant sources, with
  identical bodies and status; patient-less sources are refused except `idg_meeting`.
- Resolve: unauthorised, missing, erased and throwing sources produce byte-identical `unavailable`; a break-glass session is not
  honoured; the read event lands in the audit log.
- Static test: no M36 import of, or call to, a source module write method; resolve is GET-only.
- Live (real `wardenx_app` role, private container): cross-tenant resolve returns `unavailable`; message deletion cascades links; the
  PHI write-audit trigger fires.
- Fitness: `arch:tenancy`, `arch:manifest-mirror`, `arch:migration-numbering`, `arch:fitness`.

## Open questions

None gating. Left for the owners of each seam: the exact summary fields per kind, and which Part 2 records answer `unavailable`.
