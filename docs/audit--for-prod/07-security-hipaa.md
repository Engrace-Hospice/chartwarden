# 07 — Security and HIPAA

## Security assessment

No P0 cross-tenant PHI disclosure, hardcoded production credential, private key, practical SQL/XSS/
command exploit, or critical dependency advisory was confirmed. The baseline RLS suite passed under
the real application role, and architecture gates covered authorization composition and unverified
header use. Secret-pattern hits were documentation examples or synthetic fixtures and are not copied
here.

Confirmed/reviewed risks:

- `CW-QA-0014`: clinical free text can temporarily reside in plaintext `sessionStorage`.
- `CW-QA-0002`: security/live suites are not mandatory before production release.
- `CW-QA-0009`/`0010`/`0011`: nondeterministic Docling dependencies, absent pytest CI, and mutable
  infrastructure images weaken the supply chain.
- `CW-QA-0013`/`0017`: contingency/integrity controls are not production-ready.

## HIPAA framing

45 CFR 164.308 requires administrative safeguards including risk analysis, security management,
incident procedures, contingency planning, and evaluation. 45 CFR 164.312 covers access control,
audit controls, integrity, authentication, and transmission security. The repository contains
technical implementations addressing each theme, but code inspection cannot establish workforce
training, BAAs, sanction policy, facility controls, risk acceptance, incident exercises, backup
operations, or effective use in production.

Sources: [45 CFR 164.308](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.308)
and [45 CFR 164.312](https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312).

Verdict: technical posture is substantial but **HIPAA compliance is not certified**. Operational
evidence, production configuration, penetration testing, and a documented risk analysis remain
required.
