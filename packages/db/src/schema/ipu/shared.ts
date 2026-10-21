// @chartwarden/db — M37 IPU shared column helpers. Every M37 aggregate carries a `version bigint NOT NULL
// DEFAULT 0` optimistic-concurrency counter (§7.7 pattern shared across the corpus); this helper keeps
// the 26 table files DRY. The `mode: "number"` is safe — versions never exceed 2^53.
import { bigint } from "drizzle-orm/pg-core";

export const bigintVersion = () => bigint("version", { mode: "number" }).notNull().default(0);
