/**
 * Wave 12, part F, F-7 (round-9 R9-CR-9, R9-ADV-18).
 *
 * psql interpolation. psql replaces `:name`, `:'name'` and `:"name"` in an argument of a backslash command by the value of a variable that
 * `-v name=value`, `\set name value` or `\gset` bound, so `psql -v c='host=<remote>' -c '\c :c'` connects to a host that no text names. A connect
 * command (`\c`, `\conn`, `\connect`) with such an argument asks (a `~/.psqlrc` binds too, so it asks whether or not the command line binds the name),
 * and so does a `dblink` call whose connection argument is one. This follows the psql manual: psql could not be run against a server here.
 *
 * redis-cli. `REPLICAOF host port`, `SLAVEOF`, `CLUSTER MEET host port`, `MIGRATE host port ...` and `FAILOVER TO host port` make the server that
 * redis-cli is connected to (a LOCAL one: `-h localhost`) open a connection OUT to a host the client never named. They ask, as words of the command
 * line and as commands on stdin (a here-string, a heredoc, a pipe). `REPLICAOF NO ONE`, a local or project-container host and every other command stay
 * allow. The command names are those of `redis-cli` 8.10 (`COMMAND`-level names: `redis-cli --help` lists none of them, the Redis command reference does).
 * Hosts are built from parts.
 */
import { describe, expect, it } from "vitest";
import { connectTargetOf } from "../harness/db-connect-commands";
import { redisOutboundTarget } from "../harness/db-target";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H);

const PSQL_VARIABLES: readonly string[] = [
  "psql -v c='host={H}' -c '\\c :c'",
  "psql -c \"\\set c 'host={H}'\" -c '\\c :c'",
  "psql <<< '\\set c host={H}\n\\c :c'",
  "psql -v h={H} -c '\\c \"host=\" :h'",
  "psql -v c='host={H}' -c \"\\c :'c'\"",
  "psql -v c='host={H}' -c '\\c :\"c\"'",
  "psql -v c='host={H}' -c '\\connect :c'",
  "psql -v c='host={H}' -c '\\conn :c'",
  "psql -v c='host={H}' -c '\\c -reuse-previous=on :c'",
  "psql -v h={H} -c '\\c host=:h'",
  "psql -v h={H} -c '\\c db user :h 5432'",
  "psql --set=c='host={H}' -c '\\c :c'",
  "psql --variable c='host={H}' -c '\\c :c'",
  "echo '\\c :c' | psql -v c='host={H}'",
  "psql -v c='host={H}' <<'EOF'\n\\c :c\nEOF",
  "psql -v c='host={H}' <<< '\\c :c'",
  "pgcli -c '\\c :c'",
  "usql -c '\\c :c'",
  "psql -v c='host={H} dbname=x' -c \"select dblink_connect(:'c')\"",
  "psql -v c='host={H} dbname=x' -c \"select * from dblink(:'c', 'select 1') as t(x int)\"",
  "psql -v c='host={H} dbname=x' -c \"select dblink_connect('l', :'c')\"",
  "psql -c '\\c :c'",
  "psql -c '\\gset' -c '\\c :c'",
  "psql -h localhost -c '\\c :c'",
];

const PSQL_EVERYDAY: readonly string[] = [
  "psql -c '\\c mydb'",
  "psql -c '\\c mydb user localhost 5432'",
  "psql -c '\\c postgres://u:pw@localhost:5432/db'",
  "psql -c '\\c postgres://localhost/db?sslmode=disable'",
  "psql -c '\\c host=localhost port=5432 dbname=x'",
  "psql -c '\\c -reuse-previous=on mydb'",
  "psql -c '\\c db :5432'",
  "psql -h localhost -c \"select :'x'\"",
  "psql -v x=1 -c 'select :x'",
  "psql -v x=1 -c '\\echo :x'",
  "psql -v x=1 -c '\\set y :x'",
  "psql -c \"select '::1'::inet\"",
  "psql -c 'select a::int from t'",
  "psql -c \"select dblink_connect('host=localhost dbname=x')\"",
  "psql -h localhost -d mydb -c 'select 1'",
  "psql -h localhost -f /tmp/x.sql",
];

describe("F-7: a psql variable in a connect command or a dblink call asks", () => {
  it.each(PSQL_VARIABLES)("%s is not an allow", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it("a variable in a connect command asks (the host is not in the text: not a deny)", () => {
    for (const template of [
      "psql -v c='host={H}' -c '\\c :c'",
      "psql <<< '\\c :c'",
      "psql -c \"select dblink_connect(:'c')\"",
    ]) {
      expect(decide(fill(template)), template).toBe("ask");
    }
  });

  it.each(PSQL_EVERYDAY)("%s stays allow", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("connectTargetOf reads the colon forms in the arguments of a connect command only", () => {
    for (const text of ["\\c :c", "\\c :'c'", '\\c :"c"', "\\conn -reuse-previous=on :x"]) {
      expect(connectTargetOf("psql", [text]), text).toMatchObject({ kind: "variable" });
    }
    for (const text of [
      "\\c db",
      "\\c postgres://u:pw@localhost/db",
      "\\echo :x",
      "select :'x'",
      "\\c db :5432",
      "\\c a::b",
    ]) {
      expect(connectTargetOf("psql", [text]), text).toBeNull();
    }
  });

  it("a variable as the host of a conninfo is read as the unplaceable host it is (a deny already)", () => {
    expect(connectTargetOf("psql", ["\\connect host=:h"])).not.toBeNull();
  });

  it("a remote host named next to a variable is still the finding that denies", () => {
    expect(connectTargetOf("psql", [`\\c host=${H} :c`])).toMatchObject({ kind: "remote" });
  });
});

const REDIS_OUTBOUND: readonly string[] = [
  "redis-cli -h localhost replicaof {H} 6379",
  "redis-cli -h localhost REPLICAOF {H} 6379",
  "redis-cli -h localhost slaveof {H} 6379",
  "redis-cli -h localhost SLAVEOF {H} 6379",
  "redis-cli -h localhost -p 6380 -n 0 replicaof {H} 6379",
  "redis-cli cluster meet {H} 7000",
  "redis-cli CLUSTER MEET {H} 7000",
  "redis-cli -c cluster meet {H} 7000 17000",
  "redis-cli migrate {H} 6379 key 0 5000",
  "redis-cli -h localhost MIGRATE {H} 6379 '' 0 5000 KEYS a b",
  "redis-cli failover to {H} 6379",
  "redis-cli -u redis://localhost:6379 replicaof {H} 6379",
  "valkey-cli -h localhost replicaof {H} 6379",
  "redis-cli replicaof $HOST 6379",
  "redis-cli replicaof $(cat /tmp/h) 6379",
  "redis-cli <<< 'REPLICAOF {H} 6379'",
  "redis-cli <<< 'cluster meet {H} 7000'",
  "echo 'REPLICAOF {H} 6379' | redis-cli",
  "echo 'SLAVEOF {H} 6379' | redis-cli -h localhost",
  "printf 'GET x\\nMIGRATE {H} 6379 k 0 100\\n' | redis-cli",
  "redis-cli <<'EOF'\nGET x\nREPLICAOF {H} 6379\nEOF",
  "valkey-cli <<< 'SLAVEOF {H} 6379'",
];

const REDIS_EVERYDAY: readonly string[] = [
  "redis-cli -h localhost ping",
  "redis-cli get replicaof",
  "redis-cli set slaveof x",
  "redis-cli replicaof no one",
  "redis-cli REPLICAOF NO ONE",
  "redis-cli slaveof no one",
  "redis-cli replicaof localhost 6380",
  "redis-cli replicaof 127.0.0.1 6380",
  "redis-cli replicaof valkey 6379",
  "redis-cli cluster info",
  "redis-cli cluster nodes",
  "redis-cli cluster meet localhost 7000",
  "redis-cli migrate localhost 6380 key 0 100",
  "redis-cli failover",
  "redis-cli failover abort",
  "redis-cli failover to localhost 6380",
  "redis-cli <<< 'GET x'",
  "redis-cli <<< 'REPLICAOF NO ONE'",
  "echo 'SET a 1' | redis-cli -h localhost",
  "redis-cli info replication",
  "redis-cli -h localhost keys '*'",
];

describe("F-7: a Redis command that makes the server connect out to a host asks", () => {
  it.each(REDIS_OUTBOUND)("%s asks", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("ask");
  });

  it.each(REDIS_EVERYDAY)("%s stays allow", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("redisOutboundTarget reads the command by name, case-insensitively, and the host it names", () => {
    expect(redisOutboundTarget(["REPLICAOF", H, "6379"])).toEqual({ kind: "outbound", subject: H });
    expect(redisOutboundTarget(["slaveof", H, "6379"])).toEqual({ kind: "outbound", subject: H });
    expect(redisOutboundTarget(["Cluster", "Meet", H, "7000"])).toEqual({
      kind: "outbound",
      subject: H,
    });
    expect(redisOutboundTarget(["MIGRATE", H, "6379", "k", "0", "10"])).toEqual({
      kind: "outbound",
      subject: H,
    });
    expect(redisOutboundTarget(["failover", "TO", H, "6379"])).toEqual({
      kind: "outbound",
      subject: H,
    });
    expect(redisOutboundTarget(["replicaof", "no", "one"])).toBeNull();
    expect(redisOutboundTarget(["replicaof"])).toBeNull();
    expect(redisOutboundTarget(["cluster", "info"])).toBeNull();
    expect(redisOutboundTarget(["get", "replicaof"])).toBeNull();
    expect(redisOutboundTarget(["replicaof", "localhost", "6379"])).toBeNull();
    expect(redisOutboundTarget(["migrate", "valkey", "6379"])).toBeNull();
    expect(redisOutboundTarget([])).toBeNull();
  });

  it("a remote host named by -h is still the finding that denies, whatever command follows", () => {
    expect(decide(fill("redis-cli -h {H} replicaof localhost 6379"))).toBe("deny");
  });

  it("a text of several lines is read line by line", () => {
    expect(connectTargetOf("redis-cli", [`GET x\r\nCLUSTER MEET ${H} 7000\r\n`])).toMatchObject({
      kind: "outbound",
    });
    expect(connectTargetOf("redis-cli", ["GET x\nSET y 2\n"])).toBeNull();
  });
});
