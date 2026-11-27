import { migratePadIcons, randomIcon } from './icons.ts';

export interface Pad {
  binding: string;
  name: string;
  /** Index of a built-in demo sound, or null. */
  demo: number | null;
  /** Key of the imported audio in the IndexedDB "sounds" store, or null. */
  audio: string | null;
  icon: string;
  iconChosen: boolean;
}
export interface Bank {
  id: string;
  name: string;
  pads: Pad[];
}
export interface Board {
  current: number;
  banks: Bank[];
}

export const PAD_COUNT = 16;
export const DEFAULT_BINDINGS = Object.freeze(['q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'y', 'x', 'c', 'v', '1', '2', '3', '4']);
const bindingCandidates = [...new Set([...DEFAULT_BINDINGS, ...'abcdefghijklmnopqrstuvwxyz0123456789'])];
const DEMO_NAMES = ['Demo · Chime', 'Demo · Pop', 'Demo · Gong'];
const emptyPad = (binding: string, random = Math.random): Pad => ({ binding, name: '', demo: null, audio: null, icon: randomIcon(random), iconChosen: false });

export function makeBank(name: string, demos = false): Bank {
  return {
    id: crypto.randomUUID(),
    name,
    pads: DEFAULT_BINDINGS.map((binding, i) => ({ ...emptyPad(binding), ...(demos && i < 3 ? { name: DEMO_NAMES[i], demo: i } : {}) }))
  };
}

export function migrateBoard(board: Board, random = Math.random) {
  const migration = migratePadIcons(board, random);
  for (const bank of migration.next.banks) {
    const used = new Set(bank.pads.map(pad => String(pad.binding).toLowerCase()));
    while (bank.pads.length < PAD_COUNT) {
      const binding = bindingCandidates.find(candidate => !used.has(candidate));
      if (!binding) throw new Error('No unused shortcut found for the new sound bank.');
      bank.pads.push(emptyPad(binding, random));
      used.add(binding);
      migration.changed = true;
    }
  }
  return migration;
}
