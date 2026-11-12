// node relay.mjs <from> <to>: listens on <from>, and pipes every connection both ways to <to>. Each side is host:port or unix:<path>.
// Writes nothing to stdout; when RELAY_READY is set it writes that file once it listens. A failure to connect closes the client at once; errors on either end close both. No dependencies.
import fs from 'node:fs';
import net from 'node:net';

function parse(s) {
  if (s.startsWith('unix:')) return { path: s.slice(5) };
  const i = s.lastIndexOf(':');
  const port = Number(s.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`relay: bad address ${s}`);
  return { host: s.slice(0, i), port };
}

const [from, to] = process.argv.slice(2);
if (!from || !to) { console.error('usage: node relay.mjs <from> <to>'); process.exit(2); }
const listenOn = parse(from), target = parse(to);
if (listenOn.path) fs.rmSync(listenOn.path, { force: true });

const server = net.createServer((client) => {
  const up = net.connect(target);
  const end = () => { client.destroy(); up.destroy(); };
  client.on('error', end); up.on('error', end);
  client.on('close', end); up.on('close', end);
  client.pipe(up); up.pipe(client);
});
server.on('error', (e) => { console.error(`relay: cannot listen on ${from}: ${e.code || e.message}`); process.exit(1); });
server.listen(listenOn, () => {
  if (process.env.RELAY_READY) fs.writeFileSync(process.env.RELAY_READY, 'ready\n');
});
