# 02 — Scoring method

Part of the [risk analysis pack](./README.md) for CW-RA-01. **Draft: unreviewed, unsigned.**

This is a **proposed** method. The scales, bands and the control-credit rule in §4 are engineering's starting point; every one
is a decision for the accountable owner (§8, D1–D9). No risk in this pack has been scored. The Architecture's Module 30
description asks for "severity × likelihood scoring, remediation owner, target date, status"; this method is that, with the
scales written down so two reviewers reach the same number.

## 1. What is scored

A **risk** (`R-…`, file 04) is one threat (`T-…`) acting on one or more assets (`A-…`) through one or more known
vulnerabilities (`V-…`), with the controls (`CW-…` register rows, ADRs) that bear on it. Each risk gets an inherent and a
residual score. An **asset** is then rolled up from the risks that name it (§5). HIPAA §164.308(a)(1)(ii)(A) asks for an
assessment of risks and vulnerabilities to ePHI; the register row asks for "likelihood x impact per asset".

Horizon: the next 12 months, at the state of the repository and the register on the review date.

## 2. Likelihood (L)

Anchored on how many independent barriers stand between the threat and the harm, and how well each is evidenced. The
anchors use the register's own evidence vocabulary so a reviewer can check them without guessing a probability.

| L | Name | Anchor |
|---|---|---|
| 1 | Rare | Several independent barriers would have to fail together, and each has automated evidence (a CI gate or a live suite). No known path |
| 2 | Unlikely | One barrier would have to fail, and it has automated evidence |
| 3 | Possible | The only barrier depends on configuration, a person, or non-live tests; or the exposure reaches only an authenticated insider |
| 4 | Likely | The barrier is absent, is an owner statement with no repository evidence, or the exposure is reachable by any authenticated user, or by anything that can reach a host or an internal network |
| 5 | Almost certain | The event is known to occur, or nothing stands in the way and the actor has both means and reason |

## 3. Impact (I)

The worst plausible outcome for the asset, judged on confidentiality, integrity and availability together. Thresholds in the
anchors are proposals (D2).

| I | Name | Anchor |
|---|---|---|
| 1 | Negligible | No PHI. No clinical or billing effect. Fixed in routine operations |
| 2 | Minor | PHI of one individual, or internal data, with limited exposure; or a delay to non-clinical work |
| 3 | Moderate | PHI of a few individuals in one tenant, or PHI-Sensitive content (42 CFR Part 2, HIV, mental health, abuse) of one individual; or a Tier 3 or 4 service (DR/BCP §3.1) down beyond its RTO |
| 4 | Major | PHI of many individuals or most of one tenant; PHI-Sensitive content of more than one individual; a clinical or claim record wrong in a way that must be corrected and re-issued; a Tier 1 or 2 service down beyond its RTO |
| 5 | Severe | Cross-tenant PHI exposure; loss of key material that protects more than one tenant; ePHI lost with no restore; a patient-safety event from unavailable or wrong clinical data; an event that would need breach notification across tenants (counsel decides what is reportable: §164.400–414) |

## 4. Score, bands and control credit

**Score = L × I.** Possible products are 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 20, 25.

| Band | Score | Default response |
|---|---|---|
| Low | 1–4 | Accept with a note, review at the next annual cycle |
| Moderate | 5–9 | Treatment plan with an owner and target date, or accept with a stated reason |
| High | 10–16 | Treatment plan required; acceptance only by both roles in §6 |
| Critical | 20–25 | Treatment plan required before real patient data (issue #1134 is Tier 2: "before any real patient data"); acceptance only by both roles in §6 |

**Inherent** L and I: the threat acting with none of the controls cited on the risk. Architecture-wide baselines that no
reviewer would remove (authentication exists, the database enforces RLS) are not credited at this step; list them on the row.

**Residual** L and I: with the cited controls as the register records them. Control credit is limited by the weakest cited
row, and by what the evidence is, so a score cannot drift below what the repository proves:

| Weakest cited register row | Maximum drop of L from inherent to residual |
|---|---|
| Every cited row `implemented` with automated evidence | 2 steps |
| Any cited row `partial` | 1 step |
| Any cited row `gap`; or no register row covers a vulnerability listed on the risk; or the evidence for a cited control is an **owner statement** only, or no register row proves the control the risk's note names | 0 steps |

I may be reduced only where a control bounds the blast radius (per-tenant sealing, a scoped object-store key), and the row
must say which. An ADR is a decision, not evidence that a control works; it earns credit only through the register row or
test that proves it.

The owner may override a cap with a written reason on the row (D3). An override is a decision, not a correction.

## 5. Asset roll-up

An asset's residual score is the **highest** residual score among the risks that name it, and the risk id stays beside it.
File 04 §2 lists the risks per asset; the owner computes the score. Combining several moderate risks into one higher one is the
owner's judgment and is recorded as an override.

## 6. Treatment and acceptance

| Treatment | Meaning |
|---|---|
| Mitigate | A change that lowers L or I. The row names the work item (issue, ADR or register `gap`), an owner role, a target date, a status (open, in progress, closed) and the evidence that closes it: a register row at `implemented`, a gate or a live suite |
| Accept | The residual score stays. The row records the reason, the accepting role, and a review date (not later than the register's 180-day rule for a `partial` row) |
| Transfer | Insurance or a contract term. Recorded with the instrument; the risk does not leave the register |
| Avoid | The feature or the data flow is not used. Recorded with the switch that keeps it off (for example `RUST_ROUTES` empty, the AI BAA flag) |

Proposed acceptance authority (D5): a Moderate or Low residual risk is accepted by the Security Owner role; a High or Critical
one is accepted only when both the Security Owner and the Compliance Officer roles sign (Hardening §2.2: "Security
Owner + Compliance" decide new PHI integrations). §164.308(a)(1)(ii)(B) is risk management: reduce risks to a reasonable and
appropriate level. The pack records the decision and does not make it.

## 7. How to fill a row of file 04

1. Read the cited register rows at their current status. Note any whose owner, `review_by` or status changed since the commit
   in the README's Basis.
2. Score inherent L and I against §2 and §3. Write the one-line reason in the notes cell.
3. Apply §4 to get the residual L, and the residual I with the reason.
4. Choose a treatment (§6). A mitigation names a register `gap` or an issue; do not invent a new control id.
5. Record owner role, target date and status. Leave a cell blank rather than guess.
6. After a change, add a dated line to the change log on [`05-sign-off.md`](./05-sign-off.md).

## 8. Decisions that belong to the owner

None of these is made by this pack.

| # | Decision |
|---|---|
| D1 | Scope: the as-shipped single-host stack, the items tagged target, and the out-of-scope list in the README |
| D2 | The scales, anchors and band thresholds in §2–§4 (or a replacement, for example the HHS SRA Tool's) |
| D3 | The control-credit rule and any override |
| D4 | Every inherent and residual L and I in file 04, and the asset roll-up |
| D5 | Treatment per risk and who may accept which band |
| D6 | Which items in the README's "Not evidenced in this repository" and "Weaknesses no register row assesses" become register entries, and who assesses them |
| D7 | Whether an external assessor performs the analysis (Ops Runbook §12.1 assumes one) and whether this pack is their input |
| D8 | Who reviews independently: Hardening §2.1 names one interim owner for all four security governance roles |
| D9 | The review cadence and the date by which a signed copy is filed (§164.316(b)(2): six years) |
