#!/usr/bin/env bash
# Runs at every container start, then hands over to the requested command.
#
# As root: updates the personal Claude configuration repo's clone, which root owns and dev can only
# read, then re-runs itself as `dev` with every capability dropped. The outbound firewall lives in the
# engine container (engine-entrypoint.sh), whose network this container shares.
# As dev: links the clone into ~/.claude with the repo's own install.sh. Failures with the repo only
# warn, so the container still starts without it.
set -uo pipefail

config_dir=/home/dev/claude-configuration
state_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# Root runs git with its own HOME, so gh (the credential helper) leaves no root-owned files in dev's.
config_git() { HOME=/root git -C "$config_dir" "$@"; }

# Prints a CLAUDE.md or rules file (path relative to the clone, read from stdin) without the lines that
# name one of the skills or rules in $2, e.g. the docker-ports workflow step and rule bullet, and with
# CLAUDE.md's numbered list renumbered. This is how the container's copy leaves disabled ones out.
filter_disabled() {
  local name script=""
  for name in $2; do script="$script/\`$name\`/d;"; done
  if [ "$1" = CLAUDE.md ]; then
    sed "$script" | awk '/^[0-9]+\. / { sub(/^[0-9]+/, ++n) } !/^[0-9]+\. / { n = 0 } 1'
  else
    sed "$script"
  fi
}

# Copies files changed or added in the clone, other than by portable's filtering, to the state volume
# before an update replaces them. Read-only clones shouldn't have any, but ones from before that can.
save_leftovers() {
  local filtered file files="" backup
  filtered="$(cat "$config_dir/.git/portable-filtered" 2>/dev/null)"
  while IFS= read -r file; do
    case "$file" in
      CLAUDE.md | rules/*.md)
        config_git show "HEAD:$file" 2>/dev/null | filter_disabled "$file" "$filtered" \
          | cmp -s - "$config_dir/$file" && continue ;;
    esac
    files="$files$file"$'\n'
  done < <(config_git ls-files --modified --others --exclude-standard)
  [ -n "$files" ] || return 0

  backup="$state_dir/backups/claude-configuration-leftovers/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  while IFS= read -r file; do
    (cd "$config_dir" && cp --parents "$file" "$backup" 2>/dev/null)
  done <<< "${files%$'\n'}"
  chown dev:dev "$state_dir/backups"
  chown -R dev:dev "$state_dir/backups/claude-configuration-leftovers"
  echo "portable: $config_dir had changes made in it, which this update replaces. Saved them to $backup:" >&2
  printf '%s' "$files" | sed 's/^/  /' >&2
}

# Runs as root. The clone is root's and read-only to dev, so a session can't edit it and leave changes
# that block later updates: changes go through the repo on GitHub (see claude-instructions.md).
update_claude_config() {
  local repo="${PORTABLE_CLAUDE_CONFIG_REPO:-}"
  [ -n "$repo" ] || return 0

  # Which disabled names the clone's files are currently filtered for.
  local marker="$config_dir/.git/portable-filtered" disabled="${PORTABLE_CLAUDE_CONFIG_DISABLE:-}"
  local refilter=""

  # Also takes over clones dev owned before.
  chown -R root:root "$config_dir"
  if [ ! -d "$config_dir/.git" ]; then
    echo "portable: cloning $repo" >&2
    if ! HOME=/root git clone --quiet "$repo" "$config_dir" >&2; then
      echo "portable: couldn't clone $repo (does GH_TOKEN include it?); continuing without it" >&2
      return 0
    fi
    refilter=1
  elif ! HOME=/root timeout 10 git -C "$config_dir" fetch --quiet >/dev/null 2>&1; then
    echo "portable: couldn't update $config_dir (offline?); using the copy already there" >&2
  elif [ "$(config_git rev-parse HEAD)" != "$(config_git rev-parse '@{u}')" ]; then
    # Only touch the files when there's something new, so sessions already running in other
    # containers never see them half-updated. A reset rather than a merge: the clone only ever
    # mirrors the remote, even after a force-push.
    save_leftovers
    config_git reset --quiet --hard '@{u}' && config_git clean -fdq
    refilter=1
  fi
  if [ "$(cat "$marker" 2>/dev/null)" != "$disabled" ]; then
    config_git checkout --quiet -- CLAUDE.md rules 2>/dev/null
    refilter=1
  fi

  if [ -n "$refilter" ]; then
    # Edits go to the clone's files, which ~/.claude links to, so the links stay intact.
    local path
    for path in "$config_dir/CLAUDE.md" "$config_dir"/rules/*.md; do
      [ -f "$path" ] || continue
      filter_disabled "${path#"$config_dir/"}" "$disabled" < "$path" > "$path.tmp" && mv "$path.tmp" "$path"
    done
    echo "$disabled" > "$marker"
  fi
  chmod -R a+rX,go-w "$config_dir"
}

if [ "$(id -u)" = 0 ]; then
  [ "${PORTABLE_FIREWALL:-on}" != off ] \
    || echo "portable: firewall is off (PORTABLE_FIREWALL=off); outbound traffic is unrestricted" >&2
  # Several containers share the state and config volumes, so one start-up at a time does the setup.
  # The lock file lives in the shared state volume, and fd 9 keeps it held through the switch to dev
  # until the setup there is done too.
  lock="$state_dir/.portable-setup.lock"
  [ -e "$lock" ] || install -o dev -g dev -m 644 /dev/null "$lock"
  exec 9> "$lock"
  flock 9
  update_claude_config
  exec setpriv --reuid=dev --regid=dev --init-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all -- "$0" "$@"
fi

install_claude_config() {
  [ -n "${PORTABLE_CLAUDE_CONFIG_REPO:-}" ] && [ -d "$config_dir/.git" ] || return 0
  # install.sh keeps disabled names in this file, so write it from PORTABLE_CLAUDE_CONFIG_DISABLE
  # rather than passing --disable: names removed from .env then come back on.
  local name
  for name in ${PORTABLE_CLAUDE_CONFIG_DISABLE:-}; do echo "$name"; done > "$state_dir/personal-disabled"
  # Idempotent; stay quiet when nothing changed. This copy is the installed one: install.sh would
  # otherwise make its own clone in ~/.local/share and link that instead.
  CLAUDE_CONFIGURATION_DIR="$config_dir" "$config_dir/install.sh" 2>&1 | grep -v '^Already up to date' >&2 || true
}

# Merges the host's ~/.claude/settings.json (passed in by bin/portable) into the container's, host
# values winning. Host-only entries are stripped first, since their paths don't exist in here:
#   - settings that run host commands (hooks, status line, credential helpers), dropped whole
#   - any other value mentioning a macOS path (/Users/..., /opt/homebrew/..., etc.), wherever it is,
#     e.g. a permission rule, an additionalDirectories entry or an env value. Paths inside the
#     workspace are kept, since it's mounted at the same path in here.
sync_settings() {
  [ -n "${PORTABLE_CLAUDE_SETTINGS:-}" ] || return 0
  local file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" tmp
  [ -s "$file" ] || echo '{}' > "$file"
  tmp="$(mktemp)"
  if jq --argjson host "$PORTABLE_CLAUDE_SETTINGS" --arg ws "${WORKSPACE_DIR:-/nonexistent}" '
      def host_path: type == "string"
        and test("(^|[^A-Za-z0-9_.-])(/Users|/Applications|/Library|/System|/Volumes|/private|/opt/homebrew)(/|$)")
        and (contains($ws) | not);
      ($host
        | del(.hooks, .statusLine, .apiKeyHelper, .awsAuthRefresh, .awsCredentialExport, .otelHeadersHelper)
        | delpaths([paths(host_path)])) as $clean
      | . * $clean' \
      "$file" > "$tmp" 2>/dev/null; then
    # Replace only on a real change, so sessions running in other containers aren't disturbed.
    if cmp -s "$tmp" "$file"; then rm -f "$tmp"; else mv "$tmp" "$file"; fi
  else
    rm -f "$tmp"
    echo "portable: couldn't merge the host's settings.json; keeping the container's" >&2
  fi
}

# Skips Claude's first-run theme and welcome screens, which would otherwise return whenever the state
# volume is new. The per-folder trust prompt is left in place on purpose.
skip_onboarding() {
  local file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.claude.json" tmp
  if [ ! -s "$file" ]; then
    echo '{"hasCompletedOnboarding": true}' > "$file"
  elif [ "$(jq -r '.hasCompletedOnboarding // false' "$file" 2>/dev/null)" != true ]; then
    tmp="$(mktemp)" && jq '.hasCompletedOnboarding = true' "$file" > "$tmp" && mv "$tmp" "$file"
  fi
}

# Still under the lock taken as root.
skip_onboarding
sync_settings
install_claude_config
exec 9>&-

exec "$@"
