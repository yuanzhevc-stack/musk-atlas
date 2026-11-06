import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { watchAppUpdate } from "./lib/appUpdate";
import "./styles/app.css";
import "./styles/reader.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Musk build: no offline service worker (avoids stale corpus.json); unregister any old one.
if ("serviceWorker" in navigator) navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => null);
// A tab that stayed open across a publish compares version.json and reloads the document.
// localStorage (learning, corpus, vocab) is not touched.
void watchAppUpdate();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void watchAppUpdate();
});
if (false as boolean) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => null);
  });
}
