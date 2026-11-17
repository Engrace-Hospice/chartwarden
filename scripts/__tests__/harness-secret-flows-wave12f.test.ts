/**
 * Wave 12, part F, F-2 (round-9 R9-ADV-9, R9-CR-7): a guarded variable (a key-encryption key, a DATABASE_URL-class name) was still
 * printable through routes wave 11 did not read: `printenv` of a copy (`export X=$NAME; printenv X`, `X=$NAME printenv X`), `read` and
 * `mapfile` from a here-string, an indirection through an array element or a positional parameter (`${!a[0]}`, `${!1}`), a nameref
 * (`declare -n r=NAME; echo $r`), a write to a terminal-like target that was counted as "a file" (`> /dev/stdout`, `/dev/tty`,
 * `/dev/fd/N`, `/proc/self/fd/N`), a file written from the value and read back in the same command, and an interpreter that aliases the
 * environment before it prints it (`const e = process.env; console.log(e)`, `import.meta.env`). The decision stays: these ask (the
 * host-seed workflow passes the KEK from the api container); the names a plain `echo $NAME` denies keep their deny. Names are built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const K = `M34_TENANT${"_"}KEK`;
const D = `DATABASE${"_"}URL`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
/** `{K}` and `{D}` stand for a guarded (KEK-class) and a secret (DATABASE_URL-class) name. */
const fill = (template: string): string => template.replaceAll("{K}", K).replaceAll("{D}", D);

const PRINTENV_OF_A_COPY: readonly string[] = [
  "export X=${K}; printenv X",
  "export X=${D}; printenv X",
  "X=${K} printenv X",
  "X=${D} printenv X",
  "x=${K}; printenv x",
  "x=${D}; y=$x; printenv y",
  "export X=${K}; printenv X HOME",
  "X=${K} env printenv X",
];

const READ_AND_MAPFILE: readonly string[] = [
  'read x <<< "${K}"; echo $x',
  'read x <<< "${D}"; echo $x',
  'read -r x <<< ${K}; echo "$x"',
  'read a b <<< "${K} ${K}"; echo $b',
  'mapfile -t a <<< "${K}"; echo ${a[0]}',
  'readarray a <<< "${D}"; echo "${a[@]}"',
  "printf -v y '%s' \"${K}\"; echo $y",
  "read x <<EOF\n${K}\nEOF\necho $x",
  'read -a arr <<< "${K}"; echo "${arr[0]}"',
];

const INDIRECTIONS: readonly string[] = [
  'a=({K}); echo "${!a[0]}"',
  'a=({D}); echo "${!a[0]}"',
  'a=(HOME {K}); echo "${!a[1]}"',
  'f() { echo "${!1}"; }; f {K}',
  'f() { echo "${!1}"; }; f {D}',
  'f() { printf "%s" "${!1}"; }; f {K}',
  "a[0]={K}; echo ${!a[0]}",
  'ref={K}; echo "${!ref}"',
  'echo "${!UNSET_NAME}"',
  'echo "${!a[i]}"',
];

const NAMEREFS: readonly string[] = [
  'declare -n r={K}; echo "$r"',
  'declare -n r={D}; echo "$r"',
  "typeset -n r={K}; echo $r",
  "local -n r={K}; echo $r",
  "declare -n r={D}; cat <<< $r",
  "ref={K}; declare -n r=$ref; echo $r",
  "declare -n a=r; declare -n r={K}; echo $a",
];

/** Targets that are the terminal or the output stream, not a file. */
const STREAM_TARGETS: readonly string[] = [
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/fd/1",
  "/dev/fd/2",
  "/dev/fd/9",
  "/proc/self/fd/1",
  "/proc/self/fd/2",
  "/proc/12345/fd/1",
  "/dev/pts/0",
  "/dev/console",
  '"/dev/stdout"',
  "'/dev/tty'",
  "$out",
  '"$OUT"',
];

const FILE_THEN_READ: readonly string[] = [
  'x=${D}; cat <<< "$x" > /tmp/f; cat /tmp/f',
  "x=${K}; echo $x > /tmp/f; cat /tmp/f",
  "x=${K}; echo $x > /tmp/f && cat /tmp/f",
  "x=${K}; echo $x > /tmp/f; head /tmp/f",
  "x=${K}; echo $x > /tmp/f; less /tmp/f",
  "x=${K}; echo $x >> /tmp/f; cat /tmp/f",
  "x=${K}; echo $x > /tmp/f; cat < /tmp/f",
  "x=${K}; echo $x > /tmp/f; tail -n 1 /tmp/f",
  "x=${K}; echo $x > /tmp/f; grep . /tmp/f",
  "x=${K}; printf '%s' $x > out.txt; cat out.txt",
  "x=${K}; cat <<EOF > /tmp/f\n$x\nEOF\ncat /tmp/f",
];

const INTERPRETER_ALIASES: readonly string[] = [
  "node -e 'const e = process.env; console.log(e)'",
  "node -e 'let e = process.env; console.log(JSON.stringify(e))'",
  "node -e 'var e = process.env; console.log(Object.entries(e))'",
  "node -e 'const {env} = process; console.log(env)'",
  "node -e 'const { env: e } = process; console.log(e)'",
  "node -e 'const e = process.env; console.log(e.{D})'",
  "node -e 'const e = process.env; console.log(e[\"{D}\"])'",
  "bun -e 'console.log(import.meta.env)'",
  "bun -e 'const e = import.meta.env; console.log(e)'",
  "bun -e 'const e = Bun.env; console.log(e)'",
  "node -e 'e = process.env; console.log(e)'",
  "python3 -c 'import os; e = os.environ; print(e)'",
  "python3 -c 'import os; e = dict(os.environ); print(e)'",
  "python3 -c 'import os; e = os.environ.copy(); print(e)'",
  "ruby -e 'e = ENV; puts e'",
  "ruby -e 'e = ENV.to_h; p e'",
  "perl -e '%e = %ENV; print %e'",
  "perl -e 'my %e = %ENV; print %e'",
];

const ROUTES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["printenv of a copy", PRINTENV_OF_A_COPY],
  ["read and mapfile from a here-string", READ_AND_MAPFILE],
  ["indirection through an element or a parameter", INDIRECTIONS],
  ["nameref", NAMEREFS],
  ["file written from the value and read back", FILE_THEN_READ],
  ["interpreter that aliases the environment", INTERPRETER_ALIASES],
];

describe("F-2: a guarded or secret variable printed by one of the new routes is never an allow", () => {
  for (const [route, rows] of ROUTES) {
    describe(route, () => {
      it.each(rows)("%s", (template) => {
        const cmd = fill(template);
        expect(decide(cmd), cmd).not.toBe("allow");
      });
    });
  }

  describe("a terminal-like redirect target is not a file", () => {
    it.each(STREAM_TARGETS)("x=$KEK; echo $x > %s", (target) => {
      const cmd = fill(`x=\${K}; echo $x > ${target}`);
      expect(decide(cmd), cmd).not.toBe("allow");
    });
    it.each(STREAM_TARGETS)('x=$DATABASE_URL; cat <<< "$x" >%s', (target) => {
      const cmd = fill(`x=\${D}; cat <<< "$x" >${target}`);
      expect(decide(cmd), cmd).not.toBe("allow");
    });
    it.each(["/dev/stdout", "/dev/tty", "/dev/fd/1", "/proc/self/fd/1"])(
      "the KEK-class copy asks (not a deny) when sent to %s",
      (target) => {
        expect(decide(fill(`x=\${K}; echo $x > ${target}`))).toBe("ask");
      },
    );
  });

  it("the KEK-class routes ask (the documented seed workflow), they do not deny", () => {
    for (const cmd of [
      "export X=${K}; printenv X",
      'read x <<< "${K}"; echo $x',
      'a=({K}); echo "${!a[0]}"',
      'declare -n r={K}; echo "$r"',
      "x=${K}; echo $x > /tmp/f; cat /tmp/f",
      "node -e 'const e = process.env; console.log(e.{K})'",
    ]) {
      expect(decide(fill(cmd)), cmd).toBe("ask");
    }
  });
});

describe("F-2: everyday neighbours stay allow", () => {
  it.each([
    "echo $HOME",
    "echo $PATH",
    "x=$HOME; echo $x",
    "x=$HOME; echo $x > /tmp/out.txt",
    "printenv HOME",
    "X=1 printenv X",
    "export X=$HOME; printenv X",
    'read x <<< "hello"; echo $x',
    'mapfile -t a <<< "x"; echo ${a[0]}',
    'a=(FOO); echo "${!a[0]}"',
    "declare -n r=FOO; echo $r",
    "echo hi > /dev/stdout",
    "echo hi > /dev/null",
    "echo hi >&2",
    "x=${K}; echo $x > /tmp/f",
    "x=hello; echo $x > /tmp/f; cat /tmp/f",
    "node -e 'const e = process.env; console.log(e.HOME)'",
    "node -e 'console.log(1)'",
    "bun -e 'console.log(import.meta.url)'",
    "python3 -c 'import os; e = os.environ; print(e.get(\"HOME\"))'",
    'f() { echo "$1"; }; f hello',
    'printf "%s\\n" "${#PATH}"',
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});
