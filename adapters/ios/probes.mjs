// General checks for an iOS app. Each row: { probe, screen, passed, evidence }; passed=false means the probe flagged a problem.
// They read data the capture already holds (hierarchies, taps, launches), so they run without a simulator.
// screens: [{ id, size:{width,height}, elements, large?: {size, elements} }]; taps: [{ screen, name, crashed, report? }]; launch: { crashed, report? }.
import { scrub } from '../web/context.mjs';
import { TARGET_CHECKED, LABEL_CHECKED, isControl, nameOf, typeName, T } from './screen.mjs';

export const TOP_BAND = 47, BOTTOM_BAND = 34, MIN_TARGET = 44;
const where = (e) => `${typeName(e.type)} "${nameOf(e)}"`.trim();
const box = (e) => `${Math.round(e.frame.w)}x${Math.round(e.frame.h)} at ${Math.round(e.frame.x)},${Math.round(e.frame.y)}`;

// Text or a control whose frame is wider than the screen (or starts left of it).
export function overflowing(elements, size) {
  return elements.filter((e) => (e.type === T.staticText || isControl(e)) && e.frame.w > 0 && e.frame.h > 0 && (e.frame.x + e.frame.w > size.width + 1 || e.frame.x < -1));
}

export function runProbes({ screens, taps = [], launch = null, notChecked = [] }) {
  const rows = [];
  const row = (probe, screen, passed, evidence) => rows.push({ probe, screen, passed, evidence: scrub(evidence) });

  if (launch) row('crash-on-launch', 'launch', !launch.crashed, launch.crashed ? `the app was not running after launch${launch.report ? `: ${launch.report}` : ''}` : 'the app was running after launch');
  else notChecked.push({ probe: 'crash-on-launch', route: 'launch', reason: 'no launch was observed' });

  for (const s of screens) {
    const { size, elements } = s;
    const controls = elements.filter((e) => isControl(e) && e.frame.w > 0 && e.frame.h > 0);
    const inBand = controls.filter((e) => {
      const top = Math.min(e.frame.y + e.frame.h, TOP_BAND) - Math.max(e.frame.y, 0);
      const bottom = Math.min(e.frame.y + e.frame.h, size.height) - Math.max(e.frame.y, size.height - BOTTOM_BAND);
      return top > 2 || bottom > 2;
    });
    row('control-under-status-bar', s.id, !inBand.length, inBand.length ? `${inBand.map((e) => `${where(e)} (${box(e)})`).join('; ')} sits in the top ${TOP_BAND} or bottom ${BOTTOM_BAND} pt band of a ${size.width}x${size.height} pt screen` : `no control reaches into the top ${TOP_BAND} or bottom ${BOTTOM_BAND} pt band`);

    const small = controls.filter((e) => TARGET_CHECKED.has(e.type) && (e.frame.w < MIN_TARGET - 0.5 || e.frame.h < MIN_TARGET - 0.5));
    row('tap-target-small', s.id, !small.length, small.length ? `${small.map((e) => `${where(e)} is ${box(e)}`).join('; ')}, under ${MIN_TARGET}x${MIN_TARGET} pt` : `every button, link and tab is at least ${MIN_TARGET}x${MIN_TARGET} pt`);

    const unlabeled = controls.filter((e) => LABEL_CHECKED.has(e.type) && !nameOf(e));
    row('missing-accessibility-label', s.id, !unlabeled.length, unlabeled.length ? `${unlabeled.map((e) => `${typeName(e.type)} (${box(e)})`).join('; ')} has no accessibility label` : 'every control has a label');

    const clipped = overflowing(elements, size);
    row('text-clipped', s.id, !clipped.length, clipped.length ? `${clipped.map((e) => `${where(e)} (${box(e)})`).join('; ')} is wider than the ${size.width} pt screen` : 'nothing is wider than the screen');

    if (s.large) {
      const big = overflowing(s.large.elements, s.large.size).filter((e) => !clipped.some((c) => nameOf(c) === nameOf(e) && c.type === e.type));
      row('dynamic-type-overflow', s.id, !big.length, big.length ? `at the largest accessibility text size, ${big.map((e) => `${where(e)} (${box(e)})`).join('; ')} is wider than the ${s.large.size.width} pt screen` : 'nothing is wider than the screen at the largest accessibility text size');
    } else notChecked.push({ probe: 'dynamic-type-overflow', route: s.id, reason: 'the screen could not be reached again at the large text size' });
  }

  for (const s of screens) {
    const mine = taps.filter((t) => t.screen === s.id);
    for (const t of mine.filter((x) => x.crashed)) row('crash-on-tap', s.id, false, `tapping "${t.name}" ended the app${t.report ? `: ${t.report}` : ''}`);
    if (!mine.some((x) => x.crashed)) row('crash-on-tap', s.id, true, `${mine.length} taps left the app running`);
  }
  return rows;
}
