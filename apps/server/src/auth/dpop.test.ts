import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import type { DpopPublicJwk } from "@t3tools/shared/dpop";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerRequest } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { SecretStorePersistError } from "./ServerSecretStore.ts";
import {
  DPOP_REPLAY_RECORDS,
  mapDpopFailureReason,
  mapDpopReplayStoreError,
  verifyRequestDpopProof,
} from "./dpop.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new SecretStorePersistError({
    resource: "DPoP proof",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "dpop-proof.bin",
    }),
  });

describe("mapDpopReplayStoreError", () => {
  it("reports replay conflicts as invalid credentials", () => {
    const cause = storeFailure("AlreadyExists");
    const error = mapDpopReplayStoreError(cause);

    expect(error._tag).toBe("ServerAuthInvalidCredentialError");
    if (error._tag === "ServerAuthInvalidCredentialError") {
      expect(error.cause).toBe(cause);
      expect(error.dpopFailureReason).toBe("replay");
    }
  });

  it("reports replay-store availability failures as internal errors", () => {
    const error = mapDpopReplayStoreError(storeFailure("PermissionDenied"));

    expect(error._tag).toBe("ServerAuthDpopReplayStateRecordError");
    if (error._tag === "ServerAuthDpopReplayStateRecordError") {
      expect(error.message).toBe("Failed to record DPoP proof replay state.");
    }
  });
});

describe("mapDpopFailureReason", () => {
  it("maps verifier failures to safe client-facing categories", () => {
    const mappings = [
      ["time_window", "time_window"],
      ["key_mismatch", "key_mismatch"],
      ["method_mismatch", "request_mismatch"],
      ["url_mismatch", "request_mismatch"],
      ["access_token_hash_mismatch", "token_mismatch"],
      ["missing_proof", "invalid_proof"],
      ["malformed_proof", "invalid_proof"],
      ["invalid_signature", "invalid_proof"],
      ["invalid_proof", "invalid_proof"],
    ] as const;

    for (const [code, expected] of mappings) {
      expect(mapDpopFailureReason(code)).toBe(expected);
    }
  });
});

const signDpopProof = (input: { readonly url: string; readonly iat: number }) => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: publicKey.export({ format: "jwk" }) as DpopPublicJwk,
  });
  const payload = encode({ htm: "POST", htu: input.url, jti: "proof-pruned", iat: input.iat });
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
};

effectIt.layer(NodeServices.layer)("verifyRequestDpopProof", (it) => {
  it.effect("rejects a replay by time alone once its record can be pruned", () =>
    Effect.gen(function* () {
      const acceptedAt = Date.UTC(2026, 8, 25, 12, 0, 0);
      yield* TestClock.setTime(acceptedAt);
      // The longest-lived proof: `iat` at the 5 s future skew the verifier allows.
      const proof = signDpopProof({
        url: "http://localhost/oauth/token",
        iat: Math.floor(acceptedAt / 1_000) + 5,
      });
      const verify = verifyRequestDpopProof({
        request: HttpServerRequest.fromWeb(
          new Request("http://localhost/oauth/token", { method: "POST", headers: { dpop: proof } }),
        ),
      });
      const failureReason = verify.pipe(
        Effect.flip,
        Effect.map((error) =>
          error._tag === "ServerAuthInvalidCredentialError" ? error.dpopFailureReason : error._tag,
        ),
      );

      yield* verify;
      // While the proof is fresh, only the replay record rejects it.
      expect(yield* failureReason).toBe("replay");
      // Once the record can be pruned, the time check rejects the proof by itself.
      yield* TestClock.setTime(acceptedAt + Duration.toMillis(DPOP_REPLAY_RECORDS.maxAge));
      expect(yield* failureReason).toBe("time_window");
    }).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dpop-test-" })),
        ),
      ),
    ),
  );
});
