// Importing this prints a line and starts a timer that keeps the process alive.
console.log('noisy loaded');
setInterval(() => {}, 1000);
/** Returns 1. */
export function loud(): number { return 1; }
