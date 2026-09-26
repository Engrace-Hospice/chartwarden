// scripts/db/lib/step-up.ts — the seeds' stand-in for a live step-up ceremony.
//
// Step-up-gated writes (care-plan signing, claim submission) check `step_up_recent`, which reads the
// acting session's `last_step_up_at` / `last_step_up_factor`. A seed cannot answer a TOTP/WebAuthn
// challenge, so this writes the same two fields a completed step-up writes (`login-mfa-completed.ts`'s
// paired write, D8) on the user's most recent session, valid for `STEP_UP_POLICY.defaultMaxAgeSec`
// (300 s) — call it immediately before the gated request. Dev/demo seeding only.
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

export async function stepUpSession(userId: string): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("SET session_replication_role = replica");
    await db.query(
      `UPDATE session SET last_step_up_at = now(), last_step_up_factor = 'totp'
       WHERE id = (SELECT id FROM session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [userId],
    );
  } finally {
    await db.end();
  }
}
