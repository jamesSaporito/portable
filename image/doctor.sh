#!/usr/bin/env bash
# The container half of `portable doctor` (lib/doctor.sh runs the Mac half, then this in a fresh
# container). Prints one line per check and exits non-zero if any failed.
set -uo pipefail

failed=0
ok()   { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*"; }
skip() { printf '  skip  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; failed=1; }

# Exit status of an HTTPS request: 0 when the host answered at all, whatever the HTTP status.
reachable() { curl -s -o /dev/null --max-time 8 "https://$1"; }

check_sandbox() {
  echo "Sandbox (the container)"
  if [ "$(id -un)" = dev ]; then ok "runs as an ordinary user (dev), not as root"
  else fail "runs as $(id -un) instead of the ordinary user dev"; fi
  if [ "$(awk '/^CapEff/ { print $2 }' /proc/self/status)" = 0000000000000000 ]; then
    ok "has no admin rights, so it can't change the system or the firewall"
  else
    fail "still has admin rights (Linux capabilities), so it could change the firewall"
  fi
  if [ -S /var/run/docker.sock ]; then
    fail "can control Docker on your Mac (the Docker socket is shared), so it could escape the sandbox"
  else
    ok "can't control Docker on your Mac (only the portable engine; see Docker below)"
  fi

  local probe
  if ! mountpoint -q "$WORKSPACE_DIR"; then
    fail "your workspace folder isn't shared with the container at $WORKSPACE_DIR"
  elif probe="$(mktemp -p "$WORKSPACE_DIR" .portable-doctor.XXXXXX 2>/dev/null)"; then
    rm -f "$probe"
    ok "sees your workspace folder $WORKSPACE_DIR and can edit files in it"
  else
    fail "can see your workspace folder $WORKSPACE_DIR but can't edit files in it"
  fi
  local hidden
  for hidden in $(hidden_in "$WORKSPACE_DIR"); do
    if [ -d "$hidden" ] && [ -z "$(ls -A "$hidden")" ]; then ok "can't see $hidden, which is hidden from it"
    else fail "can see $hidden, which should be hidden from it"; fi
  done
}

# The hidden folders (lib/launch.sh) inside folder $1, where they'd otherwise be visible.
hidden_in() {
  local hidden
  for hidden in "${PORTABLE_HIDE_SELF:-}" "${PORTABLE_HIDE_CONFIG:-}"; do
    case "$hidden" in "$1"/*) echo "$hidden" ;; esac
  done
}

check_tools() {
  echo "Tools"
  local tool version
  for tool in claude git gh aws terraform pnpm docker compose; do
    case "$tool" in
      claude) version="$(claude --version 2>/dev/null)" ;;
      git) version="$(git --version 2>/dev/null)" ;;
      gh) version="$(gh --version 2>/dev/null | head -1)" ;;
      aws) version="$(aws --version 2>/dev/null | cut -d' ' -f1)" ;;
      terraform) version="$(terraform version 2>/dev/null | head -1)" ;;
      pnpm) version="$(pnpm --version 2>/dev/null)" && version="pnpm $version" ;;
      docker) version="$(docker --version 2>/dev/null)" ;;
      compose) version="$(docker compose version 2>/dev/null)" ;;
    esac
    if [ -n "$version" ]; then ok "$version"; else fail "$tool doesn't run"; fi
  done
}

check_claude_config() {
  echo "Claude configuration"
  local dir=/home/dev/claude-configuration name
  if [ -z "${PORTABLE_CLAUDE_CONFIG_REPO:-}" ]; then
    skip "no Claude configuration repo set (PORTABLE_CLAUDE_CONFIG_REPO in .env)"
  elif [ ! -d "$dir/.git" ]; then
    fail "your Claude configuration repo couldn't be downloaded (see the messages above)"
  elif [ "$(readlink "$CLAUDE_CONFIG_DIR/CLAUDE.md")" != "$dir/CLAUDE.md" ]; then
    fail "your Claude configuration repo was downloaded but not installed (its install.sh didn't link CLAUDE.md)"
  else
    ok "your skills, rules and CLAUDE.md are installed (last change $(git -C "$dir" log -1 --format='%cr'))"
    # The entrypoint fetched moments ago, so being behind means its update failed.
    local behind
    behind="$(git -C "$dir" rev-list --count 'HEAD..@{u}' 2>/dev/null)"
    if [ "${behind:-0}" -gt 0 ]; then
      fail "your Claude configuration is $behind commit(s) behind GitHub; the update failed (see the messages above)"
    fi
    if [ -w "$dir" ] || [ -w "$dir/CLAUDE.md" ]; then
      fail "your Claude configuration's copy can be edited from in here, so a session's edits could block updates"
    else
      ok "your Claude configuration's copy is read-only in here (changes go through GitHub)"
    fi
    # Silent when it worked; the filtering is an internal detail (see entrypoint.sh).
    for name in ${PORTABLE_CLAUDE_CONFIG_DISABLE:-}; do
      grep -q "\`$name\`" "$dir/CLAUDE.md" "$dir"/rules/*.md 2>/dev/null \
        && fail "your CLAUDE.md or rules still tell Claude to use $name, which PORTABLE_CLAUDE_CONFIG_DISABLE turns off"
    done
  fi

  local skill missing=""
  for skill in start stop; do
    [ -r "/etc/claude-code/.claude/skills/$skill/SKILL.md" ] || missing="$missing /$skill"
  done
  if [ -z "$missing" ]; then ok "portable's own skills (/start, /stop) are installed"
  else fail "portable's own skills are missing or unreadable:$missing"; fi

  local settings="$CLAUDE_CONFIG_DIR/settings.json"
  if [ ! -f "$settings" ]; then
    skip "no Claude settings copied from your Mac (~/.claude/settings.json not found)"
  elif ! jq empty "$settings" 2>/dev/null; then
    fail "the Claude settings copied from your Mac are broken (settings.json isn't valid JSON)"
  elif jq -e 'has("hooks") or has("statusLine")' "$settings" >/dev/null; then
    fail "the Claude settings still contain Mac-only hooks or a status line, which will fail in here"
  else
    ok "your Mac's Claude settings are copied in, minus the parts that only work on the Mac"
  fi
}

check_access() {
  echo "Access"
  local auth reply login arn
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then auth="API key"
  elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then auth="subscription token"
  fi
  if [ -z "${auth:-}" ]; then
    fail "Claude: no subscription token or API key was passed in"
  elif reply="$(timeout 90 claude -p "Reply with just the word: ok" 2>&1)" && grep -qi '\bok\b' <<< "$reply"; then
    ok "Claude answered a test prompt (signed in with your $auth)"
  else
    fail "Claude didn't answer a test prompt with your $auth: $(tail -1 <<< "$reply")"
  fi

  if [ -z "${GH_TOKEN:-}" ]; then
    fail "GitHub: no token was passed in"
  elif login="$(gh api user -q .login 2>/dev/null)"; then
    ok "GitHub accepts your token (signed in as $login)"
    if [ -n "${PORTABLE_CLAUDE_CONFIG_REPO:-}" ]; then
      if timeout 20 git ls-remote "$PORTABLE_CLAUDE_CONFIG_REPO" HEAD >/dev/null 2>&1; then
        ok "git can download from GitHub with your token"
      else
        fail "git can't download $PORTABLE_CLAUDE_CONFIG_REPO; add that repo to your token's repository access"
      fi
    fi
  else
    fail "GitHub rejected your token (expired or revoked?)"
  fi
  if [ -n "${GIT_AUTHOR_NAME:-}" ] && [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
    ok "commits will be signed as $GIT_AUTHOR_NAME <$GIT_AUTHOR_EMAIL>"
  else
    warn "commits have no name or email; set GIT_NAME and GIT_EMAIL in .env"
  fi

  if [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
    skip "AWS: not set up (PORTABLE_AWS_PROFILE in .env), or signing in failed"
  elif arn="$(timeout 30 aws sts get-caller-identity --query Arn --output text 2>/dev/null)"; then
    ok "AWS accepts your credentials, as $arn (region ${AWS_REGION:-not set})"
  else
    fail "AWS rejected your credentials, or couldn't be reached"
  fi
}

# Image for the test containers: the docker:cli image the Docker CLI comes from (see Dockerfile).
test_image="docker:${PORTABLE_DOCKER_VERSION:-}-cli"
engine_ok=""

# Runs a shell command in a throwaway container on the engine.
in_container() { docker run --rm "$@"; }

check_docker() {
  echo "Docker (the portable engine)"
  local name probe port id
  if ! name="$(docker info --format '{{.Name}}' 2>/dev/null)"; then
    fail "docker can't reach the portable engine (docker logs portable-engine on your Mac may say why)"
    return
  elif [ "$name" != portable-engine ]; then
    fail "docker talks to $name instead of the portable engine"
    return
  fi
  ok "docker talks to the portable engine (Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null))"
  if ! docker pull -q "$test_image" >/dev/null 2>&1; then
    fail "the engine can't download images from Docker Hub (tried $test_image)"
    return
  fi
  ok "the engine can download images from Docker Hub"
  engine_ok=1

  if probe="$(mktemp -p "$WORKSPACE_DIR" .portable-doctor.XXXXXX 2>/dev/null)" \
    && echo portable > "$probe" \
    && [ "$(in_container -v "$WORKSPACE_DIR:/w:ro" "$test_image" cat "/w/${probe##*/}" 2>/dev/null)" = portable ]; then
    ok "containers it starts can use files from your workspace folder"
  else
    fail "containers it starts can't see your workspace folder at $WORKSPACE_DIR"
  fi
  rm -f "$probe"
  # The engine has all of WORKSPACE_DIR, whichever folder this session started in. The folders above
  # it exist in the engine only as the path to it.
  local root="${PORTABLE_WORKSPACE_ROOT:-$WORKSPACE_DIR}" hidden
  if [ "$(in_container -v "$(dirname "$root"):/p:ro" "$test_image" ls -A /p 2>/dev/null)" \
      = "$(basename "$root")" ]; then
    ok "containers it starts can't see anything on your Mac outside $root"
  else
    fail "containers it starts can see folders next to $root, outside it"
  fi
  # Through the whole folder, as a project's bind mount would reach them.
  local listing
  for hidden in $(hidden_in "$root"); do
    if listing="$(in_container -v "$root:/w:ro" "$test_image" ls -A "/w/${hidden#"$root"/}" 2>/dev/null)" \
      && [ -z "$listing" ]; then
      ok "containers it starts can't see $hidden, which is hidden from them"
    else
      fail "containers it starts can see $hidden, which should be hidden from them"
    fi
  done

  id="$(docker run -d -p 127.0.0.1::8080 "$test_image" \
    sh -c 'while true; do printf "HTTP/1.0 200 OK\r\n\r\nportable" | nc -l -p 8080; done' 2>/dev/null)"
  port="$(docker port "$id" 8080/tcp 2>/dev/null | head -1 | cut -d: -f2)"
  if [ -n "$port" ] && sleep 1 && [ "$(curl -s --max-time 5 "http://localhost:$port")" = portable ]; then
    ok "ports they publish are reachable on localhost, as on your Mac"
  else
    fail "a port published by a test container wasn't reachable on localhost"
  fi
  [ -z "$id" ] || docker rm -f "$id" >/dev/null 2>&1
}

check_firewall() {
  echo "Firewall"
  if [ "${PORTABLE_FIREWALL:-on}" = off ]; then
    warn "turned off (PORTABLE_FIREWALL=off in .env), so the container can reach any website"
    return
  fi
  local host
  for host in registry.npmjs.org registry.terraform.io; do
    if reachable "$host"; then ok "lets through sites on its list, e.g. $host"
    else fail "blocks $host, which should be allowed"; fi
  done
  if reachable example.com; then fail "lets through sites that aren't on its list (example.com was reachable)"
  else ok "blocks every other site (tested with example.com)"; fi

  if [ -z "$engine_ok" ]; then
    skip "containers Docker starts: not tested, since the engine isn't working (see Docker above)"
    return
  fi
  if in_container "$test_image" wget -q -T 8 -O /dev/null https://registry.npmjs.org 2>/dev/null; then
    ok "containers Docker starts reach sites on its list too"
  else
    fail "containers Docker starts can't reach registry.npmjs.org, which should be allowed"
  fi
  if in_container "$test_image" wget -q -T 8 -O /dev/null https://example.com 2>/dev/null; then
    fail "containers Docker starts can reach sites that aren't on its list (example.com)"
  else
    ok "containers Docker starts are blocked from every other site too"
  fi
}

check_sandbox
check_tools
check_claude_config
check_access
check_docker
check_firewall
exit "$failed"
