#!/usr/bin/env bash
# One-command setup on a new machine. Safe to re-run.
#   0. when run from a clone (e.g. ~/Projects/portable): makes the installed copy, a clone of the same
#      GitHub repo in ~/.local/share/portable, moves the clone's old .env to the settings file, and
#      continues with the installed copy's install.sh, which does the rest
#   1. checks Docker is installed and running
#   2. links `portable` into ~/.local/bin and adds that folder to PATH in your shell's rc file
#   3. creates the settings file (~/.config/portable/.env) from .env.example if there isn't one
#   4. builds the image
#   5. offers to store any missing secrets in the Keychain (only when run in a terminal)
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$PORTABLE_ROOT/lib/secrets.sh"
. "$PORTABLE_ROOT/lib/launch.sh"

bin_dir="$HOME/.local/bin"

install_copy() {
  local installed url
  installed="$(cd -P "$PORTABLE_INSTALL_DIR" 2>/dev/null && pwd)" || true
  [ "$PORTABLE_ROOT" != "$installed" ] || return 0

  if [ -d "$PORTABLE_INSTALL_DIR/.git" ]; then
    echo "portable is already installed in $PORTABLE_INSTALL_DIR; 'portable update' updates it"
  else
    if ! url="$(git -C "$PORTABLE_ROOT" remote get-url origin 2>/dev/null)"; then
      echo "This clone has no 'origin' remote to install portable from." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$PORTABLE_INSTALL_DIR")"
    git clone --quiet "$url" "$PORTABLE_INSTALL_DIR"
    echo "Installed portable from $url in $PORTABLE_INSTALL_DIR"
  fi
  # Settings used to live in the clone.
  if [ -f "$PORTABLE_ROOT/.env" ] && [ ! -f "$PORTABLE_ENV_FILE" ]; then
    mkdir -p "$(dirname "$PORTABLE_ENV_FILE")"
    mv "$PORTABLE_ROOT/.env" "$PORTABLE_ENV_FILE"
    echo "Moved your settings from $PORTABLE_ROOT/.env to $PORTABLE_ENV_FILE"
  fi
  exec "$PORTABLE_INSTALL_DIR/install.sh" "$@"
}

check_docker() {
  if ! command -v docker >/dev/null; then
    echo "Docker isn't installed. Install Docker Desktop, then re-run this script." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Docker isn't running. Start Docker Desktop, then re-run this script." >&2
    exit 1
  fi
  command -v aws >/dev/null || echo "Note: the aws CLI isn't installed; AWS access in the container needs it on this machine."
}

rc_file() {
  case "$(basename "${SHELL:-}")" in
    zsh) echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bash_profile" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

link_command() {
  mkdir -p "$bin_dir"
  ln -sfn "$PORTABLE_ROOT/bin/portable" "$bin_dir/portable"
  echo "Linked $bin_dir/portable"

  local rc line='export PATH="$HOME/.local/bin:$PATH"'
  rc="$(rc_file)"
  if grep -qxF "$line" "$rc" 2>/dev/null; then
    return
  fi
  case ":$PATH:" in
    *":$bin_dir:"*) return ;;
  esac
  printf '\n# Added by portable/install.sh\n%s\n' "$line" >> "$rc"
  echo "Added ~/.local/bin to PATH in $rc (open a new terminal to use it)"
}

create_env() {
  if [ ! -f "$PORTABLE_ENV_FILE" ]; then
    mkdir -p "$(dirname "$PORTABLE_ENV_FILE")"
    cp "$PORTABLE_ROOT/.env.example" "$PORTABLE_ENV_FILE"
    echo "Created $PORTABLE_ENV_FILE from .env.example; edit it to change the workspace folder or AWS profile"
  fi
}

ask() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

offer_secrets() {
  if [ ! -t 0 ]; then
    echo "Not a terminal; skipping secret prompts. Store them later with: portable secret set NAME"
    return
  fi
  if ! secret_get ANTHROPIC_API_KEY >/dev/null && ! secret_get CLAUDE_CODE_OAUTH_TOKEN >/dev/null; then
    echo "No Claude credential stored. A subscription token comes from 'claude setup-token'."
    if ask "Store a subscription token (CLAUDE_CODE_OAUTH_TOKEN)?"; then
      secret_set CLAUDE_CODE_OAUTH_TOKEN
    elif ask "Store a Console API key (ANTHROPIC_API_KEY) instead?"; then
      secret_set ANTHROPIC_API_KEY
    fi
  fi
  if ! secret_get GH_TOKEN >/dev/null && ask "Store a GitHub fine-grained token (GH_TOKEN)?"; then
    secret_set GH_TOKEN
  fi
}

install_copy "$@"
check_docker
link_command
create_env
ensure_image
offer_secrets
echo "Done. Run 'portable' for a shell or 'portable claude' to start Claude in the container."
