/**
 * Wave 11, part D, D5 (round-8 R8-ADV-8): the secret-variable rule fired on the operands of `echo`, `printf`, `cat` and `printenv` only.
 * The same value reaches the transcript through a copy (`x=$M34_TENANT_KEK; echo $x`), a here-string or here-document fed to a printing
 * program, an indirect expansion (`${!K}`, `eval echo \$${K}_KEK`), `declare|typeset|export -p NAME`, and interpreter code that spells the
 * name in pieces, destructures it or prints it with `-p`. The new shapes ASK (the documented host-seed workflow passes M34_TENANT_KEK from
 * the api container); the names that were denied keep their deny (`echo $DATABASE_URL`), and the credential names the suffix lists missed
 * (MYSQL_PWD, REDISCLI_AUTH, MONGODB_URI) are denied like a password. Every name is built from parts where it could be read as a secret.
 */
import { describe, expect, it } from "vitest";
import { environmentLeak } from "../harness/env-shapes";
import { classifyBash } from "../harness/patterns";
import { isSecretVariable } from "../harness/secret-reads";

const K = `M34_TENANT${"_"}KEK`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{K}", K);

const COPIES_AND_ROUTES: readonly string[] = [
  "x=${K}; echo $x",
  'x="${K}"; echo "$x"',
  "x=${{K}}; echo $x",
  "export X=${K}; echo $X",
  "declare X=${K}; echo $X",
  "x=${K}; y=$x; echo $y",
  "x=${K}; printf '%s' \"$x\"",
  "x=${K}; echo $x | cat",
  "x=${K}; tee /tmp/out <<< $x",
  "cat <<< ${K}",
  'cat <<< "${K}"',
  "cat <<EOF\nvalue: ${K}\nEOF",
  "cat <<EOF\n$DATABASE_ADMIN_URL\nEOF",
  "tee /tmp/out <<EOF\n${K}\nEOF",
  "x=${K}; cat <<EOF\n$x\nEOF",
  "echo ${!UNKNOWN_NAME}",
  "cat <<< ${!UNKNOWN_NAME}",
  "tee /tmp/out <<< ${K}",
  "base64 <<< ${K}",
  "head -c 5 <<< ${K}",
  "awk '{print}' <<< ${K}",
  "K=M34_TENANT_KEK; echo ${!K}",
  "K=M34_TENANT_KEK; printf '%s' \"${!K}\"",
  "K=M34_TENANT; eval echo \\$${K}_KEK",
  "K=M34_TENANT_KEK; cat <<< ${!K}",
  "declare -p {K}",
  "typeset -p {K}",
  "export -p {K}",
  "declare -px {K}",
  "readonly -p {K}",
  "x=$DATABASE_URL; echo $x",
  "export X=$BETTER_AUTH_SECRET; echo $X",
  "declare -p BETTER_AUTH_SECRET",
  "cat <<< $STRIPE_SECRET_KEY",
];

describe("D5: a guarded or secret variable printed by a route other than `echo $NAME` is never an allow", () => {
  it.each(COPIES_AND_ROUTES)("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it("asks (a human approves a deliberate seed) rather than denying", () => {
    for (const template of [
      "x=${K}; echo $x",
      "cat <<< ${K}",
      "declare -p {K}",
      "K=M34_TENANT_KEK; echo ${!K}",
    ]) {
      expect(decide(fill(template)), template).toBe("ask");
    }
  });
});

const INTERPRETERS: readonly string[] = [
  "node -pe 'process.env.{K}'",
  "node -p 'process.env.{K}'",
  "node --print 'process.env.{K}'",
  "bun -p 'process.env.{K}'",
  "bun -pe 'Bun.env.{K}'",
  "node -p 'process.env[\"{K}\"]'",
  "node -e 'const {{K}:k}=process.env;console.log(k)'",
  "node -e 'const {{K}}=process.env;console.log({K})'",
  'bun -e \'console.log(process.env["M34_"+"TENANT_KEK"])\'',
  'bun -e \'console.log(Bun.env["M34_"+"TENANT_"+"KEK"])\'',
  'node -e \'console.log(process.env["M34_" + "TENANT_KEK"])\'',
  'perl -e \'print $ENV{"M34_"."TENANT_KEK"}\'',
  "perl -e 'print $ENV{M34_TENANT_KEK}'",
  'php -r \'echo getenv("M34_"."TENANT_KEK");\'',
  "php -r 'echo getenv(\"{K}\");'",
  "php -r 'echo $_ENV[\"{K}\"];'",
  'ruby -e \'puts ENV["M34_"+"TENANT_KEK"]\'',
  'python3 -c \'import os; print(os.getenv("M34_"+"TENANT_KEK"))\'',
  'python3 -c \'import os; print(os.environ["M34_" "TENANT_KEK"])\'',
  "python3 -c 'from os import environ; print(environ[\"{K}\"])'",
];

describe("D5: interpreter code that names a guarded variable in pieces, destructures it, or prints it with -p asks", () => {
  it.each(INTERPRETERS)("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("ask");
  });

  it.each([
    "python3 -c 'from os import environ; print(environ)'",
    "python3 -c 'from os import environ; print(dict(environ))'",
    "python3 -c 'from os import environ; import json; print(json.dumps(dict(environ)))'",
    "python3 -c 'from os import environ\nfor k, v in environ.items(): print(k, v)'",
    "python3 -c 'from os import environ\nfor k in environ: print(k)'",
    "python3 -c 'import os; print(os.environ)'",
  ])(
    "a whole environment printed through `environ` is a dump (deny), as `os.environ` already is: %s",
    (cmd) => {
      expect(decide(cmd)).toBe("deny");
    },
  );

  it("environmentLeak folds adjacent literals and reads a destructuring", () => {
    expect(environmentLeak("console.log(process.env['M34_'+'TENANT_KEK'])")).toBe("guarded");
    expect(environmentLeak("console.log(process.env['M34_' + 'TENANT_' + 'KEK'])")).toBe("guarded");
    expect(environmentLeak("const {M34_TENANT_KEK: k} = process.env")).toBe("guarded");
    expect(environmentLeak("console.log(process.env['HOME'])")).toBeNull();
    expect(environmentLeak("console.log('a' + 'b')")).toBeNull();
  });
});

describe("D5: credential names the suffix lists missed are denied like a password", () => {
  it.each([
    "MYSQL_PWD",
    "REDISCLI_AUTH",
    "MONGODB_URI",
    "MONGO_URL",
    "PROD_MONGODB_URI",
    "DATABASE_URI",
    "REDIS_AUTH",
  ])("echo $%s", (name) => {
    expect(decide(`echo $${name}`), name).toBe("deny");
    expect(decide(`printenv ${name}`), name).toBe("deny");
    expect(isSecretVariable(name), name).toBe(true);
  });

  it.each(["MYSQL_HOST", "REDISCLI_HOST", "MONGO_COLLECTION", "PWD", "OLDPWD", "HOME"])(
    "echo $%s is no secret",
    (name) => {
      expect(decide(`echo $${name}`), name).toBe("allow");
    },
  );
});

describe("D5: ordinary variables and the presence check stay allowed", () => {
  it.each([
    "echo $HOME",
    "echo $PATH",
    "x=$HOME; echo $x",
    'x=$PATH; echo "$x"',
    "K=HOME; echo ${!K}",
    "declare -p HOME",
    "export -p PATH",
    "cat <<< $HOME",
    "cat <<EOF\nhello $USER\nEOF",
    '[ -n "${K}" ] && echo set',
    'test -n "$DATABASE_URL" && echo set',
    "node -pe 'process.env.HOME'",
    "node -e 'console.log(process.env.HOME)'",
    "node -e 'const {HOME: h} = process.env; console.log(h)'",
    'bun -e \'console.log(process.env["HO"+"ME"])\'',
    "perl -e 'print $ENV{HOME}'",
    "php -r 'echo getenv(\"HOME\");'",
    "python3 -c 'import os; print(os.getenv(\"HOME\"))'",
    "x=1; y=$x; echo $y",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});
