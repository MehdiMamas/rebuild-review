// Starts a child process and then never listens.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(process.env.TMPDIR, 'child.pid'), String(c.pid));
setInterval(() => {}, 1000);
