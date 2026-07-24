# Better Auth OAuth popup direct-mode failure

Minimal reproduction for the experimental OAuth popup plugin from [better-auth/better-auth#9890](https://github.com/better-auth/better-auth/pull/9890).

Verified against the preview package built from Better Auth commit `4d0dbd6`.

The repository contains:

- a Vite app on `http://localhost:5173`
- a Better Auth server on `http://localhost:5174`, proxied through Vite at `/api`
- a zero-configuration mock OAuth provider on `http://localhost:5174/provider/*`
- a cross-origin iframe harness on `http://localhost:5174/iframe`

No external OAuth credentials or services are required.

## Run

```sh
bun install
bun dev
```

If those ports are occupied:

```sh
APP_PORT=5273 API_PORT=5274 VITE_IFRAME_URL=http://localhost:5274/iframe bun dev
```

## Reproduce

This repository now ships the fix (see [The fix](#the-fix)) as a local plugin, so
direct mode authenticates. To see the original failure, import `oauthPopup` from
`better-auth/plugins` in `server.ts` instead of from `./src/oauth-popup`.

### Direct mode

1. Open `http://localhost:5173`.
2. Click **Sign in with popup**.
3. The mock provider immediately redirects back and the popup closes.
4. With the fix, the result becomes `Success` and the session is authenticated.
   With the published plugin, the result is `POPUP_SIGN_IN_FAILED` and the session
   remains signed out.

### Cross-origin iframe mode

1. Open `http://localhost:5174/iframe`.
2. Click **Sign in with popup** inside the iframe.
3. The same mock provider immediately redirects back and the popup closes.
4. The result becomes `Success` and the session is authenticated (unchanged by the fix).

## Expected

Direct mode should authenticate successfully, matching iframe mode.

## Observed

| Mode                | Published plugin       | With the fix  |
| ------------------- | ---------------------- | ------------- |
| Direct page         | `POPUP_SIGN_IN_FAILED` | `Success`     |
| Cross-origin iframe | `Success`              | `Success`     |

Both opener pages send:

```http
Cross-Origin-Opener-Policy: same-origin-allow-popups
```

This removes Chrome's `window.closed` COOP warnings but does not by itself fix direct mode.

## Root cause

The popup callback creates both `better-auth.session_token` and `better-auth.session_data`,
then the popup after-hook (`oauthPopup`, in `packages/better-auth/src/plugins/oauth-popup/index.ts`)
replaces the redirect with an HTML completion `Response` and sets it as `c.context.returned`.

The hook replays the callback cookies with repeated `c.setCookie(...)` calls. But when
`c.context.returned` is a `Response`, better-call's `toResponse` copies the accumulated
`c.context.responseHeaders` onto that response with `Headers.forEach()` followed by
`Headers.set()`. `forEach` **collapses every `Set-Cookie` value into a single comma-joined
string**, and `set()` overwrites, so all but the last cookie are lost. In the final HTTP
response only `better-auth.session_data` survives; `better-auth.session_token` is missing.

The popup still posts the token successfully (so the bearer / iframe flow works), but direct
mode's subsequent cookie-authenticated `/get-session` request is signed out, which surfaces
as `POPUP_SIGN_IN_FAILED` (or `POPUP_TIMEOUT` when the completion page never posts).

This can be inspected without a browser by following the mock OAuth redirects and listing the
final response's `Set-Cookie` names. With the published plugin:

```txt
better-auth.session_data
```

## The fix

[`src/oauth-popup.ts`](src/oauth-popup.ts) is a local copy of the plugin that reuses everything
from the published `oauthPopup()` (the `/oauth-popup/start` endpoint, error codes, metadata) and
only replaces the callback after-hook. Instead of relying on `c.setCookie(...)`, it:

1. Replays every original `Set-Cookie` value from the callback response **directly on the
   completion `Response`**, one header per cookie — including `better-auth.session_token`.
2. Expires the popup marker cookie on that same response.
3. Deletes the collapsed `Set-Cookie` from `c.context.responseHeaders` so `toResponse` cannot
   clobber the cookies that were just set.

With the fix the final response carries each cookie as its own header:

```txt
better-auth.oauth_state
better-auth.account_data
better-auth.session_token
better-auth.session_data
better-auth.oauth_popup
```

Direct mode authenticates with the client unchanged, and the iframe bearer-token flow continues
to work (the token is still posted back to the opener via `postMessage`). This is the change to
apply to the `oauthPopup` after-hook upstream.

The COOP header (`Cross-Origin-Opener-Policy: same-origin-allow-popups`, already sent on both
opener pages) remains useful for avoiding `window.closed` warnings, but it does not resolve the
dropped session cookie on its own.
