#!/usr/bin/env python3
"""Generate packages/quality/__tests__/fixtures/ssvi-cms-published-sample.json from CMS's SSVI file.

The fixture is the independent source of truth for `ssvi-cms-golden.test.ts`: real per-hospice metric values with
the point flags / spending scores CMS published for them, plus CMS's own scoring-components column headers
(verbatim) from which the test parses the cut values. Public aggregate hospice data; the output carries no CCN,
hospice name or any other identifier.

Source: the zip CMS posts on the CMS-1851-F page
  https://www.cms.gov/medicare/payment/fee-for-service-providers/hospice/hospice-regulations-and-notices/cms-1851-f
  (service-spending-variation-index-ssvi.zip, tabs "FY2025/FY2024 Data" and "... Scoring Components").

Run (the zip is untrusted data: unzip it into a NEW EMPTY directory, and run this from a different one):
  python3 -I scripts/data/ssvi/build_ssvi_golden_fixture.py <unzipped dir> <out.json>
  bun run lint:fix        # formats the JSON the way the repo's linter wants it

Selection rule. CMS publishes the metric values rounded to 0.1, so a hospice whose published value EQUALS the
rounded cut can sit on either side of CMS's unrounded cut. A row is kept when it agrees with the inclusive
"concern side" rule at the header cut (an at-the-cut row only when CMS flagged it); the at-the-cut rows CMS did
not flag are left out. Kept rows still pin the cut tightly: flagged at-the-cut rows force the cut up to at least
the rounded value, and the nearest unflagged rows force it below the next 0.1 step.
"""
import csv
import json
import re
import sys

# metric key -> (Data tab column, Scoring-components flag column, unit)
METRICS = {
    "metric_02": (21, 20, "pct"),
    "metric_03": (22, 21, "pct"),
    "metric_04": (26, 23, "pct"),
    "metric_05": (25, 22, "pct"),
    "metric_06": (28, 24, "min"),
    "metric_07": (40, 25, "pct"),
    "metric_08": (41, 26, "pct"),
}
HEADER_COLUMNS = {
    "metric_02": 20, "metric_03": 21, "metric_05": 22, "metric_04": 23,
    "metric_06": 24, "metric_07": 25, "metric_08": 26,
}
DIRECTION = {  # inclusive concern side
    "metric_02": "gte", "metric_03": "lte", "metric_04": "gte", "metric_05": "gte",
    "metric_06": "lte", "metric_07": "lte", "metric_08": "gte",
}
NEAREST = 12  # distinct values nearest the cut, per side
SPREAD = 12  # plus an even spread over the rest, per side
SPENDING_HEADER_COLUMNS = range(11, 19)  # eight octile headers; the first seven carry the upper bounds
TOTAL_SPENDING_COLUMN = 13
SPENDING_SCORE_COLUMN = 8


def num(raw):
    s = raw.strip().replace("$", "").replace(",", "").replace("%", "")
    if s in ("*", "-", ""):
        return None
    if s.startswith("<"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return None


def load(path, skip):
    rows = list(csv.reader(open(path, encoding="utf-8-sig")))
    return rows[skip], [r for r in rows[skip + 1:] if r and r[0]]


def cut_from_header(metric, header):
    if metric == "metric_06":
        return float(re.search(r"\(([\d.]+) minutes", header).group(1))
    return round(float(re.search(r"([\d.]+)%", header).group(1)) / 100, 6)  # same rounding as the row values


def spending_bounds_cents(headers):
    bounds = []
    for h in headers[:7]:
        amounts = re.findall(r"\$([\d,]+\.\d\d)", h)
        bounds.append(round(float(amounts[-1].replace(",", "")) * 100))
    return bounds


def build(year, comp_file, data_file, data_skip, unz):
    comp_header, comp = load(unz + "/" + comp_file, 0)
    _, data = load(unz + "/" + data_file, data_skip)
    by_ccn = {r[0]: r for r in data}
    cut_headers = {m: comp_header[c].strip() for m, c in HEADER_COLUMNS.items()}
    spending_headers = [comp_header[c].strip() for c in SPENDING_HEADER_COLUMNS]
    cuts = {m: cut_from_header(m, h) for m, h in cut_headers.items()}

    metrics = {}
    for metric, (data_col, flag_col, unit) in METRICS.items():
        cut = cuts[metric]
        sides = {True: set(), False: set()}  # distinct (distance to the cut, value) per CMS flag
        joined = tie_drops = 0
        for c in comp:
            d = by_ccn.get(c[0])
            if d is None:
                continue
            v = num(d[data_col])
            flag = c[flag_col].strip()
            if v is None or flag not in ("0", "1"):
                continue
            joined += 1
            x = round(v / 100 if unit == "pct" else v, 6)
            concern = x >= cut if DIRECTION[metric] == "gte" else x <= cut
            if concern != (flag == "1"):
                if x != cut:
                    # Only a row AT the rounded cut can disagree because of CMS's 0.1 rounding. Anything else
                    # means a wrong column index, direction or file layout: fail loudly, never filter it away.
                    raise SystemExit(
                        f"{year} {metric}: CMS flag {flag} disagrees with the header cut {cut} at value {x} "
                        "(not a rounding tie) - check the column indexes, directions and file layout"
                    )
                tie_drops += 1  # an at-the-cut row CMS did not flag: rounding makes it ambiguous
                continue
            sides[flag == "1"].add((abs(x - cut), x))
        for flagged, distinct in sides.items():
            if len(distinct) < NEAREST:
                raise SystemExit(
                    f"{year} {metric}: only {len(distinct)} distinct {'flagged' if flagged else 'unflagged'} "
                    f"values out of {joined} joined rows - the join or a column index is wrong"
                )
        sys.stderr.write(f"{year} {metric}: {joined} joined rows, {tie_drops} rounding ties left out\n")
        picked = []
        for flagged, distinct in sides.items():
            ordered = sorted(distinct)  # nearest the cut first, so BOTH sides of the cut stay pinned
            keep = ordered[:NEAREST] + ordered[NEAREST::max(1, len(ordered) // SPREAD)]
            picked += [(x, flagged) for _, x in keep]
        metrics[metric] = [
            {"value": x, "pointAwarded": flagged} for x, flagged in sorted(picked)
        ]

    bounds = spending_bounds_cents(spending_headers)
    scored = []
    for c in comp:
        d = by_ccn.get(c[0])
        if d is None:
            continue
        total, score = num(d[TOTAL_SPENDING_COLUMN]), num(c[SPENDING_SCORE_COLUMN])
        if total is not None and score is not None:
            scored.append((round(total * 100), int(score)))
    scored.sort()
    pick = {scored[i] for i in range(0, len(scored), max(1, len(scored) // 60))}
    for b in bounds:  # exact boundaries: the rows closest to each octile bound, at or below and just above
        pick.add(min((p for p in scored if p[0] <= b), key=lambda p: b - p[0]))
        pick.add(min((p for p in scored if p[0] > b), key=lambda p: p[0] - b))
    return {
        "dataFiscalYear": year,
        "source": f"CMS SSVI file (CMS-1851-F): '{comp_file}' and '{data_file}'",
        "cutHeaders": {**cut_headers, "spending": spending_headers},
        "metrics": metrics,
        "spending": [{"totalCents": t, "points": p} for t, p in sorted(pick)],
    }


def main():
    unz, out = sys.argv[1], sys.argv[2]
    fixture = {
        "2025": build(2025, "508-Version-FY2025-Scoring-Components-FY2025-Data.csv", "508-Version-FY2025-Data.csv", 1, unz),
        "2024": build(2024, "508-Version-FY2024-Scoring-Components.csv", "508-Version-FY2024-Data.csv", 1, unz),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    main()
