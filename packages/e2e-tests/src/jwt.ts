import { importPKCS8, SignJWT } from "jose";

const TOKEN_TTL_SECONDS = 300;

/**
 * Mints the identity token the delivery surface verifies. Signed with the
 * QA workspace's private key, so the deployed Lambda's SSM public key is the
 * genuine verifier — GitHub auth is never mocked, only bypassed for the smoke
 * identity the runner itself seeds.
 */
export async function mintSmokeJwt(options: {
  privateKeyPem: string;
  userId: string;
  username: string;
}): Promise<string> {
  const privateKey = await importPKCS8(options.privateKeyPem, "RS256");
  return new SignJWT({ username: options.username })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(options.userId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}
