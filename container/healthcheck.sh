#!/usr/bin/env bash
curl -sf http://localhost:18789/health > /dev/null 2>&1 || exit 1
