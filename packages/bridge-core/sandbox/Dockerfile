# Tool execution only. DSH, provider credentials and the bridge stay on the host.
FROM node:26.4.0-bookworm-slim@sha256:ec82d089a8ae2cf02628da7b34ea57dc357b24db724d557fe2d240e6beb659c1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
USER node
