import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

export interface QueueSendOptions {
  /** FIFO ordering key; required for FIFO queues with message-group semantics. */
  messageGroupId?: string;
}

/**
 * A message queue typed over the owning domain's payload. Vocabulary-free:
 * the domain injects its own encode/decode bindings.
 */
export interface Queue<Payload> {
  send(message: Payload, options?: QueueSendOptions): Promise<void>;
}

export function createSqsQueue<Payload>(options: {
  client: SQSClient;
  queueUrl: string;
  encode: (message: Payload) => string;
}): Queue<Payload> {
  return {
    async send(message, sendOptions) {
      await options.client.send(
        new SendMessageCommand({
          QueueUrl: options.queueUrl,
          MessageBody: options.encode(message),
          ...(sendOptions?.messageGroupId === undefined
            ? {}
            : { MessageGroupId: sendOptions.messageGroupId }),
        }),
      );
    },
  };
}
