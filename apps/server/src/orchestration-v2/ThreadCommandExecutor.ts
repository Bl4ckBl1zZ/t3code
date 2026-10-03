import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { makeKeyedSerialExecutor, type KeyedSerialExecutor } from "./KeyedSerialExecutor.ts";

/**
 * The per-thread lock thread commands run under. Anything else that rewrites
 * a whole thread row (provider event ingestion moving a subagent's thread to
 * its reported model) takes it too, so both plan against current thread state.
 */
export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedSerialExecutor<ThreadId>
>()("t3/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, makeKeyedSerialExecutor<ThreadId>());
