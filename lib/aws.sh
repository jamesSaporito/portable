# Turns a host AWS profile (SSO or assumed role) into short-lived STS credentials for the container.
# The SSO token and ~/.aws stay on the host; only the temporary keys are exported.
# https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html

PORTABLE_AWS_VARS=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION)

# Prints KEY=VALUE lines; signs in through SSO in the browser when the session has expired.
aws_export() {
  aws configure export-credentials --profile "$1" --format env-no-export 2>/dev/null && return
  echo "portable: AWS session for profile '$1' has expired; signing in..." >&2
  aws sso login --profile "$1" >&2 || return 1
  aws configure export-credentials --profile "$1" --format env-no-export
}

load_aws() {
  local profile="${PORTABLE_AWS_PROFILE:-}"
  [ -n "$profile" ] || return 0
  if ! command -v aws >/dev/null; then
    echo "portable: aws CLI not found on the host; skipping AWS credentials" >&2
    return 0
  fi

  local creds line name
  if ! creds="$(aws_export "$profile")"; then
    echo "portable: couldn't get AWS credentials for profile '$profile'; continuing without them" >&2
    return 0
  fi
  # Only take the names we expect, so the output can't set anything else.
  while IFS= read -r line; do
    name="${line%%=*}"
    case " ${PORTABLE_AWS_VARS[*]} " in
      *" $name "*) export "$name=${line#*=}" ;;
    esac
  done <<< "$creds"

  local region
  region="$(aws configure get region --profile "$profile" 2>/dev/null || true)"
  [ -n "$region" ] && export AWS_REGION="$region" AWS_DEFAULT_REGION="$region"
}
