import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { ssmClient } from "./ssm.js";

export const SSM_MAPPINGS = [
  { pathEnv: "GITHUB_CLIENT_ID_SSM_PATH", targetEnv: "GITHUB_CLIENT_ID" },
  { pathEnv: "GITHUB_CLIENT_SECRET_SSM_PATH", targetEnv: "GITHUB_CLIENT_SECRET" },
  { pathEnv: "JWT_PRIVATE_KEY_SSM_PATH", targetEnv: "JWT_PRIVATE_KEY" },
  { pathEnv: "JWT_PUBLIC_KEY_SSM_PATH", targetEnv: "JWT_PUBLIC_KEY" },
  { pathEnv: "ONEDRIVE_CLIENT_ID_SSM_PATH", targetEnv: "MICROSOFT_CLIENT_ID" },
  { pathEnv: "ONEDRIVE_CLIENT_SECRET_SSM_PATH", targetEnv: "MICROSOFT_CLIENT_SECRET" },
] as const;

export async function loadSSMParameters(
  client: SSMClient,
  mappings: ReadonlyArray<{ pathEnv: string; targetEnv: string }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = mappings.map((m) => env[m.pathEnv]).filter((p): p is string => Boolean(p));

  if (paths.length === 0) {
    return;
  }

  const { Parameters = [] } = await client.send(
    new GetParametersCommand({ Names: paths, WithDecryption: true }),
  );

  for (const param of Parameters) {
    const mapping = mappings.find((m) => env[m.pathEnv] === param.Name);
    if (mapping && param.Value) {
      env[mapping.targetEnv] = param.Value;
    }
  }
}

let cachedInit: Promise<ReturnType<typeof handle>> | undefined;

/**
 * Initialises the lambda on first invocation: load the SSM-backed environment,
 * then build the route graph. Caching the promise makes both happen exactly
 * once per instance, including when invocations arrive concurrently. Doing
 * either at module scope would make importing this module an effect
 * (petroglyph-1o2d).
 */
function init(): Promise<ReturnType<typeof handle>> {
  cachedInit ??= (async () => {
    await loadSSMParameters(ssmClient(), SSM_MAPPINGS);
    return handle(createApp());
  })();
  return cachedInit;
}

/**
 * Lambda entrypoint.
 */
export const handler: ReturnType<typeof handle> = async (event, lambdaContext) => {
  const lambdaHandler = await init();
  return lambdaHandler(event, lambdaContext);
};
