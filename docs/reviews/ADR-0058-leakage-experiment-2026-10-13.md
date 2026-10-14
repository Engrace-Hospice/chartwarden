# ADR-0058 leakage experiment (design review requirement, item 2) - 2026-10-13

Status: **run once on a synthetic corpus; weak evidence only. It does not by itself satisfy the production-enablement leakage test.**
Script: `scripts/m36-global-search-leakage-experiment.ts` (`bun scripts/m36-global-search-leakage-experiment.ts`, about 2.3 minutes,
seed 20261013, byte-identical output on two runs). Raw numbers: re-run with `--json out.json`.

## 1. What was run

**Production code reused, not reimplemented** (`packages/messaging/src/search/global`): `tokenizeForSearch` (NFKC, folding, ID-like rule,
3..40, stop words), `indexTagStrings` (sparse {3,5,8,12} chain), `wholeWordInput` / `prefixInput`, `deriveSearchKey` (HKDF per tenant),
`tagForWord` / `tagForPrefix` (HMAC-SHA256 truncated to `T` bits), `paddedSize` (`N = max(16, 2^ceil(log2 n))`), `tagBitsForDistinctTags`
(the per-tenant sizing rule), `STOP_WORDS`. The index is built in memory with these functions; no DB is needed because they are pure.

**Three deliberate deviations from production, all stated in the script header:**
1. The **dense 3..12 chain** is rebuilt in the script from the production `wholeWordInput` / `prefixInput` (production only ships the sparse set).
2. **Dummies come from the seeded PRNG**, not the CSPRNG, so the run is deterministic. Same law (uniform `T`-bit); the count is the production `paddedSize`.
3. **"Names excluded"** removes the known patient and family name tokens before tagging. Production has no such code; this is the ideal (complete) exclusion.

**Corpus (synthetic, no PHI).** 20,000 messages, 7,000-word Zipf (s = 1.05) vocabulary: the 101 stop words, about 120 hospice care terms, 60
symptoms, about 70 real drug names, then a syllable-generated long tail; 120 shared "topics" (70% of words come from the message's topic);
digits and `5mg` / `7/10` shapes exercise the ID-like rule; 400 synthetic patients (surname, first name, family first name) in per-patient
channels (85% of messages; Zipf patient volume) plus 20 team channels that mention patients. 16,856 distinct tags in the sparse index, so the
sizing rule gives **T = 14** (rows per bucket 87, comparable to the ADR's 153 at 5M messages). The chosen production default **T = 19** is
also run, but at 20k messages it gives only 0.03 tags per bucket and about 3 rows per bucket, i.e. **almost no masking, which is not the
production shape (0.38 tags and 153 rows per bucket at 5M messages)**. Read T = 14 as the like-for-like masking row and T = 19 as the
"what if the tenant is far smaller than T assumes" row.

**Adversary** (database snapshot, no keys, knows the scheme and `T`): per-bucket message counts, per-message bucket sets, message-to-channel
metadata. Auxiliary corpus of the same size built from the same lexicon but **partially mismatched**: lognormal frequency noise (sigma 0.45),
25% of the tail (rank above 300) absent, 1,500 extra words, 30% of each topic's words replaced, and a public name list holding half of the
tenant's names plus 1,500 distractors. Two attacks, best of the two reported: (a) rank-frequency matching of buckets to aux labels (whole words
and all prefix tags); (b) co-occurrence refinement (IKK-style local search over a 1,000-bucket block, window 80, 5 passes). A **control** uses
a "perfect" aux (an independent draw from the tenant's own distribution, names included) to show what the attack can do at best here.

**Recovery definition.** A top-N word counts as recovered when its whole-word bucket is assigned the whole-word label or one of its own
prefix labels whose true frequency is within 25% of the word's (a unique prefix tag is the same message set, so naming it names the word).
Top-N is by document frequency of indexed tokens (post tokenizer, post stop words).

## 2. Pass threshold

**The ADR states none.** The proposal is the one in the AI desk review (`ADR-0058-design-review-2026-10-13.md`, security architect, item 2),
which says a human must ratify it before the run. **It has not been ratified**; it is applied here as proposed:

| # | Criterion |
|---|---|
| C1 | at most 5% of top-500 non-stop-word tokens recovered by the best attack (the reviewer expects the head to fail this; judge on the tail and names, record head recovery as accepted residual under D3) |
| C2 | name recovery not above the random-guess baseline plus 1% |
| C3 | exact length recoverable for no more than 10% of rare words |
| C4 | at most 1% of typical clinical single-term queries ending in `refine` |

C1 is also reported on the tail (ranks 500-2000, "C1-tail"). C4 needs the production-shaped 5M-message corpus and was **not evaluated**.

## 3. Results

Production config (sparse {3,5,8,12}, dummies on, names indexed), mismatched aux, best of rank/refine; control in the last column.

| T | top-50 | top-100 | top-500 | tail 500-2000 | name, blind (baseline) | name, with channel linkage (baseline) | exact length of rare words (modal-guess baseline) | control top-50 / top-500 |
|---|---|---|---|---|---|---|---|---|
| 14 (sizing rule) | 6.0% | 4.0% | 1.4% | 0.0% | 0.0% (0.1%) | **92.6%** (1.0%) | 15.9% (14.6%) | 8% / 1.4% |
| 19 (ADR default) | 6.0% | 4.0% | 1.0% | 0.0% | 0.0% (0.1%) | **93.4%** (1.2%) | 24.2% (14.6%) | 16% / 2.6% |

Variants at T = 14, mismatched aux, refine attack (top-50 / top-100 / top-500 | exact length | linked name):

| prefix | dummies | names | top-50 | top-100 | top-500 | exact length | linked name | rows/bucket |
|---|---|---|---|---|---|---|---|---|
| sparse | yes | indexed | 6% | 4% | 1.2% | 15.9% | 92.6% | 87 |
| sparse | yes | excluded | 6% | 3% | 0.6% | 13.1% | n/a (not indexed) | 84 |
| sparse | no | indexed | 6% | 4% | 1.0% | 18.6% | 92.6% | 61 |
| dense | yes | indexed | 8% | 4% | 0.8% | 14.8% | 92.3% | 171 |
| dense | yes | excluded | 8% | 4% | 0.8% | 13.8% | n/a | 166 |
| dense | no | indexed | 8% | 4% | 1.0% | 16.9% | 94.9% | 119 |

At T = 19 the same grid reads sparse 6/3/0.8, dense 6/5/1.0 (top-50/100/500); with perfect aux, dense reaches 22/13/3.0 versus sparse 16/8/2.6;
dense without dummies 24/13/3.4. The full 64-row table is the script's stdout.

Verdict by criterion (production config):

| Criterion | T = 14 | T = 19 |
|---|---|---|
| C1 top-500 <= 5% | PASS (1.4%) | PASS (1.0%; control 2.6%) |
| C1-tail <= 5% | PASS (0.0%) | PASS (0.0%) |
| C2 blind name recovery <= baseline + 1% | PASS (0.0%) | PASS (0.0%) |
| C2 name recovery **with per-patient channel linkage** <= baseline + 1% | **FAIL (92.6% vs 1.0%)** | **FAIL (93.4% vs 1.2%)** |
| C3 exact length <= 10% | FAIL (15.9%) but the guess-the-mode baseline is already 14.6%: advantage 1.3 points | FAIL (24.2%, advantage 9.6 points) |
| C4 | not evaluated | not evaluated |

## 4. Findings

1. **Frequency / co-occurrence recovery of vocabulary is low** under this adversary: at most 8% of the top-50, under 3% of the top-500, about
   0% of the tail, at either T and either prefix set. This is a statement about this attack on this corpus, not a bound (section 5).
2. **Sparse versus dense is not separated by this experiment.** Differences in top-N recovery (a few points; one word is 2 points of top-50)
   are inside the noise of a single seed and corpus. The only visible tendency is that without dummies and with perfect aux the dense chain
   recovers somewhat more (24/13/3.4 versus 14/7/2.2 at T = 19). Exact-length recovery of rare words: sparse 15.9% / dense 14.8% at T = 14,
   24.2% / 25.2% at T = 19, so the length leak of the dense chain did not show up with this simple chain-size classifier; it is not shown to be absent.
3. **Dummies do little to recovery here** (top-N unchanged within noise) but reduce exact-length recovery (sparse T = 14: 18.6% to 15.9%).
   The synthetic scale understates dummy noise per bucket only if rows per bucket are lower than production's; at T = 14 they are about 87 against 153.
4. **Excluding patient names does not change vocabulary recovery** (names are rare tokens) and the blind name attack already sits at the random baseline with names indexed.
5. **The one clear failure is patient-name identification with channel linkage.** Given the message-to-channel-to-patient join, the surname's
   bucket is the top concentration-lift bucket of that patient's channel for **about 93% of patients, at both T, with or without dummies, with either prefix set.**
   `T` and dummies do not defend against it, because the signal is "this tag is in 30% of this channel and rare elsewhere", not a global frequency.
   What the attacker gains is the bucket of a name he already holds (he can then find every other message that mentions that patient), not a
   decryption. Only name exclusion (or the bounded multi-channel option A) removes it. This supports the privacy officer's rule
   "above threshold, exclusion becomes mandatory before enablement" **as the experiment is written; it is not a decision**.

## 5. Limits of the synthetic corpus and the attack (read before relying on any number)

- **The attack is weak even with perfect auxiliary data**: the control recovers only 8-24% of the top-50. The corpus is largely bag-of-words with
  topic mixing; real clinical text has much stronger word association, and real adversaries use far better matchers (annealing, count
  attack, query-aware attacks with known queries). **The recovery numbers are a lower bound on a real adversary and the C1 PASS is weak evidence.**
- Zipf vocabulary and syllable-built tail words are not language: real prefix sharing (`pre-`, `con-`, drug stems) is heavier and would
  enlarge shared-prefix clusters and divergence leakage; the real distinct-tag count `D` and rows per bucket are unmeasured.
- 20,000 messages, not about 5e6. Rows per bucket match the ADR only at T = 14; the ADR's T = 19 arithmetic (0.38 tags per bucket) is not reproduced at this size.
- Single seed, single corpus, no confidence intervals. Differences of 1-3 points are noise.
- Patient names are inserted at assumed rates (30% of a patient's channel mentions the surname); family names, nicknames, misspellings, and
  staff names are not modelled; "excluded" is ideal exclusion.
- The length attack is a simple containment-chain-size classifier calibrated on aux; a better one could do more. Its baseline (always guess the mode) is already 13-15%, so C3 as written ("at most 10%") cannot pass; **the criterion should be restated as advantage over the modal baseline** before use.
- Not covered: access-pattern attacks on live queries, the two membership-independent threshold oracles, timing, key-rotation overlap, and C4.
- The pass criteria are the AI desk review's proposal, unratified.

## 6. Does it satisfy the enablement test?

**No.** It is a first measurement that makes the review's "NOT RUN" into "run once, synthetic, weak adversary." Before the
`messaging.global_search_leakage_attested` flag is set, a human should: ratify the criteria (and fix C3), run on a production-shaped corpus
(5e6 messages, real tenant text de-identified, or a much larger synthetic one) with a stronger attack and several seeds, evaluate C4, and decide
what to do about the channel-linkage name result (it fails regardless of `T`). The script runs unchanged with `--messages N --seed S`; the
production tokenizer and tag code were runnable standalone because they are pure functions with no I/O.
