#!/usr/bin/env bash
# Runs when the engine container (compose service `docker`) starts: sets up the outbound firewall
# (firewall.sh), keeps its host list fresh in the background, then starts Docker the way the
# docker:dind image does. The engine is shared by every session and keeps running after they end.
set -uo pipefail

if [ "${PORTABLE_FIREWALL:-on}" = off ]; then
  echo "portable: firewall is off (PORTABLE_FIREWALL=off); outbound traffic is unrestricted" >&2
elif ! portable-firewall; then
  echo "portable: couldn't set up the firewall; not starting. Set PORTABLE_FIREWALL=off in .env to run without it." >&2
  exit 1
else
  ( while sleep 300; do portable-firewall refresh 2>/dev/null; done ) &
fi

exec dockerd-entrypoint.sh "$@"
