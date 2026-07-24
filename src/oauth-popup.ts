import { createAuthMiddleware } from "better-auth/api";
import { expireCookie, parseSetCookieHeader, splitSetCookieHeader } from "better-auth/cookies";
import {
  OAUTH_POPUP_COMPLETE_SCRIPT,
  OAUTH_POPUP_DATA_ELEMENT_ID,
  OAUTH_POPUP_MESSAGE_TYPE,
  OAUTH_POPUP_SCRIPT_CSP_HASH,
  POPUP_MARKER_COOKIE,
  oauthPopup as baseOauthPopup,
} from "better-auth/plugins";

/**
 * Local, fixed copy of Better Auth's experimental `oauthPopup` server plugin.
 *
 * The published plugin's callback after-hook renders the popup completion page
 * and then relies on `c.setCookie(...)` to carry the session cookies over onto
 * that replacement response. When `c.context.returned` is set to a `Response`,
 * better-call's `toResponse` copies the accumulated `c.context.responseHeaders`
 * onto it with `Headers.forEach()` + `Headers.set()`. `forEach` collapses every
 * `Set-Cookie` value into a single comma-joined string and `set()` overwrites,
 * so all but the last cookie is lost. In practice `better-auth.session_token`
 * is dropped and only `better-auth.session_data` survives, which leaves
 * direct-mode popup sign-in unauthenticated: the opener's cookie-authenticated
 * `/get-session` comes back signed out and the client reports
 * `POPUP_SIGN_IN_FAILED`.
 *
 * The fix replays every original `Set-Cookie` value from the callback response
 * directly on the completion `Response` — one header per cookie — and clears the
 * collapsed `Set-Cookie` from the shared context headers so `toResponse` cannot
 * clobber them. The popup marker is expired on the completion response too,
 * instead of through the context headers. The iframe bearer-token flow is
 * untouched: the token is still posted back to the opener via `postMessage`.
 *
 * Everything except the after-hook (the `/oauth-popup/start` endpoint, error
 * codes, metadata) is reused from the published plugin.
 */

type PopupMessage = {
  nonce: string;
  token?: string;
  redirectTo?: string;
  error?: { code: string; description?: string };
};

/** Escapes `<`/`\/script>` and JS line separators for embedding in a script element. */
function inlineJSON(value: unknown): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Serializes a `Set-Cookie` header that expires the given cookie immediately.
 * Mirrors better-call's cookie serialization for the attributes the auth
 * cookies use, so the popup marker can be expired directly on the completion
 * response rather than through the (collapsed) context headers.
 */
function serializeExpiredCookie(cookie: {
  name: string;
  attributes?: Record<string, unknown>;
}): string {
  const attributes = cookie.attributes ?? {};
  const parts = [`${cookie.name}=`, "Max-Age=0"];
  if (typeof attributes.path === "string") parts.push(`Path=${attributes.path}`);
  if (typeof attributes.domain === "string") parts.push(`Domain=${attributes.domain}`);
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  if (typeof attributes.sameSite === "string") {
    const value = attributes.sameSite;
    parts.push(`SameSite=${value.charAt(0).toUpperCase()}${value.slice(1)}`);
  }
  return parts.join("; ");
}

/**
 * Rebuilds the completion page that posts the outcome (token or error) back to
 * the opener. Reuses the published script and its pinned CSP hash verbatim so
 * the content-security-policy still validates.
 */
function renderCompletion(popupOrigin: string, message: PopupMessage): Response {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Completing sign-in</title></head>
<body>
<script type="application/json" id="${OAUTH_POPUP_DATA_ELEMENT_ID}">${inlineJSON({
    type: OAUTH_POPUP_MESSAGE_TYPE,
    targetOrigin: popupOrigin,
    ...message,
  })}<\/script>
<script>${OAUTH_POPUP_COMPLETE_SCRIPT}<\/script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src '${OAUTH_POPUP_SCRIPT_CSP_HASH}'; base-uri 'none'`,
    },
  });
}

export const oauthPopup = () => {
  const base = baseOauthPopup();
  return {
    ...base,
    hooks: {
      ...base.hooks,
      after: [
        {
          matcher(context: { path?: string }) {
            return !!(
              context.path?.startsWith("/callback/") ||
              context.path?.startsWith("/oauth2/callback/")
            );
          },
          handler: createAuthMiddleware(async (c) => {
            const redirectTo = c.context.responseHeaders?.get("location");
            if (!redirectTo) return;
            const cookie = c.context.createAuthCookie(POPUP_MARKER_COOKIE);
            const marker = await c.getSignedCookie(cookie.name, c.context.secret);
            if (!marker) return;
            let popupOrigin: string;
            let popupNonce: string;
            try {
              const parsed = JSON.parse(marker);
              popupOrigin = parsed.popupOrigin;
              popupNonce = parsed.popupNonce ?? "";
            } catch {
              expireCookie(c, cookie);
              return;
            }
            const setCookie = c.context.responseHeaders?.get("set-cookie") ?? "";
            const token = parseSetCookieHeader(setCookie).get(
              c.context.authCookies.sessionToken.name,
            )?.value;
            let response: Response;
            if (token) {
              response = renderCompletion(popupOrigin, {
                nonce: popupNonce,
                token,
                redirectTo,
              });
              // Replay every original Set-Cookie from the callback response
              // directly on the completion response, one header per cookie, so
              // `better-auth.session_token` reaches the browser and direct-mode
              // sign-in is authenticated.
              const original =
                c.context.responseHeaders?.getSetCookie?.() ??
                splitSetCookieHeader(setCookie);
              for (const value of original) response.headers.append("set-cookie", value);
              // Expire the popup marker on the completion response as well.
              response.headers.append("set-cookie", serializeExpiredCookie(cookie));
              // Drop the accumulated Set-Cookie from the shared context headers
              // so they cannot clobber the cookies we just set when the
              // completion response is finalized (see the header note above).
              c.context.responseHeaders?.delete("set-cookie");
            } else {
              expireCookie(c, cookie);
              const url = new URL(redirectTo, c.context.baseURL);
              const error = url.searchParams.get("error");
              if (!error) return;
              response = renderCompletion(popupOrigin, {
                nonce: popupNonce,
                error: {
                  code: error,
                  description: url.searchParams.get("error_description") ?? undefined,
                },
              });
            }
            c.context.returned = response;
          }),
        },
      ],
    },
  };
};
