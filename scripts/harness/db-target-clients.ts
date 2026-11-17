/**
 * The database clients whose connection target the guard reads, and how each spells it (wave 9, W9-1). Data only: the
 * reader is `db-target.ts`. For each client: which option letters and long options take a value (so a SQL string or a
 * file name is never read as a host), which of them name the host, which carry a whole connection string (a URI, or a
 * libpq `key=value` string), which name an alias or a file that holds the host (a service, a login path, a DSN alias),
 * what a positional word means, and which environment variables name the host. A client option this table does not list
 * is read as a flag, but a host option (`-h`, `--host`, `--uri`, ...) is also looked for in every word, whatever value
 * the reader skipped before it (wave 10, B4), so a wrong flag/value entry cannot hide a later host. The PostgreSQL and
 * redis-cli entries are widened by the options the real programs report (`db-target-flags.ts`). The other clients' tables
 * are from their documentation and unverified: none of them is installed on the machine this was written on.
 */
import { MORE_CLIENT_SPECS } from "./db-target-clients-more";
import { VERIFIED_OPTIONS } from "./db-target-flags";

/** How a client's non-option words are read. */
export type PositionalMode =
  /** A libpq tool: a word with `=` is a connection string, a URI is a URI, anything else is a database name. */
  | "libpq"
  /** Only a URI (`scheme://...`) names a target. */
  | "uri"
  /** `host`, `host:port/db`, `user@host`: a word that looks like an address is one (a plain word is a database name). */
  | "address"
  /** The first word is the host (`cqlsh HOST [PORT]`). */
  | "host"
  /** Nothing positional names a target. */
  | "none";

export interface TargetClient {
  /** Letters of options that take a value (the rest of the word, or the next word). */
  readonly valueShort: string;
  /** Letters whose value is only ever the rest of the word (`mysql -pSECRET`); the next word is not theirs. */
  readonly attachedShort?: string;
  /** Long options (without `--`) that take a value. */
  readonly valueLong: readonly string[];
  readonly hostShort?: string;
  readonly hostLong: readonly string[];
  /** Options whose value is a connection string (URI, or libpq string for a libpq client). */
  readonly stringShort?: string;
  readonly stringLong: readonly string[];
  /** A bare value of a connection-string option is an address, not a database name (`trino --server host:8080`). */
  readonly bareStringIsHost?: boolean;
  /** Options whose value is a URI or the name of an alias in a config file (`pgcli -D prod`): an alias is indirect. */
  readonly aliasShort?: string;
  readonly aliasLong?: readonly string[];
  /** Options whose value names a file or a login that holds the host (`--login-path`, `--defaults-file`). */
  readonly indirectLong?: readonly string[];
  readonly positional: PositionalMode;
  readonly hostEnv: readonly string[];
  /** Environment variables whose value is a connection string. */
  readonly urlEnv?: readonly string[];
  /** Environment variables that name a service, or a file that holds the host or its password. */
  readonly indirectEnv: readonly string[];
  /** `-S host,1433` (sqlcmd): the comma separates the port, not another host. */
  readonly commaIsPort?: boolean;
  /** `redis-cli --cluster check HOST:PORT`: a `host:port` word after `--cluster` is a host. */
  readonly clusterWords?: boolean;
  /** Long options (exact names) that take no value. An exact flag wins over a prefix of a longer value option (`--tls`). */
  readonly flagLong?: readonly string[];
  /** The client reads a long option by its exact name only (no getopt abbreviation): `--tls` is never `--tls-ciphers`. */
  readonly exactLong?: boolean;
  /** `rs0/host1,host2`: a replica-set name and a slash precede the host list (MongoDB tools only). */
  readonly replicaSet?: boolean;
  /** The table is proven against the real program (`db-target-flags.ts`, the recorded fixtures): an unknown option there is a finding. */
  readonly verified?: true;
  /** A `$VAR` or substitution word in a positional place may be a connection string: it cannot be placed, so a human decides. */
  readonly positionalVariable?: boolean;
}

const LIBPQ_ENV: Pick<TargetClient, "hostEnv" | "urlEnv" | "indirectEnv"> = {
  hostEnv: ["PGHOST", "PGHOSTADDR"],
  // libpq expands a URI or a connection string held in PGDATABASE the way it expands the dbname argument (R7-ADV-23, unverified).
  urlEnv: ["PGDATABASE"],
  indirectEnv: ["PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"],
};

/** A libpq tool: `-h`/`--host`, a connection string behind `-d`/`--dbname`, the same environment variables. */
const libpq = (spec: Partial<TargetClient> & Pick<TargetClient, "valueShort">): TargetClient => ({
  valueLong: [],
  hostShort: "h",
  hostLong: ["host"],
  stringShort: "d",
  stringLong: ["dbname"],
  positional: "libpq",
  ...LIBPQ_ENV,
  ...spec,
});

const MYSQL_INDIRECT = ["login-path", "defaults-file", "defaults-extra-file"];

/** The mysql family: `-h`/`--host`, `-pPASSWORD` attached, a login path or defaults file that may name the host. */
/** Flags of the mysql family (documentation, unverified): listed so `mysql --batch --silent db` places its database name. */
const MYSQL_FLAGS = [
  "batch",
  "raw",
  "silent",
  "skip-column-names",
  "vertical",
  "table",
  "verbose",
  "force",
  "no-defaults",
  "compress",
  "html",
  "xml",
  "quick",
  "single-transaction",
  "routines",
  "triggers",
  "events",
  "no-data",
  "no-create-info",
  "add-drop-table",
  "all-databases",
  "databases",
  "complete-insert",
  "skip-lock-tables",
  "hex-blob",
  "skip-comments",
  "ssl",
  "help",
  "version",
  "binary-mode",
  "auto-rehash",
  "no-auto-rehash",
  "column-names",
  "comments",
  "unbuffered",
  "wait",
  "reconnect",
  "safe-updates",
  "one-database",
  "secure-auth",
];

const mysqlTool = (valueShort: string, valueLong: readonly string[] = []): TargetClient => ({
  valueShort,
  flagLong: MYSQL_FLAGS,
  attachedShort: "p",
  valueLong: ["host", "port", "user", "socket", "protocol", ...MYSQL_INDIRECT, ...valueLong],
  hostShort: "h",
  hostLong: ["host"],
  stringLong: [],
  indirectLong: MYSQL_INDIRECT,
  positional: "uri",
  hostEnv: ["MYSQL_HOST"],
  indirectEnv: [],
});

const redisTool: TargetClient = {
  valueShort: "hpsaunridD",
  valueLong: [
    "user",
    "pass",
    "cacert",
    "cacertdir",
    "cert",
    "key",
    "sni",
    "eval",
    "functions-rdb",
    "rdb",
    "cluster",
    "count",
    "pattern",
    "quoted-pattern",
    "intrinsic-latency",
    "memkeys-samples",
    "tls-ciphers",
    "tls-ciphersuites",
  ],
  hostShort: "h",
  hostLong: ["host"],
  stringShort: "u",
  stringLong: ["uri"],
  positional: "none",
  hostEnv: [],
  indirectEnv: [],
  clusterWords: true,
  exactLong: true,
};

const MONGO_VALUE_LONG = [
  "port",
  "username",
  "authenticationDatabase",
  "authenticationMechanism",
  "eval",
  "file",
  "tlsCAFile",
  "tlsCertificateKeyFile",
  "tlsCertificateKeyFilePassword",
  "tlsCRLFile",
  "gssapiServiceName",
  "awsAccessKeyId",
  "awsSecretAccessKey",
  "awsIamSessionToken",
  "keyVaultNamespace",
  "kmsURL",
  "apiVersion",
  "connectTimeoutMS",
  "serverSelectionTimeoutMS",
];

/** Flags of the MongoDB shell and tools (documentation, unverified): listed so an everyday `mongosh --quiet script.js` places. */
const MONGO_FLAGS = [
  "quiet",
  "nodb",
  "norc",
  "shell",
  "json",
  "ipv6",
  "tls",
  "ssl",
  "verbose",
  "retryWrites",
  "gzip",
  "drop",
  "help",
  "version",
  "build-info",
  "tlsAllowInvalidCertificates",
  "tlsAllowInvalidHostnames",
  "tlsInsecure",
];

const mongoShell: TargetClient = {
  valueShort: "u",
  flagLong: MONGO_FLAGS,
  attachedShort: "p",
  valueLong: ["host", "uri", ...MONGO_VALUE_LONG],
  hostLong: ["host"],
  stringLong: ["uri"],
  bareStringIsHost: true,
  positional: "address",
  hostEnv: [],
  indirectEnv: [],
  exactLong: true,
  replicaSet: true,
  positionalVariable: true,
};

const mongoTool: TargetClient = {
  valueShort: "hupdcoqfj",
  flagLong: MONGO_FLAGS,
  valueLong: [
    "host",
    "uri",
    "db",
    "collection",
    "out",
    "query",
    "queryFile",
    "fields",
    "fieldFile",
    "type",
    "sort",
    "limit",
    "skip",
    "numParallelCollections",
    ...MONGO_VALUE_LONG,
  ],
  hostShort: "h",
  hostLong: ["host"],
  stringLong: ["uri"],
  positional: "none",
  hostEnv: [],
  indirectEnv: [],
  exactLong: true,
  replicaSet: true,
};

const clickhouseClient: TargetClient = {
  valueShort: "hudqcf",
  valueLong: [
    "host",
    "port",
    "user",
    "database",
    "query",
    "config-file",
    "format",
    "queries-file",
    "history_file",
    "query_id",
    "connection",
  ],
  hostShort: "h",
  hostLong: ["host"],
  stringLong: [],
  aliasLong: ["connection"],
  positional: "uri",
  hostEnv: ["CLICKHOUSE_HOST"],
  indirectEnv: [],
  // `--password` takes its value only when attached (boost implicit value): it never eats the next word.
  flagLong: [
    "password",
    "secure",
    "multiline",
    "multiquery",
    "verbose",
    "time",
    "stacktrace",
    "echo",
    "progress",
    "version",
    "vertical",
  ],
};

const cockroach: TargetClient = {
  valueShort: "ued",
  valueLong: [
    "url",
    "host",
    "port",
    "user",
    "database",
    "execute",
    "certs-dir",
    "cluster-name",
    "format",
    "set",
  ],
  hostLong: ["host"],
  stringLong: ["url"],
  positional: "none",
  hostEnv: ["COCKROACH_HOST"],
  urlEnv: ["COCKROACH_URL"],
  indirectEnv: [],
  exactLong: true,
};

const PG_BASEBACKUP = libpq({
  valueShort: "DFrTXZclSdhpUs",
  valueLong: [
    "pgdata",
    "format",
    "max-rate",
    "tablespace-mapping",
    "waldir",
    "wal-method",
    "compress",
    "checkpoint",
    "label",
    "slot",
    "dbname",
    "host",
    "port",
    "status-interval",
    "username",
    "target",
  ],
});

/** A libpq client whose positional word is a database name that may itself be a connection string. */
const libpqDatabase = (
  spec: Partial<TargetClient> & Pick<TargetClient, "valueShort">,
): TargetClient => libpq({ positionalVariable: true, ...spec });

const CLIENT_SPECS: ReadonlyArray<readonly [string, TargetClient]> = [
  [
    "psql",
    libpqDatabase({
      valueShort: "cdfhLoPpRTUvF",
      valueLong: [
        "command",
        "dbname",
        "file",
        "field-separator",
        "host",
        "log-file",
        "output",
        "port",
        "pset",
        "record-separator",
        "table-attr",
        "username",
        "set",
        "variable",
      ],
    }),
  ],
  [
    "pg_dump",
    libpqDatabase({
      valueShort: "dfFhjnNpSTtUZE",
      valueLong: [
        "dbname",
        "file",
        "format",
        "host",
        "jobs",
        "schema",
        "exclude-schema",
        "port",
        "table",
        "exclude-table",
        "username",
        "compress",
        "encoding",
        "superuser",
        "extension",
        "exclude-extension",
        "lock-wait-timeout",
        "filter",
        "rows-per-insert",
        "snapshot",
        "section",
        "role",
        "exclude-table-data",
      ],
    }),
  ],
  [
    "pg_dumpall",
    libpq({
      valueShort: "dfhlpUS",
      valueLong: [
        "dbname",
        "file",
        "host",
        "database",
        "port",
        "username",
        "superuser",
        "role",
        "encoding",
      ],
    }),
  ],
  [
    "pg_restore",
    libpq({
      valueShort: "dfFhIjLnNPpSTtU",
      valueLong: [
        "dbname",
        "file",
        "format",
        "host",
        "index",
        "jobs",
        "use-list",
        "schema",
        "exclude-schema",
        "function",
        "port",
        "superuser",
        "table",
        "trigger",
        "username",
        "section",
        "role",
        "filter",
      ],
    }),
  ],
  ["pg_basebackup", PG_BASEBACKUP],
  ["pg_receivewal", libpq({ valueShort: "" })],
  ["pg_recvlogical", libpq({ valueShort: "" })],
  // createuser/dropuser name a role, not a database: no connection string, only the host options.
  [
    "createuser",
    libpq({ valueShort: "", stringShort: undefined, stringLong: [], positional: "none" }),
  ],
  [
    "dropuser",
    libpq({ valueShort: "", stringShort: undefined, stringLong: [], positional: "none" }),
  ],
  ["clusterdb", libpqDatabase({ valueShort: "", stringLong: ["dbname", "maintenance-db"] })],
  ["pg_amcheck", libpqDatabase({ valueShort: "", stringLong: ["dbname", "maintenance-db"] })],
  // pg_upgrade has no host option (it talks to its own servers on a socket directory) but reads the libpq variables.
  [
    "pg_upgrade",
    libpq({
      valueShort: "",
      hostShort: undefined,
      hostLong: [],
      stringShort: undefined,
      stringLong: [],
      positional: "none",
    }),
  ],
  [
    "createdb",
    libpq({
      valueShort: "DElOThpU",
      stringShort: undefined,
      stringLong: ["maintenance-db"],
      valueLong: [
        "tablespace",
        "encoding",
        "locale",
        "lc-collate",
        "lc-ctype",
        "owner",
        "template",
        "host",
        "port",
        "username",
        "maintenance-db",
        "locale-provider",
        "icu-locale",
        "strategy",
      ],
    }),
  ],
  [
    "dropdb",
    libpq({
      valueShort: "hpU",
      stringShort: undefined,
      stringLong: ["maintenance-db"],
      valueLong: ["host", "port", "username", "maintenance-db"],
    }),
  ],
  [
    "pg_isready",
    libpq({ valueShort: "dhptU", valueLong: ["dbname", "host", "port", "timeout", "username"] }),
  ],
  [
    "vacuumdb",
    libpqDatabase({
      valueShort: "dhpUtnNj",
      stringLong: ["dbname", "maintenance-db"],
      valueLong: [
        "dbname",
        "host",
        "port",
        "username",
        "table",
        "schema",
        "exclude-schema",
        "jobs",
        "maintenance-db",
        "min-mxid-age",
        "min-xid-age",
      ],
    }),
  ],
  [
    "reindexdb",
    libpqDatabase({
      valueShort: "dhpUtiSj",
      stringLong: ["dbname", "maintenance-db"],
      valueLong: [
        "dbname",
        "host",
        "port",
        "username",
        "table",
        "schema",
        "index",
        "jobs",
        "maintenance-db",
        "tablespace",
      ],
    }),
  ],
  [
    "pgbench",
    libpqDatabase({
      valueShort: "hpUcjTtfDMPRLbIsF",
      stringShort: undefined,
      stringLong: [],
      valueLong: [
        "host",
        "port",
        "username",
        "client",
        "jobs",
        "time",
        "transactions",
        "file",
        "define",
        "protocol",
        "progress",
        "rate",
        "latency-limit",
        "builtin",
        "scale",
        "fillfactor",
        "init-steps",
        "log-prefix",
        "sampling-rate",
      ],
    }),
  ],
  [
    "pgcli",
    libpqDatabase({
      valueShort: "hpUudD",
      // pgcli's flags and a few of its value options (documentation, unverified): `pgcli --file x.sql` places its file.
      flagLong: [
        "less-chatty",
        "list",
        "ping",
        "single-connection",
        "auto-vertical-output",
        "no-password",
        "password",
        "version",
        "help",
        "no-warn",
      ],
      valueLong: [
        "file",
        "init-command",
        "ssh-tunnel",
        "warn",
        "host",
        "port",
        "username",
        "user",
        "dbname",
        "dsn",
        "row-limit",
        "prompt",
        "prompt-dsn",
        "pgclirc",
        "log-file",
        "ssl-mode",
      ],
      aliasShort: "D",
      aliasLong: ["dsn"],
    }),
  ],
  ["mysql", mysqlTool("hPuSeD", ["execute", "database", "default-character-set", "init-command"])],
  [
    "mariadb",
    mysqlTool("hPuSeD", ["execute", "database", "default-character-set", "init-command"]),
  ],
  ["mysqldump", mysqlTool("hPuSrTw", ["result-file", "tab", "where"])],
  ["mariadb-dump", mysqlTool("hPuSrTw", ["result-file", "tab", "where"])],
  ["mysqladmin", mysqlTool("hPuSci", ["count", "sleep"])],
  ["mariadb-admin", mysqlTool("hPuSci", ["count", "sleep"])],
  ["mysqlshow", mysqlTool("hPuS")],
  ["mariadb-show", mysqlTool("hPuS")],
  ["mysqlcheck", mysqlTool("hPuS")],
  ["mariadb-check", mysqlTool("hPuS")],
  ["mysqlimport", mysqlTool("hPuS")],
  ["mariadb-import", mysqlTool("hPuS")],
  [
    "mycli",
    {
      ...mysqlTool("hPuSDdRep", ["database", "dsn", "prompt", "execute", "password"]),
      attachedShort: undefined,
      aliasShort: "d",
      aliasLong: ["dsn"],
    },
  ],
  [
    "mysqlsh",
    {
      ...mysqlTool("hPuSeDf", ["uri", "schema", "file", "execute"]),
      stringLong: ["uri"],
      bareStringIsHost: true,
      positional: "address",
      positionalVariable: true,
    },
  ],
  ["redis-cli", redisTool],
  ["valkey-cli", redisTool],
  // redis-benchmark's `--cluster` is a flag (redis-cli's takes a command word), and it has no `--cluster check HOST:PORT`.
  [
    "redis-benchmark",
    {
      ...redisTool,
      valueLong: redisTool.valueLong.filter((n) => n !== "cluster"),
      clusterWords: false,
    },
  ],
  ["mongosh", mongoShell],
  ["mongo", mongoShell],
  ["mongodump", mongoTool],
  ["mongorestore", mongoTool],
  ["mongoexport", mongoTool],
  ["mongoimport", mongoTool],
  ["mongostat", mongoTool],
  ["mongotop", mongoTool],
  ["clickhouse-client", clickhouseClient],
  // `clickhouse client --host H`: the subcommand is a plain word, ignored.
  ["clickhouse", clickhouseClient],
  ["cockroach", cockroach],
  ["cockroach-sql", cockroach],
  [
    "usql",
    {
      valueShort: "cfov",
      valueLong: ["command", "file", "output", "set", "variable", "pset", "field-separator"],
      hostLong: [],
      stringLong: [],
      positional: "uri",
      hostEnv: [],
      indirectEnv: [],
      exactLong: true,
      positionalVariable: true,
    },
  ],
  [
    "sqlcmd",
    {
      valueShort: "SUPdQqiohHsvwlK",
      valueLong: [
        "server",
        "user-name",
        "password",
        "database-name",
        "query",
        "input-file",
        "output-file",
      ],
      hostShort: "S",
      hostLong: ["server"],
      stringLong: [],
      positional: "none",
      hostEnv: ["SQLCMDSERVER"],
      indirectEnv: [],
      commaIsPort: true,
      exactLong: true,
    },
  ],
  [
    "trino",
    {
      valueShort: "",
      valueLong: ["server", "user", "catalog", "schema", "execute", "file", "config"],
      hostLong: [],
      stringLong: ["server"],
      bareStringIsHost: true,
      positional: "none",
      hostEnv: [],
      indirectEnv: [],
      exactLong: true,
    },
  ],
  [
    "cqlsh",
    {
      valueShort: "upkfe",
      valueLong: [
        "username",
        "password",
        "keyspace",
        "file",
        "execute",
        "cqlversion",
        "encoding",
        "connect-timeout",
        "request-timeout",
        "cqlshrc",
        "secure-connect-bundle",
        "protocol-version",
        "consistency-level",
      ],
      hostLong: [],
      stringLong: [],
      positional: "host",
      // cqlsh reads CQLSH_HOST (unverified: the client is not installed here); read it as a host.
      hostEnv: ["CQLSH_HOST"],
      indirectEnv: [],
      positionalVariable: true,
    },
  ],
  ...MORE_CLIENT_SPECS,
];

const unique = (text: string): string => [...new Set(text)].join("");

/** The hand-kept table, widened by the options the real program reports (`db-target-flags.ts`) where it is known. */
function verified(name: string, spec: TargetClient): TargetClient {
  const real = VERIFIED_OPTIONS.get(name);
  if (real === undefined) return spec;
  return {
    ...spec,
    valueShort: unique(spec.valueShort + real.valueShort),
    valueLong: [...new Set([...spec.valueLong, ...real.valueLong])],
    flagLong: [...new Set([...(spec.flagLong ?? []), ...real.flagLong])],
    verified: true,
  };
}

/** Keyed by the program name, directory dropped. */
export const TARGET_CLIENTS: ReadonlyMap<string, TargetClient> = new Map(
  CLIENT_SPECS.map(([name, spec]): [string, TargetClient] => [name, verified(name, spec)]),
);
