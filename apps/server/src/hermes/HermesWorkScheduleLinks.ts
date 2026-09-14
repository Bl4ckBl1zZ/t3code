import { Schema } from "effect";

const isCreateReceipt = Schema.is(
  Schema.Struct({
    type: Schema.Literal("dynamic_tool"),
    status: Schema.Literal("completed"),
    nativeItemRef: Schema.Struct({ driver: Schema.Literal("hermes") }),
    toolName: Schema.Literal("cronjob"),
    input: Schema.Struct({ action: Schema.Literal("create") }),
    output: Schema.Struct({ success: Schema.Literal(true), job_id: Schema.String }),
  }),
);

/** Only successful native create receipts establish ownership; prose and list results do not. */
export function hermesCreatedScheduleIds(items: ReadonlyArray<unknown>): string[] {
  return [
    ...new Set(
      items.flatMap((item) =>
        isCreateReceipt(item) && item.output.job_id.trim() ? [item.output.job_id] : [],
      ),
    ),
  ];
}
