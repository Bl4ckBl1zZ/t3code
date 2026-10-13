# T3 Connect Relay

> [!NOTE]
> Sign in to T3 Connect from the app under Settings > Connections.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture note](../../docs/internals/t3-connect.md) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs or FCM tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Transcribing voice input for signed-in accounts with one shared OpenRouter key, within daily caps.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs and FCM delivery, and queue processing.
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

This fork self-hosts the relay. PostgreSQL runs as a Dokploy service and the Worker reaches it
through an existing Cloudflare Hyperdrive configuration, which connects to the private database
through a Workers VPC service. Neither is provisioned by this stack.

Migrate the database first, then deploy with the Alchemy CLI (`vp run --filter t3code-relay deploy`
is `alchemy deploy` in this directory):

```sh
vp run --filter t3code-relay migrate
vp run --filter t3code-relay deploy -- --stage prod
```

`migrate` ([`scripts/migrate.ts`](./scripts/migrate.ts)) applies `migrations/postgres` with
Drizzle's migrator, which records applied migrations by folder name in `drizzle.relay_migrations`.
Before migrating it renames journal rows that the fork recorded under other names, so databases
migrated by the fork's relay upgrade in place. It reads `DATABASE_MIGRATION_URL`, falling back to
`DATABASE_URL`.

The stack provisions the Cloudflare Worker, queues, rate limiters, and the managed endpoint DNS
zones, and binds the Hyperdrive configuration named by `DATABASE_HYPERDRIVE_ID`. The database
password lives only in Hyperdrive. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include the scoped Cloudflare token, Clerk, APNs, and
optional FCM credentials. The Worker uses one least-privilege `CLOUDFLARE_RUNTIME_API_TOKEN` with
**Cloudflare Tunnel: Edit** on the relay account and **DNS: Edit** on `RELAY_TUNNEL_ZONE_NAME`, only
to provision and remove managed environment endpoints. Set `APNS_ENABLED=false` for an Android-only
development deployment without Apple credentials. Production adopts the configured API and tunnel DNS
zones as retained Cloudflare resources. Personal stages reference the production-owned zones and
bind whichever Hyperdrive configuration their env file names, so point theirs at a non-production
database.

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

The relay provisions no tracing backend. Use Cloudflare Worker logs for diagnostics.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main` while the `RELAY_DEPLOY_ENABLED` variable is
`true`. Before deploying it starts the Dokploy PostgreSQL service if Dokploy does not report it
running, then migrates through a `cloudflared access tcp` listener, and after deploying it checks
`/health`, which queries the database. A manual run with `dry_run` plans the deploy without migrating
or applying anything. Pull requests do not deploy relay stages.

The repository must define these Actions variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `RELAY_DEPLOY_ENABLED`

The `production` GitHub environment must define these Actions variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `DATABASE_HYPERDRIVE_ID`
- `DATABASE_TUNNEL_HOSTNAME` for CI migrations through Cloudflare Access
- `DOKPLOY_URL` and `DOKPLOY_POSTGRES_ID` for the relay PostgreSQL service
- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `CLOUDFLARE_API_TOKEN`, used only by Alchemy while deploying
- `CLOUDFLARE_RUNTIME_API_TOKEN`, bound into the Worker
- `DATABASE_MIGRATION_URL`, a `127.0.0.1:15433` URL for the CI listener
- `DATABASE_ACCESS_CLIENT_ID` and `DATABASE_ACCESS_CLIENT_SECRET` for Cloudflare Access
- `DOKPLOY_AUTH_TOKEN`
- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`
- `FCM_SERVICE_ACCOUNT` when Android push is enabled
- `OPENROUTER_API_KEY` when voice input is enabled

Voice input also reads optional `VOICE_INPUT_*` variables; see
[Relay voice input](../../docs/operations/relay-voice-input.md).

The release workflow reads the production relay's public URL and Clerk publishable key from the same
environment for downstream desktop, CLI, and hosted web builds.

See:

- [T3 Connect setup](../../docs/operations/connect-setup.md) for Clerk keys, JWT templates, and sign-up restrictions.
- [T3 Connect architecture](../../docs/internals/t3-connect.md) for environment linking and trust boundaries.
