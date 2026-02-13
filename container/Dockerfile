FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# System packages — give agent full toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    tmux \
    openssh-client \
    build-essential \
    clang \
    cmake \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    unzip \
    jq \
    ripgrep \
    gosu \
    sudo \
    wget \
    htop \
    xxd \
    && rm -rf /var/lib/apt/lists/*

# pnpm
RUN npm install -g pnpm

# Python tools
RUN pip install --break-system-packages modal supabase gdown uv

# Install uv properly
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && chmod +x /usr/local/bin/uv /usr/local/bin/uvx

# Install OpenClaw
RUN npm install -g openclaw@latest

# App user + workspace — give app user passwordless sudo
RUN useradd -m -s /bin/bash app \
    && mkdir -p /workspace \
    && chown app:app /workspace \
    && echo "app ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
WORKDIR /home/app

# Copy bridge gateway and install ws dependency
COPY --chown=app:app gateway.js /home/app/gateway.js
COPY --chown=app:app supervisor.js /home/app/supervisor.js
RUN cd /home/app && npm init -y > /dev/null 2>&1 && npm install ws

# Copy entrypoint and healthcheck
COPY --chown=app:app entrypoint.sh /home/app/entrypoint.sh
COPY --chown=app:app healthcheck.sh /home/app/healthcheck.sh
RUN chmod +x /home/app/entrypoint.sh /home/app/healthcheck.sh
VOLUME ["/workspace"]

EXPOSE 18789

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD /home/app/healthcheck.sh

ENTRYPOINT ["/home/app/entrypoint.sh"]
