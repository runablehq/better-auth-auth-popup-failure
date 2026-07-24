import { serve } from "@hono/node-server";
import { betterAuth } from "better-auth";
import { bearer, genericOAuth } from "better-auth/plugins";
import { Hono } from "hono";
import { oauthPopup } from "./src/oauth-popup";

const APP_PORT = Number(process.env.APP_PORT ?? "5173");
const API_PORT = Number(process.env.API_PORT ?? "5174");
const APP_URL = `http://localhost:${APP_PORT}`;
const API_URL = `http://localhost:${API_PORT}`;

const iframeDocument = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OAuth popup iframe reproduction</title>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font-family: ui-monospace, monospace; background: #111; color: #fff; }
      header { padding: 12px 16px; border-bottom: 1px solid #333; }
      p { margin: 4px 0 0; color: #aaa; font-size: 12px; }
      iframe { width: 100%; height: calc(100vh - 65px); border: 0; background: #fff; }
    </style>
  </head>
  <body>
    <header>
      <strong>Cross-origin iframe harness</strong>
      <p>Parent: ${API_URL} / Child: ${APP_URL}</p>
    </header>
    <iframe src="${APP_URL}" title="OAuth popup reproduction"></iframe>
  </body>
</html>`;

const auth = betterAuth({
  baseURL: APP_URL,
  basePath: "/api/auth",
  secret: "better-auth-popup-reproduction-secret",
  trustedOrigins: [APP_URL],
  plugins: [
    oauthPopup(),
    bearer(),
    genericOAuth({
      config: [
        {
          providerId: "mock",
          authorizationUrl: `${API_URL}/provider/authorize`,
          tokenUrl: `${API_URL}/provider/token`,
          userInfoUrl: `${API_URL}/provider/userinfo`,
          clientId: "mock-client",
          clientSecret: "mock-secret",
          scopes: ["openid", "email", "profile"],
          pkce: true,
          authentication: "basic",
        },
      ],
    }),
  ],
});

const app = new Hono()
  .get("/iframe", (c) => {
    c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    return c.html(iframeDocument);
  })
  .get("/provider/authorize", (c) => {
    const callback = new URL(c.req.query("redirect_uri")!);
    callback.searchParams.set("code", "mock-authorization-code");
    callback.searchParams.set("state", c.req.query("state")!);
    return c.redirect(callback.toString());
  })
  .post("/provider/token", (c) =>
    c.json({
      access_token: "mock-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  )
  .get("/provider/userinfo", (c) =>
    c.json({
      sub: "mock-user",
      email: "mock@example.com",
      email_verified: true,
      name: "Mock User",
    }),
  )
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

serve({ fetch: app.fetch, hostname: "0.0.0.0", port: API_PORT }, (info) => {
  console.log(`Reproduction API listening on http://localhost:${info.port}`);
});
