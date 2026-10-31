# Prepares the environment and runs the sandbox. Expects PORTABLE_ROOT, lib/secrets.sh and lib/aws.sh.
#
# A session is a Docker Sandbox (sbx): a microVM with its own kernel and Docker engine, one per
# workspace folder, kept between launches and reattached to. Docker's Claude Code workload provides
# Claude; portable's kit (kit/) adds the tools and the user's Claude configuration. Credentials are
# held by sbx on the Mac and put on requests by its proxy, so they never enter the VM; AWS is the
# exception (SigV4 needs the keys), so its hour-long STS credentials are written into the sandbox.
# Docs: https://docs.docker.com/ai/sandboxes/

# The copy of portable that install.sh puts on PATH, a clone of its GitHub repo kept outside any
# workspace, so sessions can work on a clone of portable without touching the launcher that runs them.
# `portable update` moves it forward. Settings live outside both, so every copy shares them.
PORTABLE_INSTALL_DIR="${PORTABLE_INSTALL_DIR:-$HOME/.local/share/portable}"
PORTABLE_ENV_FILE="${PORTABLE_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/portable/.env}"
PORTABLE_KIT="$PORTABLE_ROOT/kit"

# Docker's Claude Code workload (kit v3), pinned. Latest tag on 2026-10-30, digest
# sha256:5698d4430c206770c1243c7ac08a504133b0c31b2ae6ef002efb46653b156b76:
# https://hub.docker.com/r/docker/sbx-kit-claude/tags
PORTABLE_WORKLOAD="${PORTABLE_WORKLOAD:-docker.io/docker/sbx-kit-claude:2.1.314}"
# Oldest sbx the kit's capabilities need (host-mount@1 and git-identity@1 arrived in 0.48 and 0.50):
# https://docs.docker.com/ai/sandboxes/customize/author/capabilities/
PORTABLE_SBX_MIN=0.50.0

# Secrets in the Keychain (lib/secrets.sh). sbx reads them from there itself, through the sources
# install.sh registers; Claude's sign-in is sbx's own (/login once per Mac).
PORTABLE_SECRETS=(GH_TOKEN INFRACOST_CLI_AUTHENTICATION_TOKEN)

load_settings() {
  # Read .env as plain KEY=VALUE lines (never executed). A value already set in the shell wins.
  local key value
  if [ -f "$PORTABLE_ENV_FILE" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
      case "$key" in ''|\#*) continue ;; esac
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      [ -n "${!key:-}" ] || export "$key=$value"
    done < "$PORTABLE_ENV_FILE"
  fi
  # The most any session can see. Each one mounts only the folder it's started in (session_folder).
  export WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/Projects/sandboxed}"
  WORKSPACE_DIR="${WORKSPACE_DIR/#\~/$HOME}"
  load_protected
  check_workspace
  mkdir -p "$WORKSPACE_DIR"
  # Folders are mounted at these same paths inside the sandbox, so paths that tools record, such as
  # git worktrees, work on both sides.
  WORKSPACE_DIR="$(cd -P "$WORKSPACE_DIR" && pwd)"
  check_workspace
}

# Folders a session may not start in, even inside WORKSPACE_DIR: the copy of portable that's running
# (or the sandbox could rewrite its own launcher and so widen its access at the next launch; the
# installed copy lives outside any workspace, so this only matters for a clone run directly), and the
# configuration repo the Mac's ~/.claude links into (or it could change the skills and rules the
# Mac's Claude runs). A session started above them can still see them, as the README says.
load_protected() {
  export PORTABLE_PROTECT_SELF="$PORTABLE_ROOT"
  local link config=""
  if link="$(readlink "$HOME/.claude/CLAUDE.md")"; then
    [[ "$link" = /* ]] || link="$HOME/.claude/$link"
    config="$(cd -P "$(dirname "$link")" 2>/dev/null && pwd)"
  fi
  export PORTABLE_PROTECT_CONFIG="${config:-/nonexistent}"
}

inside_protected() {
  case "$1/" in
    "$PORTABLE_PROTECT_SELF"/* | "$PORTABLE_PROTECT_CONFIG"/*) return 0 ;;
  esac
  return 1
}

check_workspace() {
  # Compare without trailing slashes, so "/" or "~/Projects/" can't slip past the patterns below.
  local ws="$WORKSPACE_DIR"
  while [ "$ws" != "${ws%/}" ]; do ws="${ws%/}"; done
  if [ -z "$ws" ] || [ "$ws" = "$HOME" ] || [ "$ws" = /Users ]; then
    echo "portable: WORKSPACE_DIR (${WORKSPACE_DIR}) is too broad; point it at a dedicated folder in .env" >&2
    exit 1
  fi
  if inside_protected "$ws"; then
    echo "portable: WORKSPACE_DIR ($WORKSPACE_DIR) is inside portable or your Claude configuration repo; point it at another folder in .env" >&2
    exit 1
  fi
  # A Mac path never overlaps the sandbox's own folders, but a custom one could hide them.
  case "$ws/" in
    /bin/*|/boot/*|/dev/*|/etc/*|/home/*|/lib*|/proc/*|/root/*|/run/*|/sbin/*|/srv/*|/sys/*|/usr/*|/var/*)
      echo "portable: WORKSPACE_DIR ($WORKSPACE_DIR) would cover a system folder in the sandbox; pick another" >&2
      exit 1 ;;
  esac
}

# The folder a session shares, and starts in: the current one, which must be WORKSPACE_DIR or inside
# it. Starting further in narrows what Claude can see.
session_folder() {
  local here
  here="$(pwd -P)"
  case "$here/" in
    "$WORKSPACE_DIR"/*) ;;
    *)
      echo "portable: run it from WORKSPACE_DIR ($WORKSPACE_DIR) or a folder in it; the session can see only the folder it starts in" >&2
      return 1 ;;
  esac
  case "$here/" in
    "$PORTABLE_PROTECT_SELF"/*)
      echo "portable: $here is the copy of portable that's running, which a session may not change; to work on it in portable, run the installed 'portable' instead" >&2
      return 1 ;;
    "$PORTABLE_PROTECT_CONFIG"/*)
      echo "portable: $here is your Claude configuration repo: your Mac's ~/.claude links into it, so a session could change what your Mac's Claude runs." >&2
      echo "  To work on it in portable, run its installer, which links ~/.claude to a copy outside the workspace instead:" >&2
      echo "    '$PORTABLE_PROTECT_CONFIG/install.sh'" >&2
      echo "  then push changes from here, and run './install.sh update' on your Mac once they're merged." >&2
      return 1 ;;
  esac
  echo "$here"
}

# --- sbx -------------------------------------------------------------------------------------------

sbx_version() {
  { sbx version 2>/dev/null || sbx --version 2>/dev/null; } | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# version_ge A B: true when A >= B (dotted numbers).
version_ge() {
  local a b i
  IFS=. read -r -a a <<< "$1"
  IFS=. read -r -a b <<< "$2"
  for i in 0 1 2; do
    [ "${a[$i]:-0}" -gt "${b[$i]:-0}" ] && return 0
    [ "${a[$i]:-0}" -lt "${b[$i]:-0}" ] && return 1
  done
  return 0
}

ensure_sbx() {
  if ! command -v sbx >/dev/null; then
    echo "portable: Docker Sandboxes (sbx) isn't installed; run install.sh, or: brew trust docker/tap && brew install docker/tap/sbx" >&2
    return 1
  fi
  # sbx's listings are read as JSON. macOS 15 and later ship jq.
  if ! command -v jq >/dev/null; then
    echo "portable: jq isn't installed (macOS 15 and later have it; otherwise: brew install jq)" >&2
    return 1
  fi
  local version
  version="$(sbx_version)"
  if [ -n "$version" ] && ! version_ge "$version" "$PORTABLE_SBX_MIN"; then
    echo "portable: sbx $version is too old; portable's kit needs $PORTABLE_SBX_MIN or later (brew upgrade sbx)" >&2
    return 1
  fi
  # The daemon needs a Docker sign-in; sbx opens the browser.
  if ! sbx ls >/dev/null 2>&1; then
    echo "portable: signing in to Docker (sbx login)..." >&2
    sbx login >&2 || return 1
  fi
}

# Extra hosts from .env, allowed on this Mac for every sandbox. Idempotent.
ensure_policy() {
  local host
  for host in ${PORTABLE_ALLOW_DOMAINS:-}; do
    sbx policy allow network "$host" >/dev/null 2>&1 \
      || echo "portable: couldn't allow $host in the network policy (sbx policy allow network $host)" >&2
  done
}

# Sandboxes are named portable-<name>. Without --name, the folder's name, so every session started
# in a folder shares its sandbox (`claude --worktree X` included: the worktree is inside the folder,
# and agents on one project share its engine, so the docker-ports skill in there keeps their stacks
# on different ports).
sandbox_name() {
  local name="$1" workdir="$2"
  [ -n "$name" ] || name="$(basename "$workdir")"
  name="$(tr -c 'A-Za-z0-9_.\n-' '-' <<< "$name" | sed 's/-*$//')"
  if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    echo "portable: '$name' isn't a valid name (letters, digits, '.', '_', '-')" >&2
    return 1
  fi
  echo "portable-$name"
}

# portable's sandboxes as `sbx ls --format json` gives them (name, status, ports, workspaces, ...).
sandboxes_json() {
  sbx ls --format json 2>/dev/null | jq -c '[.[] | select(.name | startswith("portable-"))]' 2>/dev/null || echo '[]'
}

sandbox_exists() {
  [ "$(sandboxes_json | jq -r --arg n "$1" 'any(.[]; .name == $n)')" = true ]
}

sandbox_running() {
  [ "$(sandboxes_json | jq -r --arg n "$1" 'any(.[]; .name == $n and .status == "running")')" = true ]
}

# Environment for the sandbox, set once at creation. No secrets: AWS credentials go in through stdin
# (refresh_aws), never on a command line.
sandbox_env() {
  local name
  echo "WORKSPACE_DIR=$1"
  echo "PORTABLE_WORKSPACE_ROOT=$WORKSPACE_DIR"
  for name in PORTABLE_CLAUDE_CONFIG_REPO PORTABLE_CLAUDE_CONFIG_DISABLE PORTABLE_ALLOW_DOMAINS \
      TERM COLORTERM; do
    [ -n "${!name:-}" ] && echo "$name=${!name}"
  done
  return 0
}

# Creates the sandbox for a folder: Docker's Claude workload plus portable's kit, the folder mounted
# at its Mac path. Ports are forwarded later, as containers publish them (lib/ports.sh). The shared
# skills store is left out (--skills=off): the user's skills come from their configuration repo,
# which links into ~/.claude/skills itself.
create_sandbox() {
  local name="$1" workdir="$2" line
  local args=(create --name "$name" --skills=off)
  while IFS= read -r line; do args+=(-e "$line"); done < <(sandbox_env "$workdir")
  echo "portable: creating the sandbox $name for $workdir (the first one builds portable's kit; a few minutes)..." >&2
  sbx "${args[@]}" "$PORTABLE_WORKLOAD" --kit "$PORTABLE_KIT" "$workdir" >&2
}

# Runs a command in the sandbox with stdin, waking it first if it had stopped.
sandbox_exec() {
  local name="$1"
  shift
  # Wake it only when it isn't running, so a command that fails doesn't run a second time.
  if ! sandbox_running "$name"; then
    sbx run -d --name "$name" >/dev/null 2>&1 || true
  fi
  sbx exec -i "$name" "$@"
}

# Writes the current STS credentials (lib/aws.sh) into the sandbox for new sessions; clears them when
# there are none. See portable-setup aws.
refresh_aws() {
  local name="$1" var lines=""
  for var in "${PORTABLE_AWS_VARS[@]}" AWS_REGION AWS_DEFAULT_REGION; do
    [ -n "${!var:-}" ] && lines="${lines}export $var=${!var}"$'\n'
  done
  printf '%s' "$lines" | sandbox_exec "$name" sudo portable-setup aws \
    || echo "portable: couldn't pass AWS credentials to the sandbox; continuing" >&2
}

# Merges the Mac's ~/.claude/settings.json into the sandbox's (portable-setup settings strips the
# Mac-only parts).
sync_settings() {
  local name="$1" file="$HOME/.claude/settings.json"
  [ -f "$file" ] || return 0
  sandbox_exec "$name" portable-setup settings < "$file" \
    || echo "portable: couldn't copy your Claude settings into the sandbox; continuing" >&2
}

load_secrets() {
  if ! secret_get GH_TOKEN >/dev/null; then
    echo "portable: no GitHub token in the Keychain; run: portable secret set GH_TOKEN (then recreate the sandbox: portable rm NAME)" >&2
  fi
}

# Name, status, forwards (sandbox port → Mac port), folder and creation time of each sandbox.
list_containers() {
  {
    printf 'NAME\tSTATUS\tPORTS (SANDBOX→MAC)\tFOLDER\tCREATED\n'
    sandboxes_json | jq -r '.[] | [
        (.name | ltrimstr("portable-")),
        .status,
        ([.ports[]? | select(.protocol | startswith("tcp")) | "\(.sandbox_port)→\(.host_port)"] | join(" ") | if . == "" then "-" else . end),
        (.workspaces[0] // "-"),
        (.created_at | sub("T"; " ") | sub("(?<m>:[0-9]{2}):[0-9]{2}.*$"; "\(.m)"))
      ] | @tsv'
  } | { column -t -s $'\t' 2>/dev/null || cat; }
}

stop_container() {
  if ! sandbox_exists "portable-$1"; then
    echo "portable: no sandbox named '$1'; see 'portable ps'" >&2
    return 1
  fi
  sbx stop "portable-$1" >/dev/null && echo "Stopped $1"
}

# Deletes a sandbox: its Docker images, containers, volumes (databases included) and Claude history
# in it. Files in the workspace folder stay. sbx asks for confirmation.
remove_container() {
  if ! sandbox_exists "portable-$1"; then
    echo "portable: no sandbox named '$1'; see 'portable ps'" >&2
    return 1
  fi
  sbx rm "portable-$1"
}

# Deletes every stopped portable sandbox, after listing them and asking.
prune_containers() {
  local stopped reply name
  stopped="$(sandboxes_json | jq -r '.[] | select(.status != "running") | .name')"
  if [ -z "$stopped" ]; then
    echo "No stopped sandboxes."
    return 0
  fi
  echo "Stopped sandboxes (their Docker data and Claude history go with them; workspace files stay):"
  sed 's/^portable-/  /' <<< "$stopped"
  read -r -p "Delete them? [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]] || { echo "Left them in place."; return 0; }
  while IFS= read -r name; do
    sbx rm --force "$name" >/dev/null && echo "Deleted ${name#portable-}"
  done <<< "$stopped"
}

# Usage: run_container NAME [command...]; NAME may be empty.
run_container() {
  local name="$1" workdir status
  shift
  load_settings
  workdir="$(session_folder)" || exit 1
  ensure_sbx || exit 1
  name="$(sandbox_name "$name" "$workdir")" || exit 1
  load_secrets
  load_aws
  ensure_policy
  sandbox_exists "$name" || create_sandbox "$name" "$workdir" || exit 1
  refresh_aws "$name"
  sync_settings "$name"
  ports_sync "$name"
  case "${1:-}" in
    "") session "$name" sbx exec -it "$name" bash ;;
    claude)
      shift
      # Everything after -- goes to Claude; a leading flag is added after the workload's defaults
      # (which include --dangerously-skip-permissions): https://docs.docker.com/ai/sandboxes/agents/claude-code
      if [ $# -gt 0 ]; then session "$name" sbx run --name "$name" -- "$@"; else session "$name" sbx run --name "$name"; fi ;;
    *)
      # A one-off command, e.g. `portable docker compose up -d`: forward what it started.
      status=0
      sbx exec -it "$name" "$@" || status=$?
      ports_sync "$name" --changed
      exit "$status" ;;
  esac
}

# Runs an interactive session in the foreground with the port watcher (lib/ports.sh) beside it, and
# leaves with the session's status. The watcher is detached from the terminal, which the session
# owns, and dies with this process.
session() {
  local name="$1" status=0 watcher
  shift
  ports_watch "$name" </dev/null >/dev/null 2>&1 &
  watcher=$!
  # shellcheck disable=SC2064
  trap "kill $watcher 2>/dev/null" EXIT
  "$@" || status=$?
  exit "$status"
}
