# Test image only. Never used by Jarvis or installed on the operator's host.
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS node
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
    ca-certificates curl dnsutils iproute2 ipset iptables libstdc++6 openssl python3 systemd util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN ln -s /usr/local/bin/node /usr/bin/node
WORKDIR /lab
COPY deploy/egress-lab /lab
COPY deploy/egress/policy.mjs deploy/egress/host.mjs deploy/egress/iptables.mjs /lab/
CMD ["python3", "/lab/kernel.py"]
