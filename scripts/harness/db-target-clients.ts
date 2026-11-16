/**
 * The database clients whose connection target the guard reads, and how each spells it (wave 9, W9-1). Data only: the
 * reader is `db-target.ts`. For each client: which option letters and long options take a value (so a SQL string or a
 * file name is never read as a host), which of them name the host, which carry a whole connection string (a URI, or a
 * libpq `key=value` string), which name an alias or a file that holds the host (a service, a login path, a DSN alias),
 * what a positional word means, and which environment variables name the host. A client option this table does not list
 * is read as a flag: its value, if it is a host, is not seen (a stated limit of the guard).
 */

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
}

const LIBPQ_ENV: Pick<TargetClient, "hostEnv" | "indirectEnv"> = {
  hostEnv: ["PGHOST", "PGHOSTADDR"],
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
const mysqlTool = (valueShort: string, valueLong: readonly string[] = []): TargetClient => ({
  valueShort,
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

const mongoShell: TargetClient = {
  valueShort: "u",
  attachedShort: "p",
  valueLong: ["host", "uri", ...MONGO_VALUE_LONG],
  hostLong: ["host"],
  stringLong: ["uri"],
  bareStringIsHost: true,
  positional: "address",
  hostEnv: [],
  indirectEnv: [],
};

const mongoTool: TargetClient = {
  valueShort: "hupdcoqfj",
  valueLong: [
    "host",
    "uri",
    "password",
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
};

const clickhouseClient: TargetClient = {
  valueShort: "hudqcf",
  valueLong: [
    "host",
    "port",
    "user",
    "password",
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

/** Keyed by the program name, directory dropped. */
export const TARGET_CLIENTS: ReadonlyMap<string, TargetClient> = new Map<string, TargetClient>([
  [
    "psql",
    libpq({
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
    libpq({
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
  ["pg_receivewal", PG_BASEBACKUP],
  ["pg_recvlogical", PG_BASEBACKUP],
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
    libpq({
      valueShort: "dhpUtnNj",
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
    libpq({
      valueShort: "dhpUtiSj",
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
    libpq({
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
    libpq({
      valueShort: "hpUudD",
      valueLong: [
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
    },
  ],
  ["redis-cli", redisTool],
  ["valkey-cli", redisTool],
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
    },
  ],
  [
    "sqlcmd",
    {
      valueShort: "SUPdQqiohHsvwWlK",
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
    },
  ],
  [
    "trino",
    {
      valueShort: "",
      valueLong: ["server", "user", "password", "catalog", "schema", "execute", "file", "config"],
      hostLong: [],
      stringLong: ["server"],
      bareStringIsHost: true,
      positional: "none",
      hostEnv: [],
      indirectEnv: [],
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
      hostEnv: [],
      indirectEnv: [],
    },
  ],
]);
