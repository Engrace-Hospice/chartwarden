/**
 * More file names that hold a secret, by name (wave 8, T7(c); round-6 ADV6-14). `.envrc` and `env.sh` export variables, `secrets.json`
 * and its YAML kin are what they say, gcloud's `application_default_credentials.json` is a cloud credential, `.my.cnf` and
 * `.mylogin.cnf` hold a MySQL password. The editor copies of an env file (`.env~`, `.env.swp`, `.env.bak`) are read through
 * their original by `backup-names.ts`. `git ls-files` shows no tracked file with one of these names (checked when this was
 * written), so nothing the repo keeps is refused by them; a tracked file that gains such a name is a template or a decision for
 * a human. `.pgpass`, `.netrc`, `.npmrc` and `.pypirc` are in the main rule table already. Pure.
 */
export const EXTRA_SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)\.envrc$/i, "a live environment file (direnv exports it)"],
  // Only a path the repo or the working directory holds (relative): the agent's own scratch scripts sit at an absolute path or
  // behind a variable (`source $S/env.sh`: 16 such commands in the real corpus, a local container's URL and nothing else).
  [/^(?![/~$])(?:.*\/)?env\.sh$/i, "an environment script (it exports variables)"],
  [/(^|\/)secrets\.(json|ya?ml)$/i, "a secrets file"],
  [/(^|\/)application_default_credentials\.json$/i, "cloud credentials"],
  [/(^|\/)\.(my\.cnf|mylogin\.cnf)$/i, "a credentials file"],
];
