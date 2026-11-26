#!/usr/bin/env bash
# deploy/production/db-replication/replication-monitor.sh — standby health and lag alerts, run on the PRIMARY (CW-CP-01).
#
#   run                      the loop compose.replication.yml's `replication-monitor` service runs (needs an https
#                            OPS_ALERT_WEBHOOK_URL: it never runs silently)
#   check                    one pass: alert on what is wrong, exit 1 when anything is, 0 when healthy
#   healthcheck              exit 1 when no pass completed within 3 intervals (the container healthcheck)
#   evaluate <streaming> <lag_s> <lag_bytes> <slot_status> <retained_bytes> <absent_for_s>
#                            the decision table alone (no database): prints `kind|severity|summary` per alert
#
# Runs in the backup image as the postgres user, reading the primary over the shared socket (the same trust the backup
# sidecar has; no password). Alerts POST to OPS_ALERT_WEBHOOK_URL in the payload shape cw-backup.sh uses
# ({kind, summary, details, correlationId, occurredAt}); without a URL they only log (tests).
#
# Severity follows DR/BCP 5.1: lag or absence >= 60 s is SEV-3, >= 5 min SEV-2, >= 30 min SEV-1 (replication broken).
#   replication.standby_absent   no walsender streams from the slot (the standby is down, cut off or rejected)
#   replication.lag_high         replay lag in seconds (SEV ladder) or WAL bytes behind (>= REPLICATION_LAG_ALERT_BYTES)
#   replication.slot_missing     the slot does not exist: db-replication/provision-primary.sh has not run
#   replication.slot_wal_at_risk the slot's WAL is about to be removed (wal_status unreserved): the standby must catch up now
#   replication.slot_lost        WAL the standby needs is gone: rebuild the standby (DR/BCP 6.1.2)
#   replication.slot_wal_retained the stalled standby makes the primary keep more than REPLICATION_SLOT_RETAINED_ALERT_BYTES
#   replication.monitor_blind    the primary could not be queried
# A kind repeats at most every REPLICATION_ALERT_REPEAT_S unless its severity changed.
set -Eeuo pipefail

DB_NAME="${CHARTWARDEN_DB_NAME:-chartwarden}"
SLOT="${REPLICATION_SLOT:-cw_standby}"
INTERVAL_S="${REPLICATION_CHECK_INTERVAL_S:-60}"
REPEAT_S="${REPLICATION_ALERT_REPEAT_S:-900}"
LAG_BYTES_LIMIT="${REPLICATION_LAG_ALERT_BYTES:-268435456}"
RETAINED_LIMIT="${REPLICATION_SLOT_RETAINED_ALERT_BYTES:-2147483648}"
STATE_DIR="${REPLICATION_STATE_DIR:-/tmp/cw-replication}"
SEV3_S=60
SEV2_S=300
SEV1_S=1800

log() { printf '%s replication-monitor %s\n' "$(date -u +%FT%TZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
# Bounded: a wedged primary must turn into a failed query (monitor_blind), never into a monitor that hangs and says nothing.
PSQL_CONNECT_TIMEOUT_S=10
PSQL_STATEMENT_TIMEOUT_MS=15000
psql_db() {
  PGCONNECT_TIMEOUT="$PSQL_CONNECT_TIMEOUT_S" PGOPTIONS="-c statement_timeout=$PSQL_STATEMENT_TIMEOUT_MS" \
    psql -X -v ON_ERROR_STOP=1 -At -F '|' -h /var/run/postgresql -U postgres -d "$DB_NAME" "$@"
}
is_uint() { [[ ${1:-} =~ ^[0-9]+$ ]]; }

severity_for() { # seconds -> SEV-1|SEV-2|SEV-3|none
  if [ "$1" -ge "$SEV1_S" ]; then echo SEV-1
  elif [ "$1" -ge "$SEV2_S" ]; then echo SEV-2
  elif [ "$1" -ge "$SEV3_S" ]; then echo SEV-3
  else echo none; fi
}

evaluate() { # streaming lag_s lag_bytes slot_status retained_bytes absent_for_s
  local streaming="${1:-}" lag_s="${2:-}" lag_bytes="${3:-}" slot_status="${4:-}" retained="${5:-}" absent_for="${6:-}" sev
  if ! { is_uint "$streaming" && is_uint "$lag_s" && is_uint "$lag_bytes" && is_uint "$retained" && is_uint "$absent_for"; }; then
    die "evaluate: streaming, lag_s, lag_bytes, retained_bytes and absent_for_s must be whole numbers"
  fi
  case "$slot_status" in
  absent) echo "replication.slot_missing|SEV-2|replication slot $SLOT does not exist (provision-primary.sh has not run)" ;;
  lost) echo "replication.slot_lost|SEV-1|WAL the standby needs was removed: rebuild the standby" ;;
  unreserved) echo "replication.slot_wal_at_risk|SEV-2|the slot's WAL is about to be removed: the standby must catch up now" ;;
  reserved | extended) ;;
  *) die "evaluate: slot_status must be reserved|extended|unreserved|lost|absent" ;;
  esac
  if [ "$slot_status" != absent ]; then
    if [ "$streaming" -eq 0 ]; then
      sev="$(severity_for "$absent_for")"
      if [ "$sev" != none ]; then echo "replication.standby_absent|$sev|no standby has streamed from slot $SLOT for ${absent_for}s"; fi
    else
      sev="$(severity_for "$lag_s")"
      if [ "$sev" = none ] && [ "$lag_bytes" -ge "$LAG_BYTES_LIMIT" ]; then sev=SEV-3; fi
      if [ "$sev" != none ]; then echo "replication.lag_high|$sev|standby replay is ${lag_s}s and ${lag_bytes} bytes behind"; fi
    fi
  fi
  if [ "$retained" -ge "$RETAINED_LIMIT" ]; then
    echo "replication.slot_wal_retained|SEV-3|slot $SLOT holds back ${retained} bytes of WAL on the primary"
  fi
}

# ---- alerting (same payload and https-only delivery as cw-backup.sh) -------------------------------------------------
alert() { # kind summary details-json
  local body
  body="$(jq -nc --arg kind "$1" --arg summary "$2" --argjson details "$3" --arg cid "replication-$(date -u +%Y%m%dT%H%M%SZ)" \
    '{kind:$kind, summary:$summary, details:$details, correlationId:$cid, occurredAt:(now|todate)}')"
  log "ALERT [$1] $(jq -r '.severity // empty' <<<"$3") $2"
  [ -n "${OPS_ALERT_WEBHOOK_URL:-}" ] || return 0
  # Returns 1 when the post fails, so notify() does not start the repeat window for an alert nobody received.
  curl -fs -m 10 --proto =https -H 'content-type: application/json' --data "$body" "$OPS_ALERT_WEBHOOK_URL" \
    >/dev/null || { log "alert webhook delivery failed"; return 1; }
}
require_alerting() {
  case "${OPS_ALERT_WEBHOOK_URL:-}" in
  https://*) ;;
  *) die "OPS_ALERT_WEBHOOK_URL must be set to an https:// URL (a lost standby must page someone)" ;;
  esac
}

due() { # kind severity -> 0 when this alert should go out now (first time, escalated, or repeat interval passed)
  local f="$STATE_DIR/alert-$1" last_sev last_at
  [ -r "$f" ] || return 0
  read -r last_sev last_at <"$f" || return 0
  [ "$last_sev" = "$2" ] || return 0
  [ $(($(date +%s) - ${last_at:-0})) -ge "$REPEAT_S" ]
}

notify() { # kind severity summary details-json: alert when due, and start the repeat window only if it was delivered
  due "$1" "$2" || return 0
  if alert "$1" "$3" "$4"; then echo "$2 $(date +%s)" >"$STATE_DIR/alert-$1"; fi
}

cmd_check() {
  mkdir -p "$STATE_DIR"
  local row streaming=0 lag_s=0 lag_bytes=0 slot_status=absent retained=0 now absent_since absent_for=0
  # psql interpolates :'slot' from stdin, never from -c. The slot row does not exist before provision-primary.sh ran.
  # A standby that is still catching up counts as present (its lag is reported as lag_high), not as absent.
  if ! row="$(psql_db -v slot="$SLOT" <<'SQL'
SELECT
  coalesce((SELECT count(*) FROM pg_stat_replication r WHERE r.pid = s.active_pid AND r.state IN ('streaming', 'catchup')), 0),
  coalesce((SELECT floor(extract(epoch FROM r.replay_lag)) FROM pg_stat_replication r WHERE r.pid = s.active_pid), 0)::bigint,
  coalesce((SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn) FROM pg_stat_replication r WHERE r.pid = s.active_pid), 0)::bigint,
  coalesce(s.wal_status, 'lost'),
  coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn), 0)::bigint
FROM pg_replication_slots s WHERE s.slot_name = :'slot'
SQL
  )"; then
    notify replication.monitor_blind SEV-2 "the replication monitor could not query the primary" \
      "$(jq -nc --arg s "SEV-2" '{severity:$s}')"
    return 1
  fi
  if [ -n "$row" ]; then IFS='|' read -r streaming lag_s lag_bytes slot_status retained <<<"$row"; fi
  now="$(date +%s)"
  if [ "$streaming" -gt 0 ]; then
    rm -f "$STATE_DIR/absent-since"
  else
    [ -r "$STATE_DIR/absent-since" ] || echo "$now" >"$STATE_DIR/absent-since"
    absent_since="$(cat "$STATE_DIR/absent-since")"
    absent_for=$((now - absent_since))
  fi
  local out kind sev summary bad=0
  # Facts the table cannot grade (an unknown wal_status, a non-integer) must page, never pass quietly: `run` calls this
  # under `|| true`, where errexit is off, so the failure is handled here and not left to `set -e`.
  if ! out="$(evaluate "$streaming" "$lag_s" "$lag_bytes" "$slot_status" "$retained" "$absent_for")"; then
    notify replication.monitor_blind SEV-2 "the replication monitor could not interpret the primary's replication state" \
      "$(jq -nc --arg s "SEV-2" '{severity:$s}')"
    return 1
  fi
  if [ -n "$out" ]; then
    while IFS='|' read -r kind sev summary; do
      bad=1
      notify "$kind" "$sev" "$summary" "$(jq -nc --arg sev "$sev" --arg slot "$SLOT" --arg host "$(hostname)" --arg ss "$slot_status" \
        --argjson streaming "$streaming" --argjson lag "$lag_s" --argjson lagb "$lag_bytes" --argjson ret "$retained" \
        --argjson absent "$absent_for" \
        '{severity:$sev, slot:$slot, host:$host, slotStatus:$ss, streaming:$streaming, lagSeconds:$lag, lagBytes:$lagb, retainedBytes:$ret, absentForSeconds:$absent}')"
    done <<<"$out"
  fi
  touch "$STATE_DIR/last-check" # the pass completed: the healthcheck is about the monitor, the alerts are about the standby
  # Optional dead-man's switch, like the backup sidecar's BACKUP_HEARTBEAT_URL: when THIS monitor (or its host) stops, the
  # external service alerts; nothing else would, since a dead monitor sends nothing.
  if [ -n "${REPLICATION_HEARTBEAT_URL:-}" ]; then
    curl -fs -m 10 --proto =https "$REPLICATION_HEARTBEAT_URL" >/dev/null || log "heartbeat ping failed"
  fi
  [ "$bad" = 0 ]
}

cmd_run() {
  require_alerting
  while :; do
    cmd_check || true
    sleep "$INTERVAL_S"
  done
}

cmd_healthcheck() {
  local f="$STATE_DIR/last-check"
  [ -f "$f" ] && [ $(($(date +%s) - $(stat -c %Y "$f"))) -le $((3 * INTERVAL_S)) ]
}

cmd="${1:-}"
shift || true
case "$cmd" in
run) cmd_run ;;
check) cmd_check ;;
healthcheck) cmd_healthcheck ;;
evaluate) evaluate "$@" ;;
*) die "usage: replication-monitor.sh run|check|healthcheck|evaluate <streaming> <lag_s> <lag_bytes> <slot_status> <retained_bytes> <absent_for_s>" ;;
esac
