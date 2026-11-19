/**
 * What the integrator mounts for the swap paths (D22): every path but `#/gallery` (the integrator's) renders the
 * swap screen, which also resolves the demo scenes (`#/demo/<scene>?demo=1`) — except `#/revoke` (D46; `#/approvals`
 * too), the token approvals section, loaded as its own chunk the first time it opens.
 */
import {lazy, Suspense} from "react";
import {useHashRoute} from "../config";
import {SwapScreen} from "./SwapScreen";

const ApprovalsScreen = lazy(() => import("./approvals/ApprovalsScreen").then((m) => ({default: m.ApprovalsScreen})));

export function Routes() {
  const {path} = useHashRoute();
  if (path === "/revoke" || path === "/approvals")
    return (
      <Suspense fallback={null}>
        <ApprovalsScreen />
      </Suspense>
    );
  return <SwapScreen />;
}
