// The receive card's balance line: the connected wallet's balance of the token it receives, as on the pay card.
import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it} from "vitest";
import type {SwapToken} from "../../../src/contracts/domain";
import {DEMO_EVM_ADDRESS, demoSwapTokens} from "../../../src/mocks";
import {ReceiveCard} from "../../../src/screens/form/AmountCards";

const ARB_USDC = "arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const usdc = demoSwapTokens({evm: DEMO_EVM_ADDRESS}).find((t) => t.key === ARB_USDC)!;
const card = (to: SwapToken) => render(<ReceiveCard from={undefined} to={to} route={undefined} quoting={false} onPickToken={() => {}} />);

describe("ReceiveCard balance", () => {
  afterEach(cleanup);

  it("shows the wallet's balance of the receive token", () => {
    card({...usdc, balance: "loaded", amount: "1250420000"});
    expect(screen.getByTestId("swap-receive-balance").textContent).toBe("Balance 1,250.42");
  });

  it("a balance still loading (or failed) reads as a dash", () => {
    card({...usdc, balance: "loading", amount: "0"});
    expect(screen.getByTestId("swap-receive-balance").textContent).toBe("Balance —");
  });

  it("no wallet of the token's family: no balance line, the row keeps its height", () => {
    const {container} = card({...usdc, balance: "none", amount: "0", owner: null});
    expect(screen.queryByTestId("swap-receive-balance")).toBeNull();
    expect(container.textContent).not.toContain("Balance");
  });
});
