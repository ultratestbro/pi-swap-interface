import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {renderHook, waitFor} from "@testing-library/react";
import type {ReactNode} from "react";
import {describe, expect, it, vi} from "vitest";
import type {SwapDraft} from "../../../src/contracts/execution";
import type {WebRoute} from "../../../src/contracts/routes";
import {createUseRequote, type RequoteRouteFn} from "../../../src/swap/useRequote";
import {request} from "./fixtures";

const route = (provider: string, min: bigint): WebRoute => ({
  provider,
  sourceAmount: 5_000_000n,
  destAmount: min,
  minDestAmount: min,
  etaSeconds: 45,
  feeUsd: 0,
  fees: [],
  tags: [],
  relativeValue: 1,
  netValueUsd: null,
  approvalSpender: null,
  nativeFee: 0n,
  validUntilMs: Date.now() + 60_000,
  gasUsd: null,
  execution: "calldata",
  hasMemo: false,
  trust: "contracts",
});

const draft: SwapDraft = {req: request(), route: route("cctp", 4_999_000n)};

function wrapper() {
  const client = new QueryClient({defaultOptions: {queries: {retryDelay: 0}}});
  return ({children}: {children: ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useRequote", () => {
  it("shows the drafted route until the fresh one lands, then the fresh one", async () => {
    let resolve!: (v: {route: WebRoute | null; reason: string | null}) => void;
    const requote = vi.fn<RequoteRouteFn>(() => new Promise((r) => (resolve = r)));
    const {result} = renderHook(() => createUseRequote(requote)(draft, {}), {wrapper: wrapper()});
    expect(result.current).toMatchObject({route: draft.route, gone: null, failed: false, loading: true});
    await waitFor(() => expect(requote).toHaveBeenCalledWith(draft.req, {provider: "cctp"}, {}));
    resolve({route: route("cctp", 4_999_500n), reason: null});
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.route?.minDestAmount).toBe(4_999_500n);
  });

  it("a venue that no longer routes it: gone blocks Confirm, no route", async () => {
    const requote: RequoteRouteFn = async () => ({route: null, reason: "Minimum $10 for this pair right now"});
    const {result} = renderHook(() => createUseRequote(requote)(draft, {}), {wrapper: wrapper()});
    await waitFor(() => expect(result.current.gone).toBe("Circle CCTP no longer routes this swap: Minimum $10 for this pair right now"));
    expect(result.current.route).toBeNull();
  });

  it("a failed re-quote (network) keeps the drafted route after one retry", async () => {
    const requote = vi.fn<RequoteRouteFn>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const {result} = renderHook(() => createUseRequote(requote)(draft, {}), {wrapper: wrapper()});
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(requote).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({route: draft.route, gone: null, loading: false});
  });

  it("is idle without a draft", () => {
    const requote = vi.fn<RequoteRouteFn>();
    const {result} = renderHook(() => createUseRequote(requote)(null, {}), {wrapper: wrapper()});
    expect(result.current).toMatchObject({route: null, gone: null, failed: false, loading: false});
    expect(requote).not.toHaveBeenCalled();
  });
});
