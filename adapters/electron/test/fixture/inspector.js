const view = document.getElementById('view');
let details = false;
function draw() {
  view.innerHTML = details
    ? '<h1>Inspector details</h1><p>Build channel: stable</p><button id="hide">Hide details</button>'
    : '<h1>Inspector overview</h1><p>Two windows are open.</p><button id="show">Show details</button>';
  const b = document.querySelector('button');
  b.onclick = () => { details = !details; draw(); };
}
draw();
