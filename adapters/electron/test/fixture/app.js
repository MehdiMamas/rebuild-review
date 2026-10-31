const view = document.getElementById('view');
const api = (p) => fetch('fixture://api' + p).then((r) => r.json());
const screens = {
  home() {
    view.innerHTML = '<h1>Workbench</h1><nav><button data-go="tasks">Tasks</button><button data-go="search">Search</button><button data-go="reports">Reports</button><button data-go="settings">Settings</button><button data-go="profile">Profile</button><button data-go="sync">Sync</button><button data-go="about">About</button><button id="insp">Open inspector</button></nav>';
    view.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => go(b.dataset.go); });
    document.getElementById('insp').onclick = () => window.bridge.openInspector();
  },
  // Planted: an empty box that a banner later fills in above the list (layout shift).
  tasks() {
    view.innerHTML = '<h1>Tasks</h1><div id="slot"></div><div class="card"><ul><li>Write report</li><li>Send invoice</li></ul></div>' + back();
    setTimeout(() => { const s = document.getElementById('slot'); if (s) s.innerHTML = '<div class="banner">2 tasks are due today</div>'; }, 800);
  },
  // Planted: the whole view, input included, is redrawn on every keystroke (focus lost while typing).
  search() {
    const draw = (q) => {
      view.innerHTML = '<h1>Search</h1><label>Query <input id="q" type="text"></label><p>Results for: ' + q.replace(/</g, '&lt;') + '</p>' + back();
      document.getElementById('q').value = q;
      document.getElementById('q').oninput = (e) => draw(e.target.value);
      wireBack();
    };
    draw('');
  },
  // Planted: Refresh sends the same request eight times.
  reports() {
    view.innerHTML = '<h1>Reports</h1><p id="out">Last refresh: never</p><button id="r">Refresh</button>' + back();
    document.getElementById('r').onclick = async () => {
      await Promise.all(Array.from({ length: 8 }, () => api('/reports')));
      document.getElementById('out').textContent = 'Last refresh: just now';
    };
  },
  // Planted: an error in the console as the screen opens. A file chooser button is here too.
  settings() {
    view.innerHTML = '<h1>Settings</h1><p id="file">No file chosen</p><button id="choose">Choose file</button>' + back();
    console.error('settings: could not read saved theme');
    document.getElementById('choose').onclick = async () => { document.getElementById('file').textContent = await window.bridge.chooseFile(); };
  },
  // Planted: the request fails and nothing on the screen says so.
  profile() {
    view.innerHTML = '<h1>Profile</h1><p id="name">Name: not loaded</p><button id="load">Load profile</button>' + back();
    document.getElementById('load').onclick = async () => {
      try { const r = await fetch('fixture://api/profile'); if (r.ok) document.getElementById('name').textContent = 'Name: Sam'; } catch {}
    };
  },
  // Planted: a slow request with nothing on the screen while it runs.
  sync() {
    view.innerHTML = '<h1>Sync</h1><p id="out">Never synced</p><button id="go">Sync now</button>' + back();
    document.getElementById('go').onclick = async () => {
      const r = await fetch('fixture://api/sync');
      if (r.ok) document.getElementById('out').textContent = 'Synced';
    };
  },
  // The clean control screen: static text and one button that makes no request.
  about() {
    view.innerHTML = '<h1>About</h1><p>Workbench is a small demo app.</p>' + back();
  },
};
function back() { return '<p><button id="back">Back</button></p>'; }
function wireBack() { const b = document.getElementById('back'); if (b) b.onclick = () => go('home'); }
function go(name) { screens[name](); wireBack(); }
go('home');
