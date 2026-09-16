import type { NotificationResponse } from "expo-notifications";
import * as Schema from "effect/Schema";

export class NotificationNavigationError extends Schema.TaggedErrorClass<NotificationNavigationError>()(
  "NotificationNavigationError",
  {
    operation: Schema.Literals(["read", "route", "clear"]),
    notificationId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the last notification response.`;
  }
}

function notificationIdentifier(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null) return undefined;
  const notification = (response as { notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) return undefined;
  const request = (notification as { request?: unknown }).request;
  if (typeof request !== "object" || request === null) return undefined;
  const identifier = (request as { identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : undefined;
}

export async function consumeLastAgentNotificationResponse(input: {
  readonly getLastResponse: () => Promise<NotificationResponse | null>;
  readonly clearLastResponse: () => Promise<void>;
  readonly handleResponse: (response: NotificationResponse) => void;
}): Promise<void> {
  let response: NotificationResponse | null;
  try {
    response = await input.getLastResponse();
  } catch (cause) {
    console.error(new NotificationNavigationError({ operation: "read", cause }));
    return;
  }

  if (!response) {
    return;
  }

  try {
    input.handleResponse(response);
  } catch (cause) {
    console.error(
      new NotificationNavigationError({
        operation: "route",
        notificationId: notificationIdentifier(response),
        cause,
      }),
    );
    return;
  }

  try {
    await input.clearLastResponse();
  } catch (cause) {
    console.error(
      new NotificationNavigationError({
        operation: "clear",
        notificationId: notificationIdentifier(response),
        cause,
      }),
    );
  }
}
