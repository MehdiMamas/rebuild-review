// Pure decisions for check.mjs: the status and the exit code. A failure outranks "incomplete";
// anything not checked is never a pass.
export const EXIT = { pass: 0, fail: 1, incomplete: 2, error: 3 };

export function statusOf({ failed = [], notChecked = [] }) {
  if (failed.length) return 'fail';
  if (notChecked.length) return 'incomplete';
  return 'pass';
}

export const exitCodeOf = (status) => EXIT[status] ?? EXIT.error;

// Where a route ended up: null when it was reached (same origin and path, or an origin the caller
// allowed with --allow-origin), otherwise the reason it is not checked. A same-origin redirect to
// another path (a login page) is not reached.
export function endedOn(startUrl, finalUrl, allowOrigins = []) {
  const start = new URL(startUrl), end = new URL(finalUrl);
  const trim = (p) => p.replace(/\/$/, '');
  if (end.origin === start.origin) return trim(end.pathname) === trim(start.pathname) ? null : `ended on ${trim(end.pathname) || '/'} instead`;
  if (allowOrigins.includes(end.origin)) return null;
  return `ended on ${end.origin}${end.pathname} instead`;
}
