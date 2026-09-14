// @effect-diagnostics globalDate:off globalTimers:off - Transport tests use short deterministic waits.
import { describe, expect, it } from "vite-plus/test";

import {
  HermesGatewayCapabilityError,
  HermesGatewayClient,
  HermesGatewayConnectionError,
  HermesGatewayMutationIndeterminateError,
  HermesGatewayMutationsBlockedError,
  classifyHermesGatewayReady,
  type HermesGatewayLogEvent,
  type HermesGatewaySocket,
  type HermesGatewaySocketEvent,
} from "./HermesGatewayClient.ts";

class FakeSocket implements HermesGatewaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onSend?: (data: string) => void;
  readonly closeCalls: Array<{ readonly code: number; readonly reason?: string }> = [];
  readonly endpoint: string;
  private readonly listeners = new Map<
    "open" | "message" | "close" | "error",
    Array<{ readonly listener: (event: HermesGatewaySocketEvent) => void; readonly once: boolean }>
  >();

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code = 1000, reason?: string): void {
    this.closeCalls.push({ code, ...(reason === undefined ? {} : { reason }) });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code });
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: HermesGatewaySocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options?.once === true });
    this.listeners.set(type, entries);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  fail(): void {
    this.emit("error", {});
  }

  emit(type: "open" | "message" | "close" | "error", event: HermesGatewaySocketEvent): void {
    const entries = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(
      type,
      entries.filter((entry) => !entry.once),
    );
    for (const entry of entries) entry.listener(event);
  }
}

class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  onCreate?: (socket: FakeSocket) => void;

  readonly create = (endpoint: string): FakeSocket => {
    const socket = new FakeSocket(endpoint);
    this.sockets.push(socket);
    this.onCreate?.(socket);
    return socket;
  };
}

const nativeReady = {
  jsonrpc: "2.0",
  method: "event",
  params: {
    type: "gateway.ready",
    payload: { skin: {}, change_events: true, heartbeat: true, replay_epoch: "epoch-1" },
  },
} as const;
const fullyNegotiatedReady = nativeReady;
const legacyReady = nativeReady;
function success(id: string, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function sentFrames(socket: FakeSocket): Array<{
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}> {
  return socket.sent.map((frame) => JSON.parse(frame));
}

async function openClient(
  factory: FakeSocketFactory,
  options: Partial<ConstructorParameters<typeof HermesGatewayClient>[0]> = {},
  readyFrame: unknown = nativeReady,
) {
  const client = new HermesGatewayClient({
    endpoint: "ws://localhost:9119/api/ws",
    authToken: "private-token",
    socketFactory: factory.create,
    reconnect: { maxAttempts: 0 },
    ...options,
  });
  const connecting = client.connect();
  await Promise.resolve();
  await Promise.resolve();
  const socket = factory.sockets.at(-1)!;
  socket.open();
  socket.receive(readyFrame);
  await connecting;
  return { client, socket };
}

describe("Native Hermes Serve transport", () => {
  it("reads and writes a title on a gateway that omits the revision metadata", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const reading = client.readSessionTitle({ session_id: "live-1" });
    let frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("session.title");
    socket.receive(success(frame.id, { title: "Untitled", session_key: "stored-1" }));
    await expect(reading).resolves.toEqual({ title: "Untitled", session_key: "stored-1" });

    const writing = client.updateSessionTitle(
      { session_id: "live-1", title: "Named", origin: "client:t3-code" },
      { operationId: "title-write" },
    );
    frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { pending: false, title: "Named" }));
    await expect(writing).resolves.toEqual({ pending: false, title: "Named" });
    client.close();
  });

  it("uses the pinned cron.manage list/add/remove wire protocol", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const listing = client.listCronJobs();
    let frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({ method: "cron.manage", params: { action: "list" } });
    socket.receive(success(frame.id, { success: true, jobs: [] }));
    await expect(listing).resolves.toEqual({ success: true, jobs: [] });

    const adding = client.manageCron(
      { action: "add", name: "job", schedule: "0 0 * * *", prompt: "check" },
      { operationId: "cron-add-1" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "cron.manage",
      params: { action: "add", name: "job", schedule: "0 0 * * *", prompt: "check" },
    });
    socket.receive(success(frame.id, { success: true, job_id: "job-1" }));
    await expect(adding).resolves.toEqual({ success: true, job_id: "job-1" });
    client.close();
  });

  it("correlates out-of-order responses while serializing events in wire order", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const observed: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    client.onEvent(async (event) => {
      observed.push(`start:${event.sessionSequence}:${event.frame.params.type}`);
      if (event.frame.params.type === "message.delta") await firstMayFinish;
      observed.push(`end:${event.sessionSequence}:${event.frame.params.type}`);
    });

    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.delta",
        session_id: "session-1",
        payload: { text: "first" },
      },
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: {
        type: "message.complete",
        session_id: "session-1",
        payload: { text: "second" },
      },
    });
    await eventually(() => observed.length === 1);
    expect(observed).toEqual(["start:1:message.delta"]);
    releaseFirst();
    await eventually(() => observed.length === 4);
    expect(observed).toEqual([
      "start:1:message.delta",
      "end:1:message.delta",
      "start:2:message.complete",
      "end:2:message.complete",
    ]);

    const sessions = client.read("session.list", {});
    const history = client.read("session.history", { session_id: "session-1" });
    const frames = sentFrames(socket);
    socket.receive(success(frames[1]!.id, { count: 3 }));
    socket.receive(success(frames[0]!.id, { sessions: [] }));
    await expect(history).resolves.toEqual({ count: 3 });
    await expect(sessions).resolves.toEqual({ sessions: [] });
    client.close();
  });

  it("degrades a missing optional RPC independently", async () => {
    const logs: HermesGatewayLogEvent[] = [];
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      logger: (event) => logs.push(event),
    });
    const commands = client.read("commands.catalog", {});
    const frame = sentFrames(socket)[0]!;
    socket.receive({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "PRIVATE METHOD ERROR" },
    });
    await expect(commands).rejects.toMatchObject({ code: -32601 });
    expect(client.hasCapability("commands.catalog")).toBe(false);
    expect(client.hasCapability("session.history")).toBe(true);
    await expect(client.read("commands.catalog", {})).rejects.toBeInstanceOf(
      HermesGatewayCapabilityError,
    );
    expect(JSON.stringify(logs)).not.toContain("PRIVATE METHOD ERROR");
    client.close();
  });

  it("degrades cron.read when the cron list read is unimplemented", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const listing = client.listCronJobs();
    const frame = sentFrames(socket).at(-1)!;
    socket.receive({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32601, message: "method not found" },
    });
    await expect(listing).rejects.toMatchObject({ code: -32601 });
    expect(client.hasCapability("cron.read")).toBe(false);
    expect(client.hasCapability("cron.manage")).toBe(true);
    await expect(client.listCronJobs()).rejects.toBeInstanceOf(HermesGatewayCapabilityError);
    client.close();
  });

  it("dispatches events to remaining listeners when one listener fails", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const observed: string[] = [];
    client.onEvent(() => {
      throw new Error("listener failure");
    });
    client.onEvent(async () => {
      await Promise.reject(new Error("async listener failure"));
    });
    client.onEvent((event) => {
      observed.push(`${event.sessionSequence}:${event.frame.params.type}`);
    });

    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "session-1", payload: { text: "one" } },
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.complete", session_id: "session-1", payload: { text: "two" } },
    });
    await eventually(() => observed.length === 2);
    expect(observed).toEqual(["1:message.delta", "2:message.complete"]);
    client.close();
  });

  it("exposes typed H4 session and prompt helpers", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const createdPromise = client.createSession(
      { source: "t3-work", close_on_disconnect: false },
      { operationId: "create-operation" },
    );
    let frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        session_id: "live-1",
        stored_session_id: "durable-1",
        message_count: 0,
        messages: [],
        info: { model: "test-model", lazy: true },
      }),
    );
    await expect(createdPromise).resolves.toMatchObject({
      session_id: "live-1",
      stored_session_id: "durable-1",
    });

    const resumedPromise = client.resumeSession(
      { session_id: "durable-1", close_on_disconnect: false },
      { operationId: "resume-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        session_id: "live-2",
        resumed: "durable-1",
        message_count: 1,
        messages: [{ message_id: "message-restored", role: "assistant", text: "restored" }],
        info: {
          model: "test-model",
          title_revision: 3,
          title_origin: "agent",
        },
        running: false,
        session_key: "durable-1",
        started_at: 1,
        status: "idle",
      }),
    );
    await expect(resumedPromise).resolves.toMatchObject({
      session_id: "live-2",
      session_key: "durable-1",
      messages: [{ message_id: "message-restored" }],
      info: { title_revision: 3, title_origin: "agent" },
    });

    const statusPromise = client.readSessionStatus({ session_id: "live-2" });
    frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { output: "sanitized status" }));
    await expect(statusPromise).resolves.toEqual({ output: "sanitized status" });

    const historyPromise = client.readSessionHistory({ session_id: "live-2" });
    frame = sentFrames(socket).at(-1)!;
    socket.receive(
      success(frame.id, {
        count: 1,
        messages: [{ role: "assistant", text: "restored" }],
      }),
    );
    await expect(historyPromise).resolves.toMatchObject({ count: 1 });

    const imagePromise = client.attachImageBytes(
      {
        session_id: "live-2",
        content_base64: "iVBORw==",
        filename: "image.png",
      },
      { operationId: "image-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "image.attach_bytes",
      params: {
        session_id: "live-2",
        content_base64: "iVBORw==",
        filename: "image.png",
      },
    });
    socket.receive(success(frame.id, { attached: true, count: 1 }));
    await expect(imagePromise).resolves.toEqual({ attached: true, count: 1 });

    const filePromise = client.attachFile(
      { session_id: "live-2", name: "notes.txt", data_url: "data:text/plain;base64,YQ==" },
      { operationId: "file-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "file.attach",
      params: {
        session_id: "live-2",
        name: "notes.txt",
        data_url: "data:text/plain;base64,YQ==",
      },
    });
    socket.receive(success(frame.id, { attached: true }));
    await expect(filePromise).resolves.toEqual({ attached: true });

    const pdfPromise = client.attachPdf(
      { session_id: "live-2", filename: "report.pdf", content_base64: "JVBERg==" },
      { operationId: "pdf-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame).toMatchObject({
      method: "pdf.attach",
      params: {
        session_id: "live-2",
        filename: "report.pdf",
        content_base64: "JVBERg==",
      },
    });
    socket.receive(success(frame.id, { attached: true }));
    await expect(pdfPromise).resolves.toEqual({ attached: true });

    const promptPromise = client.submitPrompt(
      { session_id: "live-2", text: "private" },
      { operationId: "prompt-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("prompt.submit");
    socket.receive(
      success(frame.id, {
        status: "streaming",
        run_id: "run-1",
        user_message_id: "message-user",
        assistant_message_id: "message-assistant",
        mutation_id: "mutation-1",
        replayed: false,
        mutation_status: "admitted",
      }),
    );
    await expect(promptPromise).resolves.toEqual({
      status: "streaming",
      run_id: "run-1",
      user_message_id: "message-user",
      assistant_message_id: "message-assistant",
      mutation_id: "mutation-1",
      replayed: false,
      mutation_status: "admitted",
    });

    const interruptPromise = client.interruptSession(
      { session_id: "live-2" },
      { operationId: "interrupt-operation" },
    );
    frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("session.interrupt");
    socket.receive(success(frame.id, { status: "interrupted" }));
    await expect(interruptPromise).resolves.toEqual({ status: "interrupted" });
    client.close();
  });

  it("decodes profile-scoped durable session discovery", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);

    const listed = client.listSessions({ profile: "work", limit: 20 });
    const request = sentFrames(socket).at(-1)!;
    expect(request).toMatchObject({
      method: "session.list",
      params: { profile: "work", limit: 20 },
    });
    socket.receive(
      success(request.id, {
        sessions: [
          {
            id: "stored-1",
            title: "Imported",
            preview: "hello",
            started_at: 123,
            message_count: 2,
            source: "tui",
          },
        ],
      }),
    );

    await expect(listed).resolves.toEqual({
      sessions: [
        {
          id: "stored-1",
          title: "Imported",
          preview: "hello",
          started_at: 123,
          message_count: 2,
          source: "tui",
        },
      ],
    });
    client.close();
  });

  it("coalesces concurrent initial connects onto one socket", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });

    const first = client.connect();
    const second = client.connect();
    await Promise.resolve();
    expect(factory.sockets).toHaveLength(1);
    factory.sockets[0]!.open();
    await Promise.resolve();
    factory.sockets[0]!.receive(legacyReady);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(factory.sockets).toHaveLength(1);
    client.close();
  });

  it("transitions to disconnected when the socket factory throws", async () => {
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: () => {
        throw new Error("socket construction refused");
      },
      reconnect: { maxAttempts: 0 },
    });
    await expect(client.connect()).rejects.toThrow("socket construction refused");
    expect(client.health.state).toBe("disconnected");
    client.close();
  });

  it("rejects connect when the socket never emits open", async () => {
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: () => ({
        readyState: 0,
        addEventListener: () => {},
        send: () => {},
        close: () => {},
      }),
      reconnect: { maxAttempts: 0 },
      openTimeoutMs: 5,
    });

    await expect(client.connect()).rejects.toThrow("Timed out opening gateway connection.");
    expect(client.health.state).toBe("disconnected");
    client.close();
  });

  it("queues reconnect-time reads and permits a known-unsent mutation retry", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    socket.close(1006);

    const read = client.read("session.list", {});
    await expect(
      client.mutate(
        "prompt.submit",
        { session_id: "session-1", text: "private" },
        { operationId: "retry-after-reconnect" },
      ),
    ).rejects.toThrow("not ready");
    expect(client.mutationRecord("retry-after-reconnect")?.state).toBe("not_sent");

    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => replacement.sent.length === 1);
    const replayedRead = sentFrames(replacement)[0]!;
    expect(replayedRead.method).toBe("session.list");
    replacement.receive(success(replayedRead.id, { sessions: [] }));
    await expect(read).resolves.toEqual({ sessions: [] });

    const retried = client.mutate(
      "prompt.submit",
      { session_id: "session-1", text: "private" },
      { operationId: "retry-after-reconnect" },
    );
    const retriedFrame = sentFrames(replacement)[1]!;
    expect(retriedFrame.method).toBe("prompt.submit");
    replacement.receive(success(retriedFrame.id, { status: "streaming" }));
    await expect(retried).resolves.toEqual({ status: "streaming" });
    expect(client.mutationRecord("retry-after-reconnect")?.state).toBe("confirmed");
    client.close();
  });

  it("still reconnects when a health listener throws during disconnect", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const seen: string[] = [];
    client.onHealthChange((snapshot) => {
      if (snapshot.state !== "ready") throw new Error("listener failure");
    });
    client.onHealthChange((snapshot) => seen.push(snapshot.state));
    socket.close(1006);

    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => client.state === "ready");
    expect(seen).toContain("reconnecting");
    expect(seen).toContain("ready");
    client.close();
  });

  it("aborts a connect attempt when close() lands while onConnected is pending", async () => {
    const factory = new FakeSocketFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
      supervisor: { onConnected: () => gate },
    });
    const connecting = client.connect();
    await Promise.resolve();
    const socket = factory.sockets[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive(fullyNegotiatedReady);
    await eventually(() => client.state === "ready");
    client.close();
    release();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.state).toBe("closed");
  });

  it("rejects sent mutations as indeterminate when the client is closed", async () => {
    const factory = new FakeSocketFactory();
    const { client } = await openClient(factory, {}, nativeReady);
    const prompt = client.submitPrompt(
      { session_id: "session-1", text: "private" },
      { operationId: "prompt-closed-operation" },
    );
    const read = client.readSessionStatus({ session_id: "session-1" });
    client.close();
    await expect(prompt).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    await expect(read).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.mutationRecord("prompt-closed-operation")?.state).toBe("indeterminate");
  });

  it("does not resurrect a client closed while beforeConnect is pending", async () => {
    const factory = new FakeSocketFactory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
      supervisor: { beforeConnect: () => gate },
    });
    const connecting = client.connect();
    client.close();
    release();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(factory.sockets).toHaveLength(0);
    expect(client.state).toBe("closed");
  });

  it("rejects an in-flight connect() when close() is called mid-handshake", async () => {
    const factory = new FakeSocketFactory();
    const client = new HermesGatewayClient({
      endpoint: "ws://127.0.0.1:9119/api/ws",
      authToken: "private-token",
      socketFactory: factory.create,
      reconnect: { maxAttempts: 0 },
    });
    const connecting = client.connect();
    await Promise.resolve();
    expect(factory.sockets).toHaveLength(1);
    client.close();
    await expect(connecting).rejects.toBeInstanceOf(HermesGatewayConnectionError);
    expect(client.state).toBe("closed");
  });

  it("does not confirm an undecodable successful mutation response", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory);
    const created = client.createSession(
      { source: "t3-code" },
      { operationId: "malformed-create-operation" },
    );
    const frame = sentFrames(socket).at(-1)!;
    socket.receive(success(frame.id, { unexpected: true }));

    await expect(created).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    expect(client.mutationRecord("malformed-create-operation")?.state).toBe("indeterminate");
    expect(client.writesBlocked).toBe(true);
    client.close();
  });

  it("replays reads after bounded reconnect but never replays an indeterminate mutation", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const read = client.read("session.list", {});
    const mutation = client.mutate(
      "prompt.submit",
      { session_id: "session-1", text: "private" },
      { operationId: "prompt-operation" },
    );
    expect(sentFrames(socket).map((frame) => frame.method)).toEqual([
      "session.list",
      "prompt.submit",
    ]);

    socket.close(1006);
    await expect(mutation).rejects.toBeInstanceOf(HermesGatewayMutationIndeterminateError);
    expect(client.writesBlocked).toBe(true);
    await eventually(() => factory.sockets.length === 2);
    const replacement = factory.sockets[1]!;
    replacement.open();
    await Promise.resolve();
    replacement.receive(fullyNegotiatedReady);
    await eventually(() => replacement.sent.length === 1);
    const replayed = sentFrames(replacement);
    expect(replayed.map((frame) => frame.method)).toEqual(["session.list"]);
    replacement.receive(success(replayed[0]!.id, { sessions: [] }));
    await expect(read).resolves.toEqual({ sessions: [] });
    await expect(
      client.mutate(
        "prompt.submit",
        { session_id: "session-1", text: "must not send" },
        { operationId: "prompt-operation-2" },
      ),
    ).rejects.toBeInstanceOf(HermesGatewayMutationsBlockedError);
    expect(replacement.sent).toHaveLength(1);

    client.acknowledgeIndeterminate("prompt-operation");
    const interrupt = client.interrupt("session-1", { operationId: "interrupt-operation" });
    const interruptFrame = sentFrames(replacement)[1]!;
    expect(interruptFrame).toMatchObject({
      method: "session.interrupt",
      params: { session_id: "session-1" },
    });
    replacement.receive(success(interruptFrame.id, { status: "interrupted" }));
    await expect(interrupt).resolves.toEqual({ status: "interrupted" });
    client.close();
  });

  it("bounds reconnect attempts and exposes process supervision hooks", async () => {
    const factory = new FakeSocketFactory();
    const callbacks: string[] = [];
    let exhausted!: () => void;
    const exhaustedPromise = new Promise<void>((resolve) => {
      exhausted = resolve;
    });
    const { socket } = await openClient(factory, {
      reconnect: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      supervisor: {
        beforeConnect: ({ attempt, reconnect }) => {
          callbacks.push(`before:${attempt}:${reconnect}`);
        },
        onConnected: ({ attempt }) => {
          callbacks.push(`connected:${attempt}`);
        },
        onDisconnected: ({ reconnecting }) => {
          callbacks.push(`disconnected:${reconnecting}`);
          return Promise.reject(new Error("supervisor disconnect failure"));
        },
        onReconnectExhausted: ({ attempts }) => {
          callbacks.push(`exhausted:${attempts}`);
          exhausted();
          return Promise.reject(new Error("supervisor exhausted failure"));
        },
      },
      socketFactory: (endpoint) => {
        const candidate = factory.create(endpoint);
        if (factory.sockets.length > 1) {
          queueMicrotask(() => candidate.fail());
        }
        return candidate;
      },
    });
    socket.close(1006);
    await exhaustedPromise;

    expect(factory.sockets).toHaveLength(3);
    expect(callbacks).toEqual([
      "before:0:false",
      "connected:0",
      "disconnected:true",
      "before:1:true",
      "disconnected:true",
      "before:2:true",
      "disconnected:true",
      "exhausted:2",
    ]);
  });
});
async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("Hermes Serve native protocol", () => {
  it("accepts the upstream ready frame immediately after socket open without sending discovery probes", async () => {
    const { client, socket } = await openClient(new FakeSocketFactory());
    expect(client.compatibility?.status).toBe("supported");
    expect(socket.sent).toEqual([]);
    expect(client.hasCapability("events.approvals")).toBe(true);
    expect(client.hasCapability("session_mcp")).toBe(false);
    expect(client.hasCapability("mutation.stable_ids")).toBe(false);
    expect(await client.cronActionInventory()).toEqual(
      new Set(["list", "add", "pause", "resume", "remove"]),
    );
    expect(socket.sent).toEqual([]);
    client.close();
  });

  it("rejects fabricated negotiated and outdated ready frames with an upgrade explanation", () => {
    for (const payload of [
      {},
      { protocol: { major: 1, minor: 0, capabilities: ["session_mcp"] } },
    ]) {
      const result = classifyHermesGatewayReady({
        ...nativeReady,
        params: { type: "gateway.ready", payload },
      });
      expect(result.status).toBe("unsupported");
      expect(result.capabilities).toEqual([]);
      expect(result.reason).toContain("Update Hermes");
    }
  });

  it("decodes coalesced newline frames and preserves native replay sequences and global changes", async () => {
    const { client, socket } = await openClient(new FakeSocketFactory());
    const events: Array<{ eventSequence: number | undefined; type: string }> = [];
    let finish!: () => void;
    const received = new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.onEvent((event) => {
      events.push({ eventSequence: event.eventSequence, type: event.frame.params.type });
      if (events.length === 2) finish();
    });
    const first = {
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "s1", seq: 7, payload: { text: "hello" } },
    };
    const second = {
      jsonrpc: "2.0",
      method: "event",
      params: { type: "cron.changed", payload: {} },
    };
    socket.emit("message", { data: `${JSON.stringify(first)}\n${JSON.stringify(second)}\n` });
    await received;
    expect(events).toEqual([
      { eventSequence: 7, type: "message.delta" },
      { eventSequence: undefined, type: "cron.changed" },
    ]);
    client.close();
  });

  it("uses a fresh remote dashboard ticket without putting the session bearer in the websocket URL", async () => {
    const factory = new FakeSocketFactory();
    let ticketRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      ticketRequested = resolve;
    });
    let socketCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      socketCreated = resolve;
    });
    factory.onCreate = () => socketCreated();
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = new HermesGatewayClient({
      endpoint: "wss://hermes.example/api/ws",
      authToken: "session-secret",
      socketFactory: factory.create,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        ticketRequested();
        return Response.json({ ticket: "single-use-ticket", ttl_seconds: 30 });
      },
      reconnect: { maxAttempts: 0 },
    });
    const connecting = client.connect();
    await requested;
    await created;
    const socket = factory.sockets[0]!;
    expect(requests).toEqual([
      { url: "https://hermes.example/api/auth/ws-ticket", authorization: "Bearer session-secret" },
    ]);
    expect(socket.endpoint).toBe("wss://hermes.example/api/ws?ticket=single-use-ticket");
    socket.open();
    socket.receive(nativeReady);
    await connecting;
    client.close();
  });
});

describe("Hermes native event recovery", () => {
  it("reattaches before replay and emits each missed or concurrent event once", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 1, baseDelayMs: 1 },
    });
    const observed: number[] = [];
    let firstSeen!: () => void;
    const first = new Promise<void>((resolve) => {
      firstSeen = resolve;
    });
    let replaySeen!: () => void;
    const recovered = new Promise<void>((resolve) => {
      replaySeen = resolve;
    });
    client.onEvent((event) => {
      if (event.eventSequence === undefined) return;
      observed.push(event.eventSequence);
      if (observed.length === 1) firstSeen();
      if (observed.length === 3) replaySeen();
    });
    const params = (seq: number) => ({
      type: "message.delta",
      session_id: "s1",
      seq,
      payload: { text: String(seq) },
    });
    socket.receive({ jsonrpc: "2.0", method: "event", params: params(1) });
    await first;
    let reattached = false;
    client.onReconnected(async () => {
      await client.reconnectSession({ session_id: "stored-1" });
      reattached = true;
    });
    factory.onCreate = (next) => {
      next.onSend = (data) => {
        const frame = JSON.parse(data) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        if (frame.method === "session.resume") {
          expect(frame.params.lazy).toBe(true);
          queueMicrotask(() =>
            next.receive(
              success(frame.id, {
                session_id: "s1",
                resumed: "stored-1",
                session_key: "stored-1",
                message_count: 0,
                messages: [],
                info: {},
                running: true,
                started_at: 1,
                status: "streaming",
              }),
            ),
          );
        } else if (frame.method === "session.events.since") {
          expect(reattached).toBe(true);
          expect(frame.params).toEqual({ session_id: "s1", last_seen: 1 });
          queueMicrotask(() => {
            next.receive({ jsonrpc: "2.0", method: "event", params: params(3) });
            next.receive(
              success(frame.id, {
                events: [params(2), params(3)],
                latest_seq: 3,
                truncated: false,
                epoch: "epoch-1",
              }),
            );
          });
        }
      };
      queueMicrotask(() => {
        next.open();
        next.receive(nativeReady);
      });
    };
    socket.close();
    await recovered;
    expect(observed).toEqual([1, 2, 3]);
    client.close();
  });

  it("reports a replay gap instead of manufacturing missing progress", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(factory, {
      reconnect: { maxAttempts: 1, baseDelayMs: 1 },
    });
    let seen!: () => void;
    const initial = new Promise<void>((resolve) => {
      seen = resolve;
    });
    client.onEvent((event) => {
      if (event.eventSequence === 5) seen();
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "message.delta", session_id: "s1", seq: 5, payload: { text: "saved" } },
    });
    await initial;
    let gapSeen!: (value: unknown) => void;
    const gap = new Promise<unknown>((resolve) => {
      gapSeen = resolve;
    });
    client.onReplayGap(gapSeen);
    factory.onCreate = (next) => {
      next.onSend = (data) => {
        const frame = JSON.parse(data) as { id: string; method: string };
        if (frame.method === "session.events.since")
          queueMicrotask(() =>
            next.receive(
              success(frame.id, { events: [], latest_seq: 90, truncated: true, epoch: "epoch-1" }),
            ),
          );
      };
      queueMicrotask(() => {
        next.open();
        next.receive(nativeReady);
      });
    };
    socket.close();
    await expect(gap).resolves.toEqual({
      sessionId: "s1",
      lastSeen: 5,
      epoch: "epoch-1",
      reason: "truncated",
    });
    client.close();
  });
});

describe("Hermes unpersisted session recovery", () => {
  it("reattaches a never-prompted lazy session without inventing a timestamp or executing work", async () => {
    const { client, socket } = await openClient(new FakeSocketFactory());
    const result = client.reconnectSession({ session_id: "stored-fresh", profile: "personal" });
    const frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("session.resume");
    expect(frame.params).toEqual({ session_id: "stored-fresh", profile: "personal", lazy: true });
    socket.receive(
      success(frame.id, {
        session_id: "live-fresh",
        stored_session_id: "stored-fresh",
        message_count: 0,
        messages: [],
        info: { model: "hermes-model", lazy: true, profile_name: "personal" },
      }),
    );
    await expect(result).resolves.toEqual({
      session_id: "live-fresh",
      session_key: "stored-fresh",
      resumed: "stored-fresh",
      message_count: 0,
      messages: [],
      info: { model: "hermes-model", lazy: true, profile_name: "personal" },
      running: false,
      status: "idle",
    });
    expect(sentFrames(socket)).toHaveLength(1);
    client.close();
  });
});

describe("Hermes July native Serve", () => {
  const julyReady = {
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { skin: { name: "default" }, change_events: true } },
  } as const;

  it("accepts the observed July native ready frame without claiming replay support", async () => {
    const { client, socket } = await openClient(new FakeSocketFactory(), {}, julyReady);
    expect(client.compatibility?.status).toBe("supported");
    expect(client.compatibility?.reason).toContain("history reconciliation");
    expect(socket.sent).toEqual([]);
    client.close();
  });

  it("reattaches and asks the adapter to recover history when the server has no replay epoch", async () => {
    const factory = new FakeSocketFactory();
    const { client, socket } = await openClient(
      factory,
      { reconnect: { maxAttempts: 1, baseDelayMs: 1 } },
      julyReady,
    );
    let finish!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const requests: string[] = [];
    client.onReconnected(async ({ epochChanged }) => {
      expect(epochChanged).toBe(true);
      await client.reconnectSession({ session_id: "stored-1" });
      finish();
    });
    factory.onCreate = (next) => {
      next.onSend = (data) => {
        const frame = JSON.parse(data) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        };
        requests.push(frame.method);
        expect(frame.method).toBe("session.resume");
        expect(frame.params.lazy).toBe(true);
        queueMicrotask(() =>
          next.receive(
            success(frame.id, {
              session_id: "s1",
              stored_session_id: "stored-1",
              message_count: 0,
              messages: [],
              info: { lazy: true },
            }),
          ),
        );
      };
      queueMicrotask(() => {
        next.open();
        next.receive(julyReady);
      });
    };
    socket.close();
    await reconnected;
    expect(requests).toEqual(["session.resume"]);
    client.close();
  });
});

describe("Hermes native model control", () => {
  it("sends config.set with session scope and delivers preceding native events before resolving", async () => {
    const { client, socket } = await openClient(new FakeSocketFactory());
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen!: () => void;
    const delivered = new Promise<void>((resolve) => {
      seen = resolve;
    });
    client.onEvent(async (event) => {
      if (event.frame.params.type !== "session.info") return;
      seen();
      await hold;
    });
    const change = client.setSessionModel(
      { session_id: "s1", model: "z-ai/glm-5.3" },
      { operationId: "model-1" },
    );
    const frame = sentFrames(socket).at(-1)!;
    expect(frame.method).toBe("config.set");
    expect(frame.params).toEqual({
      session_id: "s1",
      key: "model",
      value: "z-ai/glm-5.3 --session",
    });
    socket.receive({
      jsonrpc: "2.0",
      method: "event",
      params: { type: "session.info", session_id: "s1", payload: { model: "z-ai/glm-5.3" } },
    });
    socket.receive(
      success(frame.id, {
        key: "model",
        value: "z-ai/glm-5.3",
        scope: "session",
        confirm_required: false,
      }),
    );
    let resolved = false;
    void change.then(() => {
      resolved = true;
    });
    await delivered;
    expect(resolved).toBe(false);
    release();
    await expect(change).resolves.toMatchObject({ value: "z-ai/glm-5.3", scope: "session" });
    client.close();
  });
});
