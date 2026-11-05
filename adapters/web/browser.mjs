// Starts headless Chromium for the web adapter. On Linux, shared libraries the browser lacks (e.g. libnspr4, libnss3) are fetched
// without root first (libs.mjs). A launch that fails says why in one line: the browser's own error lines, not Playwright's first line.
// No playwright import here: the caller passes its chromium, so this file is unit-tested with no install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxLibs } from './libs.mjs';

// Headless launches run the headless shell, a sibling build of the full browser Playwright reports; the full browser when it is not there.
export function headlessShellPath(fullPath, exists = fs.existsSync) {
  const shell = String(fullPath).replace(/([\\/])chromium-(\d+)([\\/])chrome-(linux64|linux|win64|mac-arm64|mac-x64)([\\/]).*$/,
    (m, s1, rev, s2, plat, s3) => `${s1}chromium_headless_shell-${rev}${s2}chrome-headless-shell-${plat}${s3}chrome-headless-shell${plat.startsWith('win') ? '.exe' : ''}`);
  return shell !== fullPath && exists(shell) ? shell : fullPath;
}

// One line for a failed launch: Playwright's first line, then up to 10 of the browser's [err] lines from its log.
export function launchError(e) {
  const lines = String(e?.message ?? e).split('\n');
  const errs = [...new Set(lines.map((l) => /\[pid=\d+\]\[err\]\s*(.*)$/.exec(l)?.[1]?.trim()).filter(Boolean))].slice(0, 10);
  const exit = lines.map((l) => /process did exit: (exitCode=\S+ signal=\S+?)>?$/.exec(l)?.[1]).find(Boolean);
  return [lines[0].trim(), ...errs, exit && `browser ${exit}`].filter(Boolean).join(' | ');
}

let libPath;
// chromium.launch(opts), headless, with LD_LIBRARY_PATH set for fetched libraries. Throws an Error whose message is launchError's line.
export async function launchChromium(chromium, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  if (process.platform === 'linux') {
    libPath ??= linuxLibs(headlessShellPath(chromium.executablePath()), path.join(os.tmpdir(), `rr-browser-libs-${process.getuid()}`), { label: 'the browser' });
    if (libPath) env.LD_LIBRARY_PATH = [libPath, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  try { return await chromium.launch({ ...opts, headless: true, env }); } catch (e) { throw new Error(launchError(e)); }
}
