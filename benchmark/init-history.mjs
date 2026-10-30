// Replays history/*.patch into a fresh git repo and prints its path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'bench-history-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
fs.mkdirSync(dir, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Bench Fixture');
git('config', 'user.email', 'bench@example.invalid');
const patches = fs.readdirSync(path.join(here, 'history')).filter((f) => f.endsWith('.patch')).sort();
for (const p of patches) git('am', '--quiet', path.join(here, 'history', p));
console.log(dir);
