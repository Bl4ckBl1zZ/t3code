# Fork changes

This fork stays close to `pingdotgg/t3code` and carries only the following operational changes:

- Builds a macOS ARM64-only DMG with bundle ID `com.t3code.dev`; the desktop updater reads releases
  from `Bl4ckBl1zZ/t3code`. Public releases require and verify Developer ID signing, hardened
  runtime, and Apple notarization.
- Merges `upstream/main` into the fork hourly and triggers a new ARM64 build when upstream changed.
- Uses a provider-neutral PostgreSQL database on Dokploy instead of provisioning PlanetScale.
- Reaches PostgreSQL through Cloudflare Tunnel + Access, with a private CA and Hyperdrive
  `verify-full` certificate validation.
- Runs database migrations through an authenticated `cloudflared access tcp` listener in CI.
- Deploys the T3 Connect relay with APNs sandbox credentials for `com.t3code.dev`, including push
  notification and Live Activity delivery support.
- Uses the fork's iOS identifiers: `com.t3code.dev`, `com.t3code.dev.widgets`, and
  `group.com.bl4ckbl1zz.t3code.dev`, supplied through the fork's iOS build variables. Local
  development signing uses the APNs sandbox and may omit the share extension until its separate
  provisioning profile exists.
