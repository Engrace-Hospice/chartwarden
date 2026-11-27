# Streaming replication drill - PASS

> **Synthetic scale, private containers on one machine.** It proves the replication configuration (TLS and client
> certificate auth, the slot, hot standby, the monitor's alerts, promotion). It does not size production. NOT proven
> here: the standby is restored from a local pgBackRest repository, so a standby bootstrap from the off-site S3
> repository is not exercised (the coordinated drill proves an off-site restore, with a different recovery type); the
> restore_command fallback (catching up from the WAL archive) is configured and asserted, never forced; and nothing
> reaches a real alert receiver (the monitor's alerts are asserted from its own output).

Run 589d5d at 2026-11-27T20:27:33.216Z. Scale: synthetic: one probe table (2000 rows) and 40000 rows of padding WAL; one primary, one standby, one throwaway CA.

## Tooling
- **pgbackrest**: pgBackRest 2.60.0
- **postgres**: postgres (PostgreSQL) 18.6

## Primary settings under test (compose.replication.yml)
- `max_locks_per_transaction=4096`
- `archive_mode=on`
- `archive_command=pgbackrest --stanza=chartwarden archive-push %p`
- `archive_timeout=60`
- `wal_level=replica`
- `max_wal_senders=4`
- `max_replication_slots=2`
- `wal_keep_size=1GB`
- `max_slot_wal_keep_size=4GB`
- `wal_sender_timeout=60s`
- `log_replication_commands=on`
- `ssl=on`
- `ssl_min_protocol_version=TLSv1.3`
- `ssl_cert_file=/run/secrets/replication_server_cert`
- `ssl_key_file=/run/secrets/replication_server_key`
- `ssl_ca_file=/run/secrets/replication_ca`

## Standby settings under test (db-replication/compose.standby.yml)
- `max_locks_per_transaction=4096`
- `max_wal_senders=4`
- `hot_standby=on`
- `archive_mode=off`
- `log_connections=on`
- `log_disconnections=on`

## Timings (synthetic scale)
| phase | wall |
|---|---|
| full base backup (synthetic scale) | 16.5 s |
| standby-bootstrap.sh (pgbackrest --type=standby restore) | 16.3 s |
| standby start to streaming | 3.4 s |
| write on the primary visible on the standby | 0.5 s |
| restarted standby catches up 40000 rows of WAL | 2.5 s |
| promotion (pg_promote, waited) | 0.5 s |

## Checks
| result | check | detail |
|---|---|---|
| PASS | provision-primary.sh creates the role, the slot and the pg_hba block | CREATE ROLE
ALTER ROLE
(cw_standby,0/2000028)
DO
2026-11-27T20:28:03Z provision-primary role cw_replicator and slot cw_standby ready
2026-11-27T20:28:03Z provision-primary pg_hba.conf updated and reloaded
2026-11-27T20:28:03Z provision-primary replication provisioned |
| PASS | a second provision-primary.sh run changes nothing | ALTER ROLE
DO
2026-11-27T20:28:04Z provision-primary role cw_replicator and slot cw_standby ready
2026-11-27T20:28:04Z provision-primary pg_hba.conf already carries the managed block
2026-11-27T20:28:04Z provision-primary replication provisioned |
| PASS | the managed pg_hba block is first: hostssl replication cert, then the two rejects | 2:hostssl:{replication}:{cw_replicator}:cert
3:host:{replication}:{cw_replicator}:reject
4:host:{all}:{cw_replicator}:reject
122:local:{all}:{all}:trust
124:host:{all}:{all}:trust |
| PASS | the pg_hba block appears once and the file has no invalid line | see pg_hba_file_rules |
| PASS | the replication role has REPLICATION, no password, no other attribute and a connection limit of 2 | pg_authid |
| PASS | the cert rule is pinned to the standby's address (a /32), not to every address | 10.174.193.10/255.255.255.255 |
| PASS | replication connects over verified TLS with the client certificate, from the standby's address | 7712950699328684067/1/0/205CE30/ |
| PASS | replication in plain text is refused (no TLS) | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  pg_hba.conf rejects replication connection for host "10.174.193.10", user "cw_replicator", no encryption |
| PASS | replication over TLS without a client certificate is refused | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  connection requires a valid client certificate |
| PASS | a client certificate from another CA is refused | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: SSL error: tlsv1 alert decrypt error |
| PASS | a certificate from our CA whose CN is not the role is refused | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  certificate authentication failed for user "cw_replicator" |
| PASS | the right certificate from any other address is refused (the rule is pinned to the standby) | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  pg_hba.conf rejects replication connection for host "10.174.193.11", user "cw_replicator", SSL encryption |
| PASS | a logical (replication=database) connection by the role is refused | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  pg_hba.conf rejects connection for host "10.174.193.10", user "cw_replicator", database "chartwarden", SSL encryption |
| PASS | the replication role cannot log in as a normal user | psql: error: connection to server at "primary.drill.test" (10.174.193.2), port 5432 failed: FATAL:  pg_hba.conf rejects connection for host "10.174.193.10", user "cw_replicator", database "chartwarden", SSL encryption |
| PASS | password logins still work over TCP, with and without TLS (the existing clients are untouched) | app-login-ok
app-login-ok |
| PASS | the local socket login the backup sidecar uses still works | psql over the socket |
| PASS | standby-bootstrap.sh restores the standby data directory | rted)
2026-11-27 20:28:49.233 P00   INFO: restore size = 30.1MB, file total = 1274
2026-11-27 20:28:49.233 P00   INFO: restore command end: completed successfully (14813ms)
2026-11-27T20:28:34Z standby-bootstrap restoring the latest base backup of stanza chartwarden (repo 1) as a standby of primary.drill.test:5432, slot cw_standby
2026-11-27T20:28:49Z standby-bootstrap standby data directory ready |
| PASS | a second standby-bootstrap.sh leaves the existing cluster alone | 2026-11-27T20:28:51Z standby-bootstrap /var/lib/postgresql/18/docker already holds a cluster: nothing to restore |
| PASS | the standby streams from the slot cw_standby | pg_stat_replication |
| PASS | the walsender connection negotiated TLS 1.3 with the client certificate's CN | pg_stat_ssl |
| PASS | rows from before the backup and from between backup and standby are on the standby | standby has 1500 of 1500 rows |
| PASS | a write on the primary reaches the standby while streaming | standby has 2000 of 2000 rows |
| PASS | the standby is in recovery with the intended recovery settings | slot=cw_standby archive_mode=off log_connections=on |
| PASS | provisioning left a trace in the primary's server log | docker logs of the primary |
| PASS | the primary runs the overlay's settings (ssl, wal_level, bounded slot) | ssl=on max_slot_wal_keep_size=4GB |
| PASS | the monitor is silent and exits 0 while the standby streams |  |
| PASS | a stopped standby pages: standby_absent (SEV-2 after 10 min) and slot_wal_retained | 1 replication.standby_absent SEV-2, replication.slot_wal_retained SEV-3 |
| PASS | the same alerts are not repeated on the next pass (the exit stays 1) | 1  |
| PASS | an unreadable primary raises monitor_blind | replication.monitor_blind SEV-2 |
| PASS | after the standby catches up the monitor is silent again and the absence clock is cleared |  |
| PASS | the standby promotes, takes a write and holds every row | promoted=t rows=2001 |
