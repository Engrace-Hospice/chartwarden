// ADR-0058 "Design review requirement" item 2: measured leakage experiment for the M36 global blind-token index.
// Run: bun scripts/m36-global-search-leakage-experiment.ts [--messages 30000] [--seed 20261013] [--json out.json] [--quick]
// Pure: no DB. REUSES the production tokenizer, key derivation, HMAC tag functions and padding size rule from
// packages/messaging/src/search/global. The ONLY non-production pieces are (a) the dense 3..12 prefix chain (the production
// constant is the sparse set, so the dense variant is rebuilt from the production wholeWordInput/prefixInput), (b) dummies are
// drawn from the seeded PRNG instead of the CSPRNG so the run is deterministic (same distribution: uniform T-bit values; the
// count comes from the production paddedSize). 2026-10-13 (product-owner decisions): "names excluded" now runs the PRODUCTION path
// (`digestExclusion` over `nameTokenDigest`s of every patient / family name token, applied INSIDE `tokenizeForSearch`, exactly as the
// writer does), and the per-channel-key scheme (`deriveChannelKey`) is measured for the channel-linked name attack ("--channel-keys").
// The vocabulary attacks (rank / co-occurrence over one global bucket space) only exist for a single global key; they are kept for
// comparability with the 2026-10-13 run and labelled "global key (superseded scheme)".
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  CANDIDATE_CAP,
  DEFAULT_TAG_BITS,
  PREFIX_TAG_LENGTHS,
  STOP_WORDS,
  deriveChannelKey,
  deriveSearchKey,
  digestExclusion,
  indexTagStrings,
  nameTokenDigest,
  padTags,
  paddedSize,
  prefixInput,
  tagBitsForTotalRows,
  tagForPrefix,
  tagForWord,
  tokenizeForSearch,
  wholeWordInput,
} from "../packages/messaging/src/search/global";

// ---------------------------------------------------------------- args / rng
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : fallback;
};
const QUICK = argv.includes("--quick");
const MESSAGES = Number(arg("messages", QUICK ? "6000" : "20000"));
const SEED = Number(arg("seed", "20261013"));
const K_REFINE = QUICK ? 600 : 1000;
const REFINE_ITERS = QUICK ? 3 : 5;
const REFINE_WINDOW = 80;
const TOP_NS = [50, 100, 500] as const;

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: Rng): number =>
  Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const shuffle = <T>(xs: readonly T[], r: Rng): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

// ---------------------------------------------------------------- synthetic corpus (no PHI)
const DRUGS =
  `morphine hydromorphone fentanyl oxycodone lorazepam haloperidol midazolam methadone ketamine glycopyrrolate scopolamine atropine
hyoscyamine dexamethasone prednisone ondansetron metoclopramide prochlorperazine olanzapine quetiapine risperidone senna docusate bisacodyl
polyethylene lactulose acetaminophen ibuprofen gabapentin pregabalin amitriptyline duloxetine sertraline mirtazapine trazodone zolpidem
temazepam diazepam clonazepam phenobarbital levetiracetam furosemide spironolactone metoprolol lisinopril amlodipine warfarin apixaban
insulin metformin levothyroxine omeprazole pantoprazole famotidine nystatin fluconazole ciprofloxacin amoxicillin tramadol codeine
buprenorphine naloxone baclofen tizanidine cyclobenzaprine donepezil memantine carbidopa levodopa albuterol ipratropium budesonide`.split(
    /\s+/,
  );
const SYMPTOMS =
  `pain nausea vomiting dyspnea agitation restlessness delirium confusion anxiety insomnia constipation diarrhea dysphagia cough
secretions rattle edema ascites cachexia anorexia fatigue weakness lethargy somnolence mottling cyanosis apnea tachycardia bradycardia
hypotension fever chills diaphoresis pruritus mucositis xerostomia thrush pressure ulcer wound bleeding seizure myoclonus tremor
dehydration hiccups depression grief fear dyspnoea cheyne stokes unresponsive obtunded combative tearful calm comfortable peaceful`.split(
    /\s+/,
  );
const CARE =
  `patient family daughter son wife husband spouse caregiver nurse aide chaplain social worker volunteer hospice visit assessed reports
states denies tolerating taking refusing declined sleeping resting repositioned turned bathed fed oral care mouth swabs oxygen concentrator
nasal cannula bed hospital mattress commode walker wheelchair equipment delivered ordered refill pharmacy physician medical director
orders received called notified updated educated reviewed discussed plan goals comfort measures prognosis decline transition imminent
bereavement support respite admission recertification face encounter intake discharge transfer facility home appointment scheduled
medication schedule dose increased decreased titrated PRN scheduled routine breakthrough effective ineffective relief rating scale
diagnosis cancer dementia COPD heart failure renal liver stroke Parkinson sepsis pneumonia metastatic terminal advanced stage`
    .split(/\s+/)
    .map((w) => w.toLowerCase());
const SYLLABLES =
  `ca ro li ma ten ter con pre pro dis in re ex sta ni mo ra pa do vi lu ne ti sa be fo gu hy pe tri an al el or ur ic ox
ph th ch sh zy qui sco pla ble cro dra glo ste`.split(/\s+/);
const NAME_SYLLABLES =
  `mar bren da co lin an ge la vo sku ij len ro ber ta mon ti sa ha ri ko bel ni wen del fer gus tav hol man zur yan pel
dro ven kar sim yo eli nor wes sul`.split(/\s+/);

function pseudoWord(r: Rng, syl: readonly string[], minS: number, maxS: number): string {
  const n = minS + Math.floor(r() * (maxS - minS + 1));
  let w = "";
  for (let i = 0; i < n; i += 1) w += syl[Math.floor(syl.length * r() * r())] as string; // skew -> shared prefixes
  return w;
}

interface Lexicon {
  readonly ranked: readonly string[]; // rank 0 = most frequent
  readonly nameRegistry: ReadonlySet<string>;
  readonly patients: ReadonlyArray<{ surname: string; first: string; family: string }>;
  readonly topics: readonly (readonly number[])[]; // shared domain structure (word-rank sets that co-occur)
}

function buildLexicon(r: Rng, vocab: number, patientCount: number): Lexicon {
  const func = [...STOP_WORDS];
  const head = shuffle([...func, ...CARE.slice(0, 80), ...SYMPTOMS.slice(0, 40)], r);
  const mid = shuffle([...DRUGS, ...SYMPTOMS.slice(40), ...CARE.slice(80)], r);
  const seen = new Set<string>([...head, ...mid]);
  const tail: string[] = [];
  while (head.length + mid.length + tail.length < vocab) {
    const w = pseudoWord(r, SYLLABLES, 2, 5);
    if (w.length >= 3 && !seen.has(w)) {
      seen.add(w);
      tail.push(w);
    }
  }
  const names = new Set<string>();
  const mk = (): string => {
    for (;;) {
      const n = pseudoWord(r, NAME_SYLLABLES, 2, 3);
      if (!seen.has(n) && !names.has(n)) {
        names.add(n);
        return n;
      }
    }
  };
  const patients = Array.from({ length: patientCount }, () => ({
    surname: mk(),
    first: mk(),
    family: mk(),
  }));
  const topics = Array.from({ length: 40 }, () =>
    Array.from({ length: 60 }, () => 20 + Math.floor(2500 * r() * r())),
  );
  return { ranked: [...head, ...mid, ...tail], nameRegistry: names, patients, topics };
}

const zipfCdf = (weights: readonly number[]): Float64Array => {
  const c = new Float64Array(weights.length);
  let s = 0;
  weights.forEach((w, i) => {
    s += w;
    c[i] = s;
  });
  return c.map((x) => x / s);
};
const draw = (cdf: Float64Array, r: Rng): number => {
  let lo = 0;
  let hi = cdf.length - 1;
  const u = r();
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cdf[mid] as number) < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

interface Msg {
  readonly channel: number; // patient index, or >= patients.length for team channels
  readonly text: string;
}
interface Corpus {
  readonly messages: Msg[];
  readonly lexicon: Lexicon;
}

interface GenOptions {
  readonly count: number;
  readonly auxMode: boolean; // aux = public text: perturbed frequencies, shifted topics, dropped tail, no tenant structure
  readonly auxNames?: readonly string[];
}

function generate(lexicon: Lexicon, seed: number, opt: GenOptions): Corpus {
  const r = mulberry32(seed);
  const V = lexicon.ranked.length;
  const words = [...lexicon.ranked];
  let weights = words.map((_, i) => 1 / (i + 1) ** 1.05);
  if (opt.auxMode) {
    // mismatch: lognormal weight noise (rank shuffles), 25% of the tail absent, extra aux-only words appended
    weights = weights.map((w, i) => (i > 300 && r() < 0.25 ? 0 : w * Math.exp(0.45 * gauss(r))));
    for (let i = 0; i < 1500; i += 1) {
      words.push(pseudoWord(r, SYLLABLES, 3, 6));
      weights.push(1 / (V + i + 1) ** 1.05);
    }
  }
  const cdf = zipfCdf(weights);
  // aux shares the domain's topic structure but only partly: 30% of each topic's words are replaced
  const topics = opt.auxMode
    ? lexicon.topics.map((t) => t.map((w) => (r() < 0.3 ? 20 + Math.floor(2500 * r() * r()) : w)))
    : lexicon.topics;
  const patientCdf = zipfCdf(lexicon.patients.map((_, i) => 1 / (i + 1) ** 0.7));
  const auxNameCdf = opt.auxNames ? zipfCdf(opt.auxNames.map((_, i) => 1 / (i + 1) ** 0.7)) : null;
  const titled = (w: string): string => w[0]?.toUpperCase() + w.slice(1);
  const messages: Msg[] = [];
  for (let m = 0; m < opt.count; m += 1) {
    const topic = topics[Math.floor(r() * topics.length)] as number[];
    const len = Math.max(4, Math.round(Math.exp(2.8 + 0.5 * gauss(r))));
    const parts: string[] = [];
    for (let i = 0; i < len; i += 1) {
      const idx = r() < 0.7 ? (topic[Math.floor(r() * topic.length)] as number) : draw(cdf, r);
      parts.push(words[idx] as string);
      if (r() < 0.04) parts.push(String(1 + Math.floor(r() * 10)) + (r() < 0.5 ? "mg" : "/10")); // digits: exercise ID-like rules
    }
    let channel = -1;
    if (opt.auxMode) {
      if (auxNameCdf && r() < 0.3)
        parts.push(titled((opt.auxNames as string[])[draw(auxNameCdf, r)] as string));
    } else if (r() < 0.85) {
      channel = draw(patientCdf, r);
      const p = lexicon.patients[channel] as Lexicon["patients"][number];
      if (r() < 0.3) parts.splice(Math.floor(r() * parts.length), 0, titled(p.surname));
      if (r() < 0.12) parts.splice(Math.floor(r() * parts.length), 0, titled(p.family));
      if (r() < 0.1) parts.splice(Math.floor(r() * parts.length), 0, titled(p.first));
    } else {
      channel = lexicon.patients.length + Math.floor(r() * 20);
      if (r() < 0.4)
        parts.push(
          titled((lexicon.patients[draw(patientCdf, r)] as Lexicon["patients"][number]).surname),
        );
    }
    messages.push({ channel, text: parts.join(" ") });
  }
  return { messages, lexicon };
}

// ---------------------------------------------------------------- index build with production code
type Scheme = "sparse" | "dense";
const DENSE_MAX = 12;
const MIN_PREFIX = 3;

/** Label keys `w:token` / `p:prefix`. Sparse delegates to production indexTagStrings; dense is rebuilt from the production inputs. */
function labelKeys(tokens: readonly string[], scheme: Scheme): string[] {
  if (scheme === "sparse") {
    return indexTagStrings(tokens).map((s) =>
      s.startsWith("w\u0000") ? `w:${s.slice(2)}` : `p:${s.split("\u0000")[2]}`,
    );
  }
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(`w:${t}`);
    const chars = [...t];
    for (let l = MIN_PREFIX; l <= Math.min(chars.length, DENSE_MAX); l += 1)
      out.add(`p:${chars.slice(0, l).join("")}`);
  }
  return [...out];
}

const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

interface Index {
  readonly tagBits: number;
  readonly msgBuckets: Int32Array[]; // distinct buckets per message (real + dummy)
  readonly counts: Int32Array; // messages per bucket
  readonly key: Buffer;
  readonly tagOf: (label: string) => number;
  readonly distinctReal: number;
}

function buildIndex(
  tokens: readonly (readonly string[])[],
  scheme: Scheme,
  tagBits: number,
  dummies: boolean,
  seed: number,
  tenantTag: string,
): Index {
  const key = deriveSearchKey(sha(`${seed}:${tenantTag}:dek`), `org-${tenantTag}`, "v1"); // random per-tenant key (seeded)
  const memo = new Map<string, number>();
  const tagOf = (label: string): number => {
    let t = memo.get(label);
    if (t === undefined) {
      t = label.startsWith("w:")
        ? tagForWord(key, label.slice(2), tagBits)
        : tagForPrefix(key, label.slice(2), tagBits);
      memo.set(label, t);
    }
    return t;
  };
  const r = mulberry32(seed ^ 0x9e3779b9);
  const counts = new Int32Array(2 ** tagBits);
  const msgBuckets: Int32Array[] = [];
  for (const toks of tokens) {
    const real = labelKeys(toks, scheme).map(tagOf);
    const rows = [...real];
    if (dummies)
      for (let n = paddedSize(real.length) - real.length; n > 0; n -= 1)
        rows.push(Math.floor(r() * 2 ** tagBits));
    const distinct = Int32Array.from(new Set(rows));
    for (const b of distinct) counts[b] = (counts[b] as number) + 1;
    msgBuckets.push(distinct);
  }
  return { tagBits, msgBuckets, counts, key, tagOf, distinctReal: memo.size };
}

// ---------------------------------------------------------------- adversary
interface AuxModel {
  readonly labels: string[]; // by aux df desc
  readonly df: Map<string, number>;
  readonly messages: string[][]; // label keys per message
}
function auxModel(tokens: readonly (readonly string[])[], scheme: Scheme): AuxModel {
  const df = new Map<string, number>();
  const messages = tokens.map((t) => labelKeys(t, scheme));
  for (const m of messages) for (const l of m) df.set(l, (df.get(l) ?? 0) + 1);
  const labels = [...df.keys()].sort(
    (a, b) => (df.get(b) as number) - (df.get(a) as number) || (a < b ? -1 : 1),
  );
  return { labels, df, messages };
}

/** Rank-frequency matching: i-th most frequent observed bucket -> i-th most frequent aux label. */
function rankAttack(idx: Index, aux: AuxModel): { buckets: number[]; assign: Map<number, string> } {
  const buckets: number[] = [];
  for (let b = 0; b < idx.counts.length; b += 1) if ((idx.counts[b] as number) > 0) buckets.push(b);
  buckets.sort((a, b) => (idx.counts[b] as number) - (idx.counts[a] as number) || a - b);
  const assign = new Map<number, string>();
  for (let i = 0; i < Math.min(buckets.length, aux.labels.length); i += 1)
    assign.set(buckets[i] as number, aux.labels[i] as string);
  return { buckets, assign };
}

/** Co-occurrence refinement (IKK/count-attack style): local search on the top-K block, seeded by the rank match. */
function refineAttack(
  idx: Index,
  aux: AuxModel,
  base: { buckets: number[]; assign: Map<number, string> },
): Map<number, string> {
  const K = Math.min(K_REFINE, base.buckets.length, aux.labels.length);
  const N = idx.msgBuckets.length;
  const obsPos = new Map<number, number>();
  base.buckets.slice(0, K).forEach((b, i) => obsPos.set(b, i));
  const auxPos = new Map<string, number>();
  aux.labels.slice(0, K).forEach((l, i) => auxPos.set(l, i));
  const cObs = new Float32Array(K * K);
  const cAux = new Float32Array(K * K);
  const fill = (rows: number[][], mat: Float32Array): void => {
    for (const row of rows) {
      for (const a of row) for (const b of row) mat[a * K + b] = (mat[a * K + b] as number) + 1 / N;
    }
  };
  fill(
    idx.msgBuckets.map((m) => [...m].map((b) => obsPos.get(b) ?? -1).filter((x) => x >= 0)),
    cObs,
  );
  fill(
    aux.messages.map((m) => m.map((l) => auxPos.get(l) ?? -1).filter((x) => x >= 0)),
    cAux,
  );
  const pi = Int32Array.from({ length: K }, (_, i) => i); // observed i -> aux label pi[i]
  const inv = Int32Array.from(pi);
  const freqWeight = K * 0.25;
  const cost = (i: number, j: number): number => {
    let s = 0;
    const oi = i * K;
    const aj = j * K;
    for (let k = 0; k < K; k += 1) {
      if (k === i) continue;
      const d = (cObs[oi + k] as number) - (cAux[aj + (pi[k] as number)] as number);
      s += d * d;
    }
    const f = (cObs[oi + i] as number) - (cAux[aj + j] as number);
    return s + freqWeight * f * f;
  };
  const r = mulberry32(SEED ^ 0xabcdef);
  let swapsTried = 0;
  let swapsDone = 0;
  for (let it = 0; it < REFINE_ITERS; it += 1) {
    for (const i of shuffle(
      Array.from({ length: K }, (_, x) => x),
      r,
    )) {
      const cur = pi[i] as number;
      let best = cur;
      let bestCost = cost(i, cur);
      for (
        let j = Math.max(0, i - REFINE_WINDOW);
        j <= Math.min(K - 1, i + REFINE_WINDOW);
        j += 1
      ) {
        if (j === cur) continue;
        const c = cost(i, j);
        if (c < bestCost) {
          bestCost = c;
          best = j;
        }
      }
      if (best === cur) continue;
      swapsTried += 1;
      const k = inv[best] as number;
      if (cost(i, best) + cost(k, cur) < cost(i, cur) + cost(k, best)) {
        swapsDone += 1;
        pi[i] = best;
        pi[k] = cur;
        inv[best] = i;
        inv[cur] = k;
      }
    }
  }
  if (argv.includes("--debug"))
    console.error(`    refine swaps tried=${swapsTried} done=${swapsDone}`);
  const out = new Map(base.assign);
  for (let i = 0; i < K; i += 1)
    out.set(base.buckets[i] as number, aux.labels[pi[i] as number] as string);
  return out;
}

// ---------------------------------------------------------------- metrics
interface TokenStats {
  readonly ranked: string[]; // tenant index tokens by df desc
  readonly df: Map<string, number>;
}
function tokenStats(tokens: readonly (readonly string[])[]): TokenStats {
  const df = new Map<string, number>();
  for (const t of tokens) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  const ranked = [...df.keys()].sort(
    (a, b) => (df.get(b) as number) - (df.get(a) as number) || (a < b ? -1 : 1),
  );
  return { ranked, df };
}
/**
 * A word counts as recovered when the bucket of its whole-word tag is assigned a label that pins the word: the whole-word
 * label itself, or one of its own prefix labels whose true tenant frequency is within 25% of the word's (that prefix tag
 * is then, for this word, the same message set, so naming it names the word). Whole-word and unique-prefix tags are
 * indistinguishable by frequency or nesting, so demanding the exact tag kind would understate the leak.
 */
function makeRecovered(truth: Map<string, number>) {
  return (
    words: readonly string[],
    idx: Index,
    assign: Map<number, string>,
    filter?: (w: string) => boolean,
  ): number => {
    const ws = filter ? words.filter(filter) : words;
    if (ws.length === 0) return Number.NaN;
    const hit = (w: string): boolean => {
      const l = assign.get(idx.tagOf(`w:${w}`));
      if (l === undefined) return false;
      if (l === `w:${w}`) return true;
      return (
        l.startsWith("p:") &&
        w.startsWith(l.slice(2)) &&
        (truth.get(l) ?? Number.POSITIVE_INFINITY) <= 1.25 * (truth.get(`w:${w}`) ?? 1)
      );
    };
    return ws.filter(hit).length / ws.length;
  };
}

/** Containment-chain size of a bucket: other buckets whose message set holds >= 75% of this bucket's set and is not huge. */
function chainSize(idx: Index, bucket: number, msgsOfBucket: Map<number, number[]>): number {
  const msgs = msgsOfBucket.get(bucket) as number[];
  const tally = new Map<number, number>();
  for (const m of msgs)
    for (const b of idx.msgBuckets[m] as Int32Array)
      if (b !== bucket) tally.set(b, (tally.get(b) ?? 0) + 1);
  let n = 0;
  for (const [b, c] of tally)
    if (c >= 0.75 * msgs.length && (idx.counts[b] as number) <= Math.max(4 * msgs.length, 30))
      n += 1;
  return n;
}
function bucketMessages(idx: Index): Map<number, number[]> {
  const m = new Map<number, number[]>();
  idx.msgBuckets.forEach((bs, mi) => {
    for (const b of bs) (m.get(b) ?? (m.set(b, []).get(b) as number[])).push(mi);
  });
  return m;
}
const lengthBand = (l: number): number => (l < 5 ? 0 : l < 8 ? 1 : l < 12 ? 2 : 3);
const RARE_FROM = 500;
const RARE_TO = 3000;
const MIN_RARE_DF = 4;

function lengthLeak(
  idx: Index,
  ts: TokenStats,
  auxIdx: Index,
  auxTs: TokenStats,
): { exact: number; band: number; baseline: number; n: number } {
  const learn = (i: Index, t: TokenStats): { x: number; len: number }[] => {
    const msgs = bucketMessages(i);
    return t.ranked
      .slice(RARE_FROM, RARE_TO)
      .filter((w) => (t.df.get(w) as number) >= MIN_RARE_DF)
      .map((w) => ({ x: chainSize(i, i.tagOf(`w:${w}`), msgs), len: Math.min([...w].length, 12) }));
  };
  const train = learn(auxIdx, auxTs);
  const mode = new Map<number, Map<number, number>>();
  for (const { x, len } of train) {
    const row = mode.get(x) ?? new Map<number, number>();
    row.set(len, (row.get(len) ?? 0) + 1);
    mode.set(x, row);
  }
  const best = new Map<number, number>();
  for (const [x, row] of mode)
    best.set(x, [...row.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as number);
  const test = learn(idx, ts);
  const globalMode = [
    ...test.reduce((m, t) => m.set(t.len, (m.get(t.len) ?? 0) + 1), new Map<number, number>()),
  ].sort((a, b) => b[1] - a[1])[0];
  const fallback =
    [...mode.values()].flatMap((m) => [...m.entries()]).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const guess = (x: number): number => best.get(x) ?? fallback;
  const n = test.length;
  return {
    n,
    exact: test.filter((t) => guess(t.x) === t.len).length / n,
    band: test.filter((t) => lengthBand(guess(t.x)) === lengthBand(t.len)).length / n,
    baseline: (globalMode?.[1] ?? 0) / n,
  };
}

/** Patient-name identification with per-patient channel linkage: is the channel's top-lift bucket the surname's (family-level) bucket? */
function nameLinkage(
  idx: Index,
  corpus: Corpus,
  indexedNames: ReadonlySet<string>,
  scheme: Scheme,
): { rate: number; baseline: number; n: number } {
  const N = corpus.messages.length;
  const byChannel = new Map<number, number[]>();
  corpus.messages.forEach((m, i) =>
    (byChannel.get(m.channel) ?? (byChannel.set(m.channel, []).get(m.channel) as number[])).push(i),
  );
  let hit = 0;
  let n = 0;
  let base = 0;
  corpus.lexicon.patients.forEach((p, pi) => {
    const msgs = byChannel.get(pi) ?? [];
    if (msgs.length < 20 || !indexedNames.has(p.surname)) return;
    const tally = new Map<number, number>();
    for (const m of msgs)
      for (const b of idx.msgBuckets[m] as Int32Array) tally.set(b, (tally.get(b) ?? 0) + 1);
    let top = -1;
    let topScore = Number.NEGATIVE_INFINITY;
    let candidates = 0;
    for (const [b, c] of tally) {
      if (c < 3) continue;
      candidates += 1;
      const score = c * Math.log(c / msgs.length / ((idx.counts[b] as number) / N));
      if (score > topScore) [top, topScore] = [b, score];
    }
    n += 1;
    base += candidates > 0 ? 1 / candidates : 0;
    // family-level hit: the surname's whole-word bucket or one of its own prefix buckets that holds (about) the same messages
    const whole = idx.tagOf(`w:${p.surname}`);
    const family = labelKeys([p.surname], scheme)
      .map(idx.tagOf)
      .filter(
        (b) => b === whole || (idx.counts[b] as number) <= 1.25 * (idx.counts[whole] as number),
      );
    if (family.includes(top)) hit += 1;
  });
  return { rate: n ? hit / n : Number.NaN, baseline: n ? base / n : Number.NaN, n };
}

// ---------------------------------------------------------------- per-channel keys (production scheme)
interface ChannelRow {
  readonly tagBits: number;
  readonly names: "indexed" | "excluded";
  readonly n: number;
  readonly top1: number;
  readonly top3: number;
  readonly baseline: number;
  readonly present: number;
}

/**
 * The production scheme: every channel has its own key (`deriveChannelKey`), so the same word is a different bucket in every channel
 * and NO cross-channel baseline (concentration lift) exists. The adversary with the channel-to-patient link can only look inside the
 * channel: the strongest simple test is the raw message frequency of its buckets (a surname in ~30% of a patient's messages is a
 * frequent bucket). "present" is the share of patients whose surname family tags occur in ANY row of their channel at all: with
 * the production exclusion it is the residual of shared-prefix and collision buckets.
 */
function channelKeyNameExperiment(
  corpus: Corpus,
  tokIndexed: readonly (readonly string[])[],
  tokExcluded: readonly (readonly string[])[],
  tagBitsList: readonly number[],
  surnames: ReadonlySet<string>,
): ChannelRow[] {
  const out: ChannelRow[] = [];
  const searchKey = deriveSearchKey(sha(`${SEED}:tenant:dek`), "org-tenant", "v1");
  for (const tagBits of tagBitsList) {
    for (const names of ["indexed", "excluded"] as const) {
      const toks = names === "indexed" ? tokIndexed : tokExcluded;
      const r = mulberry32(SEED ^ 0x51ed ^ tagBits);
      const keyOf = new Map<number, Buffer>();
      const channelKey = (c: number): Buffer => {
        const known = keyOf.get(c);
        if (known) return known;
        const derived = deriveChannelKey(searchKey, "v1", tagBits, `channel-${c}`);
        keyOf.set(c, derived);
        return derived;
      };
      const tagIn = (c: number, label: string): number =>
        label.startsWith("w:")
          ? tagForWord(channelKey(c), label.slice(2), tagBits)
          : tagForPrefix(channelKey(c), label.slice(2), tagBits);
      // per channel: bucket -> number of messages holding it (real + dummy rows, distinct per message)
      const perChannel = new Map<number, Map<number, number>>();
      const msgsOf = new Map<number, number>();
      corpus.messages.forEach((m, i) => {
        const real = labelKeys(toks[i] as readonly string[], "sparse").map((l) =>
          tagIn(m.channel, l),
        );
        const rows = [...real];
        for (let n = paddedSize(real.length) - real.length; n > 0; n -= 1)
          rows.push(Math.floor(r() * 2 ** tagBits));
        const tally = perChannel.get(m.channel) ?? new Map<number, number>();
        for (const b of new Set(rows)) tally.set(b, (tally.get(b) ?? 0) + 1);
        perChannel.set(m.channel, tally);
        msgsOf.set(m.channel, (msgsOf.get(m.channel) ?? 0) + 1);
      });
      let n = 0;
      let top1 = 0;
      let top3 = 0;
      let present = 0;
      let base = 0;
      corpus.lexicon.patients.forEach((p, pi) => {
        const total = msgsOf.get(pi) ?? 0;
        const tally = perChannel.get(pi);
        if (total < 20 || !tally || !surnames.has(p.surname)) return;
        const family = new Set(labelKeys([p.surname], "sparse").map((l) => tagIn(pi, l)));
        const ranked = [...tally.entries()]
          .filter(([, c]) => c >= 3)
          .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        n += 1;
        base += ranked.length > 0 ? 1 / ranked.length : 0;
        if (ranked[0] && family.has(ranked[0][0])) top1 += 1;
        if (ranked.slice(0, 3).some(([b]) => family.has(b))) top3 += 1;
        if ([...family].some((b) => (tally.get(b) ?? 0) >= 3)) present += 1;
      });
      out.push({
        tagBits,
        names,
        n,
        top1: n ? top1 / n : Number.NaN,
        top3: n ? top3 / n : Number.NaN,
        baseline: n ? base / n : Number.NaN,
        present: n ? present / n : Number.NaN,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- experiment
interface Row {
  readonly auxKind: "mismatched" | "perfect";
  readonly scheme: Scheme;
  readonly tagBits: number;
  readonly dummies: boolean;
  readonly names: "indexed" | "excluded";
  readonly attack: "rank" | "refine";
  readonly top: Record<number, number>;
  readonly tail: number; // ranks 500..2000
  readonly tailInAux: number;
  readonly nameBlind: number;
  readonly nameBlindBaseline: number;
  readonly nameLinked: number;
  readonly nameLinkedBaseline: number;
  readonly lenExact: number;
  readonly lenBand: number;
  readonly lenBaseline: number;
  readonly distinctTags: number;
  readonly rowsPerBucket: number;
}

function main(): void {
  const t0 = Date.now();
  // self-checks against production behaviour
  const probe = ["morphine", "pain", "esophagogastroduodenoscopy"];
  const prodLabels = labelKeys(probe, "sparse");
  if (prodLabels.length !== indexTagStrings(probe).length)
    throw new Error("label mapping drifted from production");
  if (padTags([1, 2, 3], 12).length !== paddedSize(3))
    throw new Error("padding rule drifted from production");
  if (
    indexTagStrings(["morphine"]).includes(wholeWordInput("morphine")) === false ||
    !indexTagStrings(["morphine"]).includes(prefixInput("mor"))
  ) {
    throw new Error("tag input shape drifted from production");
  }

  const r = mulberry32(SEED);
  const lexicon = buildLexicon(r, 7000, 400);
  const tenant = generate(lexicon, SEED + 1, { count: MESSAGES, auxMode: false });
  const allNames = [...lexicon.patients.flatMap((p) => [p.surname, p.first, p.family])];
  const publicNames = [
    ...shuffle(allNames, r).slice(0, Math.floor(allNames.length / 2)),
    ...Array.from({ length: 1500 }, () => pseudoWord(r, NAME_SYLLABLES, 2, 3)),
  ];
  const auxNames = shuffle([...new Set(publicNames)], r);
  const aux = generate(lexicon, SEED + 2, { count: MESSAGES, auxMode: true, auxNames });
  const tokAll = tenant.messages.map((m) => tokenizeForSearch(m.text));
  // PRODUCTION name exclusion: the tenant's name tokens are tokenised by the production tokenizer, replaced by keyed digests and
  // applied through `tokenizeForSearch(text, excluded)` - the very call the index writer makes.
  const tenantSearchKey = deriveSearchKey(sha(`${SEED}:tenant:dek`), "org-tenant", "v1");
  const excludedNames = digestExclusion(
    tenantSearchKey,
    new Set(
      lexicon.patients.flatMap((p) =>
        [p.surname, p.first, p.family].flatMap((part) =>
          tokenizeForSearch(part).map((token) => nameTokenDigest(tenantSearchKey, token)),
        ),
      ),
    ),
  );
  const tokNoNames = tenant.messages.map((m) => tokenizeForSearch(m.text, excludedNames));
  const auxTok = aux.messages.map((m) => tokenizeForSearch(m.text));
  const auxTokNoNames = auxTok.map((t) => t.filter((w) => !lexicon.nameRegistry.has(w) || false));
  const perfect = generate(lexicon, SEED + 3, { count: MESSAGES, auxMode: false }); // control: aux drawn from the tenant's own distribution
  const perfectTok = perfect.messages.map((m) => tokenizeForSearch(m.text));
  const perfectTokNoNames = perfectTok.map((t) => t.filter((w) => !lexicon.nameRegistry.has(w)));
  const surnames = new Set(lexicon.patients.map((p) => p.surname));
  const surnamesInAux = new Set([...surnames].filter((s) => auxNames.includes(s)));
  const nameLabelCount = auxNames.length;

  const sparseD = new Set(tokAll.flatMap((t) => labelKeys(t, "sparse"))).size;
  const storedRows = tokAll.reduce((sum, t) => sum + paddedSize(labelKeys(t, "sparse").length), 0);
  const ruleBits = tagBitsForTotalRows(storedRows); // security review H2: sized on stored ROWS, not on distinct tags
  const tagBitsList = arg("T", "")
    ? arg("T", "").split(",").map(Number)
    : [...new Set([ruleBits, DEFAULT_TAG_BITS])];
  console.error(
    `corpus: ${MESSAGES} msgs, distinct sparse tags D=${sparseD}, stored rows=${storedRows}, rule T=${ruleBits}, T list ${tagBitsList}`,
  );

  const rows: Row[] = [];
  for (const tagBits of tagBitsList) {
    for (const auxKind of ["mismatched", "perfect"] as const) {
      for (const scheme of ["sparse", "dense"] as const) {
        for (const dummies of [true, false]) {
          for (const names of ["indexed", "excluded"] as const) {
            const toks = names === "indexed" ? tokAll : tokNoNames;
            const atoks =
              auxKind === "perfect"
                ? names === "indexed"
                  ? perfectTok
                  : perfectTokNoNames
                : names === "indexed"
                  ? auxTok
                  : auxTokNoNames;
            const idx = buildIndex(toks, scheme, tagBits, dummies, SEED, "tenant");
            const auxIdx = buildIndex(atoks, scheme, tagBits, dummies, SEED + 7, "aux-calibration"); // adversary's own key
            const auxM = auxModel(atoks, scheme);
            const recoveredRate = makeRecovered(auxModel(toks, scheme).df);
            const ts = tokenStats(toks);
            const auxTs = tokenStats(atoks);
            const base = rankAttack(idx, auxM);
            const refined = refineAttack(idx, auxM, base);
            const len = lengthLeak(idx, ts, auxIdx, auxTs);
            const linked = nameLinkage(idx, tenant, surnames, scheme);
            const inAux = (w: string): boolean => auxM.df.has(`w:${w}`);
            const rpb = idx.counts.reduce((a, b) => a + b, 0) / 2 ** tagBits;
            for (const [attack, assign] of [
              ["rank", base.assign],
              ["refine", refined],
            ] as const) {
              const top: Record<number, number> = {};
              for (const n of TOP_NS) top[n] = recoveredRate(ts.ranked.slice(0, n), idx, assign);
              const nameKeys = [...surnamesInAux].filter((s) => ts.df.has(s));
              const nb =
                nameKeys.length && names === "indexed"
                  ? nameKeys.filter((s) => assign.get(idx.tagOf(`w:${s}`)) === `w:${s}`).length /
                    nameKeys.length
                  : 0;
              rows.push({
                auxKind,
                scheme,
                tagBits,
                dummies,
                names,
                attack,
                top,
                tail: recoveredRate(ts.ranked.slice(500, 2000), idx, assign),
                tailInAux: recoveredRate(ts.ranked.slice(500, 2000), idx, assign, inAux),
                nameBlind: nb,
                nameBlindBaseline: 1 / nameLabelCount,
                nameLinked: linked.rate,
                nameLinkedBaseline: linked.baseline,
                lenExact: len.exact,
                lenBand: len.band,
                lenBaseline: len.baseline,
                distinctTags: idx.distinctReal,
                rowsPerBucket: rpb,
              });
            }
            console.error(
              `  done aux=${auxKind} T=${tagBits} ${scheme} dummies=${dummies} names=${names} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
            );
          }
        }
      }
    }
  }
  const pct = (x: number): string => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const out: string[] = [];
  out.push(
    `GLOBAL KEY (superseded scheme, kept for comparability) seed=${SEED} messages=${MESSAGES} D_sparse=${sparseD} storedRows=${storedRows} ruleT=${ruleBits} sparseLengths=${PREFIX_TAG_LENGTHS.join(",")} candidateCap=${CANDIDATE_CAP}`,
  );
  out.push(
    "aux | T | prefix | dummies | names | attack | top50 | top100 | top500 | tail500-2000 (inAux) | nameBlind (base) | nameLinked (base) | lenExact/band (base) | rows/bucket",
  );
  for (const x of rows) {
    out.push(
      `${x.auxKind} | ${x.tagBits} | ${x.scheme} | ${x.dummies ? "yes" : "no"} | ${x.names} | ${x.attack} | ${pct(x.top[50] as number)} | ${pct(x.top[100] as number)} | ${pct(x.top[500] as number)} | ${pct(x.tail)} (${pct(x.tailInAux)}) | ${pct(x.nameBlind)} (${pct(x.nameBlindBaseline)}) | ${pct(x.nameLinked)} (${pct(x.nameLinkedBaseline)}) | ${pct(x.lenExact)}/${pct(x.lenBand)} (${pct(x.lenBaseline)}) | ${x.rowsPerBucket.toFixed(1)}`,
    );
  }
  out.push(
    "",
    "VERDICT per proposed criteria (production config: sparse, dummies on, names indexed; best of rank/refine)",
  );
  const best = (f: (x: Row) => number, sel: Row[]): number => Math.max(...sel.map(f));
  const pf = (ok: boolean): string => (ok ? "PASS" : "FAIL");
  for (const auxKind of ["mismatched", "perfect"] as const) {
    for (const tagBits of tagBitsList) {
      const sel = rows.filter(
        (x) =>
          x.auxKind === auxKind &&
          x.tagBits === tagBits &&
          x.scheme === "sparse" &&
          x.dummies &&
          x.names === "indexed",
      );
      const t500 = best((x) => x.top[500] as number, sel);
      const tail = best((x) => x.tail, sel);
      const nb = best((x) => x.nameBlind, sel);
      const nl = sel[0]?.nameLinked as number;
      const le = sel[0]?.lenExact as number;
      out.push(
        `aux=${auxKind} T=${tagBits}: C1 top500=${pct(t500)} (<=5%) ${pf(t500 <= 0.05)} | C1-tail=${pct(tail)} (<=5%) ${pf(tail <= 0.05)} | C2 blind-name=${pct(nb)} (base ${pct(1 / nameLabelCount)}+1%) ${pf(nb <= 1 / nameLabelCount + 0.01)} | C2 linked-name=${pct(nl)} (base ${pct(sel[0]?.nameLinkedBaseline as number)}+1%) ${pf(nl <= (sel[0]?.nameLinkedBaseline as number) + 0.01)} | C3 exact-length=${pct(le)} (<=10%; modal-guess baseline ${pct(sel[0]?.lenBaseline as number)}) ${pf(le <= 0.1)} | C4 not evaluated`,
      );
    }
  }
  const channelRows = channelKeyNameExperiment(tenant, tokAll, tokNoNames, tagBitsList, surnames);
  out.push(
    "",
    "PER-CHANNEL KEYS (production scheme): channel-linked name identification, sparse prefixes, dummies on",
  );
  out.push(
    "T | names | patients | raw-frequency top-1 hit (baseline 1/candidates) | surname bucket in channel top-3 | surname tags present in any message of its channel",
  );
  for (const x of channelRows) {
    out.push(
      `${x.tagBits} | ${x.names} | ${x.n} | ${pct(x.top1)} (${pct(x.baseline)}) | ${pct(x.top3)} | ${pct(x.present)}`,
    );
  }
  console.log(out.join("\n"));
  const jsonPath = arg("json", "");
  if (jsonPath)
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { seed: SEED, messages: MESSAGES, sparseD, ruleBits, rows, channelRows },
        null,
        1,
      ),
    );
  console.error(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
