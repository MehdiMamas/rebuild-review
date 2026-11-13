// A stand-in for docker, used through RR_CONTAINER. It keeps its state and a log of every call in RR_FAKE_DIR.
// Commands: version, info, pull, network create|rm|ls|inspect, run, inspect, logs, rm, exec, ps. A "container" is a tiny TCP key/value server on 127.0.0.2:<port> (the port comes from the label rr-port that every run carries).
// Its server speaks lines: "GET k" answers the value and a newline, "SET k v" answers OK.
// Switches (read from the environment of the call): RR_FAKE_PULL_FAIL=1 (pull fails), RR_FAKE_NEVER_READY=1 (the container runs and never listens), RR_FAKE_EXIT_AT_ONCE=1 (the container exits at once), RR_FAKE_ROOTLESS=1 (info says rootless), RR_FAKE_NO_ADDRESS=1 (inspect prints no address).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = process.env.RR_FAKE_DIR;
const argv = process.argv.slice(2);

if (argv[0] === '--serve') {
  // the container process: --serve <port> <log file>
  const port = Number(argv[1]), logFile = argv[2];
  fs.appendFileSync(logFile, `fake store starting on 127.0.0.2:${port}\n`);
  if (process.env.RR_FAKE_EXIT_AT_ONCE === '1') { fs.appendFileSync(logFile, 'fatal: data directory is not writable\n'); process.exit(3); }
  if (process.env.RR_FAKE_NEVER_READY === '1') { fs.appendFileSync(logFile, 'still initialising database\n'); setInterval(() => {}, 1000); }
  else {
    const data = new Map();
    net.createServer((s) => {
      let buf = '';
      s.on('error', () => {});
      s.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const [cmd, k, ...rest] = line.split(' ');
          if (cmd === 'SET') { data.set(k, rest.join(' ')); s.write('OK\n'); } else if (cmd === 'GET') s.write((data.get(k) || '') + '\n'); else s.write('ERR\n');
        }
      });
    }).listen(port, '127.0.0.2', () => fs.appendFileSync(logFile, 'ready to accept connections\n'));
  }
} else {
  if (!dir) { console.error('fake runtime: RR_FAKE_DIR is not set'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(argv) + '\n');
  const stateFile = path.join(dir, 'state.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { containers: {}, networks: {} }; } };
  const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  const out = (t) => process.stdout.write(t + '\n');
  const fail = (t, code = 1) => { console.error(t); process.exit(code); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
  const labelsOf = (list) => Object.fromEntries(list.map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const kill = (c) => { if (c.pid) { try { process.kill(c.pid, 'SIGKILL'); } catch {} } };
  const [cmd, sub] = argv;
  const st = load();
  if (cmd === 'version') out('Client: fake');
  else if (cmd === 'info') out('Server:\n Security Options:\n  seccomp' + (process.env.RR_FAKE_ROOTLESS === '1' ? '\n  rootless' : ''));
  else if (cmd === 'pull') {
    if (process.env.RR_FAKE_PULL_FAIL === '1') fail(`Error response from daemon: manifest for ${argv[argv.length - 1]} not found`);
    out('pulled');
  } else if (cmd === 'network') {
    if (sub === 'create') {
      const name = argv[argv.length - 1];
      if (st.networks[name]) fail(`network ${name} already exists`);
      st.networks[name] = { labels: labelsOf(all('--label')), created: Date.now(), internal: argv.includes('--internal') };
      save(st); out(name);
    } else if (sub === 'rm') {
      const name = argv[argv.length - 1];
      if (!st.networks[name]) fail(`Error: No such network: ${name}`);
      if (Object.values(st.containers).some((c) => c.network === name)) fail(`error while removing network: network ${name} has active endpoints`);
      delete st.networks[name]; save(st); out(name);
    } else if (sub === 'ls') {
      const want = flag('--filter');
      for (const [n, v] of Object.entries(st.networks)) if (!want || !want.startsWith('label=') || (want.slice(6).includes('=') ? v.labels[want.slice(6).split('=')[0]] === want.slice(6).split('=')[1] : want.slice(6) in v.labels)) out(n);
    } else if (sub === 'inspect') {
      const n = st.networks[argv[argv.length - 1]];
      if (!n) fail('Error: No such network');
      out(`${n.labels['rr-owner']} ${n.labels['rr-host']} ${new Date(n.created).toISOString()}`);
    } else fail('unknown network command');
  } else if (cmd === 'run') {
    const name = flag('--name');
    const image = argv[argv.length - 1];
    const labels = labelsOf(all('--label'));
    const port = Number(labels['rr-port']);
    const network = flag('--network');
    if (network && !st.networks[network]) fail(`Error: network ${network} not found`);
    if (st.containers[name]) fail(`Conflict. The container name "${name}" is already in use`);
    const logFile = path.join(dir, `${name}.log`);
    fs.writeFileSync(logFile, '');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve', String(port), logFile], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    st.containers[name] = { labels, created: Date.now(), network, pid: child.pid, image, port, logFile };
    save(st); out(name);
  } else if (cmd === 'inspect') {
    const c = st.containers[argv[argv.length - 1]];
    if (!c) fail(`Error: No such object: ${argv[argv.length - 1]}`);
    const f = flag('--format') || flag('-f') || '';
    if (f.includes('State')) out(String(alive(c.pid)));
    else if (f.includes('rr-owner')) out(`${c.labels['rr-owner']} ${c.labels['rr-host']} ${new Date(c.created).toISOString()}`);
    else if (process.env.RR_FAKE_NO_ADDRESS) out('');
    else out('127.0.0.2');
  } else if (cmd === 'logs') {
    const c = st.containers[argv[argv.length - 1]];
    if (!c) fail('Error: No such container');
    out(fs.readFileSync(c.logFile, 'utf8').trim());
  } else if (cmd === 'rm') {
    const name = argv[argv.length - 1];
    const c = st.containers[name];
    if (!c) fail(`Error: No such container: ${name}`);
    kill(c); delete st.containers[name]; save(st); out(name);
  } else if (cmd === 'exec') {
    const i = argv.indexOf(argv.find((a, j) => j > 0 && !a.startsWith('-')));
    const c = st.containers[argv[i]];
    if (!c) fail(`Error: No such container: ${argv[i]}`);
    const prog = argv[i + 1];
    if (prog === 'hang') setInterval(() => {}, 1000);
    else process.exit(prog === 'fail' ? 1 : 0);
  } else if (cmd === 'ps') {
    const want = flag('--filter');
    for (const [n, v] of Object.entries(st.containers)) if (!want || !want.startsWith('label=') || (want.slice(6).includes('=') ? v.labels[want.slice(6).split('=')[0]] === want.slice(6).split('=')[1] : want.slice(6) in v.labels)) out(n);
  } else fail(`fake runtime: unknown command ${cmd}`);
}
