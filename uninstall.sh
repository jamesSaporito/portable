#!/usr/bin/env bash
# Undoes install.sh. Safe to re-run. Asks before anything you'd lose for good; --yes answers yes to all.
#   1. deletes portable's sandboxes (asks first; their Docker data and Claude history go with them)
#   2. asks to remove the GitHub token and Infracost token sources from sbx
#   3. asks to delete leftovers of the Docker-based portable (engine container, volumes, images), if
#      Docker is still installed
#   4. asks to delete the secrets in the Keychain
#   5. removes the `portable` command and the PATH lines install.sh added
#   6. asks to delete the installed copy (~/.local/share/portable) and the settings file
# Never touches the workspace folder, clones of portable in it, other sandboxes or sbx itself
# (brew uninstall sbx removes that).
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$PORTABLE_ROOT/lib/secrets.sh"
. "$PORTABLE_ROOT/lib/aws.sh"
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

remove_sandboxes() {
  if ! command -v sbx >/dev/null || ! sbx ls >/dev/null 2>&1; then
    echo "sbx isn't installed or signed in; skipping sandboxes. Sign in (sbx login) and re-run to remove them."
    return
  fi
  if ! command -v jq >/dev/null; then
    echo "jq isn't installed, so portable's sandboxes can't be listed; skipping them. Install it (brew install jq) and re-run, or delete them with sbx rm."
    return
  fi
  local names name
  names="$(sandboxes_json | jq -r '.[].name')"
  if [ -n "$names" ]; then
    echo "portable's sandboxes (deleting them removes their Docker data and Claude history; workspace files stay):"
    list_containers
    if ask "Delete them?"; then
      while IFS= read -r name; do
        sbx rm --force "$name" >/dev/null && echo "Deleted ${name#portable-}"
      done <<< "$names"
    else
      echo "Left the sandboxes in place."
    fi
  fi
  if sbx secret ls 2>/dev/null | grep -q 'github' && ask "Remove the GitHub token source from sbx?"; then
    sbx secret rm github >/dev/null 2>&1 && echo "Removed it"
  fi
  if sbx secret ls 2>/dev/null | grep -q 'infracost' && ask "Remove the Infracost token source from sbx?"; then
    sbx secret rm infracost >/dev/null 2>&1 && echo "Removed it"
  fi
}

# The Docker-based portable (before the move to sandboxes) left an engine container, volumes and images.
remove_old_docker() {
  command -v docker >/dev/null && docker info >/dev/null 2>&1 || return 0
  local containers volumes images
  containers="$(docker ps -aq --filter label=com.docker.compose.project=portable 2>/dev/null || true)"
  volumes="$(docker volume ls -q --filter name='^portable_' 2>/dev/null || true)"
  local image
  images=""
  for image in portable-dev:local portable-engine:local; do
    images="$images$(docker image ls -q "$image" 2>/dev/null || true) "
  done
  images="${images// /}"
  [ -n "$containers$volumes$images" ] || return 0
  echo "Leftovers from the Docker-based portable were found in Docker Desktop."
  if ask "Delete them (the old engine, its volumes with projects' data, and the images)?"; then
    [ -z "$containers" ] || docker rm -f $containers >/dev/null
    [ -z "$volumes" ] || docker volume rm $volumes >/dev/null 2>&1 || true
    [ -z "$images" ] || docker rmi $images >/dev/null 2>&1 || true
    echo "Deleted them"
  fi
}

remove_secrets() {
  local name stored=()
  for name in "${PORTABLE_SECRETS[@]}" ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
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
  # Only the link install.sh made: to the installed copy, or to a clone from before there was one.
  case "$(readlink "$link" 2>/dev/null)" in
    "$PORTABLE_INSTALL_DIR/bin/portable" | "$PORTABLE_ROOT/bin/portable")
      rm "$link"
      echo "Removed $link" ;;
  esac
  rmdir "$bin_dir" 2>/dev/null || true

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

remove_install() {
  if [ -d "$PORTABLE_INSTALL_DIR" ]; then
    [ -z "$(git -C "$PORTABLE_INSTALL_DIR" status --porcelain 2>/dev/null)" ] \
      || echo "Note: $PORTABLE_INSTALL_DIR has changes that aren't on GitHub."
    if ask "Delete the installed copy of portable in $PORTABLE_INSTALL_DIR? A reinstall clones it again."; then
      rm -rf "$PORTABLE_INSTALL_DIR"
      echo "Deleted $PORTABLE_INSTALL_DIR"
    fi
  fi
  if [ -f "$PORTABLE_ENV_FILE" ] && ask "Delete your settings in $PORTABLE_ENV_FILE?"; then
    rm "$PORTABLE_ENV_FILE"
    rmdir "$(dirname "$PORTABLE_ENV_FILE")" 2>/dev/null || true
    echo "Deleted $PORTABLE_ENV_FILE"
  fi
}

remove_sandboxes
remove_old_docker
remove_secrets
remove_command
remove_install
echo "Done. Your workspace folder and any clones of portable in it were left in place. sbx itself stays installed (brew uninstall sbx)."
