import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createAuthProvider } from "./auth/provider-factory.js";
import { InMemoryAccountRepository } from "./account/in-memory-repository.js";
import { fixtureUser, fixtureIdentity } from "./account/fixtures.js";
import { authenticate } from "./middleware/authenticate.js";
import { resolveIdentity } from "./middleware/resolve-identity.js";
import { getAuthContext } from "./middleware/auth-context.js";

const config = loadConfig();
const authProvider = createAuthProvider(config);

// Use in-memory fixtures for local development.
// A real deployment would supply a persistent store implementation.
const repository = new InMemoryAccountRepository([fixtureUser], [fixtureIdentity]);

const app = new Hono();

// Health check — unauthenticated.
app.get("/health", (c) => c.json({ status: "ok" }));

// Protected route group: all routes here require a valid token and a known application user.
const api = new Hono();
api.use(authenticate(authProvider));
api.use(resolveIdentity(repository));

api.get("/me", (c) => {
  const { user } = getAuthContext(c);
  return c.json({ userId: user.id, displayName: user.displayName, status: user.status });
});

app.route("/api", api);

const port = config.port;
console.log(
  `API server starting on port ${port} (AUTH_MODE=${config.authMode}, LOG_LEVEL=${config.logLevel})`,
);

serve({ fetch: app.fetch, port });
