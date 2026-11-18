/**
 * Short options of the container engines with their value attached or clustered (wave 13 part B2; round-10 B3).
 * ------------------------------------------------------------------------------------------------
 * `docker -c prod ps` names the context `prod` and asks; `docker -cprod ps`, `docker -c=prod ps` and `docker -Dc prod ps` name the same context and passed, because
 * `remote-access.ts` read only the bare letter. pflag (which docker, podman and compose use) reads `-cprod` as `-c prod`, `-c=prod` the same, and a cluster
 * `-Dcprod` as the flag `-D` and then `-c prod`. The letters are RECORDED (rule 12): `docker --help` (Docker 29.9.3), `podman --help` (6.0.2) and
 * `docker-compose --help` (5.1.0), in `scripts/__tests__/fixtures/harness-engine-options/`, re-recorded by `helpers/record-engine-options.ts`. nerdctl
 * (`-n`, `-a`, `-H`) and podman's hidden `-r` are from the documentation and UNVERIFIED (not installed here). Pure.
 */

export interface EngineLetters {
  /** Letters that take a value: attached (`-cprod`), after an equals sign (`-c=prod`) or as the next word. */
  readonly valued: string;
  /** Letters that take none and may stand in front of a valued one in a cluster. */
  readonly flags: string;
}

export const ENGINE_LETTERS: Readonly<Record<string, EngineLetters>> = {
  docker: { valued: "Hcl", flags: "Dv" },
  podman: { valued: "c", flags: "vr" },
  "docker-compose": { valued: "fp", flags: "" },
  nerdctl: { valued: "Han", flags: "D" },
  "podman-compose": { valued: "fp", flags: "" },
};

/** The valued letter of a short-option word (`-cprod`, `-c=prod`, `-Dcprod`, `-Dc`) and its value, or null for the value that is the next word. */
export interface ShortValue {
  readonly letter: string;
  readonly value: string | null;
}

/** The first valued letter in `arg` (a single-dash word) and the value attached to it; undefined when `arg` has none the engine's letters know. */
export function shortValue(prog: string, arg: string): ShortValue | undefined {
  const letters = ENGINE_LETTERS[prog];
  if (letters === undefined || !/^-[^-]/.test(arg)) return undefined;
  for (let i = 1; i < arg.length; i++) {
    const letter = arg[i] as string;
    if (letters.flags.includes(letter)) continue;
    if (!letters.valued.includes(letter)) return undefined;
    const rest = arg.slice(i + 1).replace(/^=/, "");
    return { letter, value: i + 1 < arg.length ? rest : null };
  }
  return undefined;
}
