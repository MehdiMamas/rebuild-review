// Pure decisions for check.mjs: the status and the exit code. A failure outranks "incomplete";
// anything not checked is never a pass.
export const EXIT = { pass: 0, fail: 1, incomplete: 2, error: 3 };

export function statusOf({ failed = [], notChecked = [] }) {
  if (failed.length) return 'fail';
  if (notChecked.length) return 'incomplete';
  return 'pass';
}

export const exitCodeOf = (status) => EXIT[status] ?? EXIT.error;
