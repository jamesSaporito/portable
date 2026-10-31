# Forwards the ports that containers in a sandbox publish to the Mac's 127.0.0.1. Expects
# lib/launch.sh (sandbox_exec, sandbox_running, sandboxes_json).
#
# sbx keeps each sandbox's forwards and `sbx ls` lists every sandbox's, so it is the record of which
# Mac ports portable uses; nothing is kept on disk, and a deleted sandbox frees its ports. A port is
# forwarded at the same number when the Mac has it free, otherwise at the next free number above it.
# The mapping is written into the sandbox (/etc/portable/ports) so sessions can tell the user where a
# port is reachable on the Mac.

# TCP ports containers in the sandbox publish on all its interfaces (`-p 3000:80`; sbx's forward
# reaches the VM from outside, so a port bound only to its 127.0.0.1 doesn't answer), one per line,
# sorted. Fails when the sandbox can't be asked, so a sync skips rather than tearing the forwards
# down.
sandbox_published_ports() {
  sandbox_exec "$1" sh -s <<'SCRIPT' | awk '$3 ~ /\/tcp$/ && ($1 == "0.0.0.0" || $1 == "::") { print $2 }' | sort -un
ids=$(docker ps -q) || exit 1
[ -n "$ids" ] || exit 0
# shellcheck disable=SC2086
docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{.HostIp}} {{.HostPort}} {{$p}}{{"\n"}}{{end}}{{end}}' $ids
SCRIPT
}

# Mac ports something could already be using: every sandbox's forwards (a stopped sandbox's come
# back when it starts) and every TCP listener lsof can see.
mac_ports_taken() {
  {
    sbx ls --format json 2>/dev/null | jq -r '.[].ports[]?.host_port' 2>/dev/null || true
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { sub(/.*:/, "", $9); print $9 }' || true
  } | { grep -E '^[0-9]+$' || true; } | sort -un
}

# A sandbox's TCP forwards, "MAC SANDBOX" per line.
sandbox_forwards() {
  sandboxes_json | jq -r --arg n "$1" \
    '.[] | select(.name == $n) | .ports[]? | select(.protocol | startswith("tcp")) | "\(.host_port) \(.sandbox_port)"' \
    || true
}

# ports_sync NAME [MODE]: brings the Mac's forwards for a running sandbox in line with what its
# containers publish, and writes the mapping into it. MODE: --quiet prints nothing (the watcher runs
# beside Claude's full-screen UI), --changed prints the table only when a forward was added or
# removed, and the default always prints it. Never fails: problems are warnings. (bin/portable runs
# with errexit, so every command substitution here that may be empty is guarded.)
ports_sync() {
  local name="$1" mode="${2:-}" lock want have taken port mac rest="" changed="" tries
  : "${TMPDIR:=/tmp}"
  sandbox_running "$name" || return 0
  if ! ports_lock "$name"; then
    # Another portable is syncing this sandbox right now; it'll be done in a moment.
    [ "$mode" = --quiet ] || ports_table "$name"
    return 0
  fi
  lock="${TMPDIR%/}/portable-ports-$name.lock"
  if ! want="$(sandbox_published_ports "$name")"; then
    rm -rf "$lock"
    return 0
  fi
  have="$(sandbox_forwards "$name")"

  # Forwards no container publishes anymore.
  while read -r mac port; do
    [ -n "$port" ] || continue
    grep -qx "$port" <<< "$want" && continue
    if sbx ports "$name" --unpublish "$mac:$port" >/dev/null 2>&1; then
      have="$(grep -vx "$mac $port" <<< "$have" || true)"
      changed=1
    fi
  done <<< "$have"

  # New ports at the same number first, so a port's number isn't given away as a sibling's fallback.
  taken="$(mac_ports_taken)"
  for port in $want; do
    grep -qE "^[0-9]+ $port$" <<< "$have" && continue
    if ! grep -qx "$port" <<< "$taken" && sbx ports "$name" --publish "$port:$port" >/dev/null 2>&1; then
      have="$have"$'\n'"$port $port"
      taken="$taken"$'\n'"$port"
      changed=1
    else
      rest="$rest $port"
    fi
  done
  # The rest at the next free number above their own.
  for port in $rest; do
    mac=$port
    tries=0
    while [ "$tries" -lt 50 ]; do
      mac=$((mac + 1))
      [ "$mac" -le 65535 ] || break
      grep -qx "$mac" <<< "$taken" && continue
      tries=$((tries + 1))
      if sbx ports "$name" --publish "$mac:$port" >/dev/null 2>&1; then
        have="$have"$'\n'"$mac $port"
        taken="$taken"$'\n'"$mac"
        changed=1
        break
      fi
    done
    grep -qE "^[0-9]+ $port$" <<< "$have" \
      || echo "portable: couldn't forward port $port of ${name#portable-} to the Mac (tried $port and the next free ones)" >&2
  done

  if [ -n "$changed" ]; then
    # "SANDBOX MAC" lines, for /etc/portable/ports in the sandbox.
    awk 'NF == 2 { print $2, $1 }' <<< "$have" | sort -n | sandbox_exec "$name" sudo portable-setup ports \
      || echo "portable: couldn't write the port mapping into ${name#portable-}; continuing" >&2
  fi
  rm -rf "$lock"
  case "$mode" in
    --quiet) ;;
    --changed) [ -z "$changed" ] || ports_table "$name" ;;
    *) ports_table "$name" ;;
  esac
}

# One sync per sandbox at a time, so two sessions on it don't both take the same Mac port: a lock
# folder holding its owner's pid. A lock whose owner is gone (a sync killed midway) is taken over.
ports_lock() {
  : "${TMPDIR:=/tmp}"
  local lock="${TMPDIR%/}/portable-ports-$1.lock" owner
  if ! mkdir "$lock" 2>/dev/null; then
    owner="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then return 1; fi
    rm -rf "$lock"
    mkdir "$lock" 2>/dev/null || return 1
  fi
  echo "$$" > "$lock/pid"
}

# The forwards of a sandbox as a table, on stderr like portable's other messages.
ports_table() {
  local name="$1" have
  have="$(sandbox_forwards "$name")"
  if [ -z "$have" ]; then
    echo "portable: no ports forwarded for ${name#portable-} (nothing in it publishes one)" >&2
    return 0
  fi
  {
    printf 'SANDBOX PORT\tON THE MAC\n'
    sort -k2 -n <<< "$have" | awk 'NF == 2 { printf "%s\thttp://localhost:%s\n", $2, $1 }'
  } | { column -t -s $'\t' 2>/dev/null || cat; } >&2
}

# ports_watch NAME: keeps the forwards current for as long as the portable that started it runs.
# Run in the background with stdin and stdout detached; it prints nothing.
ports_watch() {
  local name="$1" parent=$$
  while kill -0 "$parent" 2>/dev/null; do
    sleep 5
    ports_sync "$name" --quiet || true
  done
}

# `portable ports [NAME]`: syncs and lists. Without a name: the current folder's sandbox when run in
# the workspace, otherwise every running sandbox.
ports_command() {
  local name="$1" workdir found=""
  load_settings
  ensure_sbx || exit 1
  if [ -n "$name" ]; then
    name="portable-$name"
  elif workdir="$(session_folder 2>/dev/null)"; then
    name="$(sandbox_name "" "$workdir")" || exit 1
  fi
  if [ -n "$name" ]; then
    if ! sandbox_exists "$name"; then
      echo "portable: no sandbox named '${name#portable-}'; see 'portable ps'" >&2
      exit 1
    fi
    if ! sandbox_running "$name"; then
      echo "portable: ${name#portable-} is stopped; its forwards come back when it starts (run 'portable' in its folder)" >&2
      exit 1
    fi
    ports_sync "$name"
    return
  fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    found=1
    echo "${name#portable-}:" >&2
    ports_sync "$name"
  done < <(sandboxes_json | jq -r '.[] | select(.status == "running") | .name')
  [ -n "$found" ] || echo "portable: no running sandboxes; see 'portable ps'" >&2
}
