import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const publicKeyPem = vi.hoisted(() => ({ value: "" }));

/**
 * Emulates SSM's SecureString contract: a parameter whose value is sensitive
 * comes back encrypted unless the caller asks for decryption. Returning
 * ciphertext for a missing flag means a verifier that forgets it fails here
 * exactly as it fails against the deployed parameter.
 */
vi.mock("@aws-sdk/client-ssm", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    SSMClient: class {
      send = (command: {
        input?: { WithDecryption?: boolean };
      }): Promise<{ Parameter?: { Value: string } }> =>
        Promise.resolve({
          Parameter: {
            Value:
              command.input?.WithDecryption === true
                ? publicKeyPem.value
                : "AQICAHi9ciphertextnotapem",
          },
        });
    },
  });
});

import { resetKeyCache, verifyJwt } from "./jwt.js";

describe("verifyJwt", () => {
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey;
    publicKeyPem.value = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    resetKeyCache();
    delete process.env["JWT_PUBLIC_KEY"];
    process.env["JWT_PUBLIC_KEY_SSM_PATH"] = "/petroglyph/qa/jwt/public-key";
  });

  afterEach(() => {
    delete process.env["JWT_PUBLIC_KEY_SSM_PATH"];
  });

  async function mintToken(): Promise<string> {
    return new SignJWT({ username: "smoke-user" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("smoke-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  it("decrypts the SecureString public key before verifying", async () => {
    const claims = await verifyJwt(await mintToken());

    expect(claims).toStrictEqual({ userId: "smoke-user", username: "smoke-user" });
  });

  it("rejects a token whose required username claim is absent", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("smoke-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifyJwt(token)).rejects.toThrow("Missing required JWT claims");
  });
});
