/**
 * The provider tree: React Query → the wallets' provider (wagmi etc.) →
 * the port registry → the hash routes. Demo mode swaps every port for the
 * fixture-backed ones at this one place (D15). The swap tracker mounts once.
 */
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {lazy, Suspense, useState} from "react";
import {activityPort} from "./activity";
import {approvalsPort} from "./approvals";
import {catalogPort} from "./catalog";
import {isDemo, PortsProvider, useHashRoute, usePorts} from "./config";
import type {AppPorts} from "./contracts/ports";
import {executePort} from "./execute";
import {demoPorts} from "./mocks";
import {Routes} from "./screens";
import {swapPort} from "./swap";
import {Toaster} from "./ui";
import {walletsPort} from "./wallets";

/** The real modules' ports (typechecked against the contract here). */
export const realPorts: AppPorts = {
  catalog: catalogPort,
  wallets: walletsPort,
  swap: swapPort,
  execute: executePort,
  activity: activityPort,
  approvals: approvalsPort,
};

/** The ui kit's gallery (design review): its own chunk, so the main bundle never carries it. */
const Gallery = lazy(() => import("./ui/Gallery").then((m) => ({default: m.Gallery})));

/** Follows unfinished swaps for the whole page (the hook runs once, here). */
function SwapTracker() {
  usePorts().activity.useSwapTracker();
  return null;
}

/** The swap app with its providers. Built once: the ports are fixed per page (demo is decided at boot). */
function SwapRoot() {
  const [ports] = useState<AppPorts>(() => (isDemo() ? demoPorts : realPorts));
  const [queryClient] = useState(
    () => new QueryClient({defaultOptions: {queries: {retry: 1, refetchOnWindowFocus: false}}}),
  );
  const WalletsProvider = ports.wallets.Provider;
  return (
    <QueryClientProvider client={queryClient}>
      <WalletsProvider>
        <PortsProvider ports={ports}>
          <SwapTracker />
          <Routes />
          <Toaster />
        </PortsProvider>
      </WalletsProvider>
    </QueryClientProvider>
  );
}

/**
 * Hash routes (D22): `#/gallery` is the ui gallery, outside the providers so it never starts wagmi, storage or
 * quotes; every other path is the swap screen (which also resolves the demo scenes, `#/demo/<scene>`).
 */
export function App() {
  const {path} = useHashRoute();
  if (path === "/gallery") {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  return <SwapRoot />;
}
