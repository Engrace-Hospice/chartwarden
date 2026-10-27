# 17 — Technical debt

Prioritized debt is distinguished from production blockers:

| Theme | Evidence | Risk | Treatment |
|---|---|---|---|
| Lint backlog mixes mechanical and behavioral diagnostics | CW-QA-0003 | hides useful signal | split/fix behavioral first, ratchet remainder |
| Frontend eager graph | CW-QA-0004/0005 | field performance | route/vendor chunking and valid budgets |
| Browser coverage architecture | CW-QA-0008 | integration/a11y escapes | separate web/admin/portal projects and data fixtures |
| Python dependency lifecycle | CW-QA-0009/0010 | nondeterminism | locked graph + mandatory pytest/golden corpus |
| Live-suite role lifecycle | CW-QA-0015 | flakiness | canonical helper only |
| Status/document heuristics | CW-QA-0018 | false readiness signals | derive capability assertions from code/tests |
| Single-host resource policy | CW-QA-0012 | correlated outages | measured limits/reservations/alerts |

No broad rewrite is recommended. The architecture-fitness system, module ownership, typed seams,
RLS helpers, and generated reports are valuable; corrections should extend those ratchets. The
highest return is making existing controls mandatory and fixing semantic boundary defects rather
than replacing frameworks.
