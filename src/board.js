import { migratePadIcons, randomIcon } from './icons.js';

export const PAD_COUNT = 16;
export const DEFAULT_BINDINGS = Object.freeze(['q','w','e','r','a','s','d','f','y','x','c','v','1','2','3','4']);
const bindingCandidates = [...new Set([...DEFAULT_BINDINGS, ...'abcdefghijklmnopqrstuvwxyz0123456789'])];
const emptyPad = (binding, random = Math.random) => ({ binding, name:'', demo:null, audio:null, icon:randomIcon(random), iconChosen:false });

export function makeBank(name, demos = false) {
  return { id:crypto.randomUUID(), name, pads:DEFAULT_BINDINGS.map((binding,i) => ({ ...emptyPad(binding), ...(demos && i < 3 ? { name:['Demo · Chime','Demo · Pop','Demo · Gong'][i], demo:i } : {}) })) };
}

export function migrateBoard(board, random = Math.random) {
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
