// Starts the service of a run.json with stores and holds. node hold.mjs <run.json> term|exit
// term: prints "up" and waits to be signalled. exit: prints "up" and ends the process normally.
import { prepare, start } from '../api.mjs';
import fs from 'node:fs';

const [file, mode] = process.argv.slice(2);
const ctx = prepare(JSON.parse(fs.readFileSync(file, 'utf8')), file);
await start(ctx);
console.log('up');
if (mode === 'exit') process.exit(0);
setInterval(() => {}, 1000);
