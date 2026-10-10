# Security and privacy

The MCP key grants access to the Canvas account configured for this service.
Use a random key, limit network exposure, and use HTTPS for remote clients.
Read-only mode is enabled by default. API permissions remain constrained by
the Canvas token's account and provider policy.

Keep tokens in private environment files or mounted secret files. `.gitignore`
and `.dockerignore` exclude these paths. Query-key authentication is an optional
compatibility setting: disable proxy access logging of query strings if you use it.

Responses may include account details, course content, grades, signed download
URLs, and other personal data. This service returns that data to authenticated
clients. It is not an anonymizer. Header redaction and response-field filtering
reduce credential exposure, but cannot remove every secret embedded in arbitrary
upstream text. Diagnostic body previews and raw downloads must be handled as
private data.

Before publishing changes, run the privacy guard and a secret scanner over
both the proposed files and Git history. Review fixtures and documentation
manually. Automated checks cannot establish that every name, number, or free
text passage is anonymous.

For a security report, use the repository's private vulnerability reporting
feature if available. Do not include live tokens or private Canvas records in
a public issue. Revoke a credential that has been exposed; deleting it from a
later commit does not remove it from earlier Git history.
