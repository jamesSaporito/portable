# `portable doctor`: checks the setup on this Mac, then runs image/doctor.sh in a fresh container.
# Prints one line per check and exits non-zero if any failed. Expects lib/secrets.sh, lib/aws.sh and
# lib/launch.sh.

doctor_failed=0
doctor_ok()   { printf '  ok    %s\n' "$*"; }
doctor_warn() { printf '  warn  %s\n' "$*"; }
doctor_skip() { printf '  skip  %s\n' "$*"; }
doctor_fail() { printf '  FAIL  %s\n' "$*"; doctor_failed=1; }

# Checks that stop the doctor when they fail, since the container can't start without them.
doctor_prerequisites() {
  local error
  if ! command -v docker >/dev/null; then
    doctor_fail "Docker isn't installed"
    return 1
  fi
  if ! docker info >/dev/null 2>&1; then
    doctor_fail "Docker isn't running; start Docker Desktop"
    return 1
  fi
  doctor_ok "Docker is running"

  if [ -f "$PORTABLE_ROOT/.env" ]; then
    doctor_ok "settings file .env found"
  else
    doctor_warn "no settings file .env, so defaults are used (run install.sh to create it)"
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

  if secret_get CLAUDE_CODE_OAUTH_TOKEN >/dev/null || secret_get ANTHROPIC_API_KEY >/dev/null; then
    doctor_ok "Claude sign-in (subscription token or API key) is saved in your Keychain"
  else
    doctor_fail "no Claude sign-in saved in your Keychain; see README step 2"
  fi
  if secret_get GH_TOKEN >/dev/null; then
    doctor_ok "GitHub token is saved in your Keychain"
  else
    doctor_fail "no GitHub token saved in your Keychain; see README step 3"
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

  if [ "$(image_hash_wanted)" = "$(image_hash_built)" ]; then
    doctor_ok "container image is up to date"
  else
    doctor_warn "container image is out of date; it's rebuilt below"
  fi
}

run_doctor() {
  echo "Your Mac"
  if doctor_prerequisites; then
    doctor_host
    echo
    # Fresh container, so the checks see exactly what a normal start gives.
    (run_container "doctor-$(printf '%04x' $((RANDOM % 65536)))" portable-doctor) || doctor_failed=1
  fi
  echo
  if [ "$doctor_failed" = 0 ]; then
    echo "All checks passed."
  else
    echo "Some checks failed; see FAIL above."
  fi
  return "$doctor_failed"
}
