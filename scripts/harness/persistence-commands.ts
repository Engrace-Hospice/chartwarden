/**
 * Commands that arrange for something to run later, without a write the file rules see (wave 10, B12; round-7 R7-ADV-22).
 * `cp` into `~/Library/LaunchAgents` and `launchctl load` already ask. The same persistence by other tools was allowed:
 * `defaults write ~/Library/LaunchAgents/x ProgramArguments -array /tmp/x` and `plutil -insert ... LaunchAgents/x.plist` write a
 * launch job's plist, `crontab FILE` and `crontab -` install a cron table, `at now <<< id` queues a command, and `osascript -e 'tell
 * app "Terminal" to do script ...'` types a command into a terminal. Each asks: a human decides whether the agent may leave
 * something behind that runs outside the session. Reading (`crontab -l`, `atq`, `defaults read`, `plutil -p`) is not. Pure.
 */
const LAUNCH_DIRECTORY = /\bLaunch(?:Agents|Daemons)\b/i;
const PLUTIL_WRITES = /^-(?:insert|replace|remove|create|convert)$/;
const AT_READS = /^(?:-l|-c|-d)$/;
/** `do script`, JXA's `doScript`, iTerm's `write text`, a typed `keystroke`, a login item, a launch job. */
const OSASCRIPT_RUNS =
  /\bdo\s+(?:shell\s+)?script\b|\bdoScript\b|\bwrite\s+text\b|\bkeystroke\b|\blogin\s+item\b|\bcreate\s+launch/i;
/** A script FILE runs unread (`osascript run.scpt`): it may do any of the above. */
const SCRIPT_FILE = /\.(?:scpt|scptd|applescript|jxa)$/i;
/** A property-list editor's change (`PlistBuddy -c "Add :Label string x" FILE`). */
const PLISTBUDDY_CHANGES = /^(?:add|set|delete|import|merge|copy|clear)\b/i;
const LOGIN_HOOKS = /\b(?:LoginHook|LogoutHook)\b/;
const REMOTE_ACCESS_SETTING = /^-setremote(?:login|appleevents)$/i;
const DIRECTORY_SERVICE_CHANGE = /^-(?:create|append|merge|delete|passwd|change)$/;

const reason = (what: string): string =>
  `${what} arranges for a command to run later, outside this session (a launch job, a cron table, a queued command, a typed one). A human decides.`;

/** Why this command line asks, or null when it only reads or is not one of these. `texts` is what is handed to it inline. */
export function persistenceReason(
  prog: string,
  args: readonly string[],
  texts: readonly string[],
): string | null {
  if (prog === "PlistBuddy") {
    const changes = args.some((a) => PLISTBUDDY_CHANGES.test(a));
    return changes && args.some((a) => LAUNCH_DIRECTORY.test(a))
      ? reason("`PlistBuddy` changing a launch job's property list")
      : null;
  }
  // Remote access and directory-service accounts: an administrator's change that outlives the session.
  if (prog === "systemsetup") {
    const turnsOn =
      args.some((a) => REMOTE_ACCESS_SETTING.test(a)) && args.some((a) => /^on$/i.test(a));
    return turnsOn ? reason("`systemsetup` turning a remote access service on") : null;
  }
  if (prog === "dscl") {
    return args.some((a) => DIRECTORY_SERVICE_CHANGE.test(a))
      ? reason("`dscl` changing a directory-service record")
      : null;
  }
  if (prog === "defaults") {
    const writes = args.some((a) => /^(?:write|import|delete|rename)$/.test(a));
    if (writes && args.some((a) => LOGIN_HOOKS.test(a))) {
      return reason("`defaults` setting a login or logout hook");
    }
    return writes && args.some((a) => LAUNCH_DIRECTORY.test(a))
      ? reason("`defaults` writing a launch job's property list")
      : null;
  }
  if (prog === "plutil") {
    const changes = args.some((a) => PLUTIL_WRITES.test(a));
    return changes && args.some((a) => LAUNCH_DIRECTORY.test(a))
      ? reason("`plutil` changing a launch job's property list")
      : null;
  }
  if (prog === "crontab") {
    if (args.includes("-l")) return null;
    // `-u USER` names a user, not a file; any other word is the table to install, `-` is standard input.
    const operands = args.filter(
      (a, k) => (!a.startsWith("-") || a === "-") && args[k - 1] !== "-u",
    );
    const installs = operands.length > 0 || args.includes("-e") || args.includes("-r");
    return installs ? reason("`crontab`") : null;
  }
  if (prog === "at" || prog === "batch") {
    if (args.some((a) => AT_READS.test(a))) return null;
    return reason(`\`${prog}\``);
  }
  if (prog === "osascript") {
    const code = [...args, ...texts].join("\n");
    return OSASCRIPT_RUNS.test(code) || args.some((a) => SCRIPT_FILE.test(a))
      ? reason("`osascript` running a script or typing into an application")
      : null;
  }
  return null;
}
