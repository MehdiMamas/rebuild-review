// Pure helpers over the iOS accessibility hierarchy (no simulator needed). The driver returns a tree of
// { elementType, label, identifier, title, value, frame: { X, Y, Width, Height }, enabled, children }.
import crypto from 'node:crypto';
import { scrub } from '../web/context.mjs';

// XCUIElementType raw values.
export const T = { other: 1, application: 2, group: 3, window: 4, sheet: 5, alert: 7, button: 9, checkBox: 12, navigationBar: 21, toolbar: 24, scrollBar: 26, slider: 33, segmentedControl: 37, switch: 40, toggle: 41, link: 42, image: 43, searchField: 45, staticText: 48, textField: 49, secureTextField: 50, cell: 75, stepper: 79, tab: 80 };
const NAMES = { 1: 'other', 3: 'group', 4: 'window', 5: 'sheet', 7: 'alert', 9: 'button', 12: 'checkbox', 21: 'navigation-bar', 24: 'toolbar', 26: 'scroll-bar', 33: 'slider', 37: 'segmented-control', 40: 'switch', 41: 'toggle', 42: 'link', 43: 'image', 45: 'search-field', 48: 'text', 49: 'text-field', 50: 'secure-text-field', 74: 'table', 75: 'cell', 79: 'stepper', 80: 'tab' };
export const typeName = (t) => NAMES[t] || `type-${t}`;
// What the crawl taps to find another screen, and what the probes call a control.
export const TAPPABLE = new Set([T.button, T.link, T.cell, T.tab]);
export const CONTROLS = new Set([T.button, 10, T.checkBox, 14, 16, 17, T.slider, T.segmentedControl, T.switch, T.toggle, T.link, T.searchField, T.textField, T.secureTextField, T.stepper, T.tab]);
// Controls whose tap target is the system's own (a UISwitch is 51x31 by design).
export const TARGET_CHECKED = new Set([T.button, T.link, T.checkBox, T.tab]);
export const LABEL_CHECKED = new Set([T.button, T.link, T.checkBox, T.switch, T.toggle, T.tab]);

const f = (n) => ({ x: n.frame?.X ?? 0, y: n.frame?.Y ?? 0, w: n.frame?.Width ?? 0, h: n.frame?.Height ?? 0 });

// The app's own tree: the child of the root with type application. Returns { size, elements } with elements flattened in order,
// each { type, label, id, title, value, enabled, frame:{x,y,w,h}, depth, inNavBar, path }.
export function flatten(dump) {
  const root = dump?.axElement ?? dump;
  const app = (root?.children || []).find((c) => c.elementType === T.application) || (root?.elementType === T.application ? root : null);
  if (!app) return { size: { width: 0, height: 0 }, elements: [] };
  const af = f(app);
  const elements = [];
  const walk = (n, depth, inNavBar) => {
    for (const c of n.children || []) {
      const fr = f(c);
      const nav = inNavBar || c.elementType === T.navigationBar;
      if (c.elementType !== T.scrollBar && !(c.label || '').startsWith('Vertical scroll bar') && !(c.label || '').startsWith('Horizontal scroll bar')) {
        elements.push({ type: c.elementType, label: c.label || '', id: c.identifier || '', title: c.title || '', value: c.value == null ? '' : String(c.value), enabled: c.enabled !== false, frame: fr, depth, inNavBar: nav });
      }
      walk(c, depth + 1, nav);
    }
  };
  walk(app, 0, false);
  return { size: { width: af.w, height: af.h }, elements };
}

const blank = (s) => String(s).replace(/\d+/g, '#');
// A screen is its signature: the hierarchy's types, labels and identifiers with digits blanked. Values (typed text, switch state) are not part of it.
export function signature(elements) {
  const lines = elements.filter((e) => e.label || e.id || CONTROLS.has(e.type) || e.type === T.staticText).map((e) => `${e.type}|${blank(e.label)}|${blank(e.id)}`);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

export const isControl = (e) => CONTROLS.has(e.type);
// Elements the crawl taps: not in a navigation bar (the way back is not a new screen), enabled, and with a visible frame.
export function tapTargets(elements, size) {
  return elements.filter((e) => TAPPABLE.has(e.type) && e.enabled && !e.inNavBar && e.frame.w > 0 && e.frame.h > 0
    && e.frame.x < size.width && e.frame.y < size.height && e.frame.x + e.frame.w > 0 && e.frame.y + e.frame.h > 0);
}
export const hasSecureField = (elements) => elements.some((e) => e.type === T.secureTextField);

// How a person would name an element: its label, else its title, else its identifier.
export const nameOf = (e) => e.label || e.title || e.id || '';

export function render(elements, size, device) {
  return { device, size, elements: elements.map((e) => ({ type: typeName(e.type), label: scrub(e.label), identifier: scrub(e.id), value: scrub(e.value), enabled: e.enabled, frame: e.frame, depth: e.depth })) };
}
// An outline in the style of an accessibility snapshot: one line per element a person can perceive or use.
export function a11yOutline(elements) {
  const lines = elements.filter((e) => nameOf(e) || e.value || CONTROLS.has(e.type)).map((e) => `${'  '.repeat(Math.min(e.depth, 8))}- ${typeName(e.type)}${nameOf(e) ? ` "${scrub(nameOf(e))}"` : ''}${e.id ? ` [id=${scrub(e.id)}]` : ''}${e.enabled ? '' : ' [disabled]'}`);
  return { outline: lines };
}
