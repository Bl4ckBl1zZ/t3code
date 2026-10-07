# Environment Authentication Profile

> For maintainers. Using T3 Code? See [docs/user](../user/).

The environment server and the relay use separate credentials, issuers, and trust
boundaries. They intentionally use a similar OAuth-shaped model so that permission
checks and token exchange behavior can be audited against established concepts.

## Authorization Model

Environment authorization is capability-based. A session carries zero or more
OAuth-style scope strings:

| Scope                   | Permission                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `orchestration:read`    | Read snapshots, status, events, configuration, and filesystem/VCS state. |
| `orchestration:operate` | Dispatch user operations and mutate environment-side workspace state.    |
| `terminal:operate`      | Create, attach, input, resize, clear, restart, and terminate terminals.  |
| `review:write`          | Read review diff previews used to compose review feedback.               |
| `access:read`           | Inspect pairing links and client sessions.                               |
| `access:write`          | Create or revoke pairing links and client sessions.                      |
| `relay:read`            | Inspect managed relay connectivity.                                      |
| `relay:write`           | Link, configure, or unlink managed relay connectivity.                   |

Ordinary pairing links grant the four client-operation scopes and read access to
managed relay connectivity:
`orchestration:read orchestration:operate terminal:operate review:write relay:read`.
The desktop bootstrap credential and command-line administrative bootstrap
credentials additionally grant `access:read access:write relay:write`.

## Authentication Flows

### Browser Session

`POST /api/auth/browser-session` consumes a one-time bootstrap credential and creates a
browser session cookie. The cookie is an HTTP transport adapter for the same
scoped session model; the response never exposes the session secret to browser
JavaScript.

### Bearer Access Token

Non-browser clients use `POST /oauth/token` with an
`application/x-www-form-urlencoded` body:

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<bootstrap credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
```

Clients may additionally submit `client_label`, `client_device_type`, and
`client_os` extension parameters so the authorized-clients UI can identify the
device that established the session. These are presentation hints only; the
environment derives transport metadata such as IP address and user agent from
the request and does not use these fields for authorization.

The response has the token-exchange shape:

```json
{
  "access_token": "<opaque session token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
}
```

Sessions issued from a plain bearer exchange use the store's
`DEFAULT_SESSION_TTL` of 30 days. The shorter one-hour `expires_in: 3600` applies
only to DPoP-bound exchanges, where the token is additionally constrained by a
proof key. See `SessionStore.ts` and `EnvironmentAuth.ts`.

The reusable `desktop-bootstrap` grant replaces active sessions with the same
subject and authentication method. Revocation and insertion share one database
transaction, so a failed insertion preserves the previous credential. This also
removes stale local desktop entries from earlier launches. Browser-cookie sessions
and sessions issued through pairing links are not replaced.

The desktop app does not hand its renderer one long-lived bootstrap token. It
launches every backend with a shared secret (`desktopBootstrapSecret`) that never
reaches the renderer, and both sides derive the token for each 12-hour window
from it (`@t3tools/shared/desktopBootstrapToken`). A backend accepts the
previous, current and next window's token. A backend launched without the secret
falls back to the fixed `desktopBootstrapToken` seed.

Requested scopes must be a subset of the one-time bootstrap credential grant.
An ordinary paired client therefore cannot exchange its grant for
`access:read`, `access:write`, or `relay:write`.

### DPoP-Bound Access Token

The same `/oauth/token` exchange supports proof-of-possession tokens. A client
that sends a `DPoP` header has its proof verified by `verifyRequestDpopProof`;
the resulting JWK thumbprint is stored on the session, which is then issued with
method `dpop-access-token` and a one-hour TTL instead of the bearer default. An
invalid proof gets a DPoP challenge header and a credential error rather than a
bearer token. Newer servers include a safe `dpopFailureReason` category in that
error. When an older server omits the category, clients mention clock skew as
one possible cause rather than presenting it as confirmed.

Each accepted proof is recorded once as a `dpop-proof-*` entry in the server
secret store, so a replayed proof is rejected; the cloud mint and health
endpoints record their `jti` and nonce the same way. `ReplayRecordPruner`
deletes these records an hour after they are written, long after their proofs
would fail the time-window check anyway.

`dpop-access-token` is advertised alongside `browser-session-cookie` and
`bearer-access-token` in the descriptor's `sessionMethods`
(`EnvironmentAuthPolicy.ts`), so clients can discover support rather than
assume it. Relay-brokered clients use this mode so that a leaked token cannot be
replayed without the corresponding key.

### WebSocket Ticket

`POST /api/auth/websocket-ticket` accepts any authenticated session and returns
a short-lived, single-purpose WebSocket ticket, issued through
`EnvironmentAuth.issueWebSocketTicket` with a five-minute default TTL. The
client presents its bearer or DPoP credential in headers to get the ticket, then
appends only that ticket to the socket URL as `wsTicket`. This keeps long-lived
tokens and browser cookies out of WebSocket URLs while letting the handshake
authenticate.

The ticket carries its session's scopes; each RPC method then enforces
`orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, `relay:write`, or `access:read` as appropriate, through
`RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts`. The WebSocket RPC
group's `RpcScopeAuthorization` middleware checks that scope before any handler runs. Review
feedback submission currently dispatches
an orchestration operation, so clients performing it also need
`orchestration:operate`. Creating a ticket is not authorization to call every
RPC method.

## Standards Alignment

- Bearer access tokens are used through the `Authorization: Bearer` scheme from
  RFC 6750.
- The token endpoint profiles the request and response vocabulary from OAuth 2.0
  Token Exchange (RFC 8693), including `subject_token`, `requested_token_type`,
  `access_token`, `issued_token_type`, and `token_type`.
- Scope values follow the OAuth 2.0 scope model from RFC 6749: space-delimited,
  unordered capabilities with subset checking during exchange.

Apart from the narrow MCP client server below, this is intentionally not a
general-purpose OAuth authorization server. The environment bootstrap token
type is private, the bootstrap cookie and WebSocket connection-token routes are
product-specific adapters, and the API returns its typed `HttpApi` errors rather
than implementing every OAuth error response surface.

## MCP Clients

Agents T3 Code did not launch sign in to `/mcp` through a narrow OAuth
authorization-code server ([McpOAuth](../../apps/server/src/auth/McpOAuth.ts)):
protected-resource and authorization-server metadata (RFC 9728, RFC 8414),
dynamic client registration (RFC 7591) at `/oauth/mcp/register`, and PKCE S256
codes at `/oauth/mcp/authorize` and `/oauth/mcp/token`. It accepts only loopback
redirect URIs: an HTTPS redirect would let anyone send the owner an approval
link that delivers the code to their own server. Client registration is
stateless (the client id is signed), so an unauthenticated caller cannot grow
server state. Authorization codes are single-use and live for 60 seconds.

Approval spends a one-time pairing code that holds the scopes being granted, or
uses a browser cookie session with `access:write` and `orchestration:read`
whose scopes cover the grant. Proof-bound T3 Connect codes are refused without
being spent.

The user grants either read-only access or a runtime-mode ceiling, not a scope
list: MCP tools are all orchestration, and `orchestration:operate` alone would
let an agent start a thread in full access and act through it. The result is an
ordinary session with subject `mcp-client` that lasts 30 days and appears in
Connections. A read-only grant holds `orchestration:read` alone; on `/mcp` it
passes only tools declared as reads in
[McpToolAccess](../../apps/server/src/mcp/McpToolAccess.ts), where every tool
must declare who may call it to compile. Any other grant adds
`orchestration:operate` and a signed ceiling (the `rtc` session claim). Only
`/mcp` accepts these sessions. Every other HTTP route and the WebSocket ticket
path reject that subject, because the RPC surface would let the agent act above
its ceiling. Inside MCP the credential sets the limits and tool parameters only
pick targets; see [threadAccess](../../apps/server/src/mcp/threadAccess.ts).

`/mcp` tries a provider session token first, then an MCP client session. A
`401` points at the protected-resource metadata in `WWW-Authenticate` unless the
presented token was a provider token, so an agent T3 launched never starts an
OAuth flow.

Issuer and resource URLs come from the request's Host and
`X-Forwarded-Proto`, so one server answers over loopback, Tailscale Serve and a
T3 Connect tunnel. A proxy that rewrites Host or drops the protocol header
breaks sign-in.

## Upgrade Behavior

Migration `031_AuthAuthorizationScopes` is a hard cutover from role-bearing auth
records to scoped records. It deletes existing pairing links and sessions while
leaving non-authentication environment state unchanged. Upgraded clients must
pair again; old `owner` or `client` credentials are never silently mapped to new
capabilities.

## Relay Boundary

Relay-managed tunnels use their own tokens and keys. The relay can reuse scope
parsing and token-exchange conventions, but an environment access token is not a
relay token and cannot be presented to the relay.
