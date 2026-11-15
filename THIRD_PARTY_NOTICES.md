# Third-party notices

cp0x Swap's own source code is licensed under the [Apache License 2.0](LICENSE). The app bundles third-party
code, fonts and images, and each keeps its own licence. They are listed below. This file ships with every
distribution: the build copies it (and `LICENSE`) into `dist/`, so the hosted site, the Docker image, `npx` and
IPFS releases all serve it next to `index.html` as `THIRD_PARTY_NOTICES.md`, linked from the app's footer
("Licences").

Nothing here is offered under a new licence by cp0x. Trademarks belong to their owners. They are used only to name
the venue, network or token they identify, and no endorsement is implied.

## Any Wallet Kit — Apache-2.0

The swap engine, the router and every venue provider are the `@anywalletkit/*` packages
([docs.anywallet.tech](https://docs.anywallet.tech)), used unmodified from npm under the Apache License 2.0. The
packages ship no NOTICE file. Their licence text is the same Apache-2.0 text as this repository's [LICENSE](LICENSE).

## WalletConnect and Reown — community licences (not open source)

`@walletconnect/*` 2.26 and `@reown/appkit*` 1.8 (pulled in by `@walletconnect/ethereum-provider` and wagmi's
WalletConnect connector) are **not** under an open-source licence. They are distributed under the WalletConnect
Community License Agreement and the Reown Community License Agreement. Both require this notice:

> Portions © 2025 Reown, Inc. All Rights Reserved

The full agreements are reproduced in the appendices below, as both agreements require. The cp0x Swap code itself
stays Apache-2.0. These terms cover only the WalletConnect and Reown parts of the bundle. WalletConnect loads only
when the operator sets `walletConnect.projectId` and the user picks it. The AppKit modal (`showQrModal`) is off.

## TON Connect UI — Apache-2.0

`@tonconnect/ui` 2.4.4, TON Connect's wallet picker, loads only when the viewer picks "TON Connect". It is under the
Apache License 2.0 (listed below) and its build compiles in solid-js, solid-styled-components (goober),
solid-transition-group, @solid-primitives/i18n, @floating-ui/dom, solid-floating-ui, qrcode-generator and
is-plain-object, all MIT. Those are not in `pnpm-lock.yaml`, so the list below does not name them.

## Fonts — SIL Open Font License 1.1

**Cp0xGrotesk** (`public/fonts/Cp0xGrotesk-*.woff2`) is Space Grotesk, Copyright 2020 The Space Grotesk Project
Authors (<https://github.com/floriankarsten/space-grotesk>), with the "0" glyphs replaced by the cp0x zero. It
is renamed and released under the SIL Open Font License 1.1, whose full text ships beside the fonts as
[`public/fonts/OFL.txt`](public/fonts/OFL.txt). The original declares no Reserved Font Name. The font may not be
sold by itself.

## Logos and images

All images are bundled with the app, and none is loaded from a third-party server at runtime. The per-file
details are in [`public/logos/LICENSES.md`](public/logos/LICENSES.md).

| files | source | licence |
|---|---|---|
| `public/logos/networks/*.svg`, `public/logos/tokens/*.svg` | [web3icons](https://github.com/0xa3k5/web3icons) (`@web3icons/core`, branded set), via the cp0x wallet's generated `logos.ts` | MIT, Copyright (c) 2024 0xa3k5 (text below) |
| Zcash mark (`public/logos/networks/zcash.svg`) | [spothq/cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) | CC0-1.0 (public domain dedication) |
| Elysium network mark (`public/logos/networks/elysium.svg`) | LI.FI's [`lifinance/types`](https://github.com/lifinance/types) chain icons; modified by cp0x (white square background removed) | Apache-2.0 |
| `public/logos/providers/*.png` (venue logos) | each venue's own mark (from the Any Wallet Kit landing page set, Relay's and Symbiosis' apple-touch icons, Fynd's docs icon, Curve's web3icons token mark), and cp0x-drawn tiles for Uniswap, Balancer and Wrap | trademarks of their owners, used nominatively to name the venue |
| `public/logos/tokens/png/*` (token logos) | each project's logo as listed on CoinGecko, and cp0x.com's DAO delegation logos | trademarks of their owners, shown only to identify the token |
| `public/logos/ton-wallets/*.png` (TON wallet icons) | the `image` of each wallet in TON Connect's official list (config.ton.org/wallets-v2.json), downscaled to 96 px | trademarks of their owners, used nominatively to name each wallet in TON Connect's picker |
| `public/logos/tonconnect/*.png` | `@tonconnect/ui`'s own images from [ton-connect/sdk](https://github.com/ton-connect/sdk) `assets/`, unmodified | Apache-2.0; TON's and Telegram's marks |
| cp0x mark and wordmark | cp0x | cp0x's own marks |

<details>
<summary>web3icons MIT licence</summary>

```
MIT License

Copyright (c) 2024 0xa3k5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

</details>

## Other dependencies

These are the licences of every production dependency in `pnpm-lock.yaml`, as reported by
`pnpm licenses list --prod` on 2026-11-13. The list covers more than the bundle, since the bundler drops code the
app never imports. Each package's own licence file and copyright notice are in its npm tarball. "Unknown" means the
package declares `SEE LICENSE IN LICENSE.md`: those are the WalletConnect and Reown packages above. Regenerate this
section after a dependency change:

```sh
pnpm licenses list --prod
```

### Apache-2.0 (45)
`@anywalletkit/core`, `@anywalletkit/protocol-swap2-0x`, `@anywalletkit/protocol-swap2-across`, `@anywalletkit/protocol-swap2-balancer`, `@anywalletkit/protocol-swap2-cctp`, `@anywalletkit/protocol-swap2-chainflip`, `@anywalletkit/protocol-swap2-core`, `@anywalletkit/protocol-swap2-curve`, `@anywalletkit/protocol-swap2-fynd`, `@anywalletkit/protocol-swap2-jupiter`, `@anywalletkit/protocol-swap2-lifi`, `@anywalletkit/protocol-swap2-near-intents`, `@anywalletkit/protocol-swap2-omniston`, `@anywalletkit/protocol-swap2-relay`, `@anywalletkit/protocol-swap2-router`, `@anywalletkit/protocol-swap2-symbiosis`, `@anywalletkit/protocol-swap2-thorchain`, `@anywalletkit/protocol-swap2-uniswap`, `@anywalletkit/protocol-swap2-usdt0`, `@anywalletkit/protocol-swap2-wrap`, `@anywalletkit/swap2-assets`, `@anywalletkit/tx-preview-evm`, `@anywalletkit/wallet-evm`, `@anywalletkit/wallet-solana`, `@base-org/account`, `@solana-program/compute-budget`, `@solana-program/record`, `@solana-program/system`, `@solana-program/token`, `@solana-program/token-2022`, `@solana-program/zk-elgamal-proof`, `@solana/wallet-standard-features`, `@tonconnect/isomorphic-eventsource`, `@tonconnect/isomorphic-fetch`, `@tonconnect/protocol`, `@tonconnect/sdk`, `@tonconnect/ui`, `@wallet-standard/app`, `@wallet-standard/base`, `@wallet-standard/features`, `@wallet-standard/wallet`, `axios-retry`, `idb-keyval`, `rxjs`, `typescript`

### MIT (236)
`@adraffy/ens-normalize`, `@coinbase/cdp-sdk`, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@phosphor-icons/webcomponents`, `@radix-ui/primitive`, `@radix-ui/react-compose-refs`, `@radix-ui/react-context`, `@radix-ui/react-dialog`, `@radix-ui/react-dismissable-layer`, `@radix-ui/react-focus-guards`, `@radix-ui/react-focus-scope`, `@radix-ui/react-id`, `@radix-ui/react-portal`, `@radix-ui/react-presence`, `@radix-ui/react-primitive`, `@radix-ui/react-slot`, `@radix-ui/react-use-callback-ref`, `@radix-ui/react-use-controllable-state`, `@radix-ui/react-use-effect-event`, `@radix-ui/react-use-layout-effect`, `@safe-global/safe-apps-provider`, `@safe-global/safe-apps-sdk`, `@safe-global/safe-gateway-typescript-sdk`, `@scure/base`, `@scure/bip32`, `@scure/bip39`, `@solana/accounts`, `@solana/addresses`, `@solana/assertions`, `@solana/codecs`, `@solana/codecs-core`, `@solana/codecs-data-structures`, `@solana/codecs-numbers`, `@solana/codecs-strings`, `@solana/errors`, `@solana/fast-stable-stringify`, `@solana/fixed-points`, `@solana/functional`, `@solana/instruction-plans`, `@solana/instructions`, `@solana/keys`, `@solana/kit`, `@solana/nominal-types`, `@solana/offchain-messages`, `@solana/options`, `@solana/plugin-core`, `@solana/plugin-interfaces`, `@solana/program-client-core`, `@solana/programs`, `@solana/promises`, `@solana/rpc`, `@solana/rpc-api`, `@solana/rpc-parsed-types`, `@solana/rpc-spec`, `@solana/rpc-spec-types`, `@solana/rpc-subscriptions`, `@solana/rpc-subscriptions-api`, `@solana/rpc-subscriptions-channel-websocket`, `@solana/rpc-subscriptions-spec`, `@solana/rpc-transformers`, `@solana/rpc-transport-http`, `@solana/rpc-types`, `@solana/signers`, `@solana/subscribable`, `@solana/sysvars`, `@solana/transaction-confirmation`, `@solana/transaction-introspection`, `@solana/transaction-messages`, `@solana/transactions`, `@ston-fi/omniston-sdk`, `@tanstack/query-core`, `@tanstack/react-query`, `@tanstack/react-virtual`, `@tanstack/virtual-core`, `@ton/core`, `@ton/crypto`, `@ton/crypto-primitives`, `@types/react`, `@types/react-dom`, `@types/trusted-types`, `@wagmi/connectors`, `@wagmi/core`, `@walletconnect/environment`, `@walletconnect/events`, `@walletconnect/heartbeat`, `@walletconnect/jsonrpc-http-connection`, `@walletconnect/jsonrpc-provider`, `@walletconnect/jsonrpc-types`, `@walletconnect/jsonrpc-utils`, `@walletconnect/jsonrpc-ws-connection`, `@walletconnect/keyvaluestorage`, `@walletconnect/logger`, `@walletconnect/relay-api`, `@walletconnect/relay-auth`, `@walletconnect/safe-json`, `@walletconnect/time`, `@walletconnect/window-getters`, `@walletconnect/window-metadata`, `abitype`, `agent-base`, `ansi-regex`, `ansi-styles`, `aria-hidden`, `asynckit`, `atomic-sleep`, `axios`, `base-x`, `base64-js`, `big.js`, `blakejs`, `bs58`, `buffer`, `call-bind-apply-helpers`, `camelcase`, `chalk`, `chokidar`, `classnames`, `clsx`, `color-convert`, `color-name`, `combined-stream`, `commander`, `cookie-es`, `cross-fetch`, `crossws`, `csstype`, `dayjs`, `debug`, `decamelize`, `deepmerge`, `defu`, `delayed-stream`, `destr`, `detect-browser`, `detect-node-es`, `dijkstrajs`, `dunder-proto`, `emoji-regex`, `encode-utf8`, `es-define-property`, `es-errors`, `es-object-atoms`, `es-set-tostringtag`, `es-toolkit`, `eventemitter3`, `events`, `eventsource`, `find-up`, `follow-redirects`, `form-data`, `function-bind`, `get-intrinsic`, `get-nonce`, `get-proto`, `gopd`, `h3`, `has-symbols`, `has-tostringtag`, `hasown`, `https-proxy-agent`, `iron-webcrypto`, `is-buffer`, `is-fullwidth-code-point`, `is-retry-allowed`, `isomorphic-ws`, `isows`, `jose`, `json-rpc-2.0`, `keyvaluestorage-interface`, `locate-path`, `math-intrinsics`, `mime-db`, `mime-types`, `mipd`, `ms`, `node-fetch`, `node-fetch-native`, `node-mock-http`, `normalize-path`, `ofetch`, `on-exit-leak-free`, `ox`, `p-limit`, `p-locate`, `p-try`, `path-exists`, `picomatch`, `pino`, `pino-abstract-transport`, `pino-std-serializers`, `pngjs`, `preact`, `process-warning`, `proxy-compare`, `proxy-from-env`, `qrcode`, `quick-format-unescaped`, `radix3`, `react`, `react-dom`, `react-remove-scroll`, `react-remove-scroll-bar`, `react-style-singleton`, `readdirp`, `real-require`, `require-directory`, `safe-stable-stringify`, `scheduler`, `slow-redact`, `sonic-boom`, `string-width`, `strip-ansi`, `thread-stream`, `tr46`, `ua-parser-js`, `ufo`, `uint8arrays`, `uncrypto`, `undici-types`, `unstorage`, `uqr`, `use-callback-ref`, `use-sidecar`, `use-sync-external-store`, `valtio`, `vaul`, `viem`, `wagmi`, `whatwg-url`, `wrap-ansi`, `ws`, `yargs`, `zod`, `zustand`

### BSD-3-Clause (11)
`@lit-labs/ssr-dom-shim`, `@lit/react`, `@lit/reactive-element`, `charenc`, `crypt`, `ieee754`, `jssha`, `lit`, `lit-element`, `lit-html`, `md5`

### BSD-2-Clause (1)
`webidl-conversions`

### ISC (11)
`@msgpack/msgpack`, `anymatch`, `cliui`, `get-caller-file`, `require-main-filename`, `semver`, `set-blocking`, `split2`, `which-module`, `y18n`, `yargs-parser`

### 0BSD (1)
`tslib`

### BlueOak-1.0.0 (1)
`lru-cache`

### (Apache-2.0 AND MIT) (1)
`multiformats`

### Unlicense (2)
`tweetnacl`, `tweetnacl-util`

### Unknown (15)
`@reown/appkit`, `@reown/appkit-common`, `@reown/appkit-controllers`, `@reown/appkit-pay`, `@reown/appkit-polyfills`, `@reown/appkit-scaffold-ui`, `@reown/appkit-ui`, `@reown/appkit-utils`, `@reown/appkit-wallet`, `@walletconnect/core`, `@walletconnect/ethereum-provider`, `@walletconnect/sign-client`, `@walletconnect/types`, `@walletconnect/universal-provider`, `@walletconnect/utils`

## Appendix A — WalletConnect Community License Agreement

Reproduced verbatim from `@walletconnect/ethereum-provider@2.26.0/LICENSE.md` (identical in every `@walletconnect/*` package listed above).

<details>
<summary>Full text</summary>

**WALLETCONNECT COMMUNITY LICENSE AGREEMENT**

**Release Date: 20 August 2025**

You, or the company or organization of which you are an employee, agent, or contractor (“**You**”, “**Your**”), desire a license from Reown, Inc. (“**We**”, “**Us**”, “**Our**”) to use the WalletKit software development kit, documentation and related materials (collectively, “**WalletKit Items**”). Before You access the WalletKit Items, We need to establish what you can expect from Us, and what We expect from You. By accessing and using the WalletKit Items, You confirm that You reviewed and You agree to this License Agreement (“**License**”), and that You are authorized to bind the company or organization you represent to this License. **_By downloading, installing, integrating and/or using the_** \*WalletKit **Items, you or the organization you represent, as applicable, agree to be bound by and become a party to this License as a "Licensee". If you do not agree to all of the terms of this License, you are not a Licensee and you may not download, install, or use (or must cease using) the WalletKit Items.\***

**1\. LICENSE**

**a. Grant of Rights.** Subject to the terms and conditions of this License We grant You (and not Your affiliates or related persons), and You accept, a perpetual (subject to Section 8(b) Termination), non-exclusive, non-transferable (subject to Section 11(c) Assignment), non-sublicensable, and worldwide license under Our intellectual property rights to use, display, copy, transmit, distribute, modify, adapt, and create derivative works of the WalletKit Items.

**b. Educational, Research and New Application Uses.** If You are using the WalletKit Items for educational or non-commercial research purposes, the License We grant You is royalty-free. In addition, Your use of WalletKit Items for development, maintenance and enhancement of Your applications and wallets is royalty-free, subject to Section 3\.

**c. Modification of WalletKit Items.** We own all right, title and interest to the intellectual property rights (including, but not limited to patent, copyright, and trademark rights) to any modification to or derivative work of the WalletKit Items that You may develop, and you hereby assign any and all such rights to such modifications and derivative works to Us, subject to the following:

(i) We hereby grant back to You a perpetual, non-exclusive, non-transferable, royalty-free, worldwide right and license to use these modifications and derivative works solely in conjunction with the WalletKit Items and only while this License remains in effect. You must cause any modified files to carry prominent notices stating that You changed the files. We and our assignees and Our and their licensees may use such modifications and derivative works without any approval from You and without compensation or attribution to You. You also agree to provide the source and binary code of any such modifications and derivative works to Us at the email address We may designate from time to time.

    (ii) For the avoidance of doubt, Your applications and wallets that you develop using the WalletKit Items are not modifications or derivative works of the WalletKit Items. You retain all rights to your applications and wallets, and you have no obligation to share or license Your applications or wallets with Us or with any third parties; provided, however, We retain all rights to the WalletKit Items and any modifications or derivative works thereof that may be incorporated into your applications and wallets.

**2\. REDISTRIBUTION AND USE**

**a. Distribution Requirements.** If You distribute or make available the WalletKit Items (including any modifications to or derivative works thereof) or any product or service that uses them (including Your applications and wallets), You must (i) include the following copyright notice in the notices or readme.txt of the product, or the about section of the website for the services: “Portions © 2025 Reown, Inc. All Rights Reserved” ; (ii) provide a copy of this License Agreement with any applications or wallets containing such WalletKit Items or that are required for the use thereof; and (iii) applicable logo and branding.

**b. Network Connection.** As a material condition of this License, all use, distribution or derivatives works of the WalletKit Items must connect to the proprietary Reown gateway infrastructure, or its successor, and its related WalletConnect messaging protocol (collectively, the “**Network**”) unless we explicitly approve you doing otherwise. You further agree not to circumvent this requirement, or instruct or suggest to Your end users to do so.

**c. Compliance with Law.** We are not in a position to monitor and assess the legality and regulatory treatment of your business and operations. Your use of the WalletKit Items must comply with all applicable laws and regulations and Our Terms of Service and Acceptable Use Policy, as amended from time to time, the terms of which are incorporated herein by reference.

**d. Use of Marks.** This License does not grant permission to use Our trade names, trademarks, service marks, or product names (collectively, the “**Marks**”), except as permitted by Our Marks usage guidelines or as required for disclosure of the development of Your applications or wallets, reproducing the attribution notice in the readme.txt file, or Your redistribution of WalletKit Items. We reserve all rights not expressly granted to you under this License. Unless explicitly approved by Us, in no event will You use Our name, trademarks, or logos to endorse or imply Our endorsement of products derived from WalletKit Items or any products or services that use WalletKit Items. Where You are permitted to use the Marks, You must comply with Our then-current trademark and logo usage guidelines, as may be updated from time to time without notice from Us. All goodwill arising out of Your use of any Mark will inure solely to Us.

**e. Export Controls.** You and We acknowledge that the WalletKit Items and all related technical information, documents and materials are subject to export controls under the U.S. Export Administration Regulations. You and We will (i) comply strictly with all legal requirements established under these controls, (ii) cooperate fully with each other in any official or unofficial audit or inspection that relates to these controls and (iii) not export, re-export, divert or transfer, directly or indirectly, any such item or direct products thereof to Cuba, Iran, North Korea, Sudan, and the Crimea, Donetsk, Luhansk, Kherson and Zaporizhzhia region not controlled by the government of Ukraine, or any national thereof or to any country or national thereof that is embargoed by Executive order, unless such party has obtained the prior written authorization of the other party and U.S. Commerce Department. We may modify this list to conform to changes in the U.S. Export Administration Regulations.

**3\. LIMITED COMMERCIAL USE**

If the number of remote processing calls (RPCs) made by, or monthly active users of (MAUs), associated with Your application or wallet developed using WalletKit Items, or your product or service that uses WalletKit Items exceed the thresholds set forth below, determined in our sole discretion, You must enter into and pay applicable fees and charges for a commercial license. You may contact Reown for these purposes using [this form](https://share.hsforms.com/1_oWa8QkwRXi6oR0nZ_SIxQnxw6s).

- Monthly RPC limit of 2,500,000

- Monthly MAU limit of 500

MAU means, as applicable: (1) a unique externally owned account that authenticates and connects to your app in a 30 day period; or (2) a unique embedded wallet that is created on, and authenticates and connects, to your app in a 30 day period

We reserve the right to change the RPC and/or MAU limit thresholds and/or set different or additional triggers or thresholds for requiring a commercial license. The current thresholds or triggers for a commercial license may be published on Our [Terms of Service](https://reown.com/terms-of-service).

**4\. DISCLAIMER OF WARRANTY**

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE WALLETKIT ITEMS ARE PROVIDED “AS IS” WITHOUT WARRANTIES OF ANY KIND. ALL WARRANTIES, CONDITIONS, REPRESENTATIONS, INDEMNITIES AND GUARANTEES WITH RESPECT TO THE WALLETKIT ITEMS, WHETHER EXPRESS OR IMPLIED, ARISING BY LAW, CUSTOM, PRIOR ORAL OR WRITTEN STATEMENTS BY US OR OTHERWISE (INCLUDING, BUT NOT LIMITED TO ANY WARRANTY OF MERCHANTABILITY, SATISFACTORY QUALITY, FITNESS FOR PARTICULAR PURPOSE AND NON-INFRINGEMENT) ARE HEREBY OVERRIDDEN, EXCLUDED AND DISCLAIMED. SOME JURISDICTIONS DO NOT PERMIT THE DISCLAIMER OF ALL WARRANTIES SO YOU MAY HAVE ADDITIONAL RIGHTS PROVIDED BY LAW.

**5\. LIMITATION OF LIABILITY**

IN NO EVENT AND UNDER NO LEGAL THEORY, WHETHER IN TORT (INCLUDING NEGLIGENCE), CONTRACT, OR OTHERWISE, UNLESS REQUIRED BY APPLICABLE LAW DESPITE THIS LIMITATION OR AGREED TO IN WRITING BY US, WILL WE BE LIABLE TO YOU OR YOUR LICENSEES OR SUBLICENSEES FOR ANY DAMAGES, INCLUDING ANY DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES OF ANY CHARACTER ARISING AS A RESULT OF THIS LICENSE OR OUT OF THE USE OR INABILITY TO USE THE WALLETKIT ITEMS OR ANY PORTION THEREOF (INCLUDING BUT NOT LIMITED TO DAMAGES FOR LOSS OF GOODWILL, WORK STOPPAGE, COMPUTER FAILURE OR MALFUNCTION, OR ANY AND ALL OTHER COMMERCIAL DAMAGES OR LOSSES), EVEN IF WE OR OUR AFFILIATES HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. SOME JURISDICTIONS DO NOT PERMIT THE EXCLUSION OF ALL DAMAGES SO YOU MAY HAVE ADDITIONAL RIGHTS PROVIDED BY LAW.

**6\. INTELLECTUAL PROPERTY**

All trademarks, service marks, patents, copyrights, trade secrets, or other proprietary rights in or related to the WalletKit Items are and will remain Our exclusive property (or that of Our licensors). You will not take any action that jeopardizes those rights, nor will you acquire any right in the WalletKit Items, except the limited use rights specified in this License. You acknowledge that We (or Our licensors) will own all rights in any copy, translation, modification, adaptation or derivative works of the WalletKit Items (whether or not authorized by Us), and You will provide any instrument We reasonably request that you obtain to give full legal effect to Our rights under this Section.

**7\. CONFIDENTIALITY**

You acknowledge that the WalletKit Items incorporate nonpublic confidential and proprietary information We have developed or acquired or licensed ("**Confidential Information**"). You will keep the Confidential Information in the strictest confidence and will not use or copy any Confidential Information, or disclose it to any other person. You will not permit removal or defacing of any confidentiality or proprietary notice placed on or in the WalletKit Items, and any copyright notices on or in these items does not constitute publication or make them non-confidential.

**8\. TERM AND TERMINATION**

**a. Term.** The term of this Agreement will commence upon Your accessing the WalletKit Items and will continue in full force and effect until terminated in accordance with the terms and conditions of this License. As this License is updated for future releases of the WalletKit Items, You must abide by and meet all requirements of future updates of this License for those future releases of WalletKit Items, and such future updates of this License will apply to such future applications and wallets that may be developed with that future release of WalletKit Items or any portion thereof. You may not use older versions of the SDK to circumvent the terms applicable to new versions you choose to download or use.

    **b.	Termination.** This License terminates (i) 30 days after either We notify you in writing that You have breached a material term of this License, if that breach is not cured before then, or (ii) immediately and automatically if You are declared bankrupt or become insolvent. Your right to access the Network ceases, if this License terminates, and We may disable Your access to the Network upon such termination. You may terminate this License at any time by disintegrating WalletKit  Items from your products and services and disabling access to the Network. If this License terminates, You must immediately cease all use of and delete the WalletKit Items, in whole or in part, as well as any Confidential Information, in Your possession or control.  At Our request, You will certify Your compliance with these obligations in writing. Sections 2, 4 through 7, 8(b), and 9 through 11 will survive any termination of this Agreement.

**9\. GOVERNING LAW**

This Agreement will be governed and construed under the laws of the State of Delaware, U.S.A., without regard to choice of law principles, and the UN Convention on Contracts for the International Sale of Goods does not apply to this Agreement.

**10\. DISPUTE RESOLUTION**

PLEASE READ THE FOLLOWING SECTION CAREFULLY BECAUSE IT REQUIRES YOU TO SUBMIT TO BINDING ARBITRATION (JURY TRIAL WAIVER) OF ANY AND ALL DISPUTES (OTHER THAN SPECIFIED SMALL CLAIMS) WITH REOWN, INC. AND LIMITS THE MANNER IN WHICH YOU CAN SEEK RELIEF FROM REOWN, INC. (NO CLASS ARBITRATIONS, CLASS ACTIONS OR REPRESENTATIVE ACTIONS OR ARBITRATIONS).

**a. Binding Arbitration; Disputes; Small Claims.** **You and We waive any right to a jury trial, or the right to have any Dispute resolved in any court, and instead accept the use of binding arbitration (which is the referral of a Dispute to one or more impartial persons for a final and binding determination); provided, however, that you have the right to litigate any Dispute in small claims court, if all the requirements of the small claims court, including any limitations on jurisdiction and the amount at issue in the Dispute, are satisfied. You agree to bring a Dispute in small claims court in the State of Delaware**. “**Dispute**” **as used in this Section 10 means any dispute, cause of action, claim, or controversy arising out of or in any way related to Us, this License, the subject matter of this License, or access to and use of the WalletKit Items, in whole or in part, or the Network, including but not limited to personal injury disputes and disputes that involve third parties (such as developers of applications or wallets).**

**b. No Class Arbitrations, Class Actions or Representative Actions.** **You and We agree that any Dispute is personal to You and Us, and that any Dispute must only be resolved by an individual arbitration and may not be brought as a class arbitration, a class action, or any other representative proceeding. Neither party agrees to class arbitration, or an arbitration where a person brings a Dispute as a representative of any other person or persons. Neither You nor We agree that a Dispute can be brought as a class or representative action whether inside or outside of arbitration, or on behalf of any other person or persons**.

**c. Federal Arbitration Act.** You and We agree that the terms of this License affect interstate commerce and that the enforceability of Section 10 is governed by, construed, and enforced, both substantively and procedurally, by the Federal Arbitration Act, 9 U.S.C. § 1 et seq. (“**FAA**”) to the maximum extent permitted by applicable law.

**d. Confidentiality.** The arbitrator, You and We must maintain the confidentiality of any proceedings, including but not limited to, any and all information gathered, prepared, and presented for purposes of the arbitration or related to the Dispute(s) therein. The arbitrator has the authority to make appropriate rulings to safeguard that confidentiality, unless the law provides to the contrary.

**e. Process.** Our goal is to resolve claims fairly and quickly. Accordingly, for any Dispute that you have against Us, you must first contact Us and attempt to resolve the claim informally by sending a written notice of your claim (“**Notice**”) to Us. The Notice to Us must be sent by certified mail addressed to: Reown Inc., 200 Continental Drive, 401, Newark, DE 19713 USA and a copy must be sent on the same day via email to Legal@walletconnect.com. The Notice must (a) include Your name, residence address, projectID and the email address and/or mobile telephone number associated with your account; (b) describe the nature and basis of the claim; and (c) set forth the specific relief sought. If You and We cannot reach an agreement to resolve the claim within 30 days after such Notice is received, then either party may, as appropriate in accordance with this Section 10, commence an arbitration proceeding or file a claim in small claims court.

**f. Binding Arbitration.** In the event that You and We cannot resolve a Dispute and do not pursue the matter through small claims court, You or We must promptly submit the Dispute to binding arbitration before the American Arbitration Association (“**AAA**”). In the event AAA declines or is unable to administer the arbitration, You and We agree to use an arbitration forum or arbitrator that You and We mutually agree upon. If, after making a reasonable effort, You and We are not able to agree upon an arbitration forum or arbitrator, AAA or a court having proper jurisdiction will appoint an arbitration forum or arbitrator. The arbitration will be conducted in accordance with the AAA Consumer Arbitration Rules (“**AAA Rules**”) then in effect. The AAA Rules and other information about AAA and arbitration are readily available at [http://www.adr.org](http://www.adr.org/), by calling 1-800-778-7879, or by mail at 120 Broadway, Floor 21, New York, NY 10271\. By entering into this License, you either (1) acknowledge that you have read and understand the AAA Rules or (2) waive reading the AAA Rules and waive any claim that the AAA Rules are unfair in any way. You and We agree that the terms of this License govern the arbitration, and that the applicable AAA Rules are subject to changes in procedures that AAA may make from time to time.

**g. Arbitrator Empowered.** As limited by the FAA, the terms of this License, and the applicable AAA Rules, the arbitrator will have the exclusive power and jurisdiction to make all procedural and substantive decisions concerning the Dispute; provided, however, that this power does not include: (i) the power to determine the question of arbitrability, which power You and We agree is vested solely in a court of competent jurisdiction; or (ii) the power to conduct a class arbitration or a representative action, which is prohibited by the terms of this License (as stated above). The arbitrator may only conduct an individual arbitration, and may not consolidate more than one person’s claims and may not preside over any form of representative or class proceeding, or any proceeding on behalf of or involving more than one person or persons.

**11\. MISCELLANEOUS**

**a. Amendment.** This License may be amended by Us on a prospective basis, and your usage of the License after such amendments or changes signifies your consent to and acceptance of any such amendments or changes on a going forward basis.

**b. Severability.** In the event any provision of this License is determined to be invalid, prohibited or unenforceable by a court or other body of competent jurisdiction, this License must be construed as if such invalid, prohibited or unenforceable provision has been more narrowly drawn so as not to be invalid, prohibited or unenforceable.

**c. Assignment.** You may not assign any rights or obligations under this License, including by operation of law, without Our prior written consent, which may be withheld in its sole discretion. We may assign Our rights or obligations under this License in Our sole discretion.

**d. Waiver.** Failure of either party at any time to enforce any of the provisions of this License will not be construed as a waiver of such provisions or in any way affect the validity of this License or parts thereof.

</details>

## Appendix B — Reown Community License Agreement

Reproduced verbatim from `@reown/appkit@1.8.19/LICENSE.md` (identical in every `@reown/*` package listed above).

<details>
<summary>Full text</summary>

**REOWN COMMUNITY LICENSE AGREEMENT**

**Release Date: 25 August 2025**

You, or the company or organization of which you are an employee, agent, or contractor (“**You**”, “**Your**”), desire a license from Reown, Inc. (“**We**”, “**Us**”, “**Our**”) to use the Reown AppKit, Blockchain-API software development kit, documentation and related materials (collectively, “**AppKit Items**”). Before You access the AppKit Items, We need to establish what you can expect from Us, and what We expect from You. By accessing and using the AppKit Items, You confirm that You reviewed and You agree to this License Agreement (“**License**”), and that You are authorized to bind the company or organization you represent to this License. By downloading, installing, integrating and/or using the AppKit Items, you or the organization you represent, as applicable, agree to be bound by and become a party to this License as a "Licensee". If you do not agree to all of the terms of this License, you are not a Licensee and you may not download, install, or use (or must cease using) the AppKit Items.

**1\. LICENSE**

**a. Grant of Rights.** Subject to the terms and conditions of this License We grant You (and not Your affiliates or related persons), and You accept, a perpetual (subject to Section 8(b) Termination), non-exclusive, non-transferable (subject to Section 11(c) Assignment), non-sublicensable, and worldwide license under Our intellectual property rights to use, display, copy, transmit, distribute, modify, adapt, and create derivative works of the AppKit Items.

**b. Educational, Research and New Application Uses.** If You are using the AppKit Items for educational or non-commercial research purposes, the License We grant You is royalty-free. In addition, Your use of AppKit Items for development, maintenance and enhancement of Your applications and wallets is royalty-free, subject to Section 3\.

**c. Modification of AppKit Items.** We own all right, title and interest to the intellectual property rights (including, but not limited to patent, copyright, and trademark rights) to any modification to or derivative work of the AppKit Items that You may develop, and you hereby assign any and all such rights to such modifications and derivative works to Us, subject to the following:

(i) We hereby grant back to You a perpetual, non-exclusive, non-transferable, royalty-free, worldwide right and license to use these modifications and derivative works solely in conjunction with the AppKit Items and only while this License remains in effect. You must cause any modified files to carry prominent notices stating that You changed the files. We and our assignees and Our and their licensees may use such modifications and derivative works without any approval from You and without compensation or attribution to You. You also agree to provide the source and binary code of any such modifications and derivative works to Us at the email address We may designate from time to time.

    (ii) For the avoidance of doubt, Your applications and wallets that you develop using the AppKit Items are not modifications or derivative works of the AppKit Items. You retain all rights to your applications and wallets, and you have no obligation to share or license Your applications or wallets with Us or with any third parties; provided, however, We retain all rights to the AppKit Items and any modifications or derivative works thereof that may be incorporated into your applications and wallets.

**2\. REDISTRIBUTION AND USE**

**a. Distribution Requirements.** If You distribute or make available the AppKit Items (including any modifications to or derivative works thereof) or any product or service that uses them (including Your applications and wallets), You must (i) include the following copyright notice in the notices or readme.txt of the product, or the about section of the website for the services: “Portions © 2025 Reown, Inc. All Rights Reserved” ; (ii) provide a copy of this License Agreement with any applications or wallets containing such AppKit Items or that are required for the use thereof; and (iii) applicable logo and branding.

**b. Network Connection.** As a material condition of this License, all use, distribution or derivatives works of the AppKit Items must connect to the proprietary Reown gateway infrastructure, or its successor, and its related WalletConnect messaging protocol (collectively, the “**Network**”) unless we explicitly approve you doing otherwise. You further agree not to circumvent this requirement, or instruct or suggest to Your end users to do so.

**c. Compliance with Law.** We are not in a position to monitor and assess the legality and regulatory treatment of your business and operations. Your use of the AppKit Items must comply with all applicable laws and regulations and Our Terms of Service and Acceptable Use Policy, as amended from time to time, the terms of which are incorporated herein by reference.

**d. Use of Marks.** This License does not grant permission to use Our trade names, trademarks, service marks, or product names (collectively, the “**Marks**”), except as permitted by Our Marks usage guidelines or as required for disclosure of the development of Your applications or wallets, reproducing the attribution notice in the readme.txt file, or Your redistribution of AppKit Items. We reserve all rights not expressly granted to you under this License. Unless explicitly approved by Us, in no event will You use Our name, trademarks, or logos to endorse or imply Our endorsement of products derived from AppKit Items or any products or services that use AppKit Items. Where You are permitted to use the Marks, You must comply with Our then-current trademark and logo usage guidelines, as may be updated from time to time without notice from Us. All goodwill arising out of Your use of any Mark will inure solely to Us.

**e. Export Controls.** You and We acknowledge that the AppKit Items and all related technical information, documents and materials are subject to export controls under the U.S. Export Administration Regulations. You and We will (i) comply strictly with all legal requirements established under these controls, (ii) cooperate fully with each other in any official or unofficial audit or inspection that relates to these controls and (iii) not export, re-export, divert or transfer, directly or indirectly, any such item or direct products thereof to Cuba, Iran, North Korea, Sudan, and the Crimea, Donetsk, Luhansk, Kherson and Zaporizhzhia region not controlled by the government of Ukraine, or any national thereof or to any country or national thereof that is embargoed by Executive order, unless such party has obtained the prior written authorization of the other party and U.S. Commerce Department. We may modify this list to conform to changes in the U.S. Export Administration Regulations.

**3\. LIMITED COMMERCIAL USE**

If the number of remote processing calls (RPCs) made by, or monthly active users of (MAUs), associated with Your application or wallet developed using AppKit Items, or your product or service that uses AppKit Items exceed the thresholds set forth below, determined in our sole discretion, You must enter into and pay applicable fees and charges for a commercial license. You may contact Reown for these purposes using [this form](https://share.hsforms.com/1_oWa8QkwRXi6oR0nZ_SIxQnxw6s).

- Monthly RPC limit of 2,500,000

- Monthly MAU limit of 500

MAU means, as applicable: (1) a unique externally owned account that authenticates and connects to your app in a 30 day period; or (2) a unique embedded wallet that is created on, and authenticates and connects, to your app in a 30 day period

We reserve the right to change the RPC and/or MAU limit thresholds and/or set different or additional triggers or thresholds for requiring a commercial license. The current thresholds or triggers for a commercial license may be published on Our [Terms of Service](https://reown.com/terms-of-service).

**4\. DISCLAIMER OF WARRANTY**

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE APPKIT ITEMS ARE PROVIDED “AS IS” WITHOUT WARRANTIES OF ANY KIND. ALL WARRANTIES, CONDITIONS, REPRESENTATIONS, INDEMNITIES AND GUARANTEES WITH RESPECT TO THE APPKIT ITEMS, WHETHER EXPRESS OR IMPLIED, ARISING BY LAW, CUSTOM, PRIOR ORAL OR WRITTEN STATEMENTS BY US OR OTHERWISE (INCLUDING, BUT NOT LIMITED TO ANY WARRANTY OF MERCHANTABILITY, SATISFACTORY QUALITY, FITNESS FOR PARTICULAR PURPOSE AND NON-INFRINGEMENT) ARE HEREBY OVERRIDDEN, EXCLUDED AND DISCLAIMED. SOME JURISDICTIONS DO NOT PERMIT THE DISCLAIMER OF ALL WARRANTIES SO YOU MAY HAVE ADDITIONAL RIGHTS PROVIDED BY LAW.

**5\. LIMITATION OF LIABILITY**

IN NO EVENT AND UNDER NO LEGAL THEORY, WHETHER IN TORT (INCLUDING NEGLIGENCE), CONTRACT, OR OTHERWISE, UNLESS REQUIRED BY APPLICABLE LAW DESPITE THIS LIMITATION OR AGREED TO IN WRITING BY US, WILL WE BE LIABLE TO YOU OR YOUR LICENSEES OR SUBLICENSEES FOR ANY DAMAGES, INCLUDING ANY DIRECT, INDIRECT, SPECIAL, INCIDENTAL, OR CONSEQUENTIAL DAMAGES OF ANY CHARACTER ARISING AS A RESULT OF THIS LICENSE OR OUT OF THE USE OR INABILITY TO USE THE APPKIT ITEMS OR ANY PORTION THEREOF (INCLUDING BUT NOT LIMITED TO DAMAGES FOR LOSS OF GOODWILL, WORK STOPPAGE, COMPUTER FAILURE OR MALFUNCTION, OR ANY AND ALL OTHER COMMERCIAL DAMAGES OR LOSSES), EVEN IF WE OR OUR AFFILIATES HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. SOME JURISDICTIONS DO NOT PERMIT THE EXCLUSION OF ALL DAMAGES SO YOU MAY HAVE ADDITIONAL RIGHTS PROVIDED BY LAW.

**6\. INTELLECTUAL PROPERTY**

All trademarks, service marks, patents, copyrights, trade secrets, or other proprietary rights in or related to the AppKit Items are and will remain Our exclusive property (or that of Our licensors). You will not take any action that jeopardizes those rights, nor will you acquire any right in the AppKit Items, except the limited use rights specified in this License. You acknowledge that We (or Our licensors) will own all rights in any copy, translation, modification, adaptation or derivative works of the AppKit Items (whether or not authorized by Us), and You will provide any instrument We reasonably request that you obtain to give full legal effect to Our rights under this Section.

**7\. CONFIDENTIALITY**

You acknowledge that the AppKit Items incorporate nonpublic confidential and proprietary information We have developed or acquired or licensed ("**Confidential Information**"). You will keep the Confidential Information in the strictest confidence and will not use or copy any Confidential Information, or disclose it to any other person. You will not permit removal or defacing of any confidentiality or proprietary notice placed on or in the AppKit Items, and any copyright notices on or in these items does not constitute publication or make them non-confidential.

**8\. TERM AND TERMINATION**

**a. Term.** The term of this Agreement will commence upon Your accessing the AppKit Items and will continue in full force and effect until terminated in accordance with the terms and conditions of this License. As this License is updated for future releases of the AppKit Items, You must abide by and meet all requirements of future updates of this License for those future releases of AppKit Items, and such future updates of this License will apply to such future applications and wallets that may be developed with that future release of AppKit Items or any portion thereof. You may not use older versions of the SDK to circumvent the terms applicable to new versions you choose to download or use.

    **b.	Termination.** This License terminates (i) 30 days after either We notify you in writing that You have breached a material term of this License, if that breach is not cured before then, or (ii) immediately and automatically if You are declared bankrupt or become insolvent. Your right to access the Network ceases, if this License terminates, and We may disable Your access to the Network upon such termination. You may terminate this License at any time by disintegrating AppKit  Items from your products and services and disabling access to the Network. If this License terminates, You must immediately cease all use of and delete the AppKit Items, in whole or in part, as well as any Confidential Information, in Your possession or control.  At Our request, You will certify Your compliance with these obligations in writing. Sections 2, 4 through 7, 8(b), and 9 through 11 will survive any termination of this Agreement.

**9\. GOVERNING LAW**

This Agreement will be governed and construed under the laws of the State of Delaware, U.S.A., without regard to choice of law principles, and the UN Convention on Contracts for the International Sale of Goods does not apply to this Agreement.

**10\. DISPUTE RESOLUTION**

PLEASE READ THE FOLLOWING SECTION CAREFULLY BECAUSE IT REQUIRES YOU TO SUBMIT TO BINDING ARBITRATION (JURY TRIAL WAIVER) OF ANY AND ALL DISPUTES (OTHER THAN SPECIFIED SMALL CLAIMS) WITH REOWN, INC. AND LIMITS THE MANNER IN WHICH YOU CAN SEEK RELIEF FROM REOWN, INC. (NO CLASS ARBITRATIONS, CLASS ACTIONS OR REPRESENTATIVE ACTIONS OR ARBITRATIONS).

**a. Binding Arbitration; Disputes; Small Claims.** **You and We waive any right to a jury trial, or the right to have any Dispute resolved in any court, and instead accept the use of binding arbitration (which is the referral of a Dispute to one or more impartial persons for a final and binding determination); provided, however, that you have the right to litigate any Dispute in small claims court, if all the requirements of the small claims court, including any limitations on jurisdiction and the amount at issue in the Dispute, are satisfied. You agree to bring a Dispute in small claims court in the State of Delaware**. “**Dispute**” **as used in this Section 10 means any dispute, cause of action, claim, or controversy arising out of or in any way related to Us, this License, the subject matter of this License, or access to and use of the AppKit Items, in whole or in part, or the Network, including but not limited to personal injury disputes and disputes that involve third parties (such as developers of applications or wallets).**

**b. No Class Arbitrations, Class Actions or Representative Actions.** **You and We agree that any Dispute is personal to You and Us, and that any Dispute must only be resolved by an individual arbitration and may not be brought as a class arbitration, a class action, or any other representative proceeding. Neither party agrees to class arbitration, or an arbitration where a person brings a Dispute as a representative of any other person or persons. Neither You nor We agree that a Dispute can be brought as a class or representative action whether inside or outside of arbitration, or on behalf of any other person or persons**.

**c. Federal Arbitration Act.** You and We agree that the terms of this License affect interstate commerce and that the enforceability of Section 10 is governed by, construed, and enforced, both substantively and procedurally, by the Federal Arbitration Act, 9 U.S.C. § 1 et seq. (“**FAA**”) to the maximum extent permitted by applicable law.

**d. Confidentiality.** The arbitrator, You and We must maintain the confidentiality of any proceedings, including but not limited to, any and all information gathered, prepared, and presented for purposes of the arbitration or related to the Dispute(s) therein. The arbitrator has the authority to make appropriate rulings to safeguard that confidentiality, unless the law provides to the contrary.

**e. Process.** Our goal is to resolve claims fairly and quickly. Accordingly, for any Dispute that you have against Us, you must first contact Us and attempt to resolve the claim informally by sending a written notice of your claim (“**Notice**”) to Us. The Notice to Us must be sent by certified mail addressed to: Reown Inc., 200 Continental Drive, 401, Newark, DE 19713 USA and a copy must be sent on the same day via email to Legal@walletconnect.com. The Notice must (a) include Your name, residence address, projectID and the email address and/or mobile telephone number associated with your account; (b) describe the nature and basis of the claim; and (c) set forth the specific relief sought. If You and We cannot reach an agreement to resolve the claim within 30 days after such Notice is received, then either party may, as appropriate in accordance with this Section 10, commence an arbitration proceeding or file a claim in small claims court.

**f. Binding Arbitration.** In the event that You and We cannot resolve a Dispute and do not pursue the matter through small claims court, You or We must promptly submit the Dispute to binding arbitration before the American Arbitration Association (“**AAA**”). In the event AAA declines or is unable to administer the arbitration, You and We agree to use an arbitration forum or arbitrator that You and We mutually agree upon. If, after making a reasonable effort, You and We are not able to agree upon an arbitration forum or arbitrator, AAA or a court having proper jurisdiction will appoint an arbitration forum or arbitrator. The arbitration will be conducted in accordance with the AAA Consumer Arbitration Rules (“**AAA Rules**”) then in effect. The AAA Rules and other information about AAA and arbitration are readily available at [http://www.adr.org](http://www.adr.org/), by calling 1-800-778-7879, or by mail at 120 Broadway, Floor 21, New York, NY 10271\. By entering into this License, you either (1) acknowledge that you have read and understand the AAA Rules or (2) waive reading the AAA Rules and waive any claim that the AAA Rules are unfair in any way. You and We agree that the terms of this License govern the arbitration, and that the applicable AAA Rules are subject to changes in procedures that AAA may make from time to time.

**g. Arbitrator Empowered.** As limited by the FAA, the terms of this License, and the applicable AAA Rules, the arbitrator will have the exclusive power and jurisdiction to make all procedural and substantive decisions concerning the Dispute; provided, however, that this power does not include: (i) the power to determine the question of arbitrability, which power You and We agree is vested solely in a court of competent jurisdiction; or (ii) the power to conduct a class arbitration or a representative action, which is prohibited by the terms of this License (as stated above). The arbitrator may only conduct an individual arbitration, and may not consolidate more than one person’s claims and may not preside over any form of representative or class proceeding, or any proceeding on behalf of or involving more than one person or persons.

**11\. MISCELLANEOUS**

**a. Amendment.** This License may be amended by Us on a prospective basis, and your usage of the License after such amendments or changes signifies your consent to and acceptance of any such amendments or changes on a going forward basis.

**b. Severability.** In the event any provision of this License is determined to be invalid, prohibited or unenforceable by a court or other body of competent jurisdiction, this License must be construed as if such invalid, prohibited or unenforceable provision has been more narrowly drawn so as not to be invalid, prohibited or unenforceable.

**c. Assignment.** You may not assign any rights or obligations under this License, including by operation of law, without Our prior written consent, which may be withheld in its sole discretion. We may assign Our rights or obligations under this License in Our sole discretion.

**d. Waiver.** Failure of either party at any time to enforce any of the provisions of this License will not be construed as a waiver of such provisions or in any way affect the validity of this License or parts thereof.

</details>
