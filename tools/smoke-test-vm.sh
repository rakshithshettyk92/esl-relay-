#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://127.0.0.1}"
env_file="${2:-$HOME/esl-relay/.env.vm}"
ops_user="$(grep '^OPS_USERNAME=' "$env_file" | cut -d= -f2-)"
ops_password="$(grep '^OPS_PASSWORD=' "$env_file" | cut -d= -f2-)"
cookie_file="$(mktemp)"
trap 'rm -f "$cookie_file"' EXIT

health="$(curl -kfsS "$base_url/health")"
jq -e '.status == "running" and .database.connected == true' <<<"$health" >/dev/null

login_code="$(curl -ksS -c "$cookie_file" -o /dev/null -w '%{http_code}' \
  --data-urlencode "username=$ops_user" --data-urlencode "password=$ops_password" \
  "$base_url/ops/login")"
[[ "$login_code" == "302" ]] || { echo "Dashboard login returned HTTP $login_code" >&2; exit 1; }

status="$(curl -kfsS -b "$cookie_file" "$base_url/ops/api/status")"
jq -e '.status == "running" and .database.connected == true and .retentionDays == 7' \
  <<<"$status" >/dev/null
logs="$(curl -kfsS -b "$cookie_file" "$base_url/ops/api/logs?limit=5")"
jq -e '.retentionDays == 7 and (.logs | type == "array")' <<<"$logs" >/dev/null

jq '{status,database,active_sessions,registered_devices,open_calls,calls_24h,pendingJobs,retentionDays}' \
  <<<"$status"
echo "Employee Call Operation dashboard smoke test passed"
