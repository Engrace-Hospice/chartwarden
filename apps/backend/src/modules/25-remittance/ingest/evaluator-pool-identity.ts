/**
 * The isolated evaluator builds three database pools from three secret files. Nothing else proves which login each
 * one actually connected as, so a swapped or wrong URL file (an app-reader URL naming a superuser or BYPASSRLS login,
 * a writer URL naming another login) would run silently with the wrong authority. Assert it once at boot and fail
 * closed; the evaluator never serves a command from a pool whose identity is wrong.
 */
export interface PoolIdentityExecutor {
  execute(query: unknown): Promise<{ readonly rows: readonly unknown[] }>;
}

interface IdentityRow {
  readonly name: string;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
}

export async function assertEvaluatorPoolIdentity(
  executor: PoolIdentityExecutor,
  query: unknown,
  label: string,
  expectedLogin?: string,
): Promise<void> {
  const { rows } = await executor.execute(query);
  const row = rows[0] as IdentityRow | undefined;
  if (!row) throw new Error(`${label} pool identity could not be read`);
  if (row.rolsuper || row.rolbypassrls)
    throw new Error(`${label} pool must not connect as a superuser or BYPASSRLS login`);
  if (expectedLogin !== undefined && row.name !== expectedLogin)
    throw new Error(`${label} pool must connect as ${expectedLogin}`);
}
