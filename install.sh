#!/usr/bin/env bash
# One-command setup on a new Mac (Apple silicon). Safe to re-run.
#   0. when run from a clone (e.g. ~/Projects/portable): makes the installed copy, a clone of the same
#      GitHub repo in ~/.local/share/portable, or updates it from GitHub when it's already there, and
#      continues with the installed copy's install.sh, which does the rest
#   1. checks this is an Apple silicon Mac, then offers to install what's missing, asking first:
#      portable's own Node 26 (from nodejs.org, into ~/.local/share/portable-node), then Docker
#      Sandboxes (sbx), with Homebrew first if it's needed for that; then signs in to Docker
#   2. links `portable` into ~/.local/bin and adds that folder to PATH in your shell's rc file
#   3. creates the settings folder (~/.config/portable): from your settings repo when given
#      (--settings URL, or PORTABLE_SETTINGS_REPO), else config.json from the defaults; asks for your
#      Claude configuration repo if none is set
#   4. runs `portable configure` (only in a terminal), which asks for the GitHub token;
#      they go in the Keychain, and sbx is told to read them from there
set -euo pipefail

PORTABLE_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTABLE_INSTALL_DIR="${PORTABLE_INSTALL_DIR:-$HOME/.local/share/portable}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/portable"
# A git repo holding ~/.config/portable (config.json and envs/), so environments come along to
# another Mac; see the README, "Carrying settings to another Mac".
SETTINGS_REPO="${PORTABLE_SETTINGS_REPO:-}"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --settings) SETTINGS_REPO="${2:-}"; [ -n "$SETTINGS_REPO" ] || { echo "usage: install.sh [--settings REPO_URL]" >&2; exit 2; }; shift 2 ;;
    --settings=*) SETTINGS_REPO="${1#--settings=}"; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
set -- ${args[@]+"${args[@]}"}
SBX_MIN=0.50.0
bin_dir="$HOME/.local/bin"
os="$(uname -s)"

ask() {
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

portable() {
  "$NODE" "$PORTABLE_ROOT/bin/portable.mjs" "$@"
}

install_copy() {
  local installed url
  installed="$(cd -P "$PORTABLE_INSTALL_DIR" 2>/dev/null && pwd)" || true
  [ "$PORTABLE_ROOT" != "$installed" ] || return 0

  if [ -d "$PORTABLE_INSTALL_DIR/.git" ]; then
    # Bring it up to GitHub's branch first, or the hand-off below would run an older installer.
    echo "portable is already installed in $PORTABLE_INSTALL_DIR; updating it from GitHub"
    if ! PORTABLE_INSTALL_DIR="$PORTABLE_INSTALL_DIR" portable update; then
      echo "Fix the installed copy as shown above, then run install.sh again." >&2
      exit 1
    fi
  else
    if ! url="$(git -C "$PORTABLE_ROOT" remote get-url origin 2>/dev/null)"; then
      echo "This clone has no 'origin' remote to install portable from." >&2
      exit 1
    fi
    mkdir -p "$(dirname "$PORTABLE_INSTALL_DIR")"
    git clone --quiet "$url" "$PORTABLE_INSTALL_DIR"
    echo "Installed portable from $url in $PORTABLE_INSTALL_DIR"
  fi
  exec "$PORTABLE_INSTALL_DIR/install.sh" ${SETTINGS_REPO:+--settings "$SETTINGS_REPO"} "$@"
}

# Asks before installing anything; without a terminal to ask in, says what's missing and stops.
offer_install() {
  local what="$1" how="$2"
  echo "$what isn't installed."
  if [ ! -t 0 ] || ! ask "Install it now ($how)?"; then
    echo "Install $what yourself, then re-run this script." >&2
    exit 1
  fi
}

# Homebrew, which installs Node and sbx on macOS: https://brew.sh/
# Its installer explains what it'll do and waits for Enter (and your password) before doing it.
ensure_brew() {
  command -v brew >/dev/null && return 0
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return 0
  fi
  offer_install Homebrew "the official installer from brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple silicon puts it in /opt/homebrew, which isn't on PATH yet; add it here and for new shells.
  eval "$(/opt/homebrew/bin/brew shellenv)"
  local line='eval "$(/opt/homebrew/bin/brew shellenv)"' profile="$HOME/.zprofile"
  [ "$(basename "${SHELL:-}")" = zsh ] || profile="$HOME/.bash_profile"
  if ! grep -qxF "$line" "$profile" 2>/dev/null; then
    printf '\n%s\n' "$line" >> "$profile"
    echo "Added Homebrew to PATH in $profile"
  fi
}

# portable runs on its own Node, one major line on every computer: the newest 26.x from nodejs.org,
# checked against its published SHA-256 sums, in ~/.local/share/portable-node. Nothing else uses it,
# and Node installed some other way is left alone. Re-running install.sh moves it to the newest 26.x.
# Files and sums: https://nodejs.org/dist/latest-v26.x/ (SHASUMS256.txt)
NODE_MAJOR=26
NODE_DIR="${PORTABLE_NODE_DIR:-$HOME/.local/share/portable-node}"
NODE="$NODE_DIR/current/bin/node"

ensure_node() {
  local platform=darwin-arm64 base sums file want got version tmp old
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  if ! sums="$(curl -fsSL "$base/SHASUMS256.txt")"; then
    if [ -x "$NODE" ]; then
      echo "Couldn't reach nodejs.org to check for a newer Node $NODE_MAJOR; keeping $("$NODE" --version)"
      return 0
    fi
    echo "Couldn't download Node $NODE_MAJOR's file list from $base (offline?)." >&2
    exit 1
  fi
  file="$(printf '%s\n' "$sums" | awk -v p="-$platform.tar.gz" 'index($2, p) && $2 ~ /^node-v[0-9.]+-/ { print $2; exit }')"
  want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1 }')"
  version="${file#node-}"
  version="${version%-"$platform".tar.gz}"
  if [ -z "$file" ] || [ -z "$want" ]; then
    echo "Node $NODE_MAJOR's file list has no build for $platform." >&2
    exit 1
  fi
  if [ -x "$NODE_DIR/$version/bin/node" ]; then
    ln -sfn "$version" "$NODE_DIR/current"
    return 0
  fi

  if [ -x "$NODE" ]; then
    echo "Updating portable's Node from $("$NODE" --version) to $version"
  else
    echo "portable runs on its own Node $NODE_MAJOR, kept in $NODE_DIR and used by nothing else."
    if [ ! -t 0 ] || ! ask "Download Node $version from nodejs.org into $NODE_DIR?"; then
      echo "portable needs it; re-run this script when you're ready." >&2
      exit 1
    fi
  fi
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  got="$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')"
  if [ "$got" != "$want" ]; then
    rm -rf "$tmp"
    echo "The download of $file doesn't match nodejs.org's SHA-256 sum; nothing was installed." >&2
    exit 1
  fi
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$tmp"
  rm -rf "${NODE_DIR:?}/$version"
  mv "$tmp/node-$version-$platform" "$NODE_DIR/$version"
  rm -rf "$tmp"
  ln -sfn "$version" "$NODE_DIR/current"
  # Only the version in use is kept.
  for old in "$NODE_DIR"/v*; do
    [ "$old" = "$NODE_DIR/$version" ] || rm -rf "$old"
  done
  echo "Installed Node $version for portable in $NODE_DIR"
}

# What Docker Sandboxes runs on, checked before anything is installed:
# https://docs.docker.com/ai/sandboxes/install/
check_platform() {
  if [ "$os" != Darwin ]; then
    echo "portable runs on macOS (Apple silicon); this is $os." >&2
    exit 1
  fi
  if [ "$(uname -m)" != arm64 ]; then
    echo "Docker Sandboxes needs an Apple silicon Mac; this one is $(uname -m)." >&2
    exit 1
  fi
}

# Docker Sandboxes: https://docs.docker.com/ai/sandboxes/install/
check_sbx() {
  if ! command -v sbx >/dev/null; then
    echo "Docker Sandboxes (sbx) isn't installed. It runs Claude in a microVM; it's free for local use and doesn't need Docker Desktop."
    ensure_brew
    if ! [ -t 0 ] || ! ask "Install it with Homebrew (brew trust docker/tap && brew install docker/tap/sbx)?"; then
      echo "Install it yourself (https://docs.docker.com/ai/sandboxes/install/), then re-run this script." >&2
      exit 1
    fi
    brew trust docker/tap
    brew install docker/tap/sbx
  fi
  local version
  version="$(sbx version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ -n "$version" ] && [ "$(printf '%s\n%s\n' "$SBX_MIN" "$version" | sort -V | head -1)" != "$SBX_MIN" ]; then
    echo "sbx $version is too old; portable needs $SBX_MIN or later. Upgrade it: brew upgrade sbx" >&2
    exit 1
  fi
  if ! sbx ls >/dev/null 2>&1; then
    echo "Signing in to Docker (sbx needs an account; the browser opens)..."
    sbx login
  fi
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
  # Only the startup files a new terminal reads count, not this shell's PATH: it may still have
  # ~/.local/bin from before an uninstall removed the line, or from whatever started this script.
  local files
  case "$(basename "${SHELL:-}")" in
    zsh) files=("$HOME/.zshenv" "$HOME/.zprofile" "$HOME/.zshrc") ;;
    bash) files=("$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile") ;;
    *) files=("$HOME/.profile") ;;
  esac
  if grep -qsE '^[^#]*PATH=.*(\$HOME|\$\{HOME\}|~)/\.local/bin' "${files[@]}" \
    || grep -qsE "^[^#]*PATH=.*$HOME/\\.local/bin" "${files[@]}"; then
    return
  fi
  printf '\n# Added by portable/install.sh\n%s\n' "$line" >> "$rc"
  echo "Added ~/.local/bin to PATH in $rc (open a new terminal to use it)"
}

# Runs a snippet with portable's config module; PORTABLE_LIB points at lib/.
with_config() {
  PORTABLE_LIB="$PORTABLE_ROOT/lib" "$NODE" --input-type=module -e "
    const { portablePaths } = await import(\`\${process.env.PORTABLE_LIB}/paths.mjs\`);
    const { loadGlobal, saveGlobal } = await import(\`\${process.env.PORTABLE_LIB}/config.mjs\`);
    const paths = portablePaths();
    $1"
}

# The settings folder: cloned from the settings repo when one is given and there's nothing there
# yet (or pulled when it's already that clone), else config.json made from the defaults. Then asks
# for the Claude configuration repo when none is set.
create_config() {
  local repo="" current
  if [ -n "$SETTINGS_REPO" ]; then
    if [ -d "$CONFIG_DIR/.git" ]; then
      current="$(git -C "$CONFIG_DIR" remote get-url origin 2>/dev/null || true)"
      if [ "$current" != "$SETTINGS_REPO" ]; then
        echo "$CONFIG_DIR is already a clone of $current, not $SETTINGS_REPO; leaving it." >&2
      elif [ -z "$(git -C "$CONFIG_DIR" status --porcelain)" ]; then
        git -C "$CONFIG_DIR" pull --quiet --ff-only || echo "Couldn't update $CONFIG_DIR from $SETTINGS_REPO; using what's there." >&2
      else
        echo "$CONFIG_DIR has local changes; not pulling $SETTINGS_REPO over them."
      fi
    elif [ -e "$CONFIG_DIR" ] && [ -n "$(ls -A "$CONFIG_DIR" 2>/dev/null)" ]; then
      echo "$CONFIG_DIR exists and isn't a clone; move it aside to use $SETTINGS_REPO, or commit it there yourself (see README, Carrying settings to another Mac)." >&2
    else
      mkdir -p "$(dirname "$CONFIG_DIR")"
      git clone --quiet "$SETTINGS_REPO" "$CONFIG_DIR"
      echo "Cloned your settings from $SETTINGS_REPO into $CONFIG_DIR"
    fi
  fi
  with_config 'const { initGlobal } = await import(`${process.env.PORTABLE_LIB}/config.mjs`); initGlobal(paths); console.log(`Settings are in ${paths.configFile}`);'
  if [ -t 0 ] && [ -z "$(with_config 'process.stdout.write(loadGlobal(paths, {}).claudeConfigRepo);')" ]; then
    read -r -p "Your Claude configuration repo (HTTPS git URL, blank for none): " repo
    [ -z "$repo" ] || REPO="$repo" with_config 'saveGlobal(paths, { ...loadGlobal(paths, {}), claudeConfigRepo: process.env.REPO });'
  fi
}

# AWS is turned on per environment, on its page, so the aws CLI is only mentioned here.
offer_aws() {
  command -v aws >/dev/null && return 0
  echo "Note: the aws CLI isn't installed. It's only needed if you turn AWS on for an environment (on its page); then: brew install awscli"
}

# Prompts for the GitHub token if it isn't stored yet (portable configure).
offer_secrets() {
  if [ ! -t 0 ]; then
    echo "Not a terminal; skipping secrets. Store them later with: portable configure"
    return
  fi
  portable configure || echo "You can finish this later with: portable configure"
}

check_platform
ensure_node
install_copy "$@"
check_sbx
link_command
create_config
offer_aws
offer_secrets
echo "Done. Run 'portable claude' in a project folder; the first time on this computer, sign in to Claude with /login. 'portable ui' opens the folder's page."
