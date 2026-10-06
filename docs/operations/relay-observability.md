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

## Webhooks

A public webhook request is one `relay.hooks.forward` span. Its `relay.hook.outcome` says what
happened: `forwarded`, `held`, `rate_limited`, `inbox_full`, `not_found`, `payload_too_large`,
`environment_unavailable`, or `environment_timeout`. `relay.hook.endpoint_key` identifies the
managed endpoint, and with it the environment. On a forward, `relay.hook.upstream_status` or
`relay.hook.upstream_error` records the environment's answer, and `relay.hook.upstream_outcome`
what it did with the request (`accepted`, `duplicate`, `prompt_too_long`, `queue_full`,
`rejected_signature`, `expired`, `disabled`, ...), from its `x-t3-hook-outcome` response header.
`relay.hook.rate_limit` says which budget ran out: `endpoint` or `hook`.
`relay.hook.rate_limiter_failed_open` is set when the Cloudflare rate limiter was unavailable and
the request went through unlimited. The relay drops any `traceparent` a sender supplied and signs
each forward (`x-t3-relay-delivery`), so the environment trusts the delivery id, receive time, and
trace context only from the relay.

Held requests are handled in the endpoint's `HookInboxObject` Durable Object. Each call into it is
its own root span, not a child of the forward span: `relay.inbox.hold`, `relay.inbox.wake`, and
`relay.inbox.deliver` for each alarm run, each carrying `relay.hook.endpoint_key`.
`HookInboxStore.hold` carries `relay.inbox.refused` when the inbox refused a request
(`max_per_hook`, `max_requests`, `max_bytes`, or `already_held`). `HookInboxStore.deliverDue`
carries `relay.inbox.run_result` (`drained`, `more_pending`, `busy`, or `unreachable`). A run that
errored outright logs `Held webhook delivery run failed` and retries a minute later. These spans
stay local like the rest; the Durable Object's log lines appear under the Worker's Cloudflare
observability.
