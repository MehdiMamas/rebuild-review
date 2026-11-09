#!/usr/bin/env node
// A small to-do list tool, the fixture for the CLI adapter checks. It plants five problems on purpose:
// an unknown flag exits 0, errors go to stdout, "done" with a bad id shows a stack trace, no arguments waits on
// stdin without a prompt, and "list" prints colour although stdout is a pipe. --version and add are clean.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const file = path.join(process.env.HOME || '.', '.fixture.json');
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
const save = (items) => fs.writeFileSync(file, JSON.stringify(items));
const args = process.argv.slice(2);

const HELP = `todo 1.0.0, a small to-do list

Usage: todo <command> [options]

Commands:
  add     Add an item: todo add <text>
  list    Show the items
  done    Mark an item done: todo done <id>

Options:
  --help       Show this help
  --version    Show the version
`;

if (!args.length) {
  // planted: waits for input and says nothing until stdin ends
  process.stdin.on('end', () => { process.stdout.write(HELP); process.exit(0); });
  process.stdin.resume();
} else if (args[0] === '--version') {
  console.log('1.0.0');
} else if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
  process.stdout.write(HELP);
} else if (args[0].startsWith('-')) {
  // planted: an unknown flag is reported on stdout and exits 0
  console.log(`error: unknown option ${args[0]}`);
} else if (args[1] === '--help') {
  console.log(`Usage: todo ${args[0]} ...`);
} else if (args[0] === 'add') {
  if (!args[1]) { console.error('error: add needs some text'); process.exit(2); }
  const items = load();
  items.push({ id: items.length + 1, text: args.slice(1).join(' '), done: false });
  save(items);
  console.log(`added ${items.length}: ${args.slice(1).join(' ')}`);
} else if (args[0] === 'list') {
  // planted: colour on a pipe
  console.log('\x1b[1mID  TEXT\x1b[0m');
  for (const i of load()) console.log(`${i.id}   ${i.text}${i.done ? ' (done)' : ''}`);
  if (process.env.FIXTURE_TOKEN) console.log(`token: ${process.env.FIXTURE_TOKEN}`);
  if (process.env.RR_SECRET_PARENT) console.log(`parent-secret: ${process.env.RR_SECRET_PARENT}`);
} else if (args[0] === 'done') {
  const items = load();
  const item = items.find((i) => String(i.id) === args[1]);
  // planted: a bad id is an uncaught error with a stack trace
  if (!item) throw new Error(`no item with id ${args[1]}`);
  item.done = true; save(items);
  console.log(`done ${item.id}`);
} else if (args[0] === 'fetch') {
  // not part of the help: used by the network check
  fetch(args[1]).then((r) => r.text()).then((t) => console.log(`reached: ${t}`), (e) => { console.error(`fetch failed: ${e.cause ? e.cause.code || e.cause.message : e.message}`); process.exit(1); });
} else if (args[0] === 'hold') {
  // not part of the help: a child that outlives its parent unless the whole group is killed
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(`child ${c.pid}`);
  setInterval(() => {}, 1000);
} else if (args[0] === 'blob') {
  // not part of the help: big or binary output
  if (args[1] === 'big') process.stdout.write('x'.repeat(1.5 * 1024 * 1024));
  else process.stdout.write(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
} else {
  console.error(`error: unknown command ${args[0]}`);
  process.exit(2);
}
