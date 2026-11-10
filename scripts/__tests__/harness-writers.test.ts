/**
 * Wave 3 (fixer W3b), ADV-M3 and ADV-M2: output writers the classifier had no model for, and the read-write
 * redirect `<>`. Every payload under an "asks" heading answered `allow` at the base of this wave (the writers the
 * second wave already closed are pinned in harness-bypasses). `classifyBash` is pure.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { extraOutputFiles, localPath } from "../harness/writers";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;
const H = "scripts/harness";

describe("a program that writes the file an option or operand names asks on a protected target", () => {
  it.each([
    `gpg -o ${H}/x -d f`,
    `gpg --output ${H}/x -d f`,
    `gpg --output=${H}/x -d f`,
    `gpg2 -o ${H}/x -d f`,
    `pg_restore -f ${H}/x a.dump`,
    `zip -x "*.o" -r ${H}/x.zip src`,
    `xxd -r a ${H}/x`,
    `xxd -r -p a ${H}/x`,
    `zip ${H}/x.zip a`,
    `zip -r ${H}/x.zip src`,
    `zip -O ${H}/x.zip a`,
    `tar cf ${H}/x.tar a`,
    `tar -cf ${H}/x.tar a`,
    `tar czf ${H}/x.tgz a`,
    `tar -czvf ${H}/x.tgz a`,
    `tar --create --file=${H}/x.tar a`,
    `tar -c --file ${H}/x.tar a`,
    `tar -rf ${H}/x.tar a`,
    `gtar cf ${H}/x.tar a`,
    `bsdtar -cf ${H}/x.tar a`,
    `pg_dump -f ${H}/x.sql db`,
    `pg_dump --file=${H}/x.sql db`,
    `pg_dumpall -f ${H}/x.sql`,
    `psql -o ${H}/x -c 'select 1'`,
    `psql --output=${H}/x -c 'select 1'`,
    `psql -L ${H}/x -c 'select 1'`,
    `sqlite3 ${H}/x.db 'select 1'`,
    `sqlite3 -cmd '.mode csv' ${H}/x.db 'select 1'`,
    `script -q ${H}/x ls`,
    `ditto a ${H}/x`,
    `ditto -x a.zip ${H}/`,
    `plutil -o ${H}/x a.plist`,
    `yq -i '.a=1' ${H}/x.yaml`,
    `echo x | sponge ${H}/x`,
    `echo x | sponge -a ${H}/x`,
    `curl -D ${H}/x http://localhost:1/`,
    `curl --dump-header ${H}/x http://localhost:1/`,
    `curl --trace ${H}/x http://localhost:1/`,
    `curl --trace-ascii ${H}/x http://localhost:1/`,
    `curl --stderr ${H}/x http://localhost:1/`,
    `curl -c ${H}/x http://localhost:1/`,
    `curl --cookie-jar ${H}/x http://localhost:1/`,
    `curl --libcurl ${H}/x http://localhost:1/`,
    `openssl rand -writerand ${H}/x 4`,
    `openssl s_client -connect localhost:1 -keylogfile ${H}/x`,
    `openssl s_client -connect localhost:1 -sess_out ${H}/x`,
    `rsync --log-file=${H}/x a b`,
    `rsync --backup-dir=${H} a b`,
    `rsync --write-batch=${H}/x a b`,
    `rsync -T ${H} a b`,
    `rsync --temp-dir=${H} a b`,
    `rsync a localhost:/repo/${H}/x`,
    `rsync a me@127.0.0.1:/repo/${H}/x`,
    `scp a localhost:/repo/${H}/x`,
    `cp -t${H}/ a`,
    `cp -at ${H} a`,
    `cp --target=${H} a`,
    `cp --targ=${H} a`,
    `rsync -avt a ${H}/`,
    `rsync -t a ${H}/`,
    `cp --target-directory=${H} a`,
    `mv --target=${H} a`,
    `mv -t${H} a`,
    `install --target=${H} a`,
    `ln -s -t${H} a`,
    "cd scripts && cp -tharness a",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "gpg -o /tmp/x -d f",
    "gpg -d f",
    "xxd f",
    "xxd -r a /tmp/o",
    "zip -r /tmp/out.zip src",
    "tar cf /tmp/x.tar src",
    "tar czf /tmp/x.tgz scripts/harness",
    "tar xf a.tar -C /tmp/x",
    "tar -tf a.tar",
    "tar tzf a.tgz",
    "pg_dump -f /tmp/x.sql db",
    "pg_dump db",
    "psql -o /tmp/out.txt -c 'select 1'",
    "psql -c 'select 1'",
    "sqlite3 :memory: 'select 1'",
    "sqlite3 /tmp/x.db 'select 1'",
    `sqlite3 -readonly ${H}/x.db 'select 1'`,
    "script -q /tmp/log ls",
    "ditto a /tmp/b",
    "plutil -p a.plist",
    "yq '.a' x.yaml",
    "yq -i '.a=1' /tmp/x.yaml",
    "echo x | sponge /tmp/x",
    "curl -D /tmp/h http://localhost:1/",
    "curl -c /tmp/c http://localhost:1/",
    "curl --trace /tmp/t http://localhost:1/",
    "openssl rand -writerand /tmp/x 4",
    "rsync -av src/ /tmp/dest/",
    "rsync -avt src/ /tmp/dest/",
    "rsync -t src/ /tmp/dest/",
    "rsync --log-file=/tmp/x a /tmp/b",
    "rsync a localhost:/tmp/x",
    "rsync a localhost:notes.txt",
    "scp a localhost:/tmp/x",
    "cp -t /tmp a",
    "cp -tdist a",
    "cp --target=/tmp a",
    "cp -rt /tmp a",
    "cp a b",
    "mv a b",
    "install -m 755 a /tmp/bin",
    "echo ok 1<>/tmp/x",
    "exec 3<>/tmp/x",
  ])("keeps the everyday %s allowed", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("a read-write redirect `<>` writes its file", () => {
  it.each([
    `echo evil 1<>${H}/x`,
    `echo evil <>${H}/x`,
    `cat <> ${H}/x`,
    `exec 3<>${H}/x; echo evil >&3`,
    `exec 3<>${H}/x`,
    "exec 3<>compliance/controls.yaml",
    "cd scripts && exec 4<> harness/x",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it("is still an input for the secret rule", () => {
    expect(d("cat <>apps/backend/.env")).toBe("deny");
  });
});

describe("the writer rules read one program's options", () => {
  it("returns the named files, in order, and nothing for a program without a rule", () => {
    expect(extraOutputFiles("gpg", ["-o", "a", "-d", "f"])).toEqual(["a"]);
    expect(extraOutputFiles("tar", ["cf", "a.tar", "src"])).toEqual(["a.tar"]);
    expect(extraOutputFiles("tar", ["xf", "a.tar"])).toEqual([]);
    expect(extraOutputFiles("tar", ["-czf", "a.tgz", "src"])).toEqual(["a.tgz"]);
    expect(extraOutputFiles("sqlite3", [":memory:", "select 1"])).toEqual([]);
    expect(extraOutputFiles("sqlite3", ["db", "select 1"])).toEqual(["db"]);
    expect(extraOutputFiles("zip", ["-r", "out.zip", "src"])).toEqual(["out.zip"]);
    expect(extraOutputFiles("cat", ["a"])).toEqual([]);
  });

  it("reads a spec that names this machine as a local path", () => {
    expect(localPath("localhost:/a/b")).toBe("/a/b");
    expect(localPath("me@127.0.0.1:/a/b")).toBe("/a/b");
    expect(localPath("localhost:a/b")).toBe("~/a/b");
    expect(localPath("example.com:/a/b")).toBe("example.com:/a/b");
    expect(localPath("/a/b")).toBe("/a/b");
  });
});
