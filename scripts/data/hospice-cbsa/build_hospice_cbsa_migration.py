#!/usr/bin/env python3
"""Generate packages/db/migrations/1058_m23_hospice_cbsa_reference.sql (platform reference data, no PHI).

Usage: build_hospice_cbsa_migration.py <src-dir> <out.sql>   (needs `pip install openpyxl`)

Sources (public; download by hand into <src-dir>; versions pinned here so a rerun is reproducible):
  * CMS hospice wage index, FY2026 and FY2027 final rules (CBSA / rural / transition codes, county lists, indexes):
      https://www.cms.gov/medicare/payment/fee-for-service-providers/hospice/hospice-wage-index
      FY2026 zip extracted to <src>/z26/, FY2027 zip to <src>/z27/
      (508-Version-{Urban-Areas,Rural-Areas,Transition-Wage-Index}.csv)
  * OMB Bulletin 23-01 delineation (July 2023), List 1 (CBSA -> FIPS county) -> <src>/list1_2023.xlsx:
      https://www.census.gov/geographies/reference-files/time-series/demo/metro-micro/delineation-files.html
  * Census Connecticut planning-region change (town -> 2022 planning region) -> <src>/ct_cou_to_cousub.txt, and the
    ZCTA5 -> county subdivision (town) relationship -> <src>/zcta_cousub.txt:
      https://www2.census.gov/geo/docs/reference/ct_change/ct_cou_to_cousub_crosswalk.txt
      https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_cousub20_natl.txt
  * Census 2020 ZCTA5 -> county relationship file -> <src>/zcta_county.txt, and the national county list:
      https://www.census.gov/geographies/reference-files/2020/geo/relationship-files.html
      https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt -> <src>/national_county2020.txt

Rule (CMS Pub. 100-04 ch. 11 s30.3, hospice wage index): a county in a Metropolitan CBSA that CMS lists as an urban
area uses that CBSA; every other county (rural, incl. micropolitan) uses its state's rural code 999NN; a county on
CMS's transition list uses the code its FY column shows (5000N transition code, or the rural/urban code).
ZIP -> county: the ZCTA's county with the largest land overlap (a ZCTA is the Census approximation of a USPS ZIP;
PO-box / unique ZIPs have no ZCTA and are therefore unresolved - the consumer fails closed).
"""
import csv
import io
import os
import re
import sys

import openpyxl

SRC = sys.argv[1]
OUT = sys.argv[2]
FYS = {2025: "z26", 2026: "z27"}  # fiscal_year_starting -> CMS folder (2025 = FY2026)

STATE_NAMES = {
    "AL": "ALABAMA", "AK": "ALASKA", "AZ": "ARIZONA", "AR": "ARKANSAS", "CA": "CALIFORNIA", "CO": "COLORADO",
    "CT": "CONNECTICUT", "DE": "DELAWARE", "DC": "DISTRICT OF COLUMBIA", "FL": "FLORIDA", "GA": "GEORGIA",
    "HI": "HAWAII", "ID": "IDAHO", "IL": "ILLINOIS", "IN": "INDIANA", "IA": "IOWA", "KS": "KANSAS",
    "KY": "KENTUCKY", "LA": "LOUISIANA", "ME": "MAINE", "MD": "MARYLAND", "MA": "MASSACHUSETTS",
    "MI": "MICHIGAN", "MN": "MINNESOTA", "MS": "MISSISSIPPI", "MO": "MISSOURI", "MT": "MONTANA",
    "NE": "NEBRASKA", "NV": "NEVADA", "NH": "NEW HAMPSHIRE", "NJ": "NEW JERSEY", "NM": "NEW MEXICO",
    "NY": "NEW YORK", "NC": "NORTH CAROLINA", "ND": "NORTH DAKOTA", "OH": "OHIO", "OK": "OKLAHOMA",
    "OR": "OREGON", "PA": "PENNSYLVANIA", "RI": "RHODE ISLAND", "SC": "SOUTH CAROLINA", "SD": "SOUTH DAKOTA",
    "TN": "TENNESSEE", "TX": "TEXAS", "UT": "UTAH", "VT": "VERMONT", "VA": "VIRGINIA", "WA": "WASHINGTON",
    "WV": "WEST VIRGINIA", "WI": "WISCONSIN", "WY": "WYOMING", "PR": "PUERTO RICO", "VI": "VIRGIN ISLANDS",
    "GU": "GUAM",
}


def rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.reader(f))


counties = {}  # fips5 -> state abbr
for line in open(os.path.join(SRC, "national_county2020.txt"), encoding="utf-8-sig").read().splitlines()[1:]:
    st, sfp, cfp = line.split("|")[:3]
    counties[sfp + cfp] = st

# Connecticut: CMS (FY2026+) and OMB 23-01 use the 2022 planning regions (FIPS 09110..09190), not the old counties.
# Census publishes the town -> planning-region crosswalk; the 2020 ZCTA file is also available at town (county
# subdivision) level, so a ZIP can be placed in a planning region exactly.
ct_town_to_region = {}  # old cousub geoid (state+old county+town) -> planning-region fips5
with open(os.path.join(SRC, "ct_cou_to_cousub.txt"), encoding="utf-8-sig", newline="") as f:
    for row in list(csv.reader(f, delimiter="|"))[1:]:
        if len(row) >= 8 and row[0].strip() == "09":
            ct_town_to_region[row[6].strip()] = "09" + row[3].strip()
for fips in [k for k, v in counties.items() if v == "CT"]:
    del counties[fips]  # the superseded counties
for region in set(ct_town_to_region.values()):
    counties[region] = "CT"

wb = openpyxl.load_workbook(os.path.join(SRC, "list1_2023.xlsx"), read_only=True)
omb = {}  # fips5 -> CBSA code
for r in list(wb.worksheets[0].iter_rows(values_only=True))[3:]:
    if r[0] and r[9] and r[10]:
        # OMB defines metropolitan divisions inside some CBSAs; CMS lists the division as the urban area.
        omb[str(r[9]) + str(r[10])] = str(r[1] or r[0])

county_rows, wage_rows, report = [], [], []
for fy, folder in FYS.items():
    d = os.path.join(SRC, folder)
    urban, urban_counts, cur = {}, {}, None
    for r in rows(os.path.join(d, "508-Version-Urban-Areas.csv")):
        if len(r) >= 4 and r[0].strip().isdigit():
            cur = r[0].strip()
            urban[cur] = (r[1].strip(), r[3].strip())
            urban_counts[cur] = 0
        if cur and len(r) >= 3 and r[2].strip():
            urban_counts[cur] += 1
    rural = {}
    for r in rows(os.path.join(d, "508-Version-Rural-Areas.csv")):
        if r and r[0].strip().isdigit() and len(r) >= 3:
            rural[r[1].strip().upper()] = (r[0].strip(), r[2].strip())
    trows = rows(os.path.join(d, "508-Version-Transition-Wage-Index.csv"))
    hi = next(i for i, r in enumerate(trows) if r and r[0].strip().startswith("FIPS"))
    hdr = trows[hi]
    fyname = "FY 2026" if fy == 2025 else "FY 2027"
    col = next(i for i, h in enumerate(hdr) if h.strip().startswith(fyname + " Transition Code or CBSA Code"))
    idxcol = next(i for i, h in enumerate(hdr) if "Wage Index" in h)
    trans = {}
    for r in trows[hi + 1:]:
        if r and r[0].strip().isdigit() and len(r) > idxcol:
            trans[r[0].strip().zfill(5)] = (r[col].strip(), r[idxcol].strip())
    for code, (name, idx) in urban.items():
        wage_rows.append((fy, code, name, idx))
    for sname, (code, idx) in rural.items():
        wage_rows.append((fy, code, sname.title(), idx))
    for fips, (code, idx) in trans.items():
        if code.startswith("5"):
            wage_rows.append((fy, code, "Transition " + code, idx))
    got, unresolved = {}, []
    for fips, st in counties.items():
        if fips in trans:
            code = trans[fips][0]
            kind = "transition" if code.startswith("5") else ("rural" if code.startswith("99") else "urban")
            got[fips] = (code, kind)
        elif omb.get(fips) in urban:
            got[fips] = (omb[fips], "urban")
        elif STATE_NAMES.get(st) in rural:
            got[fips] = (rural[STATE_NAMES[st]][0], "rural")
        else:
            unresolved.append(fips)
    per = {}
    for c, k in got.values():
        if k == "urban":
            per[c] = per.get(c, 0) + 1
    mismatched = [c for c in urban if per.get(c, 0) != urban_counts[c]]
    report.append(
        f"FY start {fy}: {len(got)} counties assigned, {len(unresolved)} unresolved {unresolved[:8]}, "
        f"{len(mismatched)}/{len(urban)} urban CBSAs whose county count differs from CMS {mismatched[:10]}"
    )
    for f, (c, k) in sorted(got.items()):
        county_rows.append((fy, f, c, k))

best = {}
for i, line in enumerate(open(os.path.join(SRC, "zcta_county.txt"), encoding="utf-8-sig")):
    if i == 0:
        continue
    p = line.rstrip("\n").split("|")
    z, c, area = p[1].strip(), p[9].strip(), p[16].strip()
    if not z or not c or not area:
        continue
    if z not in best or int(area) > best[z][1]:
        best[z] = (c, int(area))
# Connecticut ZCTAs: place by town -> planning region (the ZCTA/county file has only the superseded counties).
best = {z: v for z, v in best.items() if not v[0].startswith("09")}
ct_best = {}
for i, line in enumerate(open(os.path.join(SRC, "zcta_cousub.txt"), encoding="utf-8-sig")):
    if i == 0:
        continue
    p = line.rstrip("\n").split("|")
    z, g, area = p[1].strip(), p[9].strip(), p[16].strip()
    region = ct_town_to_region.get(g)
    if z and region and area and (z not in ct_best or int(area) > ct_best[z][1]):
        ct_best[z] = (region, int(area))
for z, v in ct_best.items():
    if z not in best or int(v[1]) > best[z][1]:
        best[z] = v
zip_rows = sorted((z, c) for z, (c, _a) in best.items() if c in counties)

# ZIP3 fallback for ZIPs with no ZCTA (PO-box / unique-organisation ZIPs): a 3-digit prefix is used ONLY when every
# ZCTA sharing it falls in the same CBSA/rural code for that fiscal year (unanimous). A mixed prefix stays unresolved.
area_of = {(fy, f): c for fy, f, c, _k in county_rows}
kind_of = {(fy, f): k for fy, f, _c, k in county_rows}
zip3_rows = []
for fy in FYS:
    groups = {}
    for z, c in zip_rows:
        a = area_of.get((fy, c))
        groups.setdefault(z[:3], set()).add((a, kind_of.get((fy, c))))
    for z3, vals in sorted(groups.items()):
        if len(vals) == 1 and next(iter(vals))[0] is not None:
            code, kind = next(iter(vals))
            zip3_rows.append((fy, z3, code, kind))
report.append(f"{len(zip3_rows)} (fiscal year, ZIP3) prefixes unanimous")
report.append(f"{len(zip_rows)} ZCTAs mapped to a county")


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


out = io.StringIO()
out.write("-- 1058_m23_hospice_cbsa_reference.sql - GENERATED by scripts/data/hospice-cbsa/build_hospice_cbsa_migration.py.\n")
out.write("-- Platform-shared reference data (no organization_id, no PHI): the CMS hospice wage-index geography that the\n")
out.write("-- claim's value code 61 (beneficiary-residence CBSA) / G8 (inpatient-facility CBSA) is resolved from.\n")
out.write("-- Sources and rule: see the generator header. Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / DROP POLICY IF EXISTS). Rerun it to regenerate; do not hand-edit.\n")
for line in report:
    out.write("-- " + line + "\n")
out.write(
    """
CREATE TABLE IF NOT EXISTS hospice_cbsa_county (
  fiscal_year_starting integer NOT NULL,
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  cbsa_code text NOT NULL CHECK (cbsa_code ~ '^[0-9]{5}$'),
  area_kind text NOT NULL CHECK (area_kind IN ('urban','rural','transition')),
  PRIMARY KEY (fiscal_year_starting, county_fips)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hospice_cbsa_wage_index (
  fiscal_year_starting integer NOT NULL,
  cbsa_code text NOT NULL CHECK (cbsa_code ~ '^[0-9]{5}$'),
  area_name text NOT NULL,
  wage_index numeric(6,4) NOT NULL,
  PRIMARY KEY (fiscal_year_starting, cbsa_code)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hospice_zip3_area (
  fiscal_year_starting integer NOT NULL,
  zip3 text NOT NULL CHECK (zip3 ~ '^[0-9]{3}$'),
  cbsa_code text NOT NULL CHECK (cbsa_code ~ '^[0-9]{5}$'),
  area_kind text NOT NULL CHECK (area_kind IN ('urban','rural','transition')),
  PRIMARY KEY (fiscal_year_starting, zip3)
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hospice_zip_county (
  zip5 text PRIMARY KEY CHECK (zip5 ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$')
);--> statement-breakpoint
"""
)


def insert(table, cols, data, fmt):
    for i in range(0, len(data), 500):
        out.write(f"INSERT INTO {table} ({cols}) VALUES\n")
        out.write(",\n".join(fmt(r) for r in data[i : i + 500]) + "\nON CONFLICT DO NOTHING;--> statement-breakpoint\n")


insert(
    "hospice_cbsa_county",
    "fiscal_year_starting, county_fips, cbsa_code, area_kind",
    county_rows,
    lambda r: f"({r[0]},{q(r[1])},{q(r[2])},{q(r[3])})",
)
seen, dedup = set(), []
for r in wage_rows:
    # CMS prints "#N/A" for a transition code with no published index; keep only real numbers, and strip the
    # "*" CMS puts on names that use a transition code.
    if not re.fullmatch(r"\d+(\.\d+)?", r[3]):
        continue
    r = (r[0], r[1], r[2].lstrip("*"), r[3])
    if (r[0], r[1]) not in seen:
        seen.add((r[0], r[1]))
        dedup.append(r)
insert(
    "hospice_cbsa_wage_index",
    "fiscal_year_starting, cbsa_code, area_name, wage_index",
    dedup,
    lambda r: f"({r[0]},{q(r[1])},{q(r[2])},{r[3]})",
)
insert("hospice_zip_county", "zip5, county_fips", zip_rows, lambda r: f"({q(r[0])},{q(r[1])})")
insert(
    "hospice_zip3_area",
    "fiscal_year_starting, zip3, cbsa_code, area_kind",
    zip3_rows,
    lambda r: f"({r[0]},{q(r[1])},{q(r[2])},{q(r[3])})",
)
for t in ("hospice_cbsa_county", "hospice_cbsa_wage_index", "hospice_zip_county", "hospice_zip3_area"):
    # PLATFORM-SHARED (the wage_index_factor precedent, migration 0078): tenants read, only the loader role writes.
    sb = ";--> statement-breakpoint\n"
    out.write(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY{sb}ALTER TABLE {t} FORCE ROW LEVEL SECURITY{sb}")
    out.write(f"DROP POLICY IF EXISTS {t}_read_all ON {t}{sb}")
    out.write(f"DROP POLICY IF EXISTS {t}_write_platform_only ON {t}{sb}")
    out.write(f"CREATE POLICY {t}_read_all ON {t} FOR SELECT TO wardenx_app USING (true){sb}")
    out.write(f"CREATE POLICY {t}_write_platform_only ON {t} FOR ALL TO billing_platform_loader USING (true) WITH CHECK (true){sb}")
    out.write(f"GRANT SELECT ON {t} TO wardenx_app{sb}REVOKE INSERT, UPDATE, DELETE ON {t} FROM wardenx_app{sb}")
    out.write(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {t} TO billing_platform_loader{sb}GRANT ALL ON {t} TO wardenx_admin{sb}")
open(OUT, "w").write(out.getvalue())
print("\n".join(report))
