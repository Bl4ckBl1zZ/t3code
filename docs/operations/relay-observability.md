# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

The fork uses Cloudflare Workers observability for initial relay diagnostics. No external Axiom
dataset or ingest token is required.

Use **Cloudflare Dashboard > Workers & Pages > T3 Code relay > Observability** to inspect invocation
status, exceptions, and structured log messages. Request and queue handlers continue to create
Effect spans locally so trace identifiers can be returned to clients and correlated with errors,
but the fork does not export those spans to a third-party service.

Keep production logging free of credentials, APNs device tokens, Clerk bearer tokens, and database
connection strings. If longer retention or cross-service distributed tracing becomes necessary,
add an optional OTLP exporter without making it a deployment prerequisite.
