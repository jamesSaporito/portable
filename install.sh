#!/usr/bin/env bash
# One-command setup on a new Mac. Safe to re-run.
#   0. when run from a clone (e.g. ~/Projects/portable): makes the installed copy, a clone of the same
#      GitHub repo in ~/.local/share/portable, moves the clone's old .env to the settings file, and
#      continues with the installed copy's install.sh, which does the rest
#   1. installs Docker Sandboxes (sbx) with Homebrew if needed, and signs in to Docker
#   2. links `portable` into ~/.local/bin and adds that folder to PATH in your shell's rc file
#   3. creates the settings file (~/.config/portable/.env) from .env.example if there isn't one
#   4. offers to store the GitHub token and Infracost token in the Keychain (only when run in a terminal)
#   5. tells sbx to read them from the Keychain
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$PORTABLE_ROOT/lib/secrets.sh"
. "$PORTABLE_ROOT/lib/aws.sh"
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

ask() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

# Docker Sandboxes: https://docs.docker.com/ai/sandboxes/install/ (Apple silicon, macOS 14+).
check_sbx() {
  if [ "$(uname -s)" != Darwin ]; then
    echo "portable runs on macOS (its secrets live in the Keychain)." >&2
    exit 1
  fi
  if [ "$(uname -m)" != arm64 ]; then
    echo "Docker Sandboxes needs an Apple silicon Mac; this one is $(uname -m)." >&2
    exit 1
  fi
  if ! command -v sbx >/dev/null; then
    if ! command -v brew >/dev/null; then
      echo "Docker Sandboxes (sbx) isn't installed and Homebrew isn't available to install it. See https://docs.docker.com/ai/sandboxes/install/" >&2
      exit 1
    fi
    echo "Docker Sandboxes (sbx) isn't installed. It runs Claude in a microVM; it's free for local use and doesn't need Docker Desktop."
    if [ -t 0 ] && ! ask "Install it with Homebrew (brew trust docker/tap && brew install docker/tap/sbx)?"; then
      echo "Install it yourself, then re-run this script." >&2
      exit 1
    fi
    brew trust docker/tap
    brew install docker/tap/sbx
  fi
  local version
  version="$(sbx_version)"
  if [ -n "$version" ] && ! version_ge "$version" "$PORTABLE_SBX_MIN"; then
    echo "sbx $version is too old; portable needs $PORTABLE_SBX_MIN or later. Run: brew upgrade sbx" >&2
    exit 1
  fi
  if ! sbx ls >/dev/null 2>&1; then
    echo "Signing in to Docker (sbx needs an account; the browser opens)..."
    sbx login
  fi
  command -v aws >/dev/null || echo "Note: the aws CLI isn't installed; AWS access in the sandbox needs it on this machine (brew install awscli)."
  command -v jq >/dev/null || echo "Note: jq isn't installed; portable needs it to read sbx's listings (macOS 15 and later have it; otherwise: brew install jq)."
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

offer_secrets() {
  if [ ! -t 0 ]; then
    echo "Not a terminal; skipping secret prompts. Store the GitHub token later with: portable secret set GH_TOKEN"
    return
  fi
  if ! secret_get GH_TOKEN >/dev/null && ask "Store a GitHub fine-grained token (GH_TOKEN) in the Keychain?"; then
    secret_set GH_TOKEN
  fi
  if ! secret_get INFRACOST_CLI_AUTHENTICATION_TOKEN >/dev/null && ask "Store an Infracost token (INFRACOST_CLI_AUTHENTICATION_TOKEN) in the Keychain?"; then
    secret_set INFRACOST_CLI_AUTHENTICATION_TOKEN
  fi
}

# sbx reads the secrets from the Keychain whenever the proxy needs them; the values never enter a
# sandbox. Must exist before a sandbox is created: https://docs.docker.com/ai/sandboxes/workflows/authentication/
register_secret_source() {
  local service="$1" name="$2" label="$3"
  if sbx secret set "$service" --command "security find-generic-password -s $PORTABLE_KEYCHAIN_SERVICE -a $name -w" >/dev/null 2>&1; then
    echo "sbx will read the $label from your Keychain"
  else
    echo "Couldn't register the $label with sbx; run: sbx secret set $service --command 'security find-generic-password -s $PORTABLE_KEYCHAIN_SERVICE -a $name -w'" >&2
  fi
}

install_copy "$@"
check_sbx
link_command
create_env
offer_secrets
register_secret_source github GH_TOKEN "GitHub token"
register_secret_source infracost INFRACOST_CLI_AUTHENTICATION_TOKEN "Infracost token"
echo "Done. Run 'portable claude' in a project folder; the first time on this Mac, sign in to Claude with /login."
