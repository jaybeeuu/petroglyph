import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { mintSmokeJwt } from "./jwt.js";

describe("mintSmokeJwt", () => {
  it("signs a token the delivery verifier accepts with the seeded identity claims", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });

    const token = await mintSmokeJwt({
      privateKeyPem: privateKey,
      userId: "smoke-user",
      username: "smoke",
    });

    const { payload } = await jwtVerify(token, await importSPKI(publicKey, "RS256"), {
      algorithms: ["RS256"],
    });
    expect(payload).toMatchObject({ sub: "smoke-user", username: "smoke" });
  });
});
