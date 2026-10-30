#!/usr/bin/env bash
# Default-deny outbound firewall, using nftables. Run as root in the engine container
# (engine-entrypoint.sh) before Docker starts. The dev container shares the engine's network and has
# no capabilities, so it can't change the rules. The rules cover:
#   - output:  the engine itself (image pulls) and the dev container (Claude, git, npm, …)
#   - forward: containers the engine starts, when their traffic leaves for the internet
# Traffic between them (Docker's own networks inside the engine) isn't restricted.
#
# Code with Docker access can still undo this, e.g. with a privileged container on the engine's
# network, since the engine is privileged. The rules stop accidents and ordinary traffic, not a
# deliberate attempt.
#
#   portable-firewall           set up the rules
#   portable-firewall refresh   re-resolve the allowed hosts (CDN addresses change)
#
# Allowed out: loopback (Docker's DNS), Docker's networks inside the engine, replies to allowed
# connections, DNS from containers the engine starts (DNS isn't filtered anyway), and
#   - the hosts in /etc/portable/allowed-domains plus PORTABLE_ALLOW_DOMAINS
#   - GitHub's published web/api/git ranges: https://api.github.com/meta
#   - AWS ranges for AWS_REGION and global services: https://ip-ranges.amazonaws.com/ip-ranges.json
#     A range is kept when it's labelled only AMAZON, or with an AWS-run service (S3, DYNAMODB, …).
#     Ranges labelled only with services that host other people's servers (EC2, CloudFront, API
#     Gateway, Global Accelerator) are left out. AWS lists some of its own endpoints in those too
#     (Lambda's regional API, for one), so allow those by name with PORTABLE_ALLOW_DOMAINS.
# Everything else is rejected, so tools fail fast instead of hanging. IPv4 only; IPv6 is rejected.
# Adapted from Anthropic's reference: https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh
set -euo pipefail

domains_file=/etc/portable/allowed-domains
region="${AWS_REGION:-us-east-1}"
# The interface towards the internet; Docker's networks inside the engine are the others.
uplink="$(ip route show default 2>/dev/null | awk '{ print $5; exit }')"
uplink="${uplink:-eth0}"

warn() { echo "portable: firewall: $*" >&2; }

# Prints "a, b, c" for an nft element list, or nothing.
elements() { sort -u | paste -sd, - | sed 's/,/, /g'; }

domain_ips() {
  local host
  for host in $(grep -vE '^\s*(#|$)' "$domains_file") ${PORTABLE_ALLOW_DOMAINS:-}; do
    getent ahostsv4 "$host" | awk '{ print $1 }' || warn "couldn't resolve $host"
  done | elements
}

github_ranges() {
  curl -fsS --max-time 10 https://api.github.com/meta \
    | jq -r '(.web + .api + .git)[] | select(contains(":") | not)' | elements
}

aws_ranges() {
  jq -r --arg region "$region" '
    [.prefixes[] | select(.region == $region or .region == "GLOBAL")]
    | group_by(.ip_prefix)[]
    | (map(.service) | unique) as $labels
    | select($labels == ["AMAZON"]
        or ($labels - ["AMAZON", "EC2", "CLOUDFRONT", "API_GATEWAY", "GLOBALACCELERATOR"] | length > 0))
    | .[0].ip_prefix' <<< "$aws_json" | elements
}

# Replaces a set's contents in one atomic nft transaction.
fill() {
  local set="$1" items="$2"
  echo "flush set inet portable $set"
  [ -z "$items" ] || echo "add element inet portable $set { $items }"
}

if [ "${1:-}" = refresh ]; then
  fill domains "$(domain_ips)" | nft -f -
  exit
fi

github="$(github_ranges)" || warn "couldn't fetch GitHub's IP ranges; GitHub is blocked"
aws_json="$(curl -fsS --max-time 10 https://ip-ranges.amazonaws.com/ip-ranges.json)" \
  || warn "couldn't fetch AWS's IP ranges; AWS is blocked"
aws=""
[ -z "$aws_json" ] || aws="$(aws_ranges)"

{
  # Start from a clean table on every run.
  echo "table inet portable {}"
  echo "delete table inet portable"
  echo "define uplink = \"$uplink\""
  cat <<'EOF'
table inet portable {
  set domains { type ipv4_addr; flags interval; auto-merge; }
  set github { type ipv4_addr; flags interval; auto-merge; }
  set aws { type ipv4_addr; flags interval; auto-merge; }

  chain output {
    type filter hook output priority filter; policy drop;
    oif lo accept
    oifname != $uplink accept
    ct state established,related accept
    ip daddr @domains accept
    ip daddr @github accept
    ip daddr @aws accept
    reject with icmpx admin-prohibited
  }

  # Containers on Docker's default bridge use public DNS servers, since the engine's own resolver is
  # on loopback; those on compose networks resolve through the engine.
  chain forward {
    type filter hook forward priority filter; policy accept;
    oifname != $uplink accept
    ct state established,related accept
    meta l4proto { tcp, udp } th dport 53 accept
    ip daddr @domains accept
    ip daddr @github accept
    ip daddr @aws accept
    reject with icmpx admin-prohibited
  }
}
EOF
  fill domains "$(domain_ips)"
  fill github "$github"
  fill aws "$aws"
} | nft -f -
