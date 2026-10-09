# GAP-020 residual - arming the BCMA `wrong_patient` arm (M5 wristband + M13 verdict)

Branch `gapc/c2-wristband`, built on `gap-fix-20261008` (PR #358). Specs: M5 "As built - patient wristband", M13 "As built - BCMA wristband verification".

## What was wrong

PR #358 closed the five-rights and the drug arm of the bedside BCMA scan. The `wrong_patient` arm stayed unreachable: `evaluateBarcodeScan` compared a scanned wristband digest with an on-file digest, and no on-file digest existed anywhere (`administration-identity.ts` hard-coded `null`; M5 had no column, table or seam). The web modal sent whatever the nurse typed in a free-text "digest" box. A refused scan also rolled back with the transaction, so a caught wrong-patient near miss left no row.

## Decisions (owner-approved) and what was built

- Server-generated token, shown once; org-salted SHA-256 digest (no pepper); `bcma_wristband_required` default TRUE; offline grace 72 h; voided bands never validate offline.
- The token is opaque and random (128 bits), not an MRN. The design said 37 characters; `WXB1.` + 26 + `.` + 4 is 36 (arithmetic slip, caught by the codec test).
- M13 never sees a digest or a token: M5's `PatientWristbandVerifier` seam returns a verdict. A verifier that throws is a 503, never a pass.

## Corrections folded in (from the design critique, verified against code)

- **Idempotency.** The shared web client attaches a random `Idempotency-Key` to every mutation, so rejecting the header would 400 every browser call. Instead the issue route sets `config.noIdempotencyCapture`; the middleware stands aside (no claim, no stored response). Proven live: even with a client key, `idempotency_key` holds nothing.
- **Offline.** `administration_offline_queue` is written by nothing; `offlineSync` loops `recordAdministration` and stops at the first failure. The Sync Issues claim in the design was dropped. Only a server-set `viaOfflineSync` flag may use the device scan time.
- **Near-miss write** sits immediately before the throw at BOTH call sites, in its own transaction. Duplicates on replay are accepted. The table's existing M4 trigger is the audit record, so no new audit action or outbox event was added.
- **Trimmed.** The `check-material` device-cache route, the Web Crypto digest helper, `superseded_by_generation`, `payload_version`, and the dead `admit` issue reason were not built (no mobile client exists to use them); `first_issue` replaces `admit`.
- **Caregiver-attested path** forces `required = false` (a home caregiver has no band); a presented band is still verified. This is a product decision, recorded here and in the M13 spec.

## What is still NOT closed

- A scan is optional. An administration with no `barcodeScan` skips BCMA. Mandatory-scan-by-location (with an IPU override reason) is a separate product decision.
- Hardware: no thermal-band (ZPL/EPL) driver and no scanner exercised; the web closure is browser print + keyboard-wedge input.
- The Capacitor offline client does not exist; the server-side grace window is exercised only with synthetic `offlineCapture` rows.
- Existing patients have no band until one is printed; until then a scan is refused `WRISTBAND_NOT_ON_FILE` (by design, fail closed).
- The system proves the scanned token belongs to the patient; it cannot prove the band is on the right wrist (a clinical two-identifier process control).
