/**
 * A route's identity (D47): its venue, and its route within the venue when it names one — "cctp/fast", "cctp/standard"
 * ("/" is no venue name's character, which the router holds to [A-Za-z0-9_-]). What the list selects, keeps and holds,
 * and what the review re-quotes and the swap executes. Its own module: routes.ts and webRoute.ts both read it.
 */
export const routeKey = (r: {provider: string; routeId?: string | undefined}): string => (r.routeId === undefined ? r.provider : `${r.provider}/${r.routeId}`);
