# M25 835: validating real MAC remittance files

Control CW-PI-03 is `partial` because every 835 the parser and the posting pipeline have seen is synthetic. This is the procedure and the checklist for closing that with real MAC files. **It has not been run on a real file.** Nothing here authorizes anyone to move real data: a real remittance carries PHI, and an agent never sees one (not a real file, not a de-identified copy, not the intake directory).

## Rules

- **A file is PHI until it has been de-identified and the privacy officer has signed that it is.** Until then it is handled as PHI: an encrypted disk, a directory only its owner can read (`chmod 700`), no cloud sync or backup of that directory (on a Mac: excluded from Time Machine, Spotlight and iCloud Drive), no copy into the repository, an issue, a PR, a log, a chat or an agent session.
- **Authority first.** Only a file the hospice owns, taken from the hospice's own MAC portal or billing system, **never from a ChartWarden environment** (a staged raw object or a clearinghouse pull is a tenant's PHI), and that its agreements with the MAC and the vendors allow it to de-identify and use to validate software. The intake note (below) records the authorizing role. Whether a BAA lets a business associate de-identify and keep the file is the privacy officer's decision, not engineering's.
- **Transfer.** Before sign-off a file is PHI in transit (164.312(e)(1)): move it only over the channel the privacy officer approves (for example the hospice's encrypted file share), never email, chat or AirDrop. After sign-off the de-identified copy moves the same way.
- **De-identification is done by the billing owner or the privacy officer, never by an agent, and a second person checks it** before the directory is used by anyone else. This table is a working aid, not legal advice. The method is Safe Harbor (45 CFR 164.514(b)(2)) or Expert Determination (164.514(b)(1)); under Expert Determination a qualified statistical expert makes and signs the determination and the privacy officer adopts it.
- **Replacement values are random, never derived.** Do not hash, shift or otherwise compute an invented value from the real one (a `sha256(real)` prefix or a letter shift can be reversed or matched). Draw each from a random source and keep it consistent within a file. The mapping table, any script that wrote the copies and any editor backup are PHI: they are deleted with the originals, never kept with the de-identified copies.
- **Results are reported as codes and counts only**: a file's short content hash, its refusal code, segment ids, reason codes. Never an element value, a name, an id or an amount that identifies a claim. A refusal *reason* can carry a dollar figure (an `X12_835_UNBALANCED` reason does), so the checker below prints the code only; reasons are read on screen and never pasted.
- **Delete when the write-up is signed, or after 30 days, whichever is first**: the intake directory, the originals' working copies, the mapping table and every backup of them; record the deletion date in the intake note. The sign-off record itself (no PHI) is kept for the period the privacy officer sets.
- `bun run harness:phi-scan` takes repo-relative paths, so it cannot scan the intake directory; the second person's read is the control.

## De-identify (the billing owner or privacy officer)

Work from an allow-list: **keep only what the checks depend on and replace every other value.** Replace consistently within a file (the same real value always gets the same invented value) so matching still works. A segment or element this table does not mention is replaced, not kept.

**Keep exactly** (they carry no identity, and the checks depend on them):

- Segment ids and their order; qualifiers (SVC01-1, N101, N103, REF01, CAS01, PLB reason codes, DTM qualifiers, the bank qualifiers BPR06, BPR08, BPR12 and BPR14); CARC and RARC codes; CLP02 (status), BPR01 and BPR04 (handling and payment method codes); the envelope facts the parser requires (ISA15 = P, GS01 = HP, GS08 = 005010X221*); control numbers (ISA13, GS06, ST02) and counts (SE01, GE01, IEA01). If a count must change because a segment was removed, say so in the intake note.
- Amounts (BPR02, CLP03-05, SVC02-03, CAS, PLB, AMT). The balance checks need them; amounts are not one of the 18 Safe Harbor identifier categories, but the privacy officer confirms that under the chosen method.

**Replace with an invented value of the same length and character class** (the list shows where identity usually hides; it is not exhaustive):

| Where | Notes |
|---|---|
| NM1 (any qualifier: QC, IL, 74, 82, TT, PR, PE), NM103-NM109 | Invented names and ids. An MBI or SSN-shaped value comes from `compliance/synthetic-identifiers.json` only |
| CLP01, CLP07, every REF (1L, EA, F8, 6R, TJ, PQ, others), TRN02-03 | Invented tokens |
| N1 (payee and payer names), N3, N4, PER (contacts) | Invented organisation and address; keep the NPI shape (N103 XX) with a test-range NPI and the TIN shape (REF*TJ) with an invented TIN |
| BPR07 and BPR13 (sender and receiver bank ids, routing numbers), BPR09 and BPR15 (sender and receiver account numbers), BPR10 and BPR11 (originating company id and supplemental code) | Invented values; keep length. The qualifiers BPR06, BPR08, BPR12 and BPR14 are kept (above) |
| ISA06, ISA08, GS02, GS03 (sender and receiver ids), PLB01 (provider id) | Invented |
| DTM (every qualifier: 050, 232, 233, 036, 472, 150, 151), BPR16, PLB02 (fiscal period), DTP, and the envelope dates and times ISA09, ISA10, GS04, GS05 | See below |

**Dates.** Under Safe Harbor every date element other than the year is removed, so the copy keeps the real year only and takes an invented month and day; the order and the gaps between dates are then **not** preserved, and the checks that depend on them (service-date order, period arithmetic) are not proved by that copy. Keeping order and gaps by shifting every date by one constant offset is Expert Determination territory: only with the expert's written determination, and the offset is a re-identification key, so it is kept secret and destroyed with the working copies. Record which method was used in the intake note.

A second person reads every file end to end before it leaves the billing owner. A file with anything left that could identify a person, a patient account or a bank account is returned, not patched.

## Intake note (one per batch, no PHI)

Authorizing role and date; the privacy officer's method and sign-off; the second reader's role; the MAC jurisdiction or payer; the number of files; the deletion date. Keep it with the sign-off record, not in the repository.

## Intake (an engineer, on their own machine, outside any agent session)

1. **Precondition: the intake note is complete**, with the privacy officer's sign-off recorded; without it nothing below starts. Put the files in a new empty directory outside the repository, for example `~/cw-835-intake/<yyyymmdd>-<mac>/`, one file per remittance, no PHI in the file names.
2. From the repository root (not from inside the intake directory), run the checker with the directory as the argument. It prints one line per file, the refusal **code** and nothing that identifies a claim. Add `reasons` as the second argument to also print the refusal reason on screen (read it, do not paste it):

   ```sh
   bun -e '
   import { createHash } from "node:crypto";
   import { readFileSync, readdirSync } from "node:fs";
   import { join } from "node:path";
   import { parseX12835AllSets } from "@chartwarden/x12-835-client";
   const dir = process.argv[1];
   if (!dir) throw new Error("usage: bun -e <script> <directory of de-identified 835 files> [reasons]");
   const showReasons = process.argv[2] === "reasons";
   const tally = (xs) => JSON.stringify(Object.fromEntries([...new Set(xs)].sort().map((x) => [x, xs.filter((y) => y === x).length])));
   for (const name of readdirSync(dir).sort()) {
     const file = readFileSync(join(dir, name), "utf8");
     const id = createHash("sha256").update(file).digest("hex").slice(0, 12);
     // The tokenizer strips a BOM and leading whitespace before it reads the ISA; do the same before indexing it.
     const raw = file.replace(/^\uFEFF/, "").replace(/^\s+/, "");
     const interest = raw.split(raw[105] ?? "~").filter((s) => s.trim().startsWith(`AMT${raw[3]}I${raw[3]}`)).length;
     const r = parseX12835AllSets(file, "medicare");
     if (!r.ok) { console.log(`${id} REFUSED ${r.degraded.code}${showReasons ? ` :: ${r.degraded.reason}` : ""}`); continue; }
     const claims = r.value.flatMap((s) => s.claims);
     const lines = claims.flatMap((c) => c.serviceLines);
     const plb = r.value.flatMap((s) => s.providerAdjustments ?? []).map((p) => p.reason);
     const unknown = r.value.flatMap((s) => s.unknownSegments ?? []).map((u) => u.segmentId);
     console.log(`${id} ok sets=${r.value.length} claims=${claims.length} lines=${lines.length} status=${tally(claims.map((c) => String(c.statusCode)))} plb=${tally(plb)} unknown=${tally(unknown)} amtI=${interest}`);
   }
   ' ~/cw-835-intake/<yyyymmdd>-<mac>
   ```

   Pass `"medicaid"` instead of `"medicare"` for a Medicaid or managed-care file.
3. Classify every line (below), then write the result up with the ids and codes only. Do not paste the checker's input, or a refusal reason, anywhere.
4. **Posting is not proved by this procedure.** The live suites (`test:m25:835-ingestion:live`, `test:m25:835-golden:live`) build their EDI in code and read no input directory, so a real file cannot be run through receive and post with them today. The checker proves what the parser understands and refuses; proving posting needs a small live suite that reads the intake directory from a variable and is skipped when it is unset, on a private `chartwarden-postgres:dev` container (its own port, never 5432 or the shared cluster). Write it when the first files exist; a real file is never loaded into a shared or production database.

## Classify each file

| The checker says | It means | Do |
|---|---|---|
| `ok`, `unknown={}` | The parser understood every segment and every set balanced | Compare with the checklist below; this is the evidence for the row |
| `REFUSED X12_835_UNBALANCED` | A charge, PR, BPR02 or PLB figure does not foot under today's rules | Decide with the billing owner whether the payer reports it differently (a rule to model, with the guide passage) or the file is wrong. Never loosen the check to pass the file |
| `REFUSED X12_835_PARSE_FAILED` | A rule on an element (shape, date, count, envelope) failed | Read the reason on screen: a real payer variant, or de-identification that dropped or changed a required element (an envelope fact, a count, a qualifier). Fix the copy, never loosen the rule |
| `ok` with `unknown={"TS3":1}` or similar | The file carries a segment the parser does not model. M25 **refuses** such a file at receive and at post; it is never posted. TS3 (provider summary) is a legal 5010 segment and may well appear on every Medicare Part A file: expect to model it first | Obtain the companion-guide passage for that segment, model it with a balance rule, then it can pass |
| `ok` with `amtI` above 0 | A claim reports interest in AMT*I, which is validated and never added | Check against the payer's guide whether BPR02 includes it (the file would have been refused) or whether PLB L6 carries it |
| `REFUSED X12_835_UNSUPPORTED_ROUTING` | A non-HP functional group sits in the interchange | Out of scope for M25; note it |

## Checklist (answer for each MAC jurisdiction or payer, with the guide passage)

- [ ] `sum(SVC02) = CLP03` on partial-payment claims with several lines, and each line's `SVC02 - SVC03 = sum(CAS)`.
- [ ] `CLP05 = sum(PR)` across claim and line level; where the payer reports patient responsibility otherwise.
- [ ] Interest: AMT*I at claim level versus PLB L6; whether BPR02 includes interest; its sign.
- [ ] PLB reasons actually sent (WO, L6, FB, 72, others) and whether any pair is a forwarding balance or a reversal that needs a policy beyond "total persisted".
- [ ] `BPR02 = 0` with `BPR04` other than NON (accepted today; the guide may require NON) and BPR16 present on every non-zero payment.
- [ ] Reversal and rebill pairs (CLP02 = 22 with negative amounts) and CLP02 values beyond 1, 2, 3, 4, 19-23, 25.
- [ ] Segments outside the modelled set (TS3, TS2, CUR, RDM, others): which appear, on every file or only some. LX is modelled (header number only, shape-checked, no amount).
- [ ] Several ST/SE sets per file, several GS groups, several ISA interchanges (refused today), and whether the payer reuses ST02 across groups.
- [ ] Payee identity: N103 qualifier (XX, FI), REF*TJ, REF*PQ, and what the payer sends as PTAN (no tenant column exists for PTAN).
- [ ] CAS: more than six triplets (refused), reason-code shapes, negative amounts, quantity use.
- [ ] LQ, MOA and MIA remark codes, and any LQ qualifier other than HE.
- [ ] Money: no amount with more than two decimals; no amount above the numeric(12,2) ceiling.

## Closing the gap

The row's gap narrows to "proved only on N de-identified files from <MACs>" when the billing owner has signed off the table above for each jurisdiction in use; its `reason` then names the jurisdictions still unproven. The count of files that is enough is the billing owner's call, not engineering's. Until then CW-PI-03 stays `partial`.
