import { SSMClient } from "@aws-sdk/client-ssm";

let cachedSsmClient: SSMClient | undefined;

/**
 * The SSM client, built on first use. Building it at module scope would make
 * importing this module an effect (petroglyph-1o2d).
 */
export function ssmClient(): SSMClient {
  cachedSsmClient ??= new SSMClient({});
  return cachedSsmClient;
}
