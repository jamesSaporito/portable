# Prepares the environment and runs the dev container. Expects PORTABLE_ROOT and lib/secrets.sh.

# The copy of portable that install.sh puts on PATH, a clone of its GitHub repo kept outside any
# workspace, so sessions can work on a clone of portable without touching the launcher that runs them.
# `portable update` moves it forward. Settings live outside both, so every copy shares them.
PORTABLE_INSTALL_DIR="${PORTABLE_INSTALL_DIR:-$HOME/.local/share/portable}"
PORTABLE_ENV_FILE="${PORTABLE_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/portable/.env}"

# Secrets exported into compose's own environment and passed through by name (see compose.yaml),
# so values never land in a file or on a command line.
PORTABLE_SECRETS=(ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN)

load_settings() {
  # Read .env as plain KEY=VALUE lines (never executed). Like Compose, a value already set in the shell wins.
  local key value
  if [ -f "$PORTABLE_ENV_FILE" ]; then
    while IFS='=' read -r key value || [ -n "$key" ]; do
      case "$key" in ''|\#*) continue ;; esac
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      [ -n "${!key:-}" ] || export "$key=$value"
    done < "$PORTABLE_ENV_FILE"
  fi
  # The most any session can see. Each one mounts the folder it's started in (session_folder), while
  # the shared engine mounts all of it (see compose.yaml).
  export WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME/Projects/sandboxed}"
  WORKSPACE_DIR="${WORKSPACE_DIR/#\~/$HOME}"
  load_hidden
  check_workspace
  mkdir -p "$WORKSPACE_DIR"
  # Folders are mounted at these same paths inside the containers (see compose.yaml), so paths that
  # tools record, such as git worktrees, work on both sides.
  WORKSPACE_DIR="$(cd -P "$WORKSPACE_DIR" && pwd)"
  check_workspace
  # Hidden folders outside it need no cover, and covering them would leave empty folders next to it
  # in the engine. Compose still needs a path, so these hide nothing.
  case "$PORTABLE_HIDE_SELF/" in "$WORKSPACE_DIR"/*) ;; *) PORTABLE_HIDE_SELF=/tmp/.portable-nothing-hidden-self ;; esac
  case "$PORTABLE_HIDE_CONFIG/" in "$WORKSPACE_DIR"/*) ;; *) PORTABLE_HIDE_CONFIG=/tmp/.portable-nothing-hidden-config ;; esac
}

# Folders covered with an empty, read-only one in the containers and the engine, even inside
# WORKSPACE_DIR: the copy of portable that's running, or the container could rewrite its own launcher
# and compose file and so widen its access on the next launch (the installed copy lives outside any
# workspace, so this only matters for a working copy run directly), and the configuration repo the Mac's ~/.claude links into, or
# it could change the skills and rules the Mac's Claude runs.
load_hidden() {
  export PORTABLE_HIDE_SELF="$PORTABLE_ROOT"
  local link config=""
  if link="$(readlink "$HOME/.claude/CLAUDE.md")"; then
    [[ "$link" = /* ]] || link="$HOME/.claude/$link"
    config="$(cd -P "$(dirname "$link")" 2>/dev/null && pwd)"
  fi
  export PORTABLE_HIDE_CONFIG="${config:-/tmp/.portable-nothing-hidden-config}"
}

# A hidden folder or one inside it can't be mounted: its real files would cover the empty one again.
inside_hidden() {
  case "$1/" in
    "$PORTABLE_HIDE_SELF"/* | "$PORTABLE_HIDE_CONFIG"/*) return 0 ;;
  esac
  return 1
}

check_workspace() {
  # Compare without trailing slashes, so "/" or "~/Projects/" can't slip past the patterns below.
  local ws="$WORKSPACE_DIR"
  while [ "$ws" != "${ws%/}" ]; do ws="${ws%/}"; done
  if [ -z "$ws" ] || [ "$ws" = "$HOME" ]; then
    echo "portable: WORKSPACE_DIR (${WORKSPACE_DIR}) is too broad; point it at a dedicated folder in .env" >&2
    exit 1
  fi
  if inside_hidden "$ws"; then
    echo "portable: WORKSPACE_DIR ($WORKSPACE_DIR) is inside portable or your Claude configuration repo, which are hidden from the container; point it at another folder in .env" >&2
    exit 1
  fi
  # A Mac path never overlaps the container's own folders, but a custom one could hide them.
  case "$ws/" in
    /bin/*|/boot/*|/dev/*|/etc/*|/home/*|/lib*|/proc/*|/root/*|/run/*|/sbin/*|/srv/*|/sys/*|/usr/*|/var/*)
      echo "portable: WORKSPACE_DIR ($WORKSPACE_DIR) would cover a system folder in the container; pick another" >&2
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
    "$PORTABLE_HIDE_SELF"/*)
      echo "portable: $here is the copy of portable that's running, which is hidden from the container so it can't change its own launcher; to work on it in portable, run the installed 'portable' instead" >&2
      return 1 ;;
    "$PORTABLE_HIDE_CONFIG"/*)
      echo "portable: $here is your Claude configuration repo, which is hidden from the container: your Mac's ~/.claude links into it, so the sandbox could change what your Mac's Claude runs." >&2
      echo "  To work on it in portable, run its installer, which links ~/.claude to a copy outside the workspace instead:" >&2
      echo "    '$PORTABLE_HIDE_CONFIG/install.sh'" >&2
      echo "  then push changes from here, and run './install.sh update' on your Mac once they're merged." >&2
      return 1 ;;
  esac
  echo "$here"
}

load_secrets() {
  local name value
  for name in "${PORTABLE_SECRETS[@]}"; do
    if value="$(secret_get "$name")"; then
      export "$name=$value"
    fi
  done

  # Claude needs one of these. An API key bills the Console; the OAuth token (from `claude setup-token`)
  # uses a Pro/Max subscription. If both are set, Claude Code prefers the API key:
  # https://code.claude.com/docs/en/authentication#authentication-precedence
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "portable: no Claude credential in the Keychain; run one of:" >&2
    echo "  portable secret set CLAUDE_CODE_OAUTH_TOKEN   # subscription, token from 'claude setup-token'" >&2
    echo "  portable secret set ANTHROPIC_API_KEY         # Console API key" >&2
  fi
  if [ -z "${GH_TOKEN:-}" ]; then
    echo "portable: no GitHub token; run: portable secret set GH_TOKEN" >&2
  fi
}

# Commits are made as the host's git identity unless GIT_NAME/GIT_EMAIL are set in .env.
load_git_identity() {
  local name="${GIT_NAME:-$(git config --global user.name 2>/dev/null || true)}"
  local email="${GIT_EMAIL:-$(git config --global user.email 2>/dev/null || true)}"
  export GIT_AUTHOR_NAME="$name" GIT_COMMITTER_NAME="$name"
  export GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_EMAIL="$email"
}

# Hash of image/, stamped on the dev image as a label when it's built.
image_hash_wanted() {
  (cd "$PORTABLE_ROOT/image" && find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)
}

# The hash the current images were built from, or nothing when either image is missing. The engine
# image has no label (see Dockerfile); it's always rebuilt along with the dev image.
image_hash_built() {
  docker image inspect portable-engine:local >/dev/null 2>&1 || return 0
  docker image inspect -f '{{index .Config.Labels "portable.image-hash"}}' portable-dev:local 2>/dev/null || true
}

# Rebuilds the images only when something in image/ changed since they were built, by comparing a hash
# of that folder with the label stamped on them (a cached `compose build` would cost ~1s per launch).
ensure_image() {
  local want have
  want="$(image_hash_wanted)"
  have="$(image_hash_built)"
  [ "$want" != "$have" ] || return 0

  # One build at a time when several launches start together (macOS has no flock, so a lock dir).
  # The others wait, then find the new image and skip building.
  local lock="$PORTABLE_ROOT/.build.lock" waiting=""
  until mkdir "$lock" 2>/dev/null; do
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      rmdir "$lock" 2>/dev/null  # left by a launch that died mid-build
      continue
    fi
    [ -n "$waiting" ] || echo "portable: waiting for another launch to finish building the image..." >&2
    waiting=1
    sleep 2
  done
  trap 'rmdir "$PORTABLE_ROOT/.build.lock" 2>/dev/null' EXIT

  have="$(image_hash_built)"
  if [ "$want" != "$have" ]; then
    echo "portable: image/ changed; rebuilding the images..." >&2
    PORTABLE_IMAGE_HASH="$want" docker compose -f "$PORTABLE_ROOT/compose.yaml" build dev docker >&2
  fi
  rmdir "$lock"
  trap - EXIT
}

# Container names are portable-<name>. Without --name, `claude --worktree X` is named X, and anything
# else <folder>-<4 random hex chars>.
container_name() {
  local name="$1" workdir="$2"
  shift 2
  if [ -z "$name" ] && [ "${1:-}" = claude ]; then
    while [ $# -gt 0 ]; do
      case "$1" in
        --worktree) name="${2:-}"; break ;;
        --worktree=*) name="${1#*=}"; break ;;
      esac
      shift
    done
  fi
  [ -n "$name" ] || name="$(basename "$workdir")-$(printf '%04x' $((RANDOM % 65536)))"
  if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    echo "portable: '$name' isn't a valid name (letters, digits, '.', '_', '-')" >&2
    return 1
  fi
  if [ -n "$(docker ps -aq --filter "name=^portable-$name\$")" ]; then
    echo "portable: a container named '$name' already exists; see 'portable ps' or pick another --name" >&2
    return 1
  fi
  echo "$name"
}

list_containers() {
  {
    printf 'NAME\tFOLDER\tCOMMAND\tSTARTED\n'
    docker ps --filter label=com.docker.compose.project=portable --filter label=portable.name \
      --format '{{.Label "portable.name"}}\t{{.Label "portable.workdir"}}\t{{.Label "portable.command"}}\t{{.RunningFor}}'
  } | column -t -s $'\t'
}

stop_container() {
  if [ -z "$(docker ps -aq --filter "name=^portable-$1\$")" ]; then
    echo "portable: no container named '$1'; see 'portable ps'" >&2
    return 1
  fi
  docker stop "portable-$1" >/dev/null && echo "Stopped $1"
}

# The host's Claude settings, merged into the container's at start (image/entrypoint.sh).
load_claude_settings() {
  local file="$HOME/.claude/settings.json"
  [ -f "$file" ] && export PORTABLE_CLAUDE_SETTINGS="$(cat "$file")"
  return 0
}

# A compose file adding PORTABLE_PORTS (from .env) to the engine, published on the Mac's 127.0.0.1.
# Compose can't turn one variable into a list of ports, so it's generated and passed on stdin.
engine_ports() {
  local port list=()
  for port in ${PORTABLE_PORTS:-}; do
    if ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      echo "portable: PORTABLE_PORTS: '$port' isn't a port number" >&2
      return 1
    fi
    list+=("\"127.0.0.1:$port:$port\"")
  done
  local IFS=,
  printf 'services:\n  docker:\n    ports: [%s]\n' "${list[*]-}"
}

# Starts the shared engine (compose service `docker`) and waits until it's ready. While other sessions
# run, an engine whose image or settings changed is left as it is: recreating it would cut their
# network and restart the containers it runs. The change applies at a launch with none running.
start_engine() {
  local ports
  ports="$(engine_ports)" || return
  local compose=(docker compose -f "$PORTABLE_ROOT/compose.yaml" -f -)
  local up=("${compose[@]}" up --detach --wait --quiet-pull docker)
  if [ -z "$(docker ps -q --filter label=com.docker.compose.project=portable --filter label=portable.name)" ]; then
    if ! "${up[@]}" <<< "$ports" >&2; then
      echo "portable: the Docker engine didn't start; if a port is already allocated, something on your Mac uses one in PORTABLE_PORTS (stop it or remove the port)" >&2
      return 1
    fi
    return
  fi
  "${up[@]}" --no-recreate <<< "$ports" >&2 || return
  # Compose's labels: the image's ID (with the containerd image store .Image is a different digest of
  # it) and a hash of the service's settings, e.g. PORTABLE_PORTS or PORTABLE_FIREWALL.
  if [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.image"}}' portable-engine 2>/dev/null)" \
      != "$(docker image inspect -f '{{.Id}}' portable-engine:local 2>/dev/null)" ] \
    || [ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' portable-engine 2>/dev/null)" \
      != "$("${compose[@]}" config --hash docker <<< "$ports" 2>/dev/null | awk '{ print $2 }')" ]; then
    echo "portable: the Docker engine has an update; it applies when no other session is running (portable ps)" >&2
  fi
}

# Usage: run_container NAME [command...]; NAME may be empty.
run_container() {
  local name="$1" workdir
  shift
  load_settings
  workdir="$(session_folder)" || exit 1
  export PORTABLE_SESSION_DIR="$workdir"
  name="$(container_name "$name" "$workdir" "$@")" || exit 1
  ensure_image
  load_secrets
  load_git_identity
  load_aws
  load_claude_settings
  start_engine || exit 1
  exec docker compose -f "$PORTABLE_ROOT/compose.yaml" run --rm --no-deps \
    --name "portable-$name" --label "portable.name=$name" --label "portable.workdir=$workdir" \
    --label "portable.command=${*:-bash}" \
    -w "$workdir" dev "$@"
}
