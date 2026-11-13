import { describe, expect, it } from "vitest";
import { responseValidationMode } from "./response-validation.js";

describe("responseValidationMode", () => {
  it("reports a mismatch wherever a user is not the victim of it", () => {
    expect(responseValidationMode({ NODE_ENV: "test" })).toBe("report");
    expect(responseValidationMode({ NODE_ENV: "development" })).toBe("report");
    expect(responseValidationMode({})).toBe("report");
  });

  it("only logs a mismatch in production, so a user's working request still completes", () => {
    expect(responseValidationMode({ NODE_ENV: "production" })).toBe("log");
  });

  it("logs in the deployed runtime, which sets no NODE_ENV", () => {
    expect(responseValidationMode({ AWS_LAMBDA_FUNCTION_NAME: "petroglyph-api-prod" })).toBe("log");
  });
});
