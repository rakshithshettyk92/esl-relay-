#!/usr/bin/env bash
set -euo pipefail

app_root="$(realpath -m "${1:?application root is required}")"
keep_count="${2:-8}"
release_root="$(realpath -m "$app_root/releases")"

[[ "$release_root" == "$HOME/esl-relay/releases" ]] || {
  echo "Refusing to prune unexpected release path: $release_root" >&2
  exit 1
}
[[ "$keep_count" =~ ^[1-9][0-9]*$ ]] || { echo "Keep count must be positive." >&2; exit 1; }
[[ -d "$release_root" ]] || exit 0

mapfile -t releases < <(find "$release_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
(( ${#releases[@]} > keep_count )) || exit 0

current_target="$(readlink -f "$app_root/current" 2>/dev/null || true)"
for release_name in "${releases[@]:keep_count}"; do
  target="$(realpath -m "$release_root/$release_name")"
  [[ "$target" == "$release_root/"* ]] || { echo "Refusing unsafe release target: $target" >&2; exit 1; }
  [[ -n "$current_target" && "$target" == "$current_target" ]] && continue
  rm -rf -- "$target"
done
