# Polling and ingestion health

The central response reports persisted last-attempt and last-success timestamps, whether a failure code is currently recorded, cursor presence, and bounded backlog counts. Labels say `success_recorded`, `failure_recorded`, or `no_durable_attempt`; they do not claim a live worker is healthy.

Tenant health reports exact attributed stage counts and exception timestamps for one authorized provider. It does not expose central polling health.
