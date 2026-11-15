/**
 * CCTP takes ONE RPC URL per chain (protocol-swap2-cctp provider.d.ts: `rpcUrls: Record<string, string>`, a single
 * viem `http` transport per chain, chunk-UPA4KJKX.js:67-70), so unlike every other RPC client here it never moves to
 * a next URL. This fetch, given to CCTP as its `fetchImpl` (which it also uses for its viem transports), sends a call
 * that fails on that URL — a non-2xx answer or a network error — to the rest of the chain's runtime list, in order,
 * and returns the first 2xx answer (else the last answer, or the last error). Every other request (Circle's
 * attestation API) passes through untouched. Calls go through the global fetch at call time, so Standard mode's
 * routing (D30) still applies to a proxy URL at the head of a list.
 */

/** `lists` maps the one URL CCTP was given for a chain → that chain's whole runtime list (starting with it). */
export function rpcFailoverFetch(lists: Readonly<Record<string, readonly string[]>>, base: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    const list = url === null ? undefined : lists[url];
    // A body that can't be sent twice (a stream) gets no second URL; every JSON-RPC client here sends a string.
    if (!list || list.length < 2 || (init?.body != null && typeof init.body !== "string")) return base(input, init);
    let last: Response | undefined;
    let error: unknown;
    for (const u of list) {
      try {
        const res = await base(u, init);
        if (res.ok) return res;
        last = res;
      } catch (e) {
        if (init?.signal?.aborted) throw e;
        error = e;
      }
    }
    if (last) return last;
    throw error;
  };
}
