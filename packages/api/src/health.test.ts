import { describe, expect, it } from "vitest";
import { handler } from "./health.js";

describe("GET /health handler", () => {
  it("returns 200 with status ok", () => {
    const result = handler();

    expect(result).toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ status: "ok" }),
    });
  });
});
