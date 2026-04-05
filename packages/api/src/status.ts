import type { Context } from "hono";
import type { AppVariables } from "./auth-middleware.js";

export interface StatusResponse {
  github: { connected: boolean; username?: string };
  oneDrive: { connected: boolean };
}

export function handleStatus(
  c: Context<{ Variables: AppVariables }>,
): Response {
  const username = c.get("username");

  const body: StatusResponse = {
    github: { connected: true, username },
    oneDrive: { connected: false },
  };

  return c.json(body);
}
