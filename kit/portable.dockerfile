# Overlay for portable's mixin (portable.yaml): built once per machine by sbx (cached by source hash)
# and laid over Docker's Claude Code workload. Only /out from the build stage ends up in the sandbox,
# so nothing here changes the workload's user, entrypoint or packages.
#
# Every download is checked against a SHA-256 recorded here, taken from the publisher's checksum
# file (Terraform, gh), the GitHub release digests (pnpm) or computed from the download (AWS CLI,
# which publishes no checksum file) on 2026-10-30. Bumping a version means updating its checksums.
#   Terraform: https://releases.hashicorp.com/terraform/1.17.0/terraform_1.17.0_SHA256SUMS
#   gh:        https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_checksums.txt
#   pnpm:      https://api.github.com/repos/pnpm/pnpm/releases/tags/v12.16.1 (asset digests)
#   AWS CLI:   https://awscli.amazonaws.com/awscli-exe-linux-<arch>-2.39.0.zip
#   Infracost: https://github.com/infracost/cli/releases/download/v2.18.3/infracost-linux-<arch>.tar.gz.sha256
#   Infracost plugins: https://releases.infracost.io/<plugin>/linux/<arch>/v<version>/data.tar.gz.sha256
#              (latest versions from .../latest/version on 2026-10-30)

# Debian stable (trixie) as of 2026-10-30: https://www.debian.org/releases/
# Pinned by digest (docker buildx imagetools inspect debian:trixie-slim, 2026-11-04) so every computer builds
# the same image; bump the digest to pick up a newer trixie-slim.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS build

ARG TARGETARCH
ARG TERRAFORM_VERSION=1.17.0
ARG GH_VERSION=2.103.3
ARG PNPM_VERSION=12.16.1
ARG AWS_CLI_VERSION=2.39.0
ARG INFRACOST_VERSION=2.18.3
ARG INFRACOST_TERRAFORM_VERSION=0.0.92
ARG INFRACOST_TERRAFORM_PLAN_VERSION=0.0.37
ARG INFRACOST_AWS_VERSION=0.0.31

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

# Downloads a URL to a file and checks its SHA-256 (second argument picks the arm64 or amd64 value).
COPY <<'EOF' /usr/local/bin/fetch
#!/bin/sh
# fetch URL OUT SHA256_ARM64 SHA256_AMD64
set -eu
case "$TARGETARCH" in arm64) sum="$3" ;; amd64) sum="$4" ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac
curl -fsSLo "$2" "$1"
echo "$sum  $2" | sha256sum -c -
EOF
RUN chmod 755 /usr/local/bin/fetch && mkdir -p /out/usr/local/bin /out/usr/local/lib

# Terraform
RUN fetch "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip" /tmp/terraform.zip \
      f32478134ffc6d710eec474bbd316652cdddc0f4e336973a3745e8d3a3309cdf \
      c168cab7c637a8769fdb90089ddd19de701bc6ff8aca64dc2e2185fe46f59f67 \
 && unzip -q /tmp/terraform.zip terraform -d /out/usr/local/bin && rm /tmp/terraform.zip

# GitHub CLI
RUN fetch "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" /tmp/gh.tgz \
      ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 \
      4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /out/usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}"

# pnpm: a self-contained binary plus its dist/ folder, which must sit next to it.
RUN case "$TARGETARCH" in arm64) a=arm64 ;; amd64) a=x64 ;; esac \
 && fetch "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${a}.tar.gz" /tmp/pnpm.tgz \
      f5847699e5d528f8f8e9bcfb385e58cb9fba7482af1b1aa7b70737be42277f81 \
      565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825 \
 && mkdir -p /out/usr/local/lib/pnpm && tar -xzf /tmp/pnpm.tgz -C /out/usr/local/lib/pnpm \
 && ln -s /usr/local/lib/pnpm/pnpm /out/usr/local/bin/pnpm && rm /tmp/pnpm.tgz

# AWS CLI v2. Installed in place so its internal `current` link resolves, then copied to the overlay.
RUN case "$TARGETARCH" in arm64) a=aarch64 ;; amd64) a=x86_64 ;; esac \
 && fetch "https://awscli.amazonaws.com/awscli-exe-linux-${a}-${AWS_CLI_VERSION}.zip" /tmp/awscli.zip \
      05da9395b4d148c42e959192650bf4a7cbb59ea275fa334d0936c593c27b946f \
      6c89ce7ed7bc0a2520e2bc3eeedfea4e2eb2e7da2836860c9471871408404036 \
 && cd /tmp && unzip -q awscli.zip && ./aws/install --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin \
 && cp -a /usr/local/aws-cli /out/usr/local/aws-cli \
 && ln -s /usr/local/aws-cli/v2/current/bin/aws /out/usr/local/bin/aws \
 && ln -s /usr/local/aws-cli/v2/current/bin/aws_completer /out/usr/local/bin/aws_completer \
 && rm -rf /tmp/aws /tmp/awscli.zip

# Infracost, and the plugins it parses Terraform and prices AWS with. The CLI would download the
# latest plugins at run time and keep updating them; baking pinned ones in and pointing
# INFRACOST_CLI_PLUGIN_DIR at them (ENV below) turns that off. Plugin layout and the plugin dir
# override: https://github.com/infracost/cli/blob/v2.18.3/pkg/plugins/install.go and
# https://github.com/infracost/cli/blob/v2.18.3/pkg/plugins/config.go
RUN fetch "https://github.com/infracost/cli/releases/download/v${INFRACOST_VERSION}/infracost-linux-${TARGETARCH}.tar.gz" /tmp/infracost.tgz \
      8aae48dde9d0c3cb2e555306ff4e01eb624a704ebefd576e4fce1c8e6071ec9a \
      0950674d6e19eee5c492e59b415f3078c7c6b72421f940543c6cfa884692874e \
 && tar -xzf /tmp/infracost.tgz -C /out/usr/local/bin infracost && rm /tmp/infracost.tgz
COPY <<'EOF' /usr/local/bin/fetch-plugin
#!/bin/sh
# fetch-plugin NAME VERSION SHA256_ARM64 SHA256_AMD64
set -eu
fetch "https://releases.infracost.io/$1/linux/$TARGETARCH/v$2/data.tar.gz" /tmp/plugin.tgz "$3" "$4"
tar -xzf /tmp/plugin.tgz -C /out/usr/local/lib/infracost/plugins "$1" && rm /tmp/plugin.tgz
EOF
RUN chmod 755 /usr/local/bin/fetch-plugin && mkdir -p /out/usr/local/lib/infracost/plugins \
 && fetch-plugin infracost-parser-terraform "$INFRACOST_TERRAFORM_VERSION" \
      90878521d6e4ef2561bd4a99377b21bb1daabe0320cf57ffb46b533e84c0bf80 \
      7fe12728cc55b0c45c6ce6129b83f9805f89361a5d34fac787005b26ac052533 \
 && fetch-plugin infracost-parser-terraform-plan "$INFRACOST_TERRAFORM_PLAN_VERSION" \
      bc5ba09b213e98d4b9ec661320089687693dc54ba0ce24c06effe79d95f9a74a \
      61a7c6363a04bc8270265b80c36fc4c87e18d6758bee564ad9116734012cbd8e \
 && fetch-plugin infracost-provider-aws "$INFRACOST_AWS_VERSION" \
      da71ab5c347bf18d21769bb431d335ccb3337cb2432d1896d5a97053c7e76c0a \
      eebaddd736b2854d60c87a318be5b5494bb0609fb3617c44e0c3de59811aa8b0

# portable's scripts, managed CLAUDE.md and skills. Claude Code loads /etc/claude-code/CLAUDE.md
# before the user's and it can't be excluded: https://code.claude.com/docs/en/memory
COPY --chmod=755 files/portable-setup files/portable-doctor /out/usr/local/bin/
COPY --chmod=644 files/claude-instructions.md /out/etc/claude-code/CLAUDE.md
COPY files/skills /out/etc/claude-code/.claude/skills
# COPY --chmod=644 above also gives /out/etc that mode, and a mixin's folders replace the base's
# (kit spec §10), so without the 755 the sandbox's /etc can't be entered by the agent.
RUN chmod 755 /out/etc && chmod -R u=rwX,go=rX /out/etc/claude-code && chown -R 0:0 /out

FROM scratch
COPY --from=build /out/ /
# A mixin's ENV is merged into the sandbox (kit spec §10). Infracost loads only the baked-in plugins
# and skips its self-update and agent-skill checks, which would reach releases.infracost.io:
# https://github.com/infracost/cli/blob/v2.18.3/internal/update/check.go
ENV INFRACOST_CLI_PLUGIN_DIR=/usr/local/lib/infracost/plugins \
    INFRACOST_SKIP_UPDATE_CHECK=1 \
    INFRACOST_SKIP_AGENT_CHECK=1
