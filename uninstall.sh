#!/usr/bin/env bash
# Undoes install.sh. Safe to re-run. Asks before anything you'd lose for good; --yes answers yes to all.
#   1. stops and removes portable's containers, its Docker engine and network (asks first if any
#      session is running)
#   2. asks to delete Claude's history and settings in the container (Docker volumes)
#   3. asks to delete what the engine holds: projects' images, containers and their data (a volume)
#   4. asks to delete the images
#   5. asks to delete the secrets in the Keychain
#   6. removes the `portable` command and the PATH lines install.sh added
# Never touches the workspace folder, this project folder or other projects' containers.
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$PORTABLE_ROOT/lib/secrets.sh"
. "$PORTABLE_ROOT/lib/launch.sh"

bin_dir="$HOME/.local/bin"
marker="# Added by portable/install.sh"
yes=""
[ "${1:-}" = --yes ] && yes=1

if [ -z "$yes" ] && [ ! -t 0 ]; then
  echo "Not a terminal; run it in one, or pass --yes to remove everything without asking." >&2
  exit 1
fi

ask() {
  [ -z "$yes" ] || return 0
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

# compose.yaml requires WORKSPACE_DIR, though removing things never uses it.
compose() { WORKSPACE_DIR=/nonexistent docker compose -f "$PORTABLE_ROOT/compose.yaml" "$@"; }

remove_docker() {
  if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
    echo "Docker isn't running; skipping containers, volumes and the image. Start it and re-run to remove them."
    return
  fi

  local running
  running="$(docker ps -q --filter label=com.docker.compose.project=portable --filter label=portable.name)"
  if [ -n "$running" ]; then
    echo "These portable sessions are running; removing them ends them:"
    list_containers
    ask "Stop and remove them?" || { echo "Left everything in place."; exit 1; }
  fi
  # Containers from `portable` (compose run) aren't removed by `down`, so remove them by label.
  local all
  all="$(docker ps -aq --filter label=com.docker.compose.project=portable)"
  [ -z "$all" ] || docker rm -f $all >/dev/null
  compose down --remove-orphans 2>/dev/null
  echo "Removed portable's containers, Docker engine and network"

  local volume
  if [ -n "$(docker volume ls -q --filter name='^portable_claude-')" ] \
    && ask "Delete Claude's history, settings and configuration clone in the container (Docker volumes)?"; then
    for volume in portable_claude-state portable_claude-configuration; do
      docker volume rm "$volume" >/dev/null 2>&1 || true
    done
    echo "Deleted Claude's volumes"
  fi
  if [ -n "$(docker volume ls -q --filter name='^portable_docker-')" ] \
    && ask "Delete everything the portable Docker engine holds: projects' images, containers and their data (e.g. databases)?"; then
    for volume in portable_docker-data portable_docker-certs; do
      docker volume rm "$volume" >/dev/null 2>&1 || true
    done
    echo "Deleted the engine's volumes"
  fi

  local image
  for image in portable-dev:local portable-engine:local; do
    if docker image inspect "$image" >/dev/null 2>&1 \
      && ask "Delete the image $image? A reinstall rebuilds it in a few minutes."; then
      docker rmi "$image" >/dev/null
      echo "Deleted $image"
    fi
  done
}

remove_secrets() {
  local name stored=()
  for name in "${PORTABLE_SECRETS[@]}"; do
    secret_get "$name" >/dev/null && stored+=("$name")
  done
  [ ${#stored[@]} -gt 0 ] || return 0
  if ask "Delete ${stored[*]} from the Keychain? You'd need to create new tokens to reinstall."; then
    for name in "${stored[@]}"; do secret_delete "$name" 2>/dev/null; done
    echo "Deleted the secrets"
  fi
}

remove_command() {
  local link="$bin_dir/portable"
  # Only the link install.sh made, pointing at this copy of the project.
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$PORTABLE_ROOT/bin/portable" ]; then
    rm "$link"
    echo "Removed $link"
  fi
  rmdir "$bin_dir" 2>/dev/null || true
  rmdir "$PORTABLE_ROOT/.build.lock" 2>/dev/null || true

  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    grep -qxF "$marker" "$rc" 2>/dev/null || continue
    # Other tools install into ~/.local/bin too; keep it on PATH while anything is left there.
    if [ -d "$bin_dir" ]; then
      echo "Kept the PATH line in $rc: other programs are in $bin_dir"
      continue
    fi
    cp "$rc" "$rc.portable-backup"
    # Drop the marker, the PATH line after it and the blank line install.sh put before it.
    awk -v marker="$marker" '
      $0 == marker { skip = 1; if (blank) blank = 0; next }
      skip { skip = 0; if ($0 ~ /^export PATH="\$HOME\/\.local\/bin:\$PATH"$/) next }
      { if (blank) print ""; blank = ($0 == ""); if (!blank) print }
      END { if (blank) print "" }' "$rc.portable-backup" > "$rc"
    echo "Removed the PATH lines from $rc (backup: $rc.portable-backup)"
  done
}

remove_docker
remove_secrets
remove_command
echo "Done. Your workspace folder and this project folder ($PORTABLE_ROOT) were left in place; delete them yourself if you want."
