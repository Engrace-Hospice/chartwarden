# ADR-0058 design review record (2026-10-13): security architect and privacy officer

Companion to [ADR-0058](../adr/ADR-0058-messaging-global-search-blind-token-index.md), "Design review requirement".

## Standing of this record (read first)

Both reviews below were performed by **AI agents as desk reviews** of the ADR text and the code on `main` (commit `d159671884`), on
2026-10-13, at the product owner's request. **They are not a human security architect's or privacy officer's review.** No live suite
or experiment was run for them, nobody signed, and no name is recorded. They satisfy none of the four items of ADR-0058 "Design review
requirement" by themselves:

| Requirement item | State |
|---|---|
| (1) written review by the security architect and the privacy officer | **AI draft recorded here. Human adoption or amendment: PENDING.** |
| (2) measured leakage experiment (also the production-enablement leakage test) | **NOT RUN.** No harness or result exists in the repo. |
| (3) HIPAA risk-analysis entry | **Draft below. Owner, filing and date: PENDING (human).** |
| (4) product-owner acceptance of the residual risk | **PENDING.** |

Sign-off block (to be completed by humans; leave blank until then):

| Role | Name | Decision (adopt / amend / reject) | Date | Signature |
|---|---|---|---|---|
| Security architect | | | | |
| Privacy officer | | | | |
| Product owner (residual risk) | | | | |

Both reviewers' disposition: **APPROVED WITH CONDITIONS, design only. Nothing is approved for production enablement.** The default-off code
on `main` is consistent with that.

## Security architect (AI desk review)

**T = 19 and the arithmetic.** Recomputed from the ADR's stated assumptions (D = 4e5, 1.6e8 rows): every row of the table matches
(0.76 tags per bucket, 53% sharing, 305 rows per bucket of which 229 real and 76 dummy; tail bounds 0.95% at H = 5,000 and 5.6% at
H = 3e4; 355 candidates and 86% false for a rare word, mean bucket only). **CONFIRM-WITH-CONDITION:** the ADR over-reads what T buys. T = 19
is a usability floor (T = 18 breaks the 500 cap), not masking. Truncation and dummies hide the counts of rare tags but **not association**:
message ids are stored beside tags, so the true tags of a rare word share exactly the same message set, and an observer intersecting
message sets recovers word clusters at any T. "Truncation protects the tail including names" is true for counts and false for
co-occurrence. Because `message_id` joins to the plaintext `message.channel_id`, sender and timestamps, a snapshot thief gets per-patient
rare-word clusters; the threat model must say so. Describe T as a candidate-set and noise knob. Keep 19 and the sizing rule
`clamp(round(log2(D/0.75)), 12, 20)` (`params.ts:32`), unmeasured on real data, and worse above about 6e5 distinct tags.

**Parameter verdicts.**

| Parameter | Verdict |
|---|---|
| NFKC, diacritic fold, min token 3, max 40 dropped, ID-like rule | CONFIRM |
| Stop words (101), `not` kept | CONFIRM |
| Patient names indexed as ordinary words (v1) | CONFIRM-WITH-CONDITION: report name recovery separately in the experiment; if high, exclusion becomes a blocker |
| T = 19 and per-tenant sizing rule | CONFIRM-WITH-CONDITION (above) |
| Padding floor 16, power-of-two bands, CSPRNG, re-draw on replace | CONFIRM; do not call it content masking |
| **Prefix lengths 3..min(len,12)** | **CHANGE to {3, 5, 8, 12}.** The prefix chain plus whole-word tag form a cluster of 2 to 11 tags in the same messages for **every** word (not only head words): cluster size gives the exact length under 12, and shared prefixes give the tenant vocabulary trie. A typed prefix of length L queries the largest tag length not above L; the post-decrypt verify (`query-terms.ts:75-82`) keeps correctness. Reject option (b) (no prefix tags for head words): it needs a build-time plaintext frequency decision and the choice itself leaks. Cost to measure: wider candidate sets for typed lengths 4, 6, 7, 9 to 11 |
| `CANDIDATE_CAP` 500, `DECRYPT_BUDGET` 200 and 3 s, `MAX_PAGES_PER_QUERY` 5 | CONFIRM |
| `HEAD_BUCKET_ROWS` 5,000 | CONFIRM-WITH-CONDITION: re-measure at the sparse prefix set |
| Rate limits 30/min/user, 300/min/org, fail-closed | CONFIRM-WITH-CONDITION: alert on sustained near-cap per-user volume (about 43k probes/user/day is a usable dictionary rate against the threshold oracles); live test that two replicas share one store |
| Key derivation (HKDF-SHA256 over the ring DEK, info `wardenx-message-search:<org>:<ringVersion>`) | CONFIRM |
| Key rotation | CONFIRM-WITH-CONDITION: `liveVersions` returns the active version only (`search-key-provider.ts:67`), so "query both versions during overlap" is not implemented. After rotation the tenant is closed until the new index is ready (safe, but an outage). Document as "rebuild, search closed" and prove it live, including deletion of old-version rows (not verified by the reviewer) |
| Logging hygiene | CONFIRM-WITH-CONDITION: tags are bound parameters, gates log error names only, audit omits `q` and `cursor`. The `pg_stat_statements` capture check soft-passes when the extension is absent (`m36-global-search.live.test.ts:1436`): make it fail in CI. Runbook must also set `log_parameter_max_length_on_error=0` and `auto_explain` parameter logging off (statement-timeout errors are the likely leak path) |
| Escrow (Shamir 2-of-3, three natural persons, dual control, drill, same for `M34_TENANT_KEK`) | CONFIRM; the env flag and the escrow flag are self-attestations, the human record must exist |
| Flag and kill switch | CONFIRM-WITH-CONDITION: the org-NULL read is well built. One flag is both kill switch and the "leakage review passed" attestation, and no code enforces the leakage test. Add a separate `messaging.global_search_leakage_attested` platform flag and a fifth checklist item `LEAKAGE_NOT_ATTESTED` |
| Role-category rule | CONFIRM (`role-gate.ts`: deny wins, unknown category denies, a disabled excluded role still excludes); ratchet and live test remain required |
| Archived channels included and marked | CONFIRM |

**Open questions assigned to the security architect.**

- *Patient attribution mechanism:* service-emitted per-patient reads (what the code does, `query-service.ts:426-432`; a failed audit fails the read). Condition: it attributes only `care_team` channels with a `subjectId`, so a patient-linked non-care-team channel is unattributed; add a live test for that case.
- *Heavy-tail handling and prefix hierarchy:* keep the head-bucket refusal; no per-tenant stop-list now; prefix lengths to {3, 5, 8, 12}.
- *`addMember` refusing excluded categories:* yes, as defence in depth at the shared membership-write chokepoint (with `ensureDmMember`) plus a static ratchet. The security architect treats it as not a blocker because the route gate is the control. **The privacy review below disagrees and treats it as a blocker; the stricter reading governs until the humans decide.**
- *`scanCapped` amendment:* ACCEPT, conditionally. The amendment text is stale against the code (the code scans up to 5 rounds and 100 channels, so the bit means more than about 5 x 500 hidden candidates or 100 hidden channels, not "more than 500"). Do not adopt the "only when the page is non-empty" alternative (a truncated empty page would read as complete: a clinical-safety regression). Timing of up to five hidden rounds is a finer oracle than the bit; record it as residual and rely on the rate limit. The head-bucket refusal also answers any permitted caller about org-wide word frequency and belongs in the risk analysis.

**Item (2), the leakage experiment: NOT RUN.** The nearest thing, the live suite's padding block (`m36-global-search.live.test.ts:1217`), checks row
counts, shape and dummy re-randomisation, not an attack. It must measure, on synthetic hospice notes at production shape (about 5e6 messages,
Zipf vocabulary with drug names, diagnoses and patient and family names), with the real tokenizer, T = 19, real padding, real message-to-channel
metadata, **for both** the full 3..12 chain and the sparse {3, 5, 8, 12} set: (a) the share of top-N words (N = 100, 500, 2000) recovered from
bucket histograms plus a public-vocabulary list; (b) cluster recovery of word and length from message-set clusters, with and without dummy
pruning, including the prefix trie; (c) patient and family name recovery with per-patient channel linkage; (d) `P(candidates > 500)` for one-term
and two-term queries and the false-candidate rate. Recommended pass criterion, **for a human to ratify before the run**: at most 5% of top-500
non-stop-word tokens recovered by the best attack; name recovery not above the random-guess baseline plus 1%; exact length recoverable for no
more than 10% of rare words; at most 1% of typical clinical single-term queries ending in `refine`. The reviewer expects the head to fail the first
criterion; D3 accepts head leakage, so judge that criterion on the tail and on names and record head recovery as accepted residual. If names or the
rare tail fail, the fallback is the bounded multi-channel option A in the ADR.

## Privacy officer (AI desk review)

**Verdicts.**

- *Pre-join history:* CONFIRM with conditions. Search equal to history read is coherent. The weaker point is the **removal gap**: a re-added
  member reads and finds messages sent while they were removed (`ensureDmMember` resets `joined_at`; nothing filters on it). Conditions: the risk
  entry names both effects; open a tracked follow-up to bound the removal gap on the history read path (search follows automatically); tenants
  are told before enablement that search makes whole-channel history discoverable.
- *Archived channels:* CONFIRM (included for current members, marked, read-only; access is unchanged because `canViewChannelFor` ignores archive
  state; live row 5, `m36-global-search.live.test.ts:565`). Condition: align or document the 2.7a mismatch (410 on archived channels).
- *Patient-name tokens:* **index them in v1; do not exclude.** Names are long-tail; exclusion is incomplete (misspellings, nicknames, relatives,
  staff), needs a patient-name dictionary job feeding the index path (new PHI plumbing, false assurance) and removes the most natural clinician
  query. Condition: the experiment uses a patient-name list as auxiliary vocabulary with a threshold written down before the run; above it,
  exclusion becomes mandatory before enablement.
- *Minimum necessary and role categories:* CONFIRM. `GLOBAL_SEARCH_ROLE_POLICY` is a `Record<RoleCategory, ...>` (`role-gate.ts:18-31`), so a new
  category fails compilation until classified; deny wins, unknown denies. `external_collaborator`, `volunteer`, `temporary_special` stay off. The
  static ratchet was not verified to fail on a `messaging.read` grant: a human should check. **Condition: close `addMember`** (an excluded
  identity can still be added to a channel and read history; the search gate does not cover that). Blocks enablement.
- *Read audit:* CONFIRM with conditions. `auditRead` with `filterOmit: ["q","cursor"]` (`global-search-routes.ts:87`), audit inside the request
  transaction so a failed write fails the read (`query-service.ts:420-433`), the token-table audit trigger never selects `tag`. **Coverage hole:**
  attributed reads are emitted only for `care_team` rows with a `subjectId` (`query-service.ts:422-424`); DM, group and announcement hits yield only
  the aggregate row although they can discuss patients. The ADR's "164.528 accounting join" framing is imprecise: internal workforce access is a use,
  not an accounting-of-disclosures event; the controls are 164.312(b) audit controls and access review. State what the audit can and cannot
  answer: it tells which user searched and which patients' care-team channels surfaced; not which messages surfaced, nor any patient in a
  non-care-team channel.
- *Retention and erasure:* CONFIRM for delete, edit, erase and retention (trigger `trg_message_search_token_purge` fires in the same transaction on
  `status -> deleted` or a `body_sha256` change; hard delete cascades; a destroyed ring makes the key provider throw so search fails closed). The
  eraser never names the token table; it relies on the trigger and cascade (explicit live assertion wanted, F8). **Redaction is not wired:**
  `neverRedacted` is the default (`mount.ts:60`, `register.ts:58`). ADR-0055 redaction must not ship until it calls `deleteSearchTokens` in the
  request transaction and supplies a real `isRedactedOrPending` to the writer, reconcile and query paths, with a ratchet test.
- *`scanCapped` amendment:* CONFIRM the choice, REQUIRE the text correction and add the head-bucket REFINE oracle (`query-service.ts:477`), a
  membership-independent frequency threshold.
- *Patient-family and auditor exposure:* CONFIRM (denied at the route; allowed plus excluded role denies).
- *Breach notification:* the index is a PHI-derived store. A snapshot or backup of `message_search_token` is a potential breach; it is probably
  not "unsecured PHI" if tags are keyed HMACs and the key is not exposed, but truncation, dummies and frequency leakage make that uncertain. The
  breach playbook treats tags plus the ring KEK as one exposure unit and records the leakage assumptions rather than declaring "encrypted". Index
  rows in backups follow the same ageing rule as legacy-wrapped ciphertext.

**HIPAA risk-analysis entry, draft (45 CFR 164.308(a)(1)(ii)(A)).** Not filed. Owner and filing date pending.

| Field | Entry |
|---|---|
| Asset | `message_search_token` (HMAC tags per message, T = 19, padded), `message_search_index_state` (head-bucket statistics), `tenant_messaging_search_setting`, and the query path that decrypts hits. PHI-derived |
| Threats | (1) database or backup compromise then frequency or co-occurrence attack; (2) insider probing through the search surface; (3) discoverability of history, including pre-join messages and messages sent while a member was removed; (4) stale index rows after redaction or rotation; (5) oracle probing via head-bucket, `scanCapped` and timing; (6) a tenant-misconfigured role gaining search or channel access |
| Vulnerabilities | head words identifiable by rank; prefix chain and message-set clusters visible (security review); message id joins to the plaintext channel, sender and time; no history-window filter on the read path; attributed audit covers care-team channels only; redaction not wired; old-version rows linger after rotation until rebuild; `addMember` has no category check; T = 19 not validated by measurement |
| Likelihood | (1) low (needs database or backup access); (2) moderate; (3) certain, by design decision; (4) low once redaction is wired |
| Impact | (1) moderate: frequent words and clusters recoverable, rare words and names partly protected, no plaintext copy; (2), (3) moderate: speed and breadth added to access the user already has |
| Existing controls | per-tenant key from the ring DEK with domain separation; truncation and padding; forced RLS and no-UPDATE grant; authority re-check at query time and decrypt-time re-verify of the current row; same-transaction purge trigger; tenant flag default off plus platform kill switch; role-category allow-list; 30/300 per minute fail-closed rate limit; per-patient audit with `q` and `cursor` omitted; escrow drill requirement |
| Residual risk | **Moderate, accepted only conditionally; not low.** Leakage is unmeasured, so no number can be quoted. (3) is accepted by decision, not mitigated. Not acceptable until the measured experiment exists and is recorded |
| Owner | to be named by the human privacy officer |
| Review date | earliest of: the experiment result, any change to `T`, tokenizer, role policy or history-window rule, first tenant enablement; 2027-10-13 at the latest |

## Findings against the code (both reviews, merged)

| # | Severity | Finding | Location |
|---|---|---|---|
| F1 | High, blocks shipping redaction (not search) | Redaction hook and `isRedactedOrPending` unwired; everything uses `neverRedacted` | `mount.ts:60`, `register.ts:58`, `index-writer.ts:58`, `ports.ts:45` |
| F2 | Medium | Attributed read audit covers `care_team` with a `subjectId` only | `query-service.ts:422-424` |
| F3 | Medium | `scanCapped` amendment text contradicts the code (5 rounds, 100 channels, all fields from visible rows) | `query-service.ts:16-27`, `:502-508`; ADR amendment |
| F4 | Medium | Head-bucket REFINE is a membership-independent frequency oracle, absent from the amendment | `query-service.ts:477` |
| F5 | Medium | Rotation overlap not implemented; `liveVersions` returns the active version only | `search-key-provider.ts:67` |
| F6 | Medium (blocks enablement per the privacy review) | `addMember` has no role-category check | ADR lines 609-615 |
| F7 | Low | Migration 1091 grants `wardenx_admin` a cross-tenant `SELECT USING (true)` on the token table for the purge-hook definer function | `1091_m36_message_search_index.sql`, policy `message_search_token_purge_hook_select` |
| F8 | Low | Eraser never names the token table; add an explicit live assertion that erase leaves zero token rows | `erasers/messaging-eraser.ts` |
| F9 | Low | ADR calls the 164.528 join the purpose of the audit; internal use is not an accounting item | ADR "Read audit" item 3 |
| F10 | Low | ADR status text is inconsistent (line 3 Accepted, line 27 Proposed); `ci.yml` comments say Proposed | ADR lines 3 and 27 |
| F11 | Low | `pg_stat_statements` capture check soft-passes when the extension is absent | `m36-global-search.live.test.ts:1436` |
| F12 | Medium | One flag is both kill switch and leakage attestation; nothing in code enforces the leakage test | `platform-flag.ts`, `prerequisites.ts` |

**Resolutions (docs and code, implemented in the branch of this PR; the human sign-off above is still pending):**

- **Prefix CHANGE to {3, 5, 8, 12}:** implemented in the branch of this PR (`PREFIX_TAG_LENGTHS` and `prefixTagLengthFor` in `packages/messaging/src/search/global/params.ts`, `indexTagStrings`, `query-terms.ts`); ADR parameter table, golden cases, leakage row and T arithmetic recomputed; unit tests updated. No tag-scheme version exists, so an already-built index would be stale; none exists in production (no tenant enabled), so no migration is needed.
- **F3:** implemented in the branch of this PR: the ADR amendment now states 5 rounds / 100 channels, all fields from visible rows, threshold about 5 x 500 hidden candidates or 100 channels.
- **F4:** implemented in the branch of this PR: the ADR amendment now records the head-bucket REFINE as a second membership-independent frequency-threshold oracle, and timing of up to five hidden rounds as a residual finer oracle.
- **F10:** implemented in the branch of this PR: ADR header and "How to read decisions" text made consistent (Accepted by the user's decision, review requirement not yet satisfied); `ci.yml` comments changed from Proposed to Accepted.

## Conditions before ANY tenant is enabled in production

1. A named human security architect and privacy officer adopt or amend this record (sign-off block above).
2. The leakage experiment is run on a production-shaped corpus for both prefix configurations, the pass criterion ratified beforehand, the result recorded; names and the rare tail meet it.
3. Prefix tags changed to {3, 5, 8, 12} (or measured evidence justifies the full chain); head-bucket statistics re-measured.
4. Separate leakage-attestation platform flag and checklist item added (F12).
5. HIPAA risk-analysis entry filed with owner and date, naming the removed-member gap, prefix and cluster leakage, the message-id-to-channel metadata join, and the threshold oracles (`scanCapped`, head-bucket, timing).
6. `addMember` (and `ensureDmMember`) refuse the three excluded categories (F6); F2 closed or explicitly accepted in the risk analysis with a written statement of what the audit can answer.
7. ADR amendment text corrected (F3, F4) and status text made consistent (F10).
8. Escrow records for `MESSAGING_ENCRYPTION_KEY` and `M34_TENANT_KEK`; the WP 2.13 backfill complete and `hash_verify` clean for the tenant.
9. Valkey-backed rate limiting active in production, with the near-cap probing alert and a two-replica shared-store live test.
10. Logging hygiene evidenced: runbook items run (`log_parameter_max_length_on_error=0`, `auto_explain` parameter logging off), CI capture test fails when `pg_stat_statements` is absent (F11).
11. Rotation documented as "rebuild, search closed" and proven live, including deletion of old-version rows (F5).
12. BAA, DPA and subprocessor documents reviewed; the index added to the data map, backup and retention schedule and breach playbook; written tenant notice of whole-history discoverability sent before a tenant admin enables search, and the enablement screen shows the statement and requires acknowledgement.
13. The product owner accepts the residual risk in writing.

Before ADR-0055 redaction ships: F1 fixed with a ratchet test, and F5 fixed or documented.
Tracked follow-ups, not blockers: F7, F8, bounding the removal gap on the history read path, aligning 2.7a archived-channel behaviour.
