import test from 'node:test';
import assert from 'node:assert/strict';
import { iconIds, isIcon, migratePadIcons, randomIcon, safeIcon, searchIcons } from '../src/icons.ts';

/** A stored pad from before icons existed. */
interface LegacyPad {
  audio: string;
  demo: null;
  binding: string;
  name: string;
  icon?: unknown;
  iconChosen?: boolean;
}

test('icon migration preserves existing sound references and pad metadata', () => {
  const original: { current: number; banks: { id: string; name: string; pads: LegacyPad[] }[] } = { current: 0, banks: [{ id: 'bank-a', name: 'Meine Bank', pads: [
    { audio: 'sound-123', demo: null, binding: 'q', name: 'Applaus' },
    { audio: 'sound-456', demo: null, binding: 'w', name: 'Gong', icon: 'Heart', iconChosen: true }
  ] }] };
  const before = structuredClone(original);
  const { next, changed } = migratePadIcons(original, () => .5);
  assert.equal(changed, true);
  assert.deepEqual(original, before);
  assert.ok(isIcon(next.banks[0].pads[0].icon));
  const migrated = { ...next.banks[0].pads[0] }; delete migrated.icon; delete migrated.iconChosen;
  assert.deepEqual(migrated, original.banks[0].pads[0]);
  assert.deepEqual(next.banks[0].pads[1], original.banks[0].pads[1]);
  const repeated = migratePadIcons(next, () => .99);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.next, next);
});

test('search returns the complete offline catalog without pagination', () => {
  const all = searchIcons('').items;
  assert.ok(iconIds.length > 1500);
  assert.deepEqual([...all].sort(), [...iconIds]);
  assert.equal(new Set(all).size, iconIds.length);
  assert.ok(searchIcons('herz').items.includes('Heart'));
  assert.ok(searchIcons('music').items.includes('Music'));
  assert.equal(searchIcons('no-such-icon-zzzzz').total, 0);
});

test('invalid stored icons fall back safely without changing valid choices', () => {
  assert.equal(safeIcon('__proto__'), 'Music');
  assert.equal(safeIcon('Heart'), 'Heart');
  assert.ok(isIcon(randomIcon(() => 0)));
  assert.ok(isIcon(randomIcon(() => .999999)));
  const result = migratePadIcons({ banks: [{ pads: [{ icon: 'not-real', audio: 'keep-me' }] }] }, () => 0);
  assert.equal(result.next.banks[0].pads[0].audio, 'keep-me');
  assert.ok(isIcon(result.next.banks[0].pads[0].icon));
});
