#!/usr/bin/env bash
# Runs at every container start, then hands over to the requested command.
#
# As root: re-runs itself as `dev` with every capability dropped. The outbound firewall lives in the
# engine container (engine-entrypoint.sh), whose network this container shares.
# As dev: clones the personal Claude configuration repo on first start and links it into ~/.claude
# with its own install.sh. Those failures only warn, so the container still starts without it.
set -uo pipefail

if [ "$(id -u)" = 0 ]; then
  [ "${PORTABLE_FIREWALL:-on}" != off ] \
    || echo "portable: firewall is off (PORTABLE_FIREWALL=off); outbound traffic is unrestricted" >&2
  exec setpriv --reuid=dev --regid=dev --init-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all -- "$0" "$@"
fi

config_dir=/home/dev/claude-configuration

setup_claude_config() {
  local repo="${PORTABLE_CLAUDE_CONFIG_REPO:-}"
  [ -n "$repo" ] || return 0

  # Which disabled names the clone's files are currently filtered for (see below).
  local marker="$config_dir/.git/portable-filtered" disabled="${PORTABLE_CLAUDE_CONFIG_DISABLE:-}"
  local refilter=""

  if [ ! -d "$config_dir/.git" ]; then
    echo "portable: cloning $repo" >&2
    if ! git clone --quiet "$repo" "$config_dir" >&2; then
      echo "portable: couldn't clone $repo (does GH_TOKEN include it?); continuing without it" >&2
      return 0
    fi
    refilter=1
  elif ! timeout 10 git -C "$config_dir" fetch --quiet >/dev/null 2>&1; then
    echo "portable: couldn't update $config_dir (offline?); using the copy already there" >&2
  elif [ "$(git -C "$config_dir" rev-parse HEAD)" != "$(git -C "$config_dir" rev-parse '@{u}')" ]; then
    # Only touch the files when there's something new, so sessions already running in other
    # containers never see them half-updated. Undo the filtering first so the merge applies cleanly.
    git -C "$config_dir" checkout --quiet -- CLAUDE.md rules 2>/dev/null
    git -C "$config_dir" merge --quiet --ff-only '@{u}' >/dev/null 2>&1 \
      || echo "portable: couldn't update $config_dir (local edits?); using the copy already there" >&2
    refilter=1
  fi
  if [ "$(cat "$marker" 2>/dev/null)" != "$disabled" ]; then
    git -C "$config_dir" checkout --quiet -- CLAUDE.md rules 2>/dev/null
    refilter=1
  fi

  # install.sh keeps disabled names in this file, so write it from PORTABLE_CLAUDE_CONFIG_DISABLE
  # rather than passing --disable: names removed from .env then come back on.
  local name
  for name in $disabled; do echo "$name"; done > "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/personal-disabled"
  # Idempotent; stay quiet when nothing changed.
  "$config_dir/install.sh" 2>&1 | grep -v '^Already up to date' >&2 || true

  [ -n "$refilter" ] || return 0
  # In the container's copy only, drop lines in CLAUDE.md and the rules that name a disabled skill
  # (e.g. the docker-ports workflow step and rule bullet), then renumber CLAUDE.md's numbered list.
  # Edits go to the clone's files, which ~/.claude links to, so the links stay intact.
  for name in $disabled; do
    sed -i "/\`$name\`/d" "$config_dir/CLAUDE.md" "$config_dir"/rules/*.md
  done
  awk '/^[0-9]+\. / { sub(/^[0-9]+/, ++n) } !/^[0-9]+\. / { n = 0 } 1' "$config_dir/CLAUDE.md" \
    > "$config_dir/CLAUDE.md.tmp" && mv "$config_dir/CLAUDE.md.tmp" "$config_dir/CLAUDE.md"
  echo "$disabled" > "$marker"
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

# Several containers share the state and config volumes, so one start-up at a time does the setup.
# The lock file lives in the shared state volume.
exec 9> "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.portable-setup.lock"
flock 9
skip_onboarding
sync_settings
setup_claude_config
exec 9>&-

exec "$@"
