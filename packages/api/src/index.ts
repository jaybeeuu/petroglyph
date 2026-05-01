import { GetParametersCommand, type SSMClient } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { app } from "./app.js";
import { ssmClient } from "./ssm.js";

export const SSM_MAPPINGS = [
  { pathEnv: "GITHUB_CLIENT_ID_SSM_PATH", targetEnv: "GITHUB_CLIENT_ID" },
  { pathEnv: "GITHUB_CLIENT_SECRET_SSM_PATH", targetEnv: "GITHUB_CLIENT_SECRET" },
  { pathEnv: "JWT_SIGNING_SECRET_SSM_PATH", targetEnv: "JWT_SIGNING_SECRET" },
  { pathEnv: "JWT_PRIVATE_KEY_SSM_PATH", targetEnv: "JWT_PRIVATE_KEY" },
  { pathEnv: "JWT_PUBLIC_KEY_SSM_PATH", targetEnv: "JWT_PUBLIC_KEY" },
  { pathEnv: "ONEDRIVE_CLIENT_ID_SSM_PATH", targetEnv: "MICROSOFT_CLIENT_ID" },
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

await loadSSMParameters(ssmClient, SSM_MAPPINGS);

export const handler = handle(app);
