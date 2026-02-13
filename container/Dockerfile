FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    tmux \
    openssh-client \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    unzip \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# pnpm
RUN npm install -g pnpm

# MCP servers (pre-installed, activated via MCP_SERVERS env)
RUN npm install -g \
    @modelcontextprotocol/server-filesystem \
    @modelcontextprotocol/server-github \
    @modelcontextprotocol/server-postgres \
    @modelcontextprotocol/server-fetch \
    @modelcontextprotocol/server-brave-search \
    @modelcontextprotocol/server-puppeteer \
    @modelcontextprotocol/server-memory \
    exa-mcp-server

# Deploy CLIs
RUN npm install -g vercel
RUN curl -L https://fly.io/install.sh | sh
ENV FLYCTL_INSTALL="/root/.fly"
ENV PATH="$FLYCTL_INSTALL/bin:$PATH"
RUN npm install -g supabase

# Modal (Python)
RUN pip3 install --break-system-packages modal

# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# App user
RUN useradd -m -s /bin/bash app
USER app
WORKDIR /home/app

# Copy gateway and install its deps
COPY --chown=app:app gateway.js /home/app/gateway.js
RUN cd /home/app && npm init -y > /dev/null 2>&1 && npm install ws

# Copy entrypoint and healthcheck
COPY --chown=app:app entrypoint.sh /home/app/entrypoint.sh
COPY --chown=app:app healthcheck.sh /home/app/healthcheck.sh
RUN chmod +x /home/app/entrypoint.sh /home/app/healthcheck.sh

# Workspace volume mount point
RUN mkdir -p /workspace
VOLUME ["/workspace"]

EXPOSE 18789

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD /home/app/healthcheck.sh

ENTRYPOINT ["/home/app/entrypoint.sh"]
