// @refresh reload
// eslint-disable-next-line import/no-unresolved
import { mount, StartClient } from "@solidjs/start/client";

const root = document.getElementById("app");
if (root) {
  mount(() => <StartClient />, root);
}
