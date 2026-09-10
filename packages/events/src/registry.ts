import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cloudEventSchema, formatCloudEvent, type CloudEvent } from "./cloud-event.js";

export interface RegisteredEventInput<Data> {
  source: string;
  data: Data;
  /** Reuse an id to re-emit the same logical event (the dedupe anchor with source). */
  id?: string;
  subject?: string;
  time?: string;
}

/**
 * A centrally registered business event. Registration binds the vocabulary
 * (type + dataschema) into the CE machinery, so producers and consumers share
 * one parse surface and one JSON Schema artifact per event.
 */
export interface RegisteredEvent<Data> {
  type: string;
  dataschema: string;
  buildDocument(input: RegisteredEventInput<Data>): CloudEvent<Data>;
  parse(document: unknown): CloudEvent<Data>;
  format(event: CloudEvent<Data>): string;
  jsonSchema(): { [key: string]: unknown };
}

export function registerEvent<Data>(options: {
  type: string;
  dataschema: string;
  dataSchema: z.ZodType<Data>;
}): RegisteredEvent<Data> {
  const envelopeSchema = cloudEventSchema(options.dataSchema).extend({
    type: z.literal(options.type),
    dataschema: z.literal(options.dataschema),
  });

  return {
    type: options.type,
    dataschema: options.dataschema,

    buildDocument(input) {
      return envelopeSchema.parse({
        specversion: "1.0",
        id: input.id ?? randomUUID(),
        source: input.source,
        type: options.type,
        dataschema: options.dataschema,
        time: input.time ?? new Date().toISOString(),
        subject: input.subject,
        data: input.data,
      }) as CloudEvent<Data>;
    },

    parse(document) {
      return envelopeSchema.parse(document) as CloudEvent<Data>;
    },

    format(event) {
      return formatCloudEvent(event);
    },

    jsonSchema() {
      return options.dataSchema.toJSONSchema() as { [key: string]: unknown };
    },
  };
}
