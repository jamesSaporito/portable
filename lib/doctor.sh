# `portable doctor`: checks the setup on this Mac, then runs kit/files/portable-doctor in a throwaway
# sandbox. Prints one line per check and exits non-zero if any failed. Expects lib/secrets.sh,
# lib/aws.sh and lib/launch.sh.

doctor_failed=0
doctor_ok()   { printf '  ok    %s\n' "$*"; }
doctor_warn() { printf '  warn  %s\n' "$*"; }
doctor_skip() { printf '  skip  %s\n' "$*"; }
doctor_fail() { printf '  FAIL  %s\n' "$*"; doctor_failed=1; }

# Checks that stop the doctor when they fail, since no sandbox can start without them.
doctor_prerequisites() {
  local error version
  if ! command -v sbx >/dev/null; then
    doctor_fail "Docker Sandboxes (sbx) isn't installed; run install.sh"
    return 1
  fi
  version="$(sbx_version)"
  if [ -n "$version" ] && ! version_ge "$version" "$PORTABLE_SBX_MIN"; then
    doctor_fail "sbx $version is too old; portable needs $PORTABLE_SBX_MIN or later (brew upgrade sbx)"
    return 1
  fi
  doctor_ok "Docker Sandboxes (sbx ${version:-unknown version}) is installed"
  if ! command -v jq >/dev/null; then
    doctor_fail "jq isn't installed; portable reads sbx's listings with it (macOS 15 and later have it; otherwise: brew install jq)"
    return 1
  fi
  if ! sbx ls >/dev/null 2>&1; then
    doctor_fail "sbx isn't signed in to Docker; run: sbx login"
    return 1
  fi
  doctor_ok "sbx is signed in"

  if [ -f "$PORTABLE_ENV_FILE" ]; then
    doctor_ok "settings file $PORTABLE_ENV_FILE found"
  else
    doctor_warn "no settings file $PORTABLE_ENV_FILE, so defaults are used (run install.sh to create it)"
  fi
  # load_settings exits on a bad workspace, so try it in a subshell first to report why.
  if ! error="$( (load_settings) 2>&1 >/dev/null)"; then
    doctor_fail "${error#portable: }"
    return 1
  fi
  load_settings
  doctor_ok "workspace folder is $WORKSPACE_DIR"
}

doctor_host() {
  if command -v portable >/dev/null; then
    doctor_ok "portable is on your PATH"
  else
    doctor_warn "portable isn't on your PATH; run install.sh and open a new terminal"
  fi
  local installed behind
  installed="$(cd -P "$PORTABLE_INSTALL_DIR" 2>/dev/null && pwd)" || true
  if [ "$PORTABLE_ROOT" != "$installed" ]; then
    doctor_warn "running the working copy in $PORTABLE_ROOT, not the installed one; fine for testing changes"
  # macOS has no `timeout`; this gives up on a connection slower than 1 byte/s for 10s.
  elif ! git -C "$PORTABLE_ROOT" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=10 fetch --quiet 2>/dev/null; then
    doctor_warn "couldn't check GitHub for portable updates (offline?)"
  elif behind="$(git -C "$PORTABLE_ROOT" rev-list --count 'HEAD..@{u}' 2>/dev/null)" && [ "$behind" -gt 0 ]; then
    doctor_warn "portable is $behind commit(s) behind GitHub; run 'portable update'"
  else
    doctor_ok "portable is installed in $PORTABLE_ROOT and up to date"
  fi

  if [ -f "$PORTABLE_KIT/portable.yaml" ] && [ -f "$PORTABLE_KIT/portable.dockerfile" ]; then
    doctor_ok "portable's kit is in place ($PORTABLE_KIT)"
  else
    doctor_fail "portable's kit is missing from $PORTABLE_KIT"
  fi

  if secret_get GH_TOKEN >/dev/null; then
    doctor_ok "GitHub token is saved in your Keychain"
  else
    doctor_fail "no GitHub token saved in your Keychain; see README step 3"
  fi
  if sbx secret ls 2>/dev/null | grep -q '^github\b\|[[:space:]]github[[:space:]]\|"github"'; then
    doctor_ok "sbx reads the GitHub token from the Keychain (secret source 'github' is registered)"
  else
    doctor_fail "sbx has no 'github' secret source; run install.sh again"
  fi
  # Optional: without it the sandbox works, but infracost can't price anything.
  if ! secret_get INFRACOST_CLI_AUTHENTICATION_TOKEN >/dev/null; then
    doctor_warn "no Infracost token saved in your Keychain, so infracost won't work in the sandbox; see README step 3"
  elif sbx secret ls 2>/dev/null | grep -q '^infracost\b\|[[:space:]]infracost[[:space:]]\|"infracost"'; then
    doctor_ok "sbx reads the Infracost token from the Keychain (secret source 'infracost' is registered)"
  else
    doctor_fail "sbx has no 'infracost' secret source; run install.sh again"
  fi

  if [ -n "$(git config --global user.name 2>/dev/null)" ] && [ -n "$(git config --global user.email 2>/dev/null)" ]; then
    doctor_ok "git identity found in your Mac's git config (used for commits in the sandbox)"
  else
    doctor_warn "no user.name/user.email in your Mac's git config; commits in the sandbox will have none"
  fi

  local profile="${PORTABLE_AWS_PROFILE:-}"
  if [ -z "$profile" ]; then
    doctor_skip "AWS: not set up (PORTABLE_AWS_PROFILE in .env)"
  elif ! command -v aws >/dev/null; then
    doctor_fail "AWS: the aws CLI isn't installed on this Mac"
  elif ! aws configure list-profiles 2>/dev/null | grep -qxF "$profile"; then
    doctor_fail "AWS: there's no profile named '$profile' on this Mac"
  elif aws configure export-credentials --profile "$profile" >/dev/null 2>&1; then
    doctor_ok "AWS: signed in to profile '$profile'"
  else
    doctor_warn "AWS: signed out of profile '$profile'; a browser sign-in opens below"
  fi
}

# A fresh sandbox, so the checks see exactly what a normal start gives, removed afterwards.
doctor_sandbox() {
  local name workdir
  name="portable-doctor-$(printf '%04x' $((RANDOM % 65536)))"
  workdir="$(session_folder 2>/dev/null)" || workdir="$WORKSPACE_DIR"
  # The trap outlives this function, so it clears itself or it fires again where $name is unset.
  trap 'sbx rm --force "$name" >/dev/null 2>&1; trap - RETURN' RETURN
  load_aws
  ensure_policy
  create_sandbox "$name" "$workdir" || return 1
  refresh_aws "$name"
  sync_settings "$name"
  local status=0
  sandbox_exec "$name" portable-doctor || status=$?
  echo
  doctor_forwarding "$name" || status=1
  return "$status"
}

# A container in the sandbox publishes a port; it should come out on the Mac (lib/ports.sh).
doctor_forwarding() {
  local name="$1" id mac reply
  echo "Ports (forwarded to the Mac)"
  id="$(sandbox_exec "$name" docker run -d -p 18080:8080 alpine:3 \
    sh -c 'while true; do printf "HTTP/1.0 200 OK\r\n\r\nportable" | nc -l -p 8080; done' 2>/dev/null || true)"
  if [ -z "$id" ]; then
    doctor_fail "couldn't start a test container in the sandbox (see Docker above)"
    return 1
  fi
  ports_sync "$name" --quiet
  mac="$(sandbox_forwards "$name" | awk '$2 == 18080 { print $1 }' | head -1)"
  reply=""
  if [ -n "$mac" ]; then
    sleep 1
    reply="$(curl -s --max-time 5 "http://localhost:$mac" || true)"
  fi
  sandbox_exec "$name" docker rm -f "$id" >/dev/null 2>&1
  ports_sync "$name" --quiet
  if [ "$reply" = portable ]; then
    doctor_ok "a port published by a test container was reachable on the Mac at http://localhost:$mac, and was closed again"
  elif [ -z "$mac" ]; then
    doctor_fail "a port published by a test container wasn't forwarded to the Mac (portable ports)"
    return 1
  else
    doctor_fail "port 18080 of a test container was forwarded to the Mac's $mac but didn't answer there"
    return 1
  fi
}

run_doctor() {
  echo "Your Mac"
  if doctor_prerequisites; then
    doctor_host
    echo
    doctor_sandbox || doctor_failed=1
  fi
  echo
  if [ "$doctor_failed" = 0 ]; then
    echo "All checks passed."
  else
    echo "Some checks failed; see FAIL above."
  fi
  return "$doctor_failed"
}
