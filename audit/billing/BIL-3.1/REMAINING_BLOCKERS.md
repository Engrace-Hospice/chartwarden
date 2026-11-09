# Remaining blockers

- **Certification:** private PostgreSQL application-role/RLS validation remains pending.
- **History completeness:** old records without durable resolution/delivery evidence correctly show partial or unavailable history.
- **Payer search:** bounded protected-summary scan (500 rows per page) is deliberate; users may continue through older pages. A normalized indexed payer key may be considered later if volume requires it.
- No tenant recovery mutation or financial action is exposed.
