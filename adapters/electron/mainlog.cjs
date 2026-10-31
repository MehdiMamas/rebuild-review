// Preloaded into the app's main process (electron -r): copies everything the app writes to its standard output and
// error into the file named by RR_MAIN_LOG, so lines printed at startup are not lost before the adapter attaches.
const fs = require('node:fs');
const file = process.env.RR_MAIN_LOG;
if (file) {
  for (const [name, tag] of [['stdout', 'stdout'], ['stderr', 'stderr']]) {
    const s = process[name], orig = s.write.bind(s);
    s.write = (chunk, ...rest) => {
      try { fs.appendFileSync(file, `${tag} ${String(chunk).replace(/\n$/, '').split('\n').join(`\n${tag} `)}\n`); } catch {}
      return orig(chunk, ...rest);
    };
  }
}
