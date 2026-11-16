import {act, cleanup, fireEvent, render, renderHook, screen} from "@testing-library/react";
import {useState} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {
  AmountInput,
  AssetIcon,
  Button,
  Field,
  ProviderLogo,
  QrCode,
  Sheet,
  SwapSteps,
  Switch,
  TokenIcon,
  TxReviewCard,
  useBreakpoint,
  VenueBadge,
} from "../../../src/ui";
import {qrPath} from "../../../src/ui/QrCode";
import {placeTooltip, Tooltip} from "../../../src/ui/Tooltip";
import {installMatchMedia} from "./matchMedia";

afterEach(cleanup);

describe("Button", () => {
  it("disabled: the click does nothing", () => {
    const onClick = vi.fn();
    render(<Button title="Review swap" disabled onClick={onClick} />);
    const b = screen.getByRole("button", {name: "Review swap"});
    expect(b).toHaveProperty("disabled", true);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading: keeps the title, is busy and cannot be clicked twice", () => {
    const onClick = vi.fn();
    render(<Button title="Confirm swap" loading icon="arrowRight" onClick={onClick} />);
    const b = screen.getByRole("button", {name: "Confirm swap"});
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b).toHaveProperty("disabled", true);
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button so it never submits a form", () => {
    render(<Button title="Go" />);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });
});

describe("Switch", () => {
  it("is a role=switch whose aria-checked follows the state", () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} aria-label="Send to another address" />;
    }
    render(<Harness />);
    const sw = screen.getByRole("switch", {name: "Send to another address"});
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("disabled: no change", () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} disabled aria-label="Forced" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Field", () => {
  it("labels the input and describes it with the error", () => {
    render(<Field label="Recipient" error="That isn't an Arbitrum address." defaultValue="0x12" />);
    const input = screen.getByLabelText("Recipient");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const note = document.getElementById(input.getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe("That isn't an Arbitrum address.");
  });
});

describe("AmountInput", () => {
  it("shrinks with its length like the receive amount, so a long MAX isn't cut off", () => {
    const {rerender} = render(<AmountInput aria-label="Amount to pay" value="0.25" onChange={() => {}} />);
    const input = screen.getByLabelText("Amount to pay");
    // jsdom drops a min() font-size, so the tier shows in the tracking that goes with it (amountFontSize).
    expect(input.style.letterSpacing).toBe("-0.8px");
    rerender(<AmountInput aria-label="Amount to pay" value="0.005883953566923" onChange={() => {}} />);
    expect(input.style.letterSpacing).toBe("-0.6px");
  });
});

describe("Sheet (dialog, ≥ 640)", () => {
  function Harness({locked = false, onClose}: {locked?: boolean; onClose: () => void}) {
    return (
      <Sheet open onClose={onClose} label="Review swap" locked={locked}>
        <button type="button">Confirm swap</button>
      </Sheet>
    );
  }

  it("is a labelled modal dialog", () => {
    render(<Harness onClose={() => {}} />);
    const d = screen.getByRole("dialog", {name: "Review swap"});
    expect(d.getAttribute("aria-modal")).toBe("true");
  });

  it("Esc closes", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /** A primary-button press: Radix defers an outside pointerdown to the click that follows it. */
  const press = (el: Element) => {
    fireEvent.pointerDown(el);
    fireEvent.click(el);
  };

  it("a press on the backdrop closes", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await act(() => new Promise((r) => setTimeout(r, 10))); // Radix arms the outside listener a tick later
    press(screen.getByTestId("sheet-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("locked: neither Esc nor the backdrop closes", async () => {
    const onClose = vi.fn();
    render(<Harness locked onClose={onClose} />);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});
    press(screen.getByTestId("sheet-backdrop"));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("Sheet focus return (WCAG 2.4.3)", () => {
  function Opener({onClosed}: {onClosed?(): void}) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Pick token
        </button>
        <Sheet open={open} onClose={() => setOpen(false)} onClosed={onClosed} label="Tokens">
          <button type="button" onClick={() => setOpen(false)}>
            USDC
          </button>
        </Sheet>
      </>
    );
  }

  for (const width of [1280, 375]) {
    it(`closing puts focus back on the button that opened it, then calls onClosed (${width} px)`, async () => {
      const vp = installMatchMedia(width);
      try {
        // a sheet opened from onClosed finds the opener focused (so its own close hands focus back there)
        const focused: (Element | null)[] = [];
        render(<Opener onClosed={() => focused.push(document.activeElement)} />);
        const opener = screen.getByRole("button", {name: "Pick token"});
        opener.focus();
        fireEvent.click(opener);
        const dialog = await screen.findByRole("dialog", {name: "Tokens"});
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect(dialog.contains(document.activeElement)).toBe(true);
        fireEvent.keyDown(dialog, {key: "Escape"});
        await act(() => new Promise((r) => setTimeout(r, 600))); // vaul animates out
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(opener);
        expect(focused).toEqual([opener]);
      } finally {
        vp.restore();
      }
    });
  }
});

describe("Sheet (bottom sheet, < 640)", () => {
  it("is a labelled modal; Esc closes unless locked", () => {
    const vp = installMatchMedia(375);
    try {
      const onClose = vi.fn();
      const {rerender} = render(
        <Sheet open onClose={onClose} label="Routes" locked>
          <p>list</p>
        </Sheet>,
      );
      const d = screen.getByRole("dialog", {name: "Routes"});
      expect(d.getAttribute("aria-modal")).toBe("true");
      expect(d.hasAttribute("data-vaul-drawer")).toBe(true);
      fireEvent.keyDown(d, {key: "Escape"});
      expect(onClose).not.toHaveBeenCalled();
      rerender(
        <Sheet open onClose={onClose} label="Routes">
          <p>list</p>
        </Sheet>,
      );
      fireEvent.keyDown(screen.getByRole("dialog"), {key: "Escape"});
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vp.restore();
    }
  });
});

describe("logos", () => {
  it("AssetIcon: bundled PNG first, then the monogram when the file fails", () => {
    const {container} = render(<AssetIcon token={{symbol: "ARB", caip2: "eip155:42161", contract: "0x912ce59144191c1204e64559fe8253a0e49e6548"}} size={34} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("logos/tokens/png/arb@2x.png");
    expect(img.getAttribute("sizes")).toBe("34px");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("ARB");
  });

  it("AssetIcon: SVG by symbol, gas token → its chain, unknown → monogram", () => {
    const tok = (symbol: string) => ({symbol, caip2: "", contract: null});
    const src = (symbol: string) => render(<AssetIcon token={tok(symbol)} />).container.querySelector("img")?.getAttribute("src");
    expect(src("USDC")).toBe("logos/tokens/USDC.svg");
    expect(src("MON")).toBe("logos/networks/monad.svg");
    const {container} = render(<AssetIcon token={tok("scrvUSD")} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("SCRV");
    expect(render(<AssetIcon network="morph" />).container.textContent).toBe("MORP");
  });

  it("an imported token is its monogram — never the logo its symbol names (D39)", () => {
    const fake = {symbol: "USDC", caip2: "eip155:8453", contract: "0x1111111111111111111111111111111111111111", chain: "base", imported: true};
    const {container} = render(<TokenIcon token={fake} />);
    expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["logos/networks/base.svg"]);
    expect(container.textContent).toBe("USDC");
  });

  it("an imported token shows the logo found by its contract, inline only — a URL that would load from a host is ignored", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const imported = {symbol: "DEGEN", caip2: "eip155:8453", contract: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", chain: "base", imported: true};
    const srcs = (token: typeof imported & {logo?: string}) => [...render(<TokenIcon token={token} />).container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs({...imported, logo})).toEqual([logo, "logos/networks/base.svg"]);
    expect(srcs({...imported, logo: "https://example.com/degen.png"})).toEqual(["logos/networks/base.svg"]);
    expect(srcs({...imported, logo: "data:text/html;base64,PGI+"})).toEqual(["logos/networks/base.svg"]);
    // A catalog token never takes a `logo`: its own bundled file stands.
    expect(srcs({symbol: "USDC", caip2: "eip155:8453", contract: "0x8335", chain: "base", imported: false, logo})).toEqual(["logos/tokens/USDC.svg", "logos/networks/base.svg"]);
  });

  it("TokenIcon adds the network badge; logos are decorative unless labelled", () => {
    const {container} = render(<TokenIcon token={{symbol: "USDC", caip2: "eip155:8453", contract: "0x8335", chain: "base"}} />);
    const srcs = [...container.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["logos/tokens/USDC.svg", "logos/networks/base.svg"]);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  it("ProviderLogo: tile with 1x/2x, unknown venue → its initial", () => {
    const {container} = render(<ProviderLogo provider="lifi" size={32} state="refused" />);
    expect(container.querySelector("img")?.getAttribute("srcset")).toBe("logos/providers/lifi.png 32w, logos/providers/lifi@2x.png 64w");
    expect(container.firstElementChild?.getAttribute("data-state")).toBe("refused");
    expect(render(<ProviderLogo provider="newvenue" name="Newvenue" />).container.textContent).toBe("N");
  });
});

describe("QrCode", () => {
  it("renders an SVG of dark modules with a name", () => {
    render(<QrCode value="bitcoin:bc1qexample?amount=0.01" aria-label="Deposit address QR code" />);
    const img = screen.getByRole("img", {name: "Deposit address QR code"});
    const svg = img.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("208");
    expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it("module count matches the QR version (21 for a short payload)", () => {
    expect(qrPath("hello")?.modules).toBe(21);
  });

  it("marks an expired code", () => {
    render(<QrCode value="x" expired aria-label="Expired" />);
    expect(screen.getByRole("img").getAttribute("data-expired")).toBe("true");
  });
});

describe("SwapSteps", () => {
  it("keeps the mobile test ids and marks the running step current", () => {
    render(
      <SwapSteps
        activeDetail="Waiting for Base…"
        steps={[
          {key: "confirm", label: "You confirmed the transaction", state: "done"},
          {key: "swap", label: "Swap on Base", state: "active"},
          {key: "deliver", label: "Deliver ETH on Arbitrum", state: "todo"},
        ]}
      />,
    );
    expect(screen.getByTestId("swap-steps")).toBeTruthy();
    expect(screen.getByTestId("swap-step-swap-active").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("swap-step-deliver-todo")).toBeTruthy();
    expect(screen.getByText("Waiting for Base…")).toBeTruthy();
  });
});

describe("TxReviewCard / VenueBadge", () => {
  it("puts the row's test id on the value", () => {
    render(<TxReviewCard rows={[{k: "Minimum received", v: "0.078 ETH", testId: "review-min"}]} />);
    expect(screen.getByTestId("review-min").textContent).toBe("0.078 ETH");
  });

  it("VenueBadge labels and explains the trust level", () => {
    render(<VenueBadge trust="provider-api" providerName="LI.FI" chainName="Base" />);
    expect(screen.getByText("API")).toBeTruthy();
    expect(screen.getByRole("tooltip", {hidden: true}).textContent).toBe("Quoted by LI.FI's API — checked in your browser before you sign");
  });
});

describe("Tooltip", () => {
  const VIEW = {width: 1280, height: 800};
  const TIP = {width: 200, height: 40};
  const at = (left: number, top: number, w = 40, h = 20) => ({left, top, right: left + w, bottom: top + h});

  it("placeTooltip: centred over the trigger, 8 px above it", () => {
    expect(placeTooltip(at(500, 300), TIP, VIEW)).toEqual({left: 420, top: 252, side: "top"});
    expect(placeTooltip(at(500, 300), TIP, VIEW, "bottom")).toEqual({left: 420, top: 328, side: "bottom"});
  });

  it("placeTooltip: slid back inside the viewport, 8 px from either edge (the left edge when it is too wide)", () => {
    // A "Preview" badge at the start of a row near the panel's left edge: centring would put it at -70.
    expect(placeTooltip(at(10, 300), TIP, VIEW).left).toBe(8);
    expect(placeTooltip(at(1230, 300), TIP, VIEW).left).toBe(1280 - 8 - 200);
    expect(placeTooltip(at(100, 300), {width: 400, height: 40}, {width: 375, height: 812}).left).toBe(8);
  });

  it("placeTooltip: flips to the other side without room, else takes the roomier side", () => {
    // 30 px under the viewport's top: no room above for 40 px (+ gap and margin), so below.
    expect(placeTooltip(at(500, 30), TIP, VIEW)).toEqual({left: 420, top: 58, side: "bottom"});
    // Asked for below at the viewport's bottom: above.
    expect(placeTooltip(at(500, 770), TIP, VIEW, "bottom")).toEqual({left: 420, top: 722, side: "top"});
    // Room on neither side (a 70 px viewport): the side with more of it.
    expect(placeTooltip(at(500, 10), TIP, {width: 1280, height: 70}).side).toBe("bottom");
    expect(placeTooltip(at(500, 40), TIP, {width: 1280, height: 70}, "bottom").side).toBe("top");
  });

  it("draws the tip on <body> while hovered or focused, aria-hidden; the description stays in place", () => {
    render(
      <div data-testid="clip" style={{overflow: "hidden"}}>
        <Tooltip content="Priced for a sample address">
          <button type="button">Preview</button>
        </Tooltip>
      </div>,
    );
    const trigger = screen.getByRole("button", {name: "Preview"});
    const wrap = trigger.parentElement!;
    const description = document.getElementById(wrap.getAttribute("aria-describedby")!)!;
    expect(description.getAttribute("role")).toBe("tooltip");
    expect(description.textContent).toBe("Priced for a sample address");
    expect(screen.getByTestId("clip").contains(description)).toBe(true);
    const drawn = () => [...document.body.children].filter((el) => el.textContent === "Priced for a sample address");
    expect(drawn()).toHaveLength(0);

    fireEvent.pointerEnter(wrap);
    expect(drawn()).toHaveLength(1);
    expect(drawn()[0]!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.pointerLeave(wrap);
    expect(drawn()).toHaveLength(0);

    fireEvent.focus(trigger);
    expect(drawn()).toHaveLength(1);
    fireEvent.blur(trigger);
    expect(drawn()).toHaveLength(0);
    // The description outlives the tip.
    expect(document.getElementById(description.id)).toBe(description);
  });

  it("a scroll drops a hover tip; a focus tip stays with its trigger", () => {
    render(
      <Tooltip content="Quoted by a THORChain node">
        <button type="button">Node</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", {name: "Node"});
    const drawn = () => [...document.body.children].filter((el) => el.textContent === "Quoted by a THORChain node");
    fireEvent.pointerEnter(trigger.parentElement!);
    expect(drawn()).toHaveLength(1);
    fireEvent.scroll(window);
    expect(drawn()).toHaveLength(0);
    fireEvent.focus(trigger);
    fireEvent.scroll(window);
    expect(drawn()).toHaveLength(1);
  });

  it("touch shows no hover tip", () => {
    const vp = installMatchMedia(375);
    const hoverless = window.matchMedia;
    window.matchMedia = (q: string) => (q === "(hover: hover)" ? ({matches: false} as MediaQueryList) : hoverless(q));
    try {
      render(
        <Tooltip content="On-chain">
          <span>Tag</span>
        </Tooltip>,
      );
      fireEvent.pointerEnter(screen.getByText("Tag").parentElement!);
      expect([...document.body.children].some((el) => el.textContent === "On-chain")).toBe(false);
    } finally {
      vp.restore();
    }
  });
});

describe("useBreakpoint", () => {
  it("follows the viewport across 640 and 1024", () => {
    const vp = installMatchMedia(375);
    try {
      const {result} = renderHook(() => useBreakpoint());
      expect(result.current).toBe("phone");
      act(() => vp.setWidth(768));
      expect(result.current).toBe("tablet");
      act(() => vp.setWidth(1280));
      expect(result.current).toBe("desktop");
      act(() => vp.setWidth(639));
      expect(result.current).toBe("phone");
    } finally {
      vp.restore();
    }
  });

  it("is desktop where matchMedia does not exist", () => {
    const {result} = renderHook(() => useBreakpoint());
    expect(result.current).toBe("desktop");
  });
});
