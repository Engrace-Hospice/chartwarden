/**
 * The whole hook object of Claude's pinned hooks, not only its `command` and `timeout` (wave 8, T9(a); round-6 ADV6-11).
 * `arch:compliance` pins each hook COMMAND byte for byte, but a hook object carries more keys than that, and a key the
 * gate did not read could change what Claude Code does with a pinned command: `"if": "Bash(zzz-never)"` (the hook runs only
 * for a call that never happens), `"shell": "powershell"`, `"once": true`, `"asyncRewake"`, a `"type"` of `"prompt"` or
 * `"http"` (the pinned text is no longer run as a command), and a second hook after the guard in the same group. Whether
 * this Claude Code honours each of those was not verified; the gate refuses them all. A hook object holds exactly `type`
 * (`"command"`), `command` and `timeout`, plus `async` for the ledger (which never decides anything); a group holds `matcher` and
 * the ONE hook; a group that runs a pinned script holds nothing else. Pure.
 */

export interface PinnedHook {
  readonly event: string;
  readonly script: string;
}

/** The keys a pinned hook object may hold, by event: the ledger is async; nothing else is. */
const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  PreToolUse: ["type", "command", "timeout"],
  PostToolUse: ["type", "command", "timeout", "async"],
  Stop: ["type", "command", "timeout"],
};

const GROUP_KEYS: readonly string[] = ["matcher", "hooks"];

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** The violations in the groups of `settings.hooks[pin.event]` that run `pin.script`; none for a settings text without them. */
export function hookObjectViolations(settings: unknown, pins: readonly PinnedHook[]): string[] {
  const out: string[] = [];
  const hooks = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks : {};
  for (const pin of pins) {
    const script = `scripts/harness/${pin.script}.ts`;
    const groups = Array.isArray(hooks[pin.event]) ? (hooks[pin.event] as unknown[]) : [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      const runs = group.hooks.some(
        (h) => isRecord(h) && typeof h.command === "string" && h.command.includes(script),
      );
      if (!runs) continue;
      const where = `.claude/settings.json: the ${pin.event} group that runs ${script}`;
      const strayKeys = Object.keys(group).filter((k) => !GROUP_KEYS.includes(k));
      if (strayKeys.length > 0)
        out.push(
          `${where} has the key(s) ${strayKeys.map((k) => `\`${k}\``).join(", ")}; a group holds only \`matcher\` and \`hooks\``,
        );
      if (group.hooks.length !== 1)
        out.push(`${where} holds ${group.hooks.length} hooks; it must hold exactly the pinned one`);
      for (const hook of group.hooks) {
        if (!isRecord(hook)) {
          out.push(`${where} has a hook that is not an object`);
          continue;
        }
        const allowed = ALLOWED_KEYS[pin.event] ?? [];
        const extra = Object.keys(hook).filter((k) => !allowed.includes(k));
        if (extra.length > 0)
          out.push(
            `${where} has the hook key(s) ${extra.map((k) => `\`${k}\``).join(", ")}; the hook object holds exactly ${allowed.map((k) => `\`${k}\``).join(", ")} (a key the gate does not read can change what Claude Code does with the pinned command)`,
          );
        if (hook.type !== "command")
          out.push(
            `${where} has a hook of type ${JSON.stringify(hook.type)}; it must be \`"command"\``,
          );
      }
    }
  }
  return out;
}
