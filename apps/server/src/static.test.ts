import * as DateTime from "effect/DateTime";
import { assert, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import * as ServerConfig from "./config.ts";
import { staticAndDevRouteLayer } from "./http.ts";
import { httpCompressionLayer } from "./http.ts";

const buildAppUnderTest = ({ config }: { config: { staticDir: string } }) =>
  HttpRouter.serve(staticAndDevRouteLayer.pipe(Layer.provide(httpCompressionLayer)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(Effect.map((base) => ({ ...base, ...config }))),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-static-test-" }))),
    ),
    Layer.build,
  );

it.layer(NodeServices.layer)("static router seam", (it) => {
  it.effect("revalidates static files without sending unchanged bodies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-cache-" });
      const assetPath = path.join(staticDir, "app.js");
      yield* fileSystem.writeFileString(assetPath, 'export const build = "first";');
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/app.js");
      assert.equal(initial.status, 200);
      assert.equal(initial.headers["cache-control"], "no-cache");
      assert.include(yield* initial.text, "first");
      const etag = initial.headers.etag;
      assert.isDefined(etag);
      assert.isDefined(initial.headers["last-modified"]);

      for (const headers of [
        { "if-none-match": etag! },
        { "if-none-match": `"older", ${etag!.replace(/^W\//, "")}` },
        { "if-none-match": "*" },
        { "if-modified-since": initial.headers["last-modified"]! },
      ]) {
        const response = yield* HttpClient.get("/app.js", { headers });
        assert.equal(response.status, 304);
        assert.equal(response.headers.etag, etag);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(yield* response.text, "");
      }

      const mismatched = yield* HttpClient.get("/app.js", {
        headers: {
          "if-none-match": '"another-build"',
          "if-modified-since": initial.headers["last-modified"]!,
        },
      });
      assert.equal(mismatched.status, 200);
      assert.include(yield* mismatched.text, "first");

      yield* fileSystem.writeFileString(assetPath, 'export const build = "the next build";');
      const changed = yield* HttpClient.get("/app.js", { headers: { "if-none-match": etag! } });
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers.etag, etag);
      assert.include(yield* changed.text, "next build");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves changed HTML with the same size and timestamp", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-html-" });
      const indexPath = path.join(staticDir, "index.html");
      const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      yield* fileSystem.writeFileString(indexPath, "<html>old build</html>");
      yield* fileSystem.utimes(indexPath, modifiedAt, modifiedAt);
      yield* buildAppUnderTest({ config: { staticDir } });

      const initial = yield* HttpClient.get("/");
      assert.equal(yield* initial.text, "<html>old build</html>");
      const previousEtag = initial.headers.etag ?? '"previous-html"';
      const nextHtml = "<html>new build</html>";
      yield* fileSystem.writeFileString(indexPath, nextHtml);
      yield* fileSystem.utimes(indexPath, modifiedAt, modifiedAt);

      for (const [resource, headers] of [
        ["/", { "if-none-match": previousEtag }],
        ["/threads/example", { "if-modified-since": modifiedAt.toUTCString() }],
        ["/", { "if-none-match": "*" }],
      ] as const) {
        const response = yield* HttpClient.get(resource, { headers });
        assert.equal(response.status, 200);
        assert.equal(yield* response.text, nextHtml);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.isUndefined(response.headers.etag);
        assert.isUndefined(response.headers["last-modified"]);
      }

      const head = yield* HttpClient.head("/", {
        headers: { "if-none-match": previousEtag, "accept-encoding": "identity" },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-length"], String(Buffer.byteLength(nextHtml)));
      assert.equal(yield* head.text, "");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("caches hashed static assets without freezing mutable files or SPA fallbacks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-hashes-" });
      yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
      yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
      yield* fileSystem.writeFileString(
        path.join(staticDir, ".vite", "manifest.json"),
        `{
          "index.html": { "file": "assets/index-AbCd0123.js", "isEntry": true },
          "large.js": { "file": "assets/large-aBcD9876.js" }
        }`,
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "index.html"), "<html>app</html>");
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "index-AbCd0123.js"),
        "export const app = true;",
      );
      yield* fileSystem.writeFileString(path.join(staticDir, "assets", "config.json"), "{}");
      const largeAsset = "export const value = 123;\n".repeat(8192);
      yield* fileSystem.writeFileString(
        path.join(staticDir, "assets", "large-aBcD9876.js"),
        largeAsset,
      );
      yield* buildAppUnderTest({ config: { staticDir } });

      const asset = yield* HttpClient.get("/assets/index-AbCd0123.js");
      assert.equal(asset.status, 200);
      assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
      assert.equal(yield* asset.text, "export const app = true;");

      const head = yield* HttpClient.head("/assets/index-AbCd0123.js", {
        headers: { "accept-encoding": "identity" },
      });
      assert.equal(head.status, 200);
      assert.equal(head.headers.etag, asset.headers.etag);
      assert.equal(head.headers["content-length"], String("export const app = true;".length));
      assert.equal(yield* head.text, "");

      const compressed = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressed.headers["content-encoding"], "gzip");
      assert.equal(compressed.headers.vary, "Accept-Encoding");
      assert.equal(yield* compressed.text, largeAsset);
      const compressedHead = yield* HttpClient.head("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(compressedHead.status, 200);
      assert.equal(compressedHead.headers["content-encoding"], "gzip");
      assert.equal(compressedHead.headers.vary, "Accept-Encoding");
      assert.equal(compressedHead.headers.etag, compressed.headers.etag);
      assert.equal(compressedHead.headers["content-length"], compressed.headers["content-length"]);
      assert.equal(yield* compressedHead.text, "");
      const unchanged = yield* HttpClient.get("/assets/large-aBcD9876.js", {
        headers: { "accept-encoding": "identity", "if-none-match": compressed.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.vary, "Accept-Encoding");
      assert.equal(yield* unchanged.text, "");

      for (const resource of [
        "/assets/config.json",
        "/threads/example",
        "/assets/old-ZyXw9876.js",
      ]) {
        const response = yield* HttpClient.get(resource);
        assert.equal(response.status, 200);
        assert.equal(response.headers["cache-control"], "no-cache");
        assert.equal(
          yield* response.text,
          resource.endsWith("config.json") ? "{}" : "<html>app</html>",
        );
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const manifest of [
    { label: "missing", contents: null },
    { label: "nonmatching", contents: '{"other.js":{"file":"assets/other-AbCd0123.js"}}' },
    { label: "malformed", contents: "{not-json" },
  ]) {
    it.effect(`revalidates hash-like static filenames with a ${manifest.label} manifest`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const staticDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-static-mutable-",
        });
        yield* fileSystem.makeDirectory(path.join(staticDir, "assets"));
        if (manifest.contents !== null) {
          yield* fileSystem.makeDirectory(path.join(staticDir, ".vite"));
          yield* fileSystem.writeFileString(
            path.join(staticDir, ".vite", "manifest.json"),
            manifest.contents,
          );
        }
        const filePath = path.join(staticDir, "assets", "config-20260904.js");
        yield* fileSystem.writeFileString(filePath, "first config");
        yield* buildAppUnderTest({ config: { staticDir } });

        const initial = yield* HttpClient.get("/assets/config-20260904.js");
        assert.equal(initial.headers["cache-control"], "no-cache");
        assert.equal(yield* initial.text, "first config");

        yield* fileSystem.writeFileString(filePath, "replacement config");
        const changed = yield* HttpClient.get("/assets/config-20260904.js", {
          headers: { "if-none-match": initial.headers.etag! },
        });
        assert.equal(changed.status, 200);
        assert.equal(changed.headers["cache-control"], "no-cache");
        assert.notEqual(changed.headers.etag, initial.headers.etag);
        assert.equal(yield* changed.text, "replacement config");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("binds static metadata and bytes to one file across atomic replacement", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-replace-" });
      const beforeOpenPath = path.join(staticDir, "before-open.txt");
      const afterOpenPath = path.join(staticDir, "after-open.txt");
      const original = "original bytes";
      const replacement = "replacement bytes with a different size";
      for (const filePath of [beforeOpenPath, afterOpenPath]) {
        yield* fileSystem.writeFileString(filePath, original);
        yield* fileSystem.writeFileString(`${filePath}.next`, replacement);
      }
      const replaced = new Set<string>();
      const replaceOnce = Effect.fnUntraced(function* (filePath: string) {
        if (replaced.has(filePath)) return;
        replaced.add(filePath);
        yield* fileSystem.rename(`${filePath}.next`, filePath);
      });
      const replacingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        stat: (filePath) =>
          fileSystem
            .stat(filePath)
            .pipe(
              Effect.tap(() => (filePath === beforeOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
        open: (filePath, options) =>
          fileSystem
            .open(filePath, options)
            .pipe(
              Effect.tap(() => (filePath === afterOpenPath ? replaceOnce(filePath) : Effect.void)),
            ),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, replacingFileSystem),
      );

      for (const [name, expected] of [
        ["before-open.txt", replacement],
        ["after-open.txt", original],
      ] as const) {
        const response = yield* HttpClient.get(`/${name}`, {
          headers: { "accept-encoding": "identity" },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers["content-length"], String(expected.length));
        assert.isTrue(response.headers.etag?.startsWith(`W/"${expected.length.toString(16)}-`));
        assert.equal(yield* response.text, expected);
        assert.isTrue(replaced.has(path.join(staticDir, name)));
        assert.equal(yield* fileSystem.readFileString(path.join(staticDir, name)), replacement);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes static file handles after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "file content\n".repeat(1024);
      yield* fileSystem.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fileSystem.open(candidate, options);
            let opened: FileSystem.File | undefined;
            // Registered first, so this signal runs after the real descriptor-close finalizer.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fileSystem.open(candidate, options);
            opened = file;
            active.add(file);
            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* Effect.never;
            }
            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: FileSystem.SizeInput) => {
                    bodyReads += 1;
                    return target.readAlloc(size);
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      yield* buildAppUnderTest({ config: { staticDir } }).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* HttpClient.get("/app.txt");
      assert.equal(yield* get.text, body);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.isAbove(bodyReads, 0);
      const readsAfterGet = bodyReads;

      const head = yield* HttpClient.head("/app.txt", { headers: { "accept-encoding": "gzip" } });
      assert.equal(head.status, 200);
      assert.equal(head.headers["content-encoding"], "gzip");
      assert.equal(yield* head.text, "");
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      const unchanged = yield* HttpClient.get("/app.txt", {
        headers: { "if-none-match": get.headers.etag! },
      });
      assert.equal(unchanged.status, 304);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
      assert.equal(bodyReads, readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* HttpClient.get("/app.txt").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      assert.equal(active.size, 1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      assert.equal(active.size, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
