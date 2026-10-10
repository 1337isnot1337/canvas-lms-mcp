#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077
mkdir -p .secrets
chmod 700 .secrets
if [[ ! -e .secrets/mcp_key ]]; then
  openssl rand -hex 32 > .secrets/mcp_key
  chmod 444 .secrets/mcp_key
fi
if [[ ! -e .secrets/canvas_token ]]; then
  read -r -s -p 'Canvas API token: ' canvas_token_input
  printf '\n'
  if [[ ${#canvas_token_input} -lt 10 ]]; then
    printf 'A Canvas API token of at least 10 characters is required.\n' >&2
    exit 1
  fi
  printf '%s\n' "$canvas_token_input" > .secrets/canvas_token
  unset canvas_token_input
  chmod 444 .secrets/canvas_token
fi
printf 'Secret files are ready in .secrets/. Existing values were preserved.\n'
