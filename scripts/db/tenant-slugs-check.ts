/**
 * Lists organizations whose slug fails the tenant-slug rules (ADR-0049 D3), so they can be renamed by hand
 * (the rename records an alias); the guard trigger only checks a slug when it changes. Read-only. Exits 1 when any slug fails.
 *
 *   DATABASE_URL=postgres://… bun run scripts/db/tenant-slugs-check.ts
 */
import { Client } from "pg";
import { validateTenantSlug } from "../../packages/types/src/tenant-slug";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("tenant-slugs-check: DATABASE_URL is required");
  process.exit(2);
}

const db = new Client({ connectionString: url });
await db.connect();
try {
  const { rows } = await db.query<{ id: string; slug: string; status: string }>(
    "SELECT id, slug, status FROM organization ORDER BY slug",
  );
  const failing = rows.flatMap((row) => {
    const result = validateTenantSlug(row.slug);
    return result.ok ? [] : [{ ...row, reason: result.reason }];
  });
  for (const f of failing) console.log(`${f.id}  ${f.status.padEnd(9)} ${f.slug}  (${f.reason})`);
  console.log(`tenant-slugs-check: ${failing.length} of ${rows.length} slug(s) fail the rules`);
  process.exitCode = failing.length > 0 ? 1 : 0;
} finally {
  await db.end();
}
