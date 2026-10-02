FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Run pnpm non-interactively: without a TTY, pnpm 10 otherwise aborts when it
# needs to purge node_modules (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
ENV CI=true
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# Run the build on the NATIVE builder platform (--platform=$BUILDPLATFORM), not
# the target platform. tsup/esbuild ship a Go binary that crashes under QEMU
# emulation (fatal error: lfstack.push) when cross-building. The output is plain,
# architecture-independent JavaScript, so it is safe to copy into a target-arch
# final image below.
FROM --platform=$BUILDPLATFORM node:20-slim AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true
RUN corepack enable
COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

FROM base
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
EXPOSE 3000
# No MCP_BIND_ADDRESS here on purpose. The image keeps the loopback default, which
# a sidecar or any other container sharing this network namespace can reach.
# Publishing a port is the case that needs a wider bind, and that stays an explicit
# `-e MCP_BIND_ADDRESS=0.0.0.0` alongside an inbound credential. See "Network
# Exposure" in the README.
#
# PORT has no env-var binding in cmd.ts (only a --port CLI flag, default
# 3000) and the listener defaults to loopback — so without this shim the
# container never answers on the Kubernetes-injected PORT/pod IP and every
# readiness/liveness probe against it fails, crash-looping the pod. This
# wraps the binary in a shell so ${PORT}/${MCP_BIND_ADDRESS} expand into
# CLI flags at container start. --allow-unauthenticated is safe here only
# because every deployment of this image sits behind an external BasicAuth
# layer (Traefik Middleware) — see the chart's mcp-argocd values.yaml.
# `docker run <image> http --stateless` still works: CMD's args land after
# --allow-unauthenticated via "$@".
ENTRYPOINT [ "sh", "-c", "exec node dist/index.js http --port \"${PORT:-3000}\" --bind-address \"${MCP_BIND_ADDRESS:-0.0.0.0}\" --allow-unauthenticated \"$@\"", "--" ]
CMD []
USER 1000
