# T3 Connect Relay

> [!WARNING]
> T3 Connect is currently in private beta. Join the waitlist in the app under Settings > T3 Connect.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and emitting structured Worker logs for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter t3code-relay deploy
```

The stack provisions the Cloudflare Worker and queues plus managed endpoint resources. PostgreSQL is
provider-neutral and supplied through the secret `DATABASE_URL`; the database must already exist,
accept TLS connections, and be connected to the existing Hyperdrive configuration identified by
`DATABASE_HYPERDRIVE_ID`. For private Dokploy databases, use a Workers VPC service backed by
Cloudflare Tunnel and keep the database's public port closed. The Worker also needs one
least-privilege `CLOUDFLARE_RUNTIME_API_TOKEN` with **Cloudflare Tunnel: Edit** on the relay account
and **DNS: Edit** on `RELAY_TUNNEL_ZONE_NAME`; it uses that credential only when provisioning and
removing managed environment endpoints. Copy
[`infra/relay/.env.example`](./.env.example) to `infra/relay/.env` and fill in the deployment-specific
values before deploying. Alchemy loads that file from the relay directory. Runtime secrets include
the scoped Cloudflare token, Clerk, and APNs credentials. Production adopts the configured API and
tunnel DNS zones as retained Cloudflare resources. Personal stages reference the production-owned
zones.

Apply the checked-in database migrations before deploying infrastructure:

```sh
vp run --filter t3code-relay migrate
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_HYPERDRIVE_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_RUNTIME_API_TOKEN`
- `DATABASE_URL`
- `DATABASE_MIGRATION_URL` with a localhost URL for the CI `cloudflared access tcp` listener

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `DATABASE_TUNNEL_HOSTNAME` for CI migrations through Cloudflare Access
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

`CLOUDFLARE_API_TOKEN` is consumed only by Alchemy while provisioning relay stages.
`CLOUDFLARE_RUNTIME_API_TOKEN` is bound into the Worker with the narrow account/zone permissions
described above. The database password is stored in Cloudflare Hyperdrive and is not bound directly
into the relay Worker. The relay uses Cloudflare Worker logs for initial operational diagnostics and
does not require an external tracing account. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [T3 Connect Clerk Setup](../../docs/cloud/t3-connect-clerk.md) for Clerk keys, JWT templates, and waitlist
  setup.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment diagnostics.
- [T3 Connect Architecture Overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.
