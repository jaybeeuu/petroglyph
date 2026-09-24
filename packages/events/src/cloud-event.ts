import { z } from "zod";

const rfc3339UtcSchema = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    "time must be an RFC3339 UTC timestamp (e.g. 2026-09-03T12:00:00Z)",
  );

export const cloudEventContextSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  time: rfc3339UtcSchema,
  datacontenttype: z.literal("application/json").default("application/json"),
  dataschema: z.url(),
  subject: z.string().min(1).optional(),
});

export type CloudEventContext = z.infer<typeof cloudEventContextSchema>;

export type CloudEvent<Data> = CloudEventContext & { data: Data };

export type CloudEventEnvelopeSchema = z.ZodObject<z.ZodRawShape>;

/** Binds a payload schema to the CE context — used by the registry to type events. */
export function cloudEventSchema<Data>(dataSchema: z.ZodType<Data>): CloudEventEnvelopeSchema {
  return cloudEventContextSchema.extend({ data: dataSchema }) as CloudEventEnvelopeSchema;
}

export function parseCloudEvent<Data = unknown>(
  document: unknown,
  envelopeSchema: z.ZodType = cloudEventSchema(z.unknown()),
): CloudEvent<Data> {
  return envelopeSchema.parse(document) as CloudEvent<Data>;
}

/** JSON-format serialization of a structured-mode CE document. */
export function formatCloudEvent<Data>(event: CloudEvent<Data>): string {
  return JSON.stringify(event);
}
