import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { defineEndpoint } from "@petroglyph/contracts/hono";
import { getHealth } from "@petroglyph/contracts/operations";
import type { AppContext } from "./auth-middleware.js";

/** The `GET /health` route: liveness of the app, not of its dependencies. */
export const getHealthEndpoint = defineEndpoint(getHealth, (_input, c: AppContext) =>
  c.json({ status: "ok" }),
);

/**
 * The standalone Lambda entry, kept for the API Gateway health check that does
 * not go through the Hono app.
 */
export const handler = (): APIGatewayProxyResultV2 => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "ok" }),
  };
};
