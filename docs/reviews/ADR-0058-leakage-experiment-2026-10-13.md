# ADR-0058 leakage experiment (design review requirement, item 2) - 2026-10-13

Status: **run once on a synthetic corpus; weak evidence only. It does not by itself satisfy the production-enablement leakage test.** Section 7 records the
re-run after the product owner's decisions (names excluded, per-channel keys); sections 1 to 6 are the original run and describe the single-global-key scheme, which is superseded.
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

## 7. Re-run after the product-owner decisions (2026-10-13): names excluded, per-channel keys

Decisions that followed finding 5 above (see the ADR amendment "name exclusion and per-channel keys"): patient and contact names are not indexed, and tags are
keyed per channel. The script (`scripts/m36-global-search-leakage-experiment.ts`, same seed 20261013, 20,000 messages, about 2.6 minutes) changed as follows.

- **"Names excluded" now runs the production path.** The tenant's name tokens (every patient's surname, first name and family name) are tokenised with the production
  tokenizer, replaced by `nameTokenDigest` (keyed HMAC digests), wrapped in `digestExclusion`, and applied inside `tokenizeForSearch(text, excluded)`, the very call
  the index writer makes. The earlier registry filter is gone for the tenant corpus (the adversary's own auxiliary corpus still drops names by registry: the adversary
  knows the scheme).
- **The sizing rule is the new one** (`tagBitsForTotalRows`, security review H2): the corpus stores 1,423,136 padded rows, so the rule gives **T = 13** (the
  earlier distinct-tag rule gave 14). T = 19 is still run.
- **A per-channel-key section** (`PER-CHANNEL KEYS (production scheme)`) builds the index with `deriveChannelKey` per patient channel. There is then no cross-channel
  baseline (the same word is an unrelated bucket in every channel), so the concentration-lift attack of finding 5 cannot be run. The strongest simple attack left to an
  adversary who holds the channel-to-patient link is the raw in-channel message frequency of a bucket; the section reports whether the surname's bucket is the channel's
  top bucket (top-1), within its top three, and whether any of the surname's tags occur in at least 3 messages of the channel ("present").
- The global-key vocabulary grid (rank and co-occurrence attacks, length leak) is unchanged in method and is kept only to compare with section 3. **It does not apply to
  per-channel keys and no vocabulary attack was run against them** (a per-channel version would need per-channel aggregation and much smaller samples; it is the first thing
  to measure on a production-shaped corpus).

### 7.1 Channel-linked name recovery (the number the decision turned on)

Global key (superseded scheme; mismatched auxiliary data; sparse prefixes; dummies on; best of rank/refine; baseline = random guess among the channel's candidate buckets):

| T | names indexed | names excluded (production path) |
|---|---|---|
| 13 (sizing rule) | **93.0%** (baseline 0.8%) | **0.0%** (baseline 0.9%) |
| 19 | **93.4%** (baseline 1.2%) | **0.0%** (baseline 1.3%) |

Per-channel keys (production scheme; 272 patients with at least 20 messages; raw in-channel frequency attack; baseline 1 / candidate buckets):

| T | names | top-1 (baseline) | surname bucket in top 3 | surname tags present in at least 3 messages of the channel |
|---|---|---|---|---|
| 13 | indexed | 3.3% (0.9%) | 8.1% | 99.6% |
| 13 | excluded | **0.0%** (1.0%) | 0.0% | 16.5% |
| 19 | indexed | 2.6% (1.2%) | 7.0% | 99.6% |
| 19 | excluded | **0.0%** (1.3%) | 0.0% | 8.8% |

The "present" column with names excluded is not leakage of the name: it counts buckets of the surname's tag set that hold at least 3 messages by chance (dummies and
collisions at 2^13 or 2^19 buckets, plus a prefix tag shared with another word). **Reading:** the 93% result is closed twice over. Excluding names takes the global-key attack from
93% to 0.0%; per-channel keys alone take the strongest attack that remains from 93% to 3.3% top-1 (still 3.7x the random baseline, and 8.1% within the top three).

### 7.2 What the vocabulary rows say now (global key only)

Mismatched auxiliary data, sparse prefixes, dummies on: top-50 / top-100 / top-500 recovery 4.0% / 2.0% / 0.4% at T = 13 and 6.0% / 3.0-4.0% / 1.0-1.2% at T = 19, tail 0.0%, and the
same with names excluded. With perfect auxiliary data (control) top-500 is 1.4% at T = 13 and 2.6% at T = 19. Exact word-length recovery of rare words is 14.4% at T = 13 (modal-guess
baseline 14.6%) and 24.2% at T = 19 (baseline 14.6%, advantage 9.6 points; unchanged by exclusion). Criteria C1 and C2 (blind) pass as before; C3 as written still cannot pass and
should be restated as advantage over the modal baseline.

### 7.3 Verdict on the proposed criteria

| Criterion | Production configuration (names excluded, per-channel keys) | Note |
|---|---|---|
| C1 top-500 and tail | not measured against per-channel keys | global-key figures above are for the superseded scheme |
| C2 name recovery with channel linkage <= baseline + 1% | **PASS** on this corpus (0.0% against 1.0% and 1.3%) | requires the names to be in M5; unrecorded names, nicknames and staff names are not covered |
| C3 exact length | not measured against per-channel keys; global key: FAIL at T = 19 (advantage 9.6 points) | restate as advantage over baseline |
| C4 refine rate | not evaluated | needs the 5 x 10^6-message corpus |

### 7.4 Limits (in addition to section 5)

- Single seed, one 20,000-message corpus, no confidence intervals; the per-channel section has 272 patients, so one patient is 0.4 points.
- "Excluded" assumes the exclusion set is complete for the surname, first name and family name tokens. Real data has nicknames, misspellings, a name split by a digit or a space,
  staff names and place names, none of which are modelled; production recall of the exclusion equals the completeness of M5's name data.
- The per-channel raw-frequency attack is simple. A stronger one (an auxiliary model of expected in-channel frequencies per clinical word, annealing across a channel's buckets) was not
  tried; the 3.3% / 8.1% figures are a lower bound on what an adversary with the channel link can do when names are NOT excluded.
- Determinism: two consecutive `--quick --T 13` runs after the change are byte-identical (`cmp`); the full-run figures above were produced once (`bun scripts/m36-global-search-leakage-experiment.ts`, 158 s).
