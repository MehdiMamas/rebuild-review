// Copies the app to a target folder without answers.json, as a fresh git repo. Prints the path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const here = path.dirname(new URL(import.meta.url).pathname);
const dir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'bench-android-'));
const skip = new Set(['answers.json', 'init.mjs', 'build', '.gradle', 'node_modules', '.dart_tool']);
fs.cpSync(here, dir, { recursive: true, filter: (s) => !skip.has(path.basename(s)) });
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Bench Fixture'); git('config', 'user.email', 'bench@example.invalid');
git('add', '-A'); git('commit', '-q', '-m', 'Task list app');
console.log(dir);
