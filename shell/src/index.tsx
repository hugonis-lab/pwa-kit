import { render } from "solid-js/web";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";

const root = document.getElementById("root");
if (root) {
  render(() => <App />, root);
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Non-fatal in private browsing or restricted contexts
    });
  });
}
