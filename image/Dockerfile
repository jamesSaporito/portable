# Two images, both built by compose (one stage each):
#   engine  the Docker engine for containers Claude starts (compose service `docker`), and the firewall
#   dev     Claude Code, git, gh, AWS CLI v2, Terraform, pnpm and the Docker CLI with Compose
# No secrets are baked in; they arrive as env vars at launch (see lib/launch.sh).

# Latest stable Docker as of 2026-10-29: https://github.com/moby/moby/releases/latest
# Images: https://hub.docker.com/_/docker
ARG DOCKER_VERSION=29.9.2

FROM docker:${DOCKER_VERSION}-cli AS docker-cli

# Runs privileged, since nested containers need it, and owns the outbound firewall: the dev container
# shares its network, so the rules cover the engine, the dev container and every container it starts.
FROM docker:${DOCKER_VERSION}-dind AS engine
# Alpine updates clear CVEs fixed since the image was published (brotli and curl as of 2026-10-29,
# found with `docker scout cves`). bash, curl, jq and nftables are for firewall.sh.
RUN apk upgrade --no-cache \
 && apk add --no-cache bash curl jq nftables
COPY --chmod=755 firewall.sh /usr/local/bin/portable-firewall
COPY --chmod=644 allowed-domains /etc/portable/allowed-domains
COPY --chmod=755 engine-entrypoint.sh /usr/local/bin/portable-engine
ENTRYPOINT ["portable-engine"]
# No hash label here (unlike dev): an unchanged stage then rebuilds to the identical image, so editing
# the dev image doesn't restart the engine and everything running on it.

# Node 24 is the current LTS line (https://nodejs.org/dist/index.json); Debian trixie is Debian stable.
FROM node:24.22.1-trixie-slim AS dev

# Latest stable releases as of 2026-10-27. Claude Code follows Anthropic's `stable` channel (npm dist-tag),
# which runs about a week behind `latest` and skips releases with major regressions:
# https://code.claude.com/docs/en/setup#configure-release-channel
ARG CLAUDE_CODE_VERSION=2.1.308
ARG TERRAFORM_VERSION=1.17.0
ARG AWS_CLI_VERSION=2.39.0
ARG GH_VERSION=2.103.3
# Latest stable as of 2026-10-29: https://registry.npmjs.org/pnpm
ARG PNPM_VERSION=12.16.1
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less nano procps unzip \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-version.html
RUN case "$TARGETARCH" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac \
 && cd /tmp \
 && curl -fsSLo awscli.zip "https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${AWS_CLI_VERSION}.zip" \
 && unzip -q awscli.zip && ./aws/install \
 && rm -rf /tmp/aws /tmp/awscli.zip

# Terraform, checked against HashiCorp's SHA256SUMS: https://releases.hashicorp.com/terraform/
RUN cd /tmp \
 && base="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}" \
 && zip="terraform_${TERRAFORM_VERSION}_linux_${TARGETARCH}.zip" \
 && curl -fsSLO "$base/$zip" \
 && curl -fsSL "$base/terraform_${TERRAFORM_VERSION}_SHA256SUMS" | grep " $zip\$" | sha256sum -c - \
 && unzip -q "$zip" terraform -d /usr/local/bin \
 && rm "$zip"

# GitHub CLI, checked against the release checksums: https://github.com/cli/cli/releases
RUN cd /tmp \
 && base="https://github.com/cli/cli/releases/download/v${GH_VERSION}" \
 && tarball="gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSLO "$base/$tarball" \
 && curl -fsSL "$base/gh_${GH_VERSION}_checksums.txt" | grep " $tarball\$" | sha256sum -c - \
 && tar -xzf "$tarball" \
 && mv "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf "$tarball" "gh_${GH_VERSION}_linux_${TARGETARCH}"

# Pinned Claude Code with auto-update off: https://code.claude.com/docs/en/devcontainer
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# pnpm from npm, like Claude Code.
RUN npm install -g "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force

# Docker CLI, Compose and Buildx, talking to the engine container (DOCKER_HOST in compose.yaml).
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# git over HTTPS to GitHub gets its credentials from gh, which reads GH_TOKEN from the environment.
# The configuration repo's clone is root's (entrypoint.sh), so dev's git needs it marked safe to read.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
 && git config --system credential.https://gist.github.com.helper '!gh auth git-credential' \
 && git config --system --add safe.directory /home/dev/claude-configuration

# Reuse the base image's uid 1000 user, renamed to `dev`. No sudo.
RUN usermod -l dev -d /home/dev -m node \
 && groupmod -n dev node \
 && mkdir -p /home/dev/.claude /home/dev/claude-configuration \
 && chown dev:dev /home/dev/.claude /home/dev/claude-configuration

COPY --chmod=755 entrypoint.sh /usr/local/bin/portable-entrypoint
COPY --chmod=755 doctor.sh /usr/local/bin/portable-doctor
# Notes for Claude on how the container differs from the Mac, as a managed CLAUDE.md, which loads
# before the user's and can't be excluded: https://code.claude.com/docs/en/memory
# The folder comes first, since COPY --chmod would give it the file's mode, and dev couldn't open it.
RUN mkdir -m 755 /etc/claude-code
COPY --chmod=644 claude-instructions.md /etc/claude-code/CLAUDE.md
# portable's own skills (/start, /stop), as managed skills, so every project in here has them without
# going through the shared ~/.claude volume: https://code.claude.com/docs/en/skills
# Copied without --chmod, which would give the folders the files' mode; the chmod makes them readable.
COPY skills /etc/claude-code/.claude/skills
RUN chmod -R u=rwX,go=rX /etc/claude-code/.claude

# DISABLE_UPDATES also blocks `claude update`; the version is pinned above, so updates come from a rebuild.
# https://code.claude.com/docs/en/setup#disable-auto-updates
# The container starts as root only so the entrypoint can drop every capability as it switches to dev,
# so HOME and USER are set for dev here.
# PORTABLE_DOCKER_VERSION is for doctor.sh, which tests the engine with the matching docker:cli image.
ARG DOCKER_VERSION
ENV DISABLE_UPDATES=1 \
    PORTABLE_DOCKER_VERSION=${DOCKER_VERSION} \
    CLAUDE_CONFIG_DIR=/home/dev/.claude \
    HOME=/home/dev \
    USER=dev

# bin/portable always sets the working directory to the workspace, mounted at its Mac path.
WORKDIR /home/dev
ENTRYPOINT ["portable-entrypoint"]
CMD ["bash"]

# Last, so a changed hash doesn't invalidate the cached layers above.
ARG PORTABLE_IMAGE_HASH
LABEL portable.image-hash=$PORTABLE_IMAGE_HASH
