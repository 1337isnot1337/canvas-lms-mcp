# Optional Canvas relay

This small HTTP service makes Canvas requests from a different egress network.
The main MCP server normally calls Canvas directly. Use the relay only when
your deployment requires another outbound path.

The relay accepts its own random shared secret using `Authorization: Bearer`.
It holds the Canvas token, limits requests to the configured Canvas origin,
and defaults to read-only mode. It has no database or persistent response cache.

To run it with the included Compose profile:

```bash
# Existing .env and .secrets/canvas_token are reused.
umask 077
openssl rand -hex 32 > .secrets/relay_key
chmod 444 .secrets/relay_key
docker compose --profile relay up --build -d relay
```

The relay listens on `127.0.0.1:8300` on the host. Expose it through an HTTPS
reverse proxy if the MCP service will connect to it. On the MCP side, set:

```text
CANVAS_RELAY_URL=https://relay.example.org
CANVAS_RELAY_SECRET_FILE=.secrets/relay_key
```

For the Node launch, put these settings in your private `.env`. For Compose,
add the relay URL, secret-file environment value, and `relay_key` secret mount
to the `canvas-mcp` service. The relay URL must be an HTTPS origin. Local
plain HTTP is intentionally not accepted as a relay URL.

Standalone use requires Node.js 24 or newer:

```bash
cd relay
# Supply CANVAS_BASE_URL, CANVAS_TOKEN_FILE, and RELAY_SHARED_SECRET_FILE
# through your environment or a private .env in this directory.
npm start
```

`CANVAS_TOKEN` and `RELAY_SHARED_SECRET` can be used instead of file settings.
`HOST` defaults to `::`, and `PORT` to `8300` for standalone relay use.
`READ_ONLY`, byte limits, and outbound Canvas header overrides are supported.

`/healthz` is a public process check. `/v1/health`, `/v1/canvas`, `/v1/probe`,
and `/v1/download` require authentication. Relay responses may contain private
Canvas data; do not commit them or include them in public issue reports.
