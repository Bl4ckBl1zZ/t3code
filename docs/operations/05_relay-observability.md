# Relay observability

> For maintainers. Using T3 Code? See [docs/user](../user/).

The self-hosted relay uses Cloudflare Workers observability for diagnostics and provisions no
external tracing backend.

Use **Cloudflare Dashboard > Workers & Pages > the relay Worker > Observability** to inspect
invocation status, exceptions, and structured log messages. Request, queue, and cron handlers still
create Effect spans so trace identifiers can be returned to clients and correlated with errors, but
the spans are not exported. The span and attribute names below identify where a log line or error
came from.

Keep production logging free of credentials, APNs device tokens, Clerk bearer tokens, and database
connection strings.

DPoP proof failures include the stable `relay.dpop.failure_code` span attribute. A `time_window`
failure means that a signed proof was too old or too far in the future for the relay's allowed
window. It can point to a date or time problem on either device, but it can also result from a
delayed request. The client uses this category, and the absence of a category from an older relay,
to decide whether clock skew is confirmed or only one possible cause.

## Webhooks

A public webhook request is one `relay.hooks.forward` span. Its `relay.hook.outcome` says what
happened: `forwarded`, `held`, `rate_limited`, `inbox_full`, `not_found`, `payload_too_large`,
`environment_unavailable`, or `environment_timeout`. `relay.hook.endpoint_key` identifies the
managed endpoint, and with it the environment. On a forward, `relay.hook.upstream_status` or
`relay.hook.upstream_error` records the environment's answer, and
`relay.hook.upstream_outcome` what it did with the request (`accepted`, `duplicate`,
`prompt_too_long`, `queue_full`, `rejected_signature`, `expired`, `disabled`, ...), from its
`x-t3-hook-outcome` response header. A held request's delivery records the same on its
`relay.inbox.deliver` span. The relay sends its own `traceparent` with each forward and drops any a
sender supplied, and signs each forward (`x-t3-relay-delivery`) so the environment trusts the
relay's delivery id, receive time and trace context only from the relay, so on environments that export to T3 Connect, the environment's
`ScheduledTaskService.triggerWebhook` span lands in the same trace. `relay.hook.rate_limit` says which
budget ran out: `endpoint` or `hook`. `relay.hook.rate_limiter_failed_open` is set when the
Cloudflare rate limiter was unavailable and the request went through unlimited.

Held requests are handled in the endpoint's `HookInboxObject`, and each call into it is its own
trace, not a child of the forward span: `relay.inbox.hold`, `relay.inbox.wake`, and
`relay.inbox.deliver` for each alarm run. Each carries `relay.hook.endpoint_key`, so they join to
forwards. The details are on the child spans: `HookInboxStore.hold` carries
`relay.inbox.refused` when the inbox refused a request (`max_per_hook`, `max_requests`,
`max_bytes`, or `already_held`). `HookInboxStore.deliverDue` carries `relay.inbox.run_result`
(`drained`, `more_pending`, `busy`, or `unreachable`), how many requests it sent and delivered,
the consecutive failures behind the retry delay, the longest time a delivered request waited, and
the backlog left. A run that errored outright has `relay.inbox.run_result = failed` on the root
`relay.inbox.deliver` span instead.
