# Troubleshooting

## Startup rejects configuration

Check that `CANVAS_BASE_URL` is an HTTPS origin, with no username, password,
query, or fragment. The optional `/api/v1` suffix is accepted. The MCP key
must contain at least 24 characters. Direct Canvas access requires a Canvas
API token. A configured `_FILE` value takes precedence over the environment
variable and must point to a readable file.

The Docker container runs as a non-root user. The setup script creates files
readable by that user inside an owner-only host directory. Avoid mounting
your entire secret directory into the container; Compose mounts individual files.

## MCP returns 401, 403, or 406

For 401, check your MCP authentication header and key. For 403, check
`ALLOWED_HOSTS` and, if your client sends an Origin header, `ALLOWED_ORIGINS`.
For 406, ensure the MCP client accepts both `application/json` and
`text/event-stream`.

## Canvas returns 401, 403, or 406

These are provider responses, distinct from MCP transport errors. Confirm
that the Canvas token is valid and that the account may access the requested
endpoint. Some deployments apply network or request-header policies. Use
`canvas_header_probe` to compare safe GET request profiles. The diagnostic
output redacts Authorization headers; body previews can still contain private
account data and should not be posted publicly.

`CANVAS_USER_AGENT`, `CANVAS_ACCEPT`, and `CANVAS_ACCEPT_LANGUAGE` override
outbound headers. An optional relay may help when a provider restricts the
service's egress network. Configure a relay only after checking the direct
provider response.

## Health passes but course reads fail

`/healthz` and `/readyz` report process readiness without contacting Canvas.
Use an authenticated MCP tool, such as `list_courses`, to check actual account
access. Do not save its response as a repository fixture.
