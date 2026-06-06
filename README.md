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

### Direct mode

1. Open `http://localhost:5173`.
2. Click **Sign in with popup**.
3. The mock provider immediately redirects back and the popup closes.
4. The result becomes `POPUP_SIGN_IN_FAILED` and the session remains signed out.

### Cross-origin iframe mode

1. Open `http://localhost:5174/iframe`.
2. Click **Sign in with popup** inside the iframe.
3. The same mock provider immediately redirects back and the popup closes.
4. The result becomes `Success` and the session is authenticated.

## Expected

Direct mode should authenticate successfully, matching iframe mode.

## Observed

| Mode                | Popup result           | Session       |
| ------------------- | ---------------------- | ------------- |
| Direct page         | `POPUP_SIGN_IN_FAILED` | Signed out    |
| Cross-origin iframe | `Success`              | Authenticated |

Both opener pages send:

```http
Cross-Origin-Opener-Policy: same-origin-allow-popups
```

This removes Chrome's `window.closed` COOP warnings but does not fix direct mode.

## Suspected path

In the preview package's popup client, the successful popup token is stored only when `isEmbedded()` is true. Direct mode clears the popup token and then calls `/get-session`, relying on the popup's session cookie being available to the opener:

```js
if (isEmbedded()) storePopupToken(outcome.token);
else clearPopupToken();

const session = await $fetch("/get-session");
```

The popup itself completes successfully in both modes. Direct mode fails at the subsequent session fetch.
