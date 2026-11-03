// The early-element move signal counts only what the user could see at the snapshot (#86).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { SNAP, MOVED } from '../probes.mjs';

// Each page fills a spacer 300 px tall after 200 ms, then (for the hidden cases) shows the content.
const late = (show) => `<script>setTimeout(() => { document.getElementById('gap').style.height = '300px'; ${show} }, 200);</script>`;
const pages = {
  'visibility hidden main': [`<main id="m" style="visibility:hidden"><div id="gap"></div><h2>Title</h2><button>Go</button></main>${late("m.style.visibility = 'visible';")}`, false],
  'opacity 0 parent': [`<div id="m" style="opacity:0"><div id="gap"></div><h2>Title</h2></div>${late("m.style.opacity = '1';")}`, false],
  'display none parent': [`<div id="m" style="display:none"><div id="gap"></div><h2>Title</h2></div>${late("m.style.display = 'block';")}`, false],
  'visible header pushed down': [`<div id="gap"></div><h2>Title</h2><button>Go</button>${late('')}`, true],
  'hidden part pushes a visible one': [`<div id="m" style="display:none;height:300px"></div><h2>Title</h2><script>setTimeout(() => { m.style.display = 'block'; }, 200);</script>`, true],
};

test('layout-shift move signal skips hidden elements and still catches visible moves', async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, [html, moves]] of Object.entries(pages)) {
      const page = await browser.newPage();
      await page.setContent(`<body style="margin:0">${html}</body>`);
      await page.evaluate(SNAP);
      await page.waitForTimeout(600);
      const mv = await page.evaluate(MOVED);
      if (moves) assert.ok(mv.d >= 8, `${name}: expected a move of 8 px or more, saw ${mv.d} px`);
      else assert.ok(mv.d < 8, `${name}: expected no counted move, saw ${mv.d} px (${mv.el})`);
      await page.close();
    }
  } finally { await browser.close(); }
});
