import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";

const DEFAULT_PROFILE_ID = "default";

const sqsClient = new SQSClient({});

const parentReferenceSchema = z.object({
  driveId: z.string().min(1),
  path: z.string().min(1),
});

const notificationSchema = z.object({
  subscriptionId: z.string().min(1),
  clientState: z.string().min(1),
  changeType: z.string().min(1),
  resource: z.string().min(1),
  resourceData: z.object({
    id: z.string().min(1),
    "@odata.type": z.string().min(1),
    name: z.string().min(1).optional(),
    webUrl: z.url().optional(),
    parentReference: parentReferenceSchema.optional(),
  }),
});

export const notificationPayloadSchema = z.object({
  value: z.array(notificationSchema).min(1),
});

const ingestQueueMessageSchema = z.object({
  fileId: z.string().min(1),
  profileId: z.string().min(1),
  itemMetadata: z.object({
    id: z.string().min(1),
    odataType: z.string().min(1),
    name: z.string().min(1).optional(),
    webUrl: z.url().optional(),
    resource: z.string().min(1),
    parentReference: parentReferenceSchema.optional(),
  }),
});

export type IngestQueueMessage = z.infer<typeof ingestQueueMessageSchema>;

type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
type Notification = NotificationPayload["value"][number];

function jsonResponse(
  statusCode: number,
  body: { [key: string]: string },
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function parseNotificationPayload(body: string | undefined): NotificationPayload | null {
  try {
    const parsedBody: unknown = JSON.parse(body ?? "");
    const payload = notificationPayloadSchema.safeParse(parsedBody);
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}

function normalizeClientState(clientState: string): string | null {
  const normalizedClientState = clientState.trim();
  return normalizedClientState.length > 0 ? normalizedClientState : null;
}

const pendingNotificationWork = new Set<Promise<void>>();

function notificationsHaveClientState(notifications: Notification[]): boolean {
  return notifications.every(
    (notification) => normalizeClientState(notification.clientState) !== null,
  );
}

async function enqueueNotificationJobs(notifications: Notification[]): Promise<void> {
  const queueUrl = process.env["INGEST_QUEUE_URL"];
  if (!queueUrl) {
    throw new Error("INGEST_QUEUE_URL env var not set");
  }

  await Promise.all(
    notifications.map(async (notification) => {
      const message = ingestQueueMessageSchema.parse({
        fileId: notification.resourceData.id,
        profileId: DEFAULT_PROFILE_ID,
        itemMetadata: {
          id: notification.resourceData.id,
          odataType: notification.resourceData["@odata.type"],
          name: notification.resourceData.name,
          webUrl: notification.resourceData.webUrl,
          resource: notification.resource,
          parentReference: notification.resourceData.parentReference,
        },
      });

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message),
        }),
      );
    }),
  );
}

async function processNotifications(notifications: Notification[]): Promise<void> {
  if (!notificationsHaveClientState(notifications)) {
    return;
  }

  await enqueueNotificationJobs(notifications);
}

function scheduleNotificationProcessing(notifications: Notification[]): void {
  const backgroundWork = processNotifications(notifications)
    .catch((error: unknown) => {
      console.error("Failed to process OneDrive notifications", error);
    })
    .finally(() => {
      pendingNotificationWork.delete(backgroundWork);
    });

  pendingNotificationWork.add(backgroundWork);
}

export async function flushPendingNotificationWork(): Promise<void> {
  while (pendingNotificationWork.size > 0) {
    await Promise.allSettled([...pendingNotificationWork]);
  }
}

export const handler = (
  event: Pick<APIGatewayProxyEventV2, "body" | "queryStringParameters" | "requestContext">,
): Promise<APIGatewayProxyResultV2> => {
  const validationToken = event.queryStringParameters?.["validationToken"];
  const method = event.requestContext.http.method;

  if (typeof validationToken === "string") {
    return Promise.resolve({
      statusCode: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: validationToken,
    });
  }

  if (method === "POST") {
    const payload = parseNotificationPayload(event.body);
    if (!payload) {
      return Promise.resolve(jsonResponse(400, { error: "Invalid notification payload" }));
    }

    if (!notificationsHaveClientState(payload.value)) {
      return Promise.resolve(jsonResponse(401, { error: "Invalid clientState" }));
    }

    scheduleNotificationProcessing(payload.value);

    return Promise.resolve({
      statusCode: 200,
      body: "",
    });
  }

  return Promise.resolve({
    statusCode: 404,
    body: "",
  });
};

export { ingestQueueMessageSchema };
