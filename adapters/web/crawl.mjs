// Pure helpers for the capture crawl (capture.mjs runs at import, so they live here).

// A path segment that is a UUID, all digits, or 8+ hex characters becomes ":id".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function routeKey(pathname) {
  return pathname.split('/').map((seg) => (UUID.test(seg) || /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) ? ':id' : seg)).join('/');
}

const keyOf = (url) => routeKey(new URL(url).pathname);

// Index in `queue` of the next URL to visit, or -1. A URL whose route has not been visited goes
// before any URL whose route has; a route is visited at most `maxPerRoute` times.
// `counts` is a Map of route key -> URLs visited so far; `seen` holds keys already visited.
export function pickNext(queue, counts, seen, seenKey, maxPerRoute) {
  const open = (i) => !seen.has(seenKey(queue[i]));
  for (let i = 0; i < queue.length; i++) if (open(i) && !counts.get(keyOf(queue[i]))) return i;
  for (let i = 0; i < queue.length; i++) if (open(i) && counts.get(keyOf(queue[i])) < maxPerRoute) return i;
  return -1;
}

// What is left in the queue when the crawl ends: `cut` = first URL of each route never visited
// (the screen cap stopped it); `sameRouteSkipped` = [{route, count}] for the other left-over URLs.
export function leftOver(queue, counts, seen, seenKey) {
  const cut = [], skipped = new Map(), cutKeys = new Set(), done = new Set();
  for (const u of queue) {
    const sk = seenKey(u);
    if (seen.has(sk) || done.has(sk)) continue;
    done.add(sk);
    const rk = keyOf(u);
    if (!counts.get(rk) && !cutKeys.has(rk)) { cutKeys.add(rk); cut.push(sk); }
    else skipped.set(rk, (skipped.get(rk) || 0) + 1);
  }
  return { cut, sameRouteSkipped: [...skipped].map(([route, count]) => ({ route, count })) };
}
