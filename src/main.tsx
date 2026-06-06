import React from "react";
import { createRoot } from "react-dom/client";
import { authClient } from "./auth-client";
import "./styles.css";

function App() {
  const embedded = window.self !== window.top;
  const iframeUrl = import.meta.env.VITE_IFRAME_URL ?? "http://localhost:5174/iframe";
  const session = authClient.useSession();
  const [result, setResult] = React.useState("Not run");
  const [pending, setPending] = React.useState(false);

  const signIn = async () => {
    setPending(true);
    setResult("Waiting for popup");

    try {
      const response = await authClient.signIn.popup({
        providerId: "mock",
        callbackURL: window.location.origin,
      });
      setResult(response.error?.code ?? "Success");
    } finally {
      setPending(false);
    }
  };

  return (
    <main>
      <section>
        <p className="eyebrow">Better Auth OAuth popup reproduction</p>
        <h1>{embedded ? "Iframe mode" : "Direct mode"}</h1>
        <p>
          Expected failure: direct mode returns <code>POPUP_SIGN_IN_FAILED</code> after the OAuth
          popup completes. The same flow succeeds inside the cross-origin iframe harness.
        </p>

        <button type="button" disabled={pending} onClick={signIn}>
          {pending ? "Waiting for popup..." : "Sign in with popup"}
        </button>

        <dl>
          <div>
            <dt>Popup result</dt>
            <dd>{result}</dd>
          </div>
          <div>
            <dt>Session</dt>
            <dd>{session.data ? "Authenticated" : "Signed out"}</dd>
          </div>
        </dl>

        <pre>{JSON.stringify(session.data ?? { authenticated: false }, null, 2)}</pre>

        {!embedded && (
          <a href={iframeUrl} target="_blank" rel="noreferrer">
            Open iframe comparison
          </a>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
