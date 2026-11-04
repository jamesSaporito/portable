#!/usr/bin/env bash
# Undoes install.sh. Safe to re-run. Asks before anything you'd lose for good; --yes answers yes to all.
#   1. deletes portable's sandboxes (asks first; their Docker data and Claude history go with them)
#   2. asks to remove the GitHub token and Infracost token sources from sbx
#   3. asks to delete leftovers of the Docker-based portable (engine container, volumes, images), if
#      Docker is still installed
#   4. asks to delete the secrets in the Keychain (macOS)
#   5. stops the environment pages and removes the `portable` command and the PATH lines install.sh added
#   6. deletes portable's own Node (~/.local/share/portable-node), then asks to delete the installed
#      copy (~/.local/share/portable) and the settings (config.json and
#      every environment's settings and sticky ports)
# Never touches the workspace folder, clones of portable in it, other sandboxes or sbx itself
# (brew uninstall sbx removes that).
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTABLE_INSTALL_DIR="${PORTABLE_INSTALL_DIR:-$HOME/.local/share/portable}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/portable"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/portable"
KEYCHAIN_SERVICE="${PORTABLE_KEYCHAIN_SERVICE:-portable}"
NODE_DIR="${PORTABLE_NODE_DIR:-$HOME/.local/share/portable-node}"
# portable's own Node, or any other while it's still there.
NODE="$NODE_DIR/current/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node || echo node)"

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

# portable's sandboxes, one name per line.
sandbox_names() {
  sbx ls --format json 2>/dev/null | "$NODE" -e '
    let text = ""; process.stdin.on("data", (c) => { text += c; }).on("end", () => {
      try { for (const s of JSON.parse(text)) if (s.name.startsWith("portable-")) console.log(s.name); } catch {}
    });'
}

remove_sandboxes() {
  if ! command -v sbx >/dev/null || ! sbx ls >/dev/null 2>&1; then
    echo "sbx isn't installed or signed in; skipping sandboxes. Sign in (sbx login) and re-run to remove them."
    return
  fi
  local names name
  names="$(sandbox_names)"
  if [ -n "$names" ]; then
    echo "portable's sandboxes (deleting them removes their Docker data and Claude history; workspace files stay):"
    "$NODE" "$PORTABLE_ROOT/bin/portable.mjs" ps || true
    if ask "Delete them?"; then
      while IFS= read -r name; do
        sbx rm --force "$name" >/dev/null && echo "Deleted ${name#portable-}"
      done <<< "$names"
    else
      echo "Left the sandboxes in place."
    fi
  fi
  if sbx secret ls 2>/dev/null | grep -q 'github' && ask "Remove the GitHub token source from sbx?"; then
    sbx secret rm --force github >/dev/null 2>&1 && echo "Removed it" || echo "Couldn't remove the github source; run: sbx secret rm --force github"
  fi
  if sbx secret ls 2>/dev/null | grep -q 'infracost' && ask "Remove the Infracost token source from sbx?"; then
    sbx secret rm --force infracost >/dev/null 2>&1 && echo "Removed it" || echo "Couldn't remove the infracost source; run: sbx secret rm --force infracost"
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
  for name in GH_TOKEN INFRACOST_CLI_AUTHENTICATION_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN; do
    security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$name" >/dev/null 2>&1 && stored+=("$name")
  done
  [ ${#stored[@]} -gt 0 ] || return 0
  if ask "Delete ${stored[*]} from the Keychain? You'd need to create new tokens to reinstall."; then
    for name in "${stored[@]}"; do security delete-generic-password -s "$KEYCHAIN_SERVICE" -a "$name" >/dev/null 2>&1; done
    echo "Deleted the secrets"
  fi
}

# The environment pages stop with their sandboxes; stop any left over.
stop_agents() {
  local file pid
  for file in "$STATE_DIR"/*/agent.json; do
    [ -f "$file" ] || continue
    pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$file")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "Stopped the page of $(basename "$(dirname "$file")")"
  done
  return 0
}

remove_command() {
  local link="$bin_dir/portable"
  # Only the link install.sh made: to the installed copy, or to a clone from before there was one.
  case "$(readlink "$link" 2>/dev/null)" in
    "$PORTABLE_INSTALL_DIR/bin/portable.mjs" | "$PORTABLE_ROOT/bin/portable.mjs" | "$PORTABLE_INSTALL_DIR/bin/portable" | "$PORTABLE_ROOT/bin/portable")
      rm "$link"
      echo "Removed $link" ;;
  esac
  rmdir "$bin_dir" 2>/dev/null || true

  local rc
  for rc in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
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
  if [ -d "$NODE_DIR" ]; then
    rm -rf "$NODE_DIR"
    echo "Deleted portable's Node ($NODE_DIR)"
  fi
  if [ -d "$CONFIG_DIR" ] && ask "Delete your settings in $CONFIG_DIR (config.json, and each environment's settings and ports)?"; then
    rm -rf "$CONFIG_DIR" "$STATE_DIR"
    echo "Deleted $CONFIG_DIR and $STATE_DIR"
  fi
}

remove_sandboxes
remove_old_docker
remove_secrets
stop_agents
remove_command
remove_install
echo "Done. Your workspace folder and any clones of portable in it were left in place. sbx itself stays installed (brew uninstall sbx)."
