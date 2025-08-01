import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
// eslint-disable-next-line import/no-unresolved
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

export default function App() {
  return (
    <Router
      root={props => (
        <MetaProvider>
          <Title>SolidStart - with Vitest</Title>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
