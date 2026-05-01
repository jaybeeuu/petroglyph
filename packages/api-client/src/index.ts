import createFetchClient from "openapi-fetch";
import type { paths } from "./openapi-types.js";

export type { paths } from "./openapi-types.js";

export interface PetroglyphClientOptions {
  baseUrl: string;
  accessToken?: string;
}

export function createPetroglyphClient(
  options: PetroglyphClientOptions,
): ReturnType<typeof createFetchClient<paths>> {
  const { baseUrl, accessToken } = options;

  const clientOptions: Parameters<typeof createFetchClient<paths>>[0] = {
    baseUrl,
  };

  if (accessToken) {
    clientOptions.headers = { Authorization: `Bearer ${accessToken}` };
  }

  return createFetchClient<paths>(clientOptions);
}

export type PetroglyphClient = ReturnType<typeof createPetroglyphClient>;
