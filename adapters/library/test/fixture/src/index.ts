// @ts-ignore
import fs from 'node:fs';
// @ts-ignore
import { spawn } from 'node:child_process';
declare const process: any;

/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }
export function greet(name: string): string { return 'hello ' + name; }
export class Counter {
  private n: number;
  constructor(start: number) { this.n = start; }
  inc(): number { return ++this.n; }
}
/** Returns a function. */
export function makeAdder(n: number): (x: number) => number { return (x) => x + n; }
export function makeCounter(): Counter { return new Counter(0); }
export function kindOf(x: unknown): string { return typeof x === 'object' && x ? (x as object).constructor.name : typeof x; }
export function echoValues(): unknown { return { d: new Date(0), m: new Map([['a', 1]]), b: 5n, n: NaN, e: new Error('plain') }; }
export function readEnv(name: string): string | null { return process.env[name] ?? null; }
/** @deprecated use add */
export function oldAdd(a: number, b: number): number { return a + b; }
export interface Readable { read(): string }
export function consume(src: Readable): string { return src.read(); }

// Planted problems
export function throwString(): never { throw 'boom'; }
export function fillOpts(opts: { x?: number }): void { opts.x = 1; }
export function floatReject(): void { void Promise.reject(new Error('nobody waits for me')); }
export function leakTimer(): void { setInterval(() => {}, 1000); }
export function writeHome(): void { fs.writeFileSync(process.env.HOME + '/.fixture.json', '{"saved":true}'); }
export async function fetchOut(url: string): Promise<string> { const r = await fetch(url); return await r.text(); }
export function hold(ms: number): void {
  if (!(ms > 0)) return;
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  console.log('child ' + c.pid);
  for (;;) { /* never returns */ }
}
