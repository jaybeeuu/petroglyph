import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { handle } from "hono/aws-lambda";
import { app } from "./app.js";
import { ssmClient } from "./ssm.js";

const SSM_MAPPINGS = [
  { pathEnv: "GITHUB_CLIENT_ID_SSM_PATH", targetEnv: "GITHUB_CLIENT_ID" },
  { pathEnv: "GITHUB_CLIENT_SECRET_SSM_PATH", targetEnv: "GITHUB_CLIENT_SECRET" },
  { pathEnv: "JWT_SIGNING_SECRET_SSM_PATH", targetEnv: "JWT_SIGNING_SECRET" },
  { pathEnv: "JWT_PRIVATE_KEY_SSM_PATH", targetEnv: "JWT_PRIVATE_KEY" },
  { pathEnv: "JWT_PUBLIC_KEY_SSM_PATH", targetEnv: "JWT_PUBLIC_KEY" },
  { pathEnv: "ONEDRIVE_CLIENT_ID_SSM_PATH", targetEnv: "MICROSOFT_CLIENT_ID" },
] as const;

const paths = SSM_MAPPINGS.map((m) => process.env[m.pathEnv]).filter((p): p is string =>
  Boolean(p),
);

if (paths.length > 0) {
  const { Parameters = [] } = await ssmClient.send(
    new GetParametersCommand({ Names: paths, WithDecryption: true }),
  );
  for (const param of Parameters) {
    const mapping = SSM_MAPPINGS.find((m) => process.env[m.pathEnv] === param.Name);
    if (mapping && param.Value) {
      process.env[mapping.targetEnv] = param.Value;
    }
  }
}

export const handler = handle(app);
