---
paths:
  - "packages/db/migrations/**"
  - "packages/db/src/**"
---
# Migrations (loaded only when touching the database layer)

- Every PHI table follows the three-column tenancy rule, has RLS **enabled and FORCEd**, and has the
  audit trigger. `arch:tenancy` and `arch:fitness-gaps` decide; ECC's `database-migrations` and
  `postgres-patterns` skills are advice only.
- Check `bun run arch:migration-numbering` against `main` before picking a number. Branches collide
  on "next number".
- Mirror new enums and tables into `packages/db/src/enums.ts` / `packages/types` and into **both**
  manifests (`architecture/module-manifest.ts` and `.cjs`).
- Prove isolation live as the NOBYPASSRLS `chartwarden_app` role (`_live-app-role.ts`). A
  cross-tenant assertion on a superuser proves nothing.
- Migrations never contain data copied from production. Seed rows use synthetic identifiers.
- Retention and destruction changes must keep legal holds honoured (`test:m10:retention:live`,
  `test:m36:retention-destruction:live`), and they touch control CW-DS-01 in `compliance/controls.yaml`.
