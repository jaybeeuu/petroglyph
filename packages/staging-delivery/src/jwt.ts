import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { importSPKI, jwtVerify } from "jose";

export interface JwtClaims {
  userId: string;
  username: string;
}

const ssmClient = new SSMClient({});

async function fetchPublicKeyPem(): Promise<string> {
  const envKey = process.env["JWT_PUBLIC_KEY"];
  if (envKey) return envKey;

  const paramName = process.env["JWT_PUBLIC_KEY_SSM_PATH"] ?? "/petroglyph/jwt/public-key";
  const result = await ssmClient.send(new GetParameterCommand({ Name: paramName }));
  const key = result.Parameter?.Value;
  if (!key) throw new Error(`JWT public key not found at SSM path: ${paramName}`);
  return key;
}

let cachedKeyPromise: Promise<CryptoKey> | null = null;

function getPublicKey(): Promise<CryptoKey> {
  if (!cachedKeyPromise) {
    cachedKeyPromise = fetchPublicKeyPem().then((pem) => importSPKI(pem, "RS256"));
  }
  return cachedKeyPromise;
}

export function resetKeyCache(): void {
  cachedKeyPromise = null;
}

export async function verifyJwt(token: string): Promise<JwtClaims> {
  const publicKey = await getPublicKey();

  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ["RS256"],
  });

  const userId = payload.sub;
  const username = typeof payload["username"] === "string" ? payload["username"] : undefined;

  if (!userId || !username) {
    throw new Error("Missing required JWT claims: sub, username");
  }

  return { userId, username };
}
