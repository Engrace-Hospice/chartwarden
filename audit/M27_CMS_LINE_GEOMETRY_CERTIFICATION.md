# M27 Cost Report — CMS Line-Geometry Certification

**Date:** 2026-06-28 · **Scope:** Form CMS-1984-14 (freestanding hospice cost report) worksheet math in
`packages/cost-report/`. **Pass:** line-by-line against the authoritative primary sources (in-repo).
**Verdict:** ✅ **REALIGNED** — the line-by-line pass found a material structural divergence (the M27 model
implemented a hospital/HHA-shaped chain), and the worksheet **model has now been realigned** to Form
CMS-1984-14. The worksheet inventory, the A → B/B-1 → C computation chain, the validation rule library, the
DB enum, and the seed catalog all now match the form. See [Realignment — done](#realignment--done).

## Sources (obtained — `docs/reference/cms/`)

Downloaded via `curl` from cms.gov (the WebFetch tool was bot-blocked; `curl` with a browser UA succeeded):

| File | Document | Authority |
|------|----------|-----------|
| `r8p243f.pdf` | **Form CMS-1984-14** (blank worksheet layouts), Rev. 8 | the form itself |
| `r8p243i.pdf` | **CMS Pub. 15-2, Chapter 43** — Hospice Cost Report instructions, Rev. 8 (§§4306–4352) | line-by-line computation prose |

(An earlier guess, `r5p247i.pdf`, turned out to be the *Home Health Agency* report (Form CMS-1728-20,
Chapter 47) — discarded. The hospice instructions are the `…243i` transmittal, paired with the `…243f` form.)

## The real Form CMS-1984-14 — verified worksheet inventory

From the Chapter 43 instruction index (r8p243i) and the form (r8p243f), the **complete** worksheet set is:

`S` · `S-1` · `S-2` · `A` · `A-1` · `A-2` · `A-3` · `A-4` · `A-6` · `A-8` · `A-8-1` · `B` · `B-1` · `C` · `F` · `F-1` · `F-2`

**There is no Worksheet D, E, E-1, G, G-1/2/3, H, S-3, S-4, or A-7.** (Confirmed: a regex over the full
instructions for `WORKSHEET (D|E|E-1|G|H)` returns nothing.) The real hospice cost flow is short:

```
A (trial balance, by cost center)
  → B / B-1 (step-down cost allocation; B-1 carries the statistical basis)   §4320
  → C (per-diem cost by level of care, from B col. 18 + S-1 days)             §4330
```

There is **no ancillary ratio-of-cost-to-charges**, **no program-apportionment worksheet**, and **no
settlement worksheet** on the form. Hospice is paid prospectively per-diem; the cap/settlement is determined
by the MAC via the PS&R + the annual **cap-determination notice** — a process *outside* this form (it is
M26's domain, not a Form CMS-1984-14 worksheet).

### Certified line geometry (the worksheets that DO exist)

**Worksheet B / B-1 — Cost Allocation & Statistical Basis (§4320).** Step-down method (42 CFR 413.24(d)(1)).
- Rows: general-service cost centers (lines 1–17: Cap-Rel Bldg&Fixt, Cap-Rel Mvble Equip, Employee Benefits,
  A&G, Plant Op&Maint, Laundry, Housekeeping, Dietary, Nursing Admin, Routine Med Supplies, Medical Records,
  Staff Transportation, Volunteer Coord, Pharmacy, Physician Admin, Other, Patient/Residential Care); direct
  patient-care by **level of care** on lines **50 CHC / 51 RHC / 52 IRC / 53 GIP**; nonreimbursable below.
- B-1 column = the recommended **statistical basis** (square feet, in-facility days, gross salaries, …);
  **A&G is allocated on accumulated cost** (Wkst B col. 3A).
- **Unit cost multiplier** = (col. total expense, line 101) ÷ (total statistical base, line 1), **rounded to
  SIX (6) decimal places** (B-1 line 102); allocated cost = multiplier × each receiving center's statistic.
- **Close order**: centers rendering the most / receiving the least services close first (Pub 15-1 ch.23
  §2306.1); a hospice may change order/statistics only with approval (§2313).
- **Tie-out**: col. 18 line 101 (fully allocated) must equal col. 0 line 101 (input). ✅ matches ChartWarden's
  conservation invariant.
- **Transfer to C**: B col. 18 → C col. 3: line 50→C1 (CHC), 51→C6 (RHC), 52→C11 (IRC), 53→C16 (GIP).

**Worksheet C — Calculation of Per Diem Cost (§4330).** Columns 1=Medicare(XVIII), 2=Medicaid(XIX), 3=Total.
- Per LOC (CHC L1–5, RHC L6–10, IRC L11–15, GIP L16–20): total cost (col 3, from B col 18) ÷ total days
  (col 3, from **Worksheet S-1 col 4** — *unduplicated days*) = **average cost per diem** (col 3); then
  program cost = per diem × program days (col 1/2, from S-1 col 1/2). Total Hospice Care rollup L21–23.

## Findings — ChartWarden M27 vs. Form CMS-1984-14

| ChartWarden M27 | Real Form CMS-1984-14 | Verdict |
|---|---|---|
| `A` Trial Balance | `A` Reclass & Adjust Trial Balance (§4310) | ✅ aligned in concept |
| `B` Cost Allocation step-down | `B` Cost Allocation (§4320) | ✅ aligned; mechanics correct |
| `B-1` **Cap Calculations** | `B-1` **Cost Allocation – Statistical Basis** (§4320) | ❌ **misassigned** — B-1 is the step-down statistic, not the cap |
| `C` **Ancillary RCC** | `C` **Calculation of Per Diem Cost** (§4330) | ❌ **wrong concept** — hospice has no ancillary RCC |
| `D` Program Apportionment | *(none)* — this maps to real **Worksheet C** | ❌ **does not exist** |
| `E-1` Settlement | *(none)* — no settlement worksheet on the form | ❌ **does not exist** (cap/settlement = MAC + M26) |
| `S-3`/`S-4` statistics | days live on **S-1** (§4307 Parts II–III, unduplicated) | ❌ S-3/S-4 do not exist |
| `A-7`,`G`,`G-1/2/3`,`H` | *(none)* | ❌ do not exist |
| *(not modeled)* | `A-1`/`A-2`/`A-3`/`A-4` (direct care by LOC), `A-8-1`, `F-1`, `F-2` | ❌ real worksheets missing |

**Impact on this session's work.** The allocation chain built/extended this session is structurally off-form:
- The **step-down statistical weights** (wired onto Worksheet B `allocationColumns.statisticalWeights`) belong
  on **Worksheet B-1** per §4320, and the unit-cost multiplier must round to **6 decimals** — the
  weight-driven mechanics are conceptually right but the placement/rounding diverge.
- The **per-LOC allowable-cost split → "Worksheet D"** is actually real **Worksheet C** (per-diem cost), and
  the day basis must come from **Worksheet S-1 unduplicated days**, not `statistic_data`/"S-3".
- The **"Worksheet E-1 settlement"** (sequestration/cap lines) has **no counterpart on the form**; that logic
  models the MAC cap-determination process and belongs with M26 cap management, not a CMS-1984-14 worksheet.

## Verified statutory constants (unchanged, now cross-checked)

- **Inpatient day cap = 20%** of total Medicare days — 42 CFR §418.302(f)/§418.108. ✅
- **Aggregate cap year = Nov 1 – Oct 31** — 42 CFR §418.309. ✅
- **Sequestration = 2%, period-variable** (BCA 2011; suspended 2020-05-01→2022-03-31 per CARES/PAMA; 1%
  2022-04-01→06-30; 2% thereafter). The Ch.43 HHA-analog §4715.2 confirms sequestration is taken from the
  **PS&R**, not recomputed on the cost report — reinforcing that it is a payment-side (M23/M26) concern.
- Aggregate-cap dollar schedule (FY24 $33,494.01 · FY25 $34,465.34 · FY26 $35,361.44 · FY27 $36,210.11) —
  M26's domain; not hardcoded in M27.

## Realignment — done

The M27 worksheet model was realigned to Form CMS-1984-14 (gate-green: build + arch:fitness + 4059 tests; the
A→B→C live chain proven over RLS). What landed:

1. ✅ **Worksheet inventory** (`contracts.ts` + the DB enum `m27_worksheet_code` + the registry): retired
   Worksheets D, E-1, G/G-1/2/3, H, S-3, S-4, A-7; added A-2/A-3/A-4 (direct patient-care by LOC), A-8-1,
   F-1, F-2. Now exactly the 17 real codes.
2. ✅ **Worksheet B-1** rebuilt as **Cost Allocation – Statistical Basis** (per-center statistic + 6-decimal
   unit-cost-multiplier note + A&G-on-accumulated-cost); the step-down weights re-homed off Worksheet B onto B-1.
3. ✅ **Worksheet C** rebuilt as **Calculation of Per Diem Cost** (`allocation/per-diem.ts`): per-LOC cost
   (B col. 18) ÷ days = per diem, × program days; the ancillary-RCC + program-apportionment + settlement
   modules were deleted.
4. ✅ **Recompute chain** (`assemble-inputs` → `step-down` → `per-diem` → `to-worksheets` + the worker): A
   (+ A-1…A-4) → B step-down on the B-1 basis → C per-diem; writes Worksheets B + C; C ties B to the cent.
5. ✅ **Validation rule library**: dropped the ancillary-RCC / program-D / settlement-E1 / balance-sheet-G /
   S3↔D rules; added `perdiem.c_ties_to_b` (Worksheet C ties B) + `balance_sheet.f_balances` (Worksheet F).
   25 platform-default rules across 14 categories; seed migration 0073 + the parity test updated to match.
6. **Deferred** — cap/settlement stays M26's domain (already true; the realignment removed the fictitious E-1
   from M27 rather than relocating logic). A penny-level fixture from a MAC-published worked example is still
   a good follow-up; CMS publishes no such example, so it needs a MAC source.

The in-code `CMS-CERT` markers now point here as the certified record; the prior `⚠️ CMS-DIVERGENCE` banners
were removed with the worksheets they flagged.
