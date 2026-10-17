import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

export const ManagedEndpointCleanupMode = Schema.Literals(["off", "dry-run", "enabled"]);
export type ManagedEndpointCleanupMode = typeof ManagedEndpointCleanupMode.Type;
const decodeManagedEndpointCleanupMode = Schema.decodeUnknownEffect(ManagedEndpointCleanupMode);

const RELAY_TUNNEL_CLEANUP_MODE = "RELAY_TUNNEL_CLEANUP_MODE";
const RELAY_LEGACY_TUNNEL_CLEANUP_MODE = "RELAY_LEGACY_TUNNEL_CLEANUP_MODE";

const cleanupModeConfig = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault("off"),
    Config.map((value) => value.trim() || "off"),
    Config.mapEffect((value) =>
      decodeManagedEndpointCleanupMode(value).pipe(
        Effect.mapError((error) => new Config.ConfigError(error)),
      ),
    ),
  );

export const managedEndpointCleanupModeConfig = cleanupModeConfig(RELAY_TUNNEL_CLEANUP_MODE);
export const legacyManagedEndpointCleanupModeConfig = cleanupModeConfig(
  RELAY_LEGACY_TUNNEL_CLEANUP_MODE,
);

const RELAY_LEGACY_TUNNEL_GRACE_MINUTES = "RELAY_LEGACY_TUNNEL_GRACE_MINUTES";

export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

export interface VoiceInputConfig {
  /** Kill switch. Voice is also off while no OpenRouter key is configured. */
  readonly enabled: boolean;
  readonly openRouterApiKey: Redacted.Redacted<string> | undefined;
  /** Audio seconds each account may transcribe per UTC day. */
  readonly dailySeconds: number;
  readonly maxClipSeconds: number;
  /** Decoded audio bytes per request. */
  readonly maxUploadBytes: number;
}

// Unset GitHub variables arrive as empty strings, so blank means "use the default".
const voiceVariable = <A>(name: string, schema: Schema.Codec<A, string>, fallback: A) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
    Config.mapEffect((value) =>
      value === ""
        ? Effect.succeed(fallback)
        : Schema.decodeEffect(schema)(value).pipe(
            Effect.mapError((error) => new Config.ConfigError(error)),
          ),
    ),
  );

const PositiveIntFromString = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);

export const voiceInputConfig: Config.Config<VoiceInputConfig> = Config.all({
  enabled: voiceVariable("VOICE_INPUT_ENABLED", Schema.Literals(["true", "false"]), "true").pipe(
    Config.map((value) => value === "true"),
  ),
  openRouterApiKey: Config.option(Config.Redacted("OPENROUTER_API_KEY")).pipe(
    Config.map((key) =>
      Option.getOrUndefined(Option.filter(key, (value) => Redacted.value(value).trim().length > 0)),
    ),
  ),
  dailySeconds: voiceVariable("VOICE_INPUT_DAILY_SECONDS", PositiveIntFromString, 30 * 60),
  maxClipSeconds: voiceVariable("VOICE_INPUT_MAX_CLIP_SECONDS", PositiveIntFromString, 120),
  maxUploadBytes: voiceVariable(
    "VOICE_INPUT_MAX_UPLOAD_BYTES",
    PositiveIntFromString,
    10 * 1024 * 1024,
  ),
});

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

export class RelayConfiguration extends Context.Service<
  RelayConfiguration,
  {
    readonly relayIssuer: string;
    readonly apns: ApnsCredentials | null;
    readonly fcmServiceAccount?: Redacted.Redacted<string>;
    readonly clerkSecretKey: Redacted.Redacted<string>;
    readonly clerkPublishableKey: string;
    readonly clerkJwtAudience: string;
    readonly apnsDeliveryJobSigningSecret: Redacted.Redacted<string>;
    readonly cloudMintPrivateKey: Redacted.Redacted<string>;
    readonly cloudMintPublicKey: string;
    readonly managedEndpointBaseDomain: string | undefined;
    readonly managedEndpointNamespace: string | undefined;
    readonly managedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyManagedEndpointCleanupMode?: ManagedEndpointCleanupMode;
    readonly legacyTunnelGraceMinutes?: number;
    /** Absent in tests and older deployments; voice is then unavailable. */
    readonly voiceInput?: VoiceInputConfig;
  }
>()("t3code-relay/Config/RelayConfiguration") {}

export const make = (configuration: RelayConfiguration["Service"]) =>
  RelayConfiguration.of(configuration);

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, make(configuration));
