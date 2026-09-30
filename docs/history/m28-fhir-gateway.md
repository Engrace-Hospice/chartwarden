# M28 FHIR gateway now serves (F-035)

> Why the gateway 404'd every read, the three stacked dead ends, `SERVED_RESOURCES`, and the §164.528 disclosure ledger. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

**The FHIR gateway (M28) now actually serves (F-035, #95, 2026-08-28.)** It was listed as a merged
capability and read 🟢, and a partner connecting to it got a `404 not-found` for every single-resource
read — not "when absent", ALWAYS, including for a resource the tenant demonstrably held. Underneath sat
a defect nobody had logged and that made the 404 moot: `POST /fhir/oauth2/token` answered
`invalid_client` unconditionally, so no client could obtain a bearer at all and R4–R22 were unreachable
by construction. That was not a fail-closed posture, it was a **wall** — whether a partner had been
provisioned made no difference. A third followed: `resolveBearer` read `fhir_client_session` on the
tenant pool with no org context, where `current_setting('app.org_id', true)` is NULL, the policy
predicate is NULL, and the read matches nothing — so every bearer that would ever be presented resolved
to null. The whole surface was three independent dead ends deep, each one individually sufficient. Two
of the pure cores it needed had been complete and unit-tested since M28-T03 with **no caller at all**
(`verifyClientAssertion`, `verifyApiKey`) — the step-up-routes shape (F-029) one module over.
**Now bound**: R3 runs both §D2 auth paths for real (JWKS fetch + cache, `jti` replay burn — Valkey
cluster-wide when `REDIS_URL` is set, per-process otherwise — audience binding on
`FHIR_TOKEN_ENDPOINT_URL`, which is a required production env var because unset does not weaken the
gateway, it silently disables it); the tenant is resolved by two narrow `SECURITY DEFINER` functions
(migration 0233) that take one unguessable uuid and return one org uuid, chosen over the
`DATABASE_PLATFORM_URL` BYPASSRLS login precisely because that credential's grants live in deployment
config, so the gateway would have worked only on deployments that had also been granted these tables and
failed as "invalid credential" on the rest; and the read path projects through the M1 seam registry into
the pure `@wardenx/fhir` mappers and out through the D3 egress consent gate.
**`SERVED_RESOURCES` is now the single source of truth for both the CapabilityStatement and the router**,
so the conformance claim and the behaviour cannot drift. That matters because R1 `/fhir/r4/metadata` is
served **anonymously, before authentication** — the first artefact any partner's tooling reads — and it
declared `read` + `search-type` on TWELVE resource types plus `$export` and `$everything`, none of which
worked. It now declares four, with per-resource interactions: Patient (read + search by `_id`/
`identifier`), MedicationRequest and MedicationAdministration (read + search by patient), and **Encounter
as `search-type` ONLY** — M8 publishes `signedEncountersForPatientSince` and no read-by-id, so an instance
read has no data path and `CapabilityStatement.rest.resource.interaction` is exactly where a server says
so. A type this gateway does not serve now answers `not-supported`, never `not-found`: the first is a
statement about the SERVER, the second a statement about the TENANT'S DATA, and answering the second when
the first is true is how a partner concludes a patient has no medications. The eight dropped types each
need a named producer-side read that does not exist (Condition and Coverage have no reader seam at all;
`CarePlanReader`'s methods are an encounter-element picker, an overdue check and two org rollups — none
can load one plan by id). **M12's `asFhirMedicationRequest` and M13's `asFhirMedicationAdministration` —
both documented as "the M28 FHIR projection" — are deliberately NOT used**: neither payload carries a
42 CFR Part 2 SUD-class flag, and D3 makes SUD redaction default-ON at every egress, so projecting from
them would mean a second per-resource seam read or asserting `sudClass: false` for every medication,
which is not a shortcut but a Part 2 disclosure. The full DTOs carry `isSudTreatment`; adding it to those
two payloads is the producer-side fix that would let this switch over.
**The §164.528 accounting is real, and had to be.** The disclosure-audit port defaulted to a NO-OP and the
composition root never overrode it, which was defensible only while the surface served nothing — the
moment it serves PHI to a third party, a gateway whose accounting seam answers zero is publishing a false
compliance statement to M30's disclosure scorecard. Migration 0233 adds `fhir_read_disclosure`
(tenant-scoped RLS, **append-only by GRANT** — `wardenx_app` holds SELECT + INSERT and nothing else, so
the code that writes the evidence cannot edit it away, compliance retention, deliberately unpartitioned
because nothing is ever purged), the routes write it AFTER the body exists so `resultCount` is what
actually crossed, and a read that 403s, 404s or is consent-filtered is deliberately NOT accounted for —
§164.528 accounts for DISCLOSURES, not requests. `disclosureMetricsForOrg` reads that ledger instead of
returning its hard-coded zero. **Two of the issue's own claims were stale**: the three published seams
have been registered on every db boot for as long as the store has existed (`index.ts` passes it; only
the header comment still said "registers nothing", and the audit read the comment rather than the
argument), and the disclosure row the finding says the 404 was written after was never written at all.
Proven by `m28-fhir-gateway.live.test.ts` — mint at R3, read a real US Core Patient at R4, org A's bearer
refused org B's patient and vice versa, the ledger row visible to the disclosing tenant only, the
append-only grants, and a revoked client's still-in-TTL bearer dying on its next request.
