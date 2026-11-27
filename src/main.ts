import './style.css';
import { createScene, type Scene } from './scene.ts';
import { createMeetControls } from './meet.ts';
import { createAppearanceControls } from './appearance.ts';
import { PAD_COUNT, makeBank, migrateBoard, type Board, type Pad } from './board.ts';
import { iconElement, iconLabel, isIcon, randomIcon, safeIcon, searchIcons } from './icons.ts';
import { $, errorMessage } from './dom.ts';

interface ImportGeneration {
  key: string;
  token: number;
}
interface IconTarget {
  mode: 'editor' | 'import';
  bankId: string;
  index: number;
  audioId?: string;
  generation?: ImportGeneration;
}
interface IconSession extends IconTarget {
  icon: string;
}

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app');
root.innerHTML = `<div id="device"><div id="brand" class="anchor drag-area">klangdeck</div><div id="tools" class="anchor"><button id="settings" title="Configure sounds and keys" aria-label="Settings">⚙</button><button id="hide" title="Hide" aria-label="Hide">−</button></div><div id="pads" aria-label="Sound pads"></div></div><div id="notice" role="status" aria-live="polite"></div><input id="audio-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aiff" hidden><dialog id="dialog"><form id="editor"><header><h1>Your Klangdeck</h1><button id="close-dialog" type="button" aria-label="Close settings">×</button></header><label>Sound bank<select id="bank-select"></select></label><label>Bank name<div class="bank-row"><input id="bank-title" maxlength="28" required><button id="add-bank" type="button">＋ New bank</button></div></label><label>Pad<select id="edit-pad"></select></label><div class="edit-row"><label>Sound name<input id="pad-title" maxlength="24" placeholder="My sound"></label><label>Shortcut<input id="pad-key" maxlength="1" autocomplete="off" spellcheck="false" required></label></div><div class="icon-field"><span>Pad icon</span><button id="choose-icon" type="button"><span id="icon-preview"></span><span>Choose icon</span></button></div><p id="sound-info"></p><div class="sound-actions"><button id="replace-sound" type="button">Choose sound</button><button id="clear-sound" type="button">Remove sound</button></div><p class="help">Playable MP3, WAV, M4A, OGG, FLAC or AIFF. Up to 25 MB per sound. Your files stay on this Mac.</p><p class="help" id="shortcut-info">⌘ ⇧ Space opens Klangdeck. Esc stops all sounds.</p><p id="form-error" role="alert"></p><footer><button id="save-pad" type="submit" class="primary">Save</button></footer></form></dialog><dialog id="icon-dialog" aria-labelledby="icon-title"><header><h1 id="icon-title">Choose icon</h1><button id="close-icons" type="button" aria-label="Close icon picker">×</button></header><p id="icon-intro" class="help"></p><label for="icon-search">Search Lucide icons</label><input id="icon-search" type="search" placeholder="e.g. music, heart or lightning" autocomplete="off"><p id="icon-count" role="status"></p><div id="icon-results" aria-label="Available icons"><div id="icon-grid"></div></div><div class="icon-selection"><span id="chosen-icon"></span><span id="chosen-icon-name"></span><button id="random-icon" type="button">Random icon</button></div><p id="icon-error" role="alert"></p><footer><button id="skip-icon" type="button">Keep</button><button id="apply-icon" type="button" class="primary">Use icon</button></footer></dialog>`;

const dialog = $<HTMLDialogElement>('dialog'), iconDialog = $<HTMLDialogElement>('icon-dialog'), editor = $<HTMLFormElement>('editor');
const audioFile = $<HTMLInputElement>('audio-file'), noticeBox = $('notice'), formError = $('form-error');
const bankSelect = $<HTMLSelectElement>('bank-select'), editPad = $<HTMLSelectElement>('edit-pad');
const iconResults = $('icon-results'), iconGrid = $('icon-grid'), iconSearch = $<HTMLInputElement>('icon-search');
const iconError = $('icon-error'), applyIcon = $<HTMLButtonElement>('apply-icon');

const buttons: HTMLButtonElement[] = [], held = new Map<string, number>(), active = new Map<number, AudioBufferSourceNode>(), buffers = new Map<string, AudioBuffer>();
let scene: Scene, db: IDBDatabase, state: Board | undefined, context: AudioContext | undefined;
let bankSwitching = false, selected = 0, pickerTarget: { bankId: string; index: number } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined, writeQueue: Promise<void> = Promise.resolve();
let editorIcon = 'Music', editorIconChosen = false, iconSession: IconSession | null = null;
let iconMatches: string[] = [], iconFocus = 0, iconWindow = '', iconScrollFrame = 0;
const meet = createMeetControls(editor, notice);
const playTokens = Array<number>(PAD_COUNT).fill(0), pressSources = Array.from({ length: PAD_COUNT }, () => new Set<string>());
const importTokens = new Map<string, number>(), pendingBuffers = new Map<string, Promise<AudioBuffer>>();

/** Only called after the board has loaded; every handler that needs it checks `state` first. */
function board() {
  if (!state) throw new Error('The board is not loaded yet.');
  return state;
}
const current = () => {
  const loaded = board();
  return loaded.banks[loaded.current];
};
const findPad = (next: Board, bankId: string, index: number) => next.banks.find(bank => bank.id === bankId)?.pads[index];
const dialogsOpen = () => dialog.open || iconDialog.open;

function hold(i: number, source: string, down: boolean) {
  if (down) pressSources[i].add(source);
  else pressSources[i].delete(source);
  scene.press(i, pressSources[i].size > 0);
}
function releaseHolds() {
  pressSources.forEach(sources => sources.clear());
  held.clear();
  scene.release();
}
function cacheBuffer(id: string, buffer: AudioBuffer) {
  buffers.delete(id);
  buffers.set(id, buffer);
  while (buffers.size > PAD_COUNT * 2) {
    const oldest = buffers.keys().next().value;
    if (oldest === undefined) break;
    buffers.delete(oldest);
  }
  return buffer;
}
function advanceImport(bankId: string, index: number): ImportGeneration {
  const key = `${bankId}:${index}`, token = (importTokens.get(key) || 0) + 1;
  importTokens.set(key, token);
  return { key, token };
}
const importCurrent = (generation: ImportGeneration) => importTokens.get(generation.key) === generation.token;
function notice(message: string, error = false) {
  noticeBox.textContent = message;
  noticeBox.classList.toggle('error', error);
  noticeBox.classList.add('visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => noticeBox.classList.remove('visible'), error ? 7000 : 3500);
}
function position(element: HTMLElement, point: { x: number; y: number }) {
  element.style.left = `${point.x}px`;
  element.style.top = `${point.y}px`;
}

for (let i = 0; i < PAD_COUNT; i++) {
  const b = document.createElement('button');
  b.className = 'pad';
  b.dataset.pad = String(i);
  b.type = 'button';
  $('pads').append(b);
  buttons.push(b);
  b.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !state) return;
    e.preventDefault();
    b.focus();
    b.setPointerCapture(e.pointerId);
    hold(i, `pointer:${e.pointerId}`, true);
    void trigger(i);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) b.addEventListener(event, e => hold(i, `pointer:${e.pointerId}`, false));
  b.addEventListener('click', e => {
    if (e.detail === 0) {
      hold(i, 'accessible-click', true);
      void trigger(i);
      setTimeout(() => hold(i, 'accessible-click', false), 140);
    }
  });
  b.addEventListener('contextmenu', e => {
    e.preventDefault();
    openSettings(i);
  });
  b.addEventListener('dragover', e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    b.classList.add('drop');
  });
  b.addEventListener('dragleave', () => b.classList.remove('drop'));
  b.addEventListener('drop', e => {
    e.preventDefault();
    b.classList.remove('drop');
    const file = e.dataTransfer?.files[0];
    if (file) void importSound(file, current().id, i);
  });
}
try {
  scene = createScene($('device'), layout => {
    layout.pads.forEach((p, i) => Object.assign(buttons[i].style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.w}px`, height: `${p.h}px` }));
    position($('brand'), layout.header);
    position($('tools'), layout.tools);
  });
} catch (e) {
  root.innerHTML = '<div class="fatal"><h1>3D could not start</h1><p>Please restart Klangdeck. The app requires WebGL hardware acceleration.</p></div>';
  throw e;
}

createAppearanceControls(editor, scene, notice);

function request<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function commit(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save cancelled'));
  });
}
function openDB() {
  const r = indexedDB.open('klangdeck', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('settings');
    r.result.createObjectStore('sounds');
  };
  return request(r);
}
/** Stored values are whatever the app wrote earlier: the board object and raw audio bytes. */
const readSound = (id: string) => request<ArrayBuffer | undefined>(db.transaction('sounds').objectStore('sounds').get(id));
const audioIds = (value: Board) => value.banks.flatMap(bank => bank.pads.map(pad => pad.audio).filter((id): id is string => !!id));
async function persist(next: Board, audioEntry: { id: string; bytes: ArrayBuffer } | null = null) {
  const tx = db.transaction(['settings', 'sounds'], 'readwrite');
  tx.objectStore('settings').put(next, 'board');
  const kept = new Set(audioIds(next));
  for (const id of state ? audioIds(state) : []) {
    if (!kept.has(id)) {
      tx.objectStore('sounds').delete(id);
      buffers.delete(id);
    }
  }
  if (audioEntry) tx.objectStore('sounds').put(audioEntry.bytes, audioEntry.id);
  await commit(tx);
  state = next;
  render();
}
function queueChange(change: (next: Board) => void, audio: { id: string; bytes: ArrayBuffer } | null = null) {
  const operation = writeQueue.then(async () => {
    const next = structuredClone(board());
    change(next);
    await persist(next, audio);
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
function render() {
  const bank = current();
  scene.setPads(bank.pads);
  bank.pads.forEach((p, i) => {
    buttons[i].setAttribute('aria-label', `${p.name || 'Add sound'}, key ${p.binding.toUpperCase()}`);
    buttons[i].title = `${p.name || 'Add sound'} · ${p.binding.toUpperCase()}\nRight-click to edit`;
  });
}
function audioContext() {
  return context ??= new AudioContext();
}
function demoBuffer(kind: number) {
  const ac = audioContext(), length = [.7, .22, 1.3][kind], b = ac.createBuffer(1, Math.ceil(ac.sampleRate * length), ac.sampleRate), a = b.getChannelData(0);
  for (let n = 0; n < a.length; n++) {
    const t = n / ac.sampleRate;
    let x = 0;
    if (kind === 0) x = (Math.sin(2 * Math.PI * 660 * t) + .45 * Math.sin(2 * Math.PI * 990 * t)) * Math.exp(-t * 8);
    if (kind === 1) x = Math.sin(2 * Math.PI * (180 * t + 100 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 22);
    if (kind === 2) x = (Math.sin(2 * Math.PI * 220 * t) + .3 * Math.sin(2 * Math.PI * 443 * t) + .2 * Math.sin(2 * Math.PI * 657 * t)) * Math.exp(-t * 4);
    a[n] = x * .22 * Math.min(t * 700, 1);
  }
  return b;
}
const hasSound = (p: Pad) => !!p.audio || p.demo !== null;
async function loadBuffer(p: Pad) {
  const demo = p.demo, audio = p.audio;
  const id = demo !== null ? `demo:${demo}` : audio;
  if (id === null) throw new Error('This pad has no sound.');
  const cached = buffers.get(id) ?? pendingBuffers.get(id);
  if (cached) return cached;
  const pending = (async () => {
    if (demo !== null) return cacheBuffer(id, demoBuffer(demo));
    const bytes = await readSound(id);
    if (!bytes) throw new Error('The saved audio file is missing. Please choose it again.');
    return cacheBuffer(id, await audioContext().decodeAudioData(bytes.slice(0)));
  })();
  pendingBuffers.set(id, pending);
  try {
    return await pending;
  } finally {
    pendingBuffers.delete(id);
  }
}
async function warmBank() {
  const bank = current();
  await Promise.all(bank.pads.map(async (p, i) => {
    if (!hasSound(p)) return;
    buttons[i].classList.add('loading');
    try {
      await loadBuffer(p);
    } catch {
      if (current().id === bank.id) notice(`“${p.name}” could not be loaded. Please choose it again.`, true);
    } finally {
      if (current().id === bank.id) buttons[i].classList.remove('loading');
    }
  }));
}
let playbackEpoch = 0;
async function trigger(i: number) {
  if (!state || bankSwitching || dialogsOpen()) return;
  const p = current().pads[i];
  if (!hasSound(p)) {
    chooseFile(current().id, i);
    return;
  }
  const createdAt = Date.now(), epoch = playbackEpoch, bankId = current().id, token = ++playTokens[i];
  try {
    const ac = audioContext();
    await ac.resume();
    const buffer = await loadBuffer(p);
    if (epoch !== playbackEpoch || current().id !== bankId || token !== playTokens[i]) return;
    active.get(i)?.stop();
    const source = ac.createBufferSource();
    source.buffer = buffer;
    source.connect(ac.destination);
    source.onended = () => {
      source.disconnect();
      if (active.get(i) === source) {
        active.delete(i);
        scene.playing(i, false);
      }
    };
    active.set(i, source);
    scene.playing(i, true);
    source.start();
    void meet.play({ slot: i, pad: p, buffer, createdAt, readBytes: readSound });
  } catch (e) {
    notice(`Sound could not be played: ${errorMessage(e)}`, true);
  }
}
function stopAll() {
  playbackEpoch++;
  meet.stop();
  for (const source of active.values()) source.stop();
  active.clear();
  for (let i = 0; i < PAD_COUNT; i++) scene.playing(i, false);
  releaseHolds();
}
function chooseFile(bankId: string, index: number) {
  pickerTarget = { bankId, index };
  audioFile.value = '';
  audioFile.click();
}
audioFile.addEventListener('change', () => {
  const file = audioFile.files?.[0];
  if (file && pickerTarget) void importSound(file, pickerTarget.bankId, pickerTarget.index);
});
async function importSound(file: File, bankId: string, index: number) {
  const generation = advanceImport(bankId, index);
  if (file.size > 25 * 1024 * 1024) {
    notice('This sound exceeds 25 MB. Please choose a smaller file.', true);
    return;
  }
  if (!file.size) {
    notice('This file is empty. Please choose an audio file.', true);
    return;
  }
  buttons[index].classList.add('loading');
  try {
    const bytes = await file.arrayBuffer();
    const decoded = await audioContext().decodeAudioData(bytes.slice(0));
    const id = crypto.randomUUID(), name = file.name.replace(/\.[^.]+$/, '').slice(0, 24);
    if (!importCurrent(generation)) return;
    await queueChange(next => {
      if (!importCurrent(generation)) throw new Error('stale-import');
      const pad = findPad(next, bankId, index);
      if (!pad) throw new Error('Sound bank not found');
      pad.audio = id;
      pad.demo = null;
      pad.name = name;
      if (!pad.iconChosen || !isIcon(pad.icon)) {
        pad.icon = randomIcon();
        pad.iconChosen = false;
      }
    }, { id, bytes });
    cacheBuffer(id, decoded);
    notice(`“${name}” saved.`);
    if (dialog.open && current().id === bankId && selected === index) fillEditor();
    if (current().id === bankId && importCurrent(generation)) openIconPicker({ mode: 'import', bankId, index, audioId: id, generation });
  } catch (e) {
    if (errorMessage(e) === 'stale-import') return;
    notice('Sound not saved. Choose a playable audio file and check available disk space.', true);
    console.warn('Sound import:', errorMessage(e));
  } finally {
    buttons[index].classList.remove('loading');
  }
}
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    stopAll();
    return;
  }
  if (!state || e.repeat || e.metaKey || e.ctrlKey || e.altKey || dialogsOpen() || (e.target instanceof Element && e.target.closest('input,select,textarea'))) return;
  const index = current().pads.findIndex(p => p.binding === e.key.toLowerCase());
  if (index < 0) return;
  e.preventDefault();
  held.set(e.code, index);
  hold(index, `key:${e.code}`, true);
  void trigger(index);
});
window.addEventListener('keyup', e => {
  const i = held.get(e.code);
  if (i !== undefined) {
    hold(i, `key:${e.code}`, false);
    held.delete(e.code);
  }
});
window.addEventListener('blur', releaseHolds);
$('hide').onclick = () => window.soundboard?.hide();
$('hide').hidden = !window.soundboard;
async function switchBank(bankId: string) {
  if (bankSwitching || bankId === current().id) return;
  bankSwitching = true;
  stopAll();
  pickerTarget = null;
  iconDialog.close();
  const controls = [...editor.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')], disabled = controls.map(el => el.disabled);
  controls.forEach(el => el.disabled = true);
  try {
    await queueChange(next => {
      const index = next.banks.findIndex(bank => bank.id === bankId);
      if (index < 0) throw new Error('Sound bank not found');
      next.current = index;
    });
    selected = 0;
    void warmBank();
  } catch {
    notice('Sound bank could not be saved.', true);
  } finally {
    bankSwitching = false;
    controls.forEach((el, i) => el.disabled = disabled[i]);
    fillEditor();
  }
}
bankSelect.onchange = () => void switchBank(bankSelect.value);
function option(value: string, label: string) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}
function fillEditor() {
  const bank = current(), p = bank.pads[selected];
  bankSelect.replaceChildren(...board().banks.map(b => option(b.id, b.name)));
  bankSelect.value = bank.id;
  $<HTMLInputElement>('bank-title').value = bank.name;
  editPad.replaceChildren(...bank.pads.map((pad, i) => option(String(i), `${pad.binding.toUpperCase()} · ${pad.name || 'Empty'}`)));
  editPad.value = String(selected);
  $<HTMLInputElement>('pad-title').value = p.name;
  $<HTMLInputElement>('pad-key').value = p.binding.toUpperCase();
  editorIcon = safeIcon(p.icon);
  editorIconChosen = !!p.iconChosen;
  renderEditorIcon();
  $('sound-info').textContent = p.audio ? 'Custom sound saved on this Mac.' : p.demo !== null ? 'Built-in demo sound. You can replace it.' : 'No sound saved here yet.';
  $<HTMLButtonElement>('clear-sound').disabled = !hasSound(p);
  formError.textContent = '';
}
function openSettings(i = 0) {
  if (!state) return;
  stopAll();
  selected = i;
  fillEditor();
  dialog.showModal();
}
$('settings').onclick = () => openSettings();
$('close-dialog').onclick = () => dialog.close();
editPad.onchange = () => {
  selected = Number(editPad.value);
  fillEditor();
};
$('replace-sound').onclick = () => chooseFile(current().id, selected);
$('clear-sound').onclick = async () => {
  const bankId = current().id, index = selected;
  advanceImport(bankId, index);
  try {
    await queueChange(next => {
      const p = findPad(next, bankId, index);
      if (!p) throw new Error('Sound bank not found');
      p.audio = null;
      p.demo = null;
      p.name = '';
    });
    if (current().id === bankId && selected === index) fillEditor();
  } catch {
    notice('Change could not be saved.', true);
  }
};
$('add-bank').onclick = async () => {
  try {
    await queueChange(next => {
      next.banks.push(makeBank(`Sound bank ${next.banks.length + 1}`));
      next.current = next.banks.length - 1;
    });
    selected = 0;
    fillEditor();
  } catch {
    notice('New sound bank could not be saved.', true);
  }
};
editor.onsubmit = async e => {
  e.preventDefault();
  const bankId = current().id, index = selected, icon = editorIcon, iconChosen = editorIconChosen;
  const binding = $<HTMLInputElement>('pad-key').value.trim().toLowerCase(), name = $<HTMLInputElement>('pad-title').value.trim(), bankName = $<HTMLInputElement>('bank-title').value.trim();
  if (!/^[\p{L}\p{N}]$/u.test(binding)) {
    formError.textContent = 'Choose one letter or number as the shortcut.';
    return;
  }
  if (current().pads.some((p, i) => i !== selected && p.binding === binding)) {
    formError.textContent = 'This shortcut is already used in this sound bank.';
    return;
  }
  if (!bankName) {
    formError.textContent = 'Enter a name for the sound bank.';
    return;
  }
  try {
    await queueChange(next => {
      const b = next.banks.find(bank => bank.id === bankId);
      if (!b) throw new Error('Sound bank not found');
      if (b.pads.some((p, i) => i !== index && p.binding === binding)) throw new Error('This shortcut is already used.');
      b.name = bankName;
      Object.assign(b.pads[index], { name, binding, icon, iconChosen });
    });
    dialog.close();
    notice('Sound and shortcut saved.');
  } catch (e) {
    const message = errorMessage(e);
    formError.textContent = message === 'This shortcut is already used.' ? message : 'Save failed. Please check available disk space.';
  }
};
window.addEventListener('klangdeck:settings', () => openSettings());

function renderEditorIcon() {
  $('icon-preview').replaceChildren(iconElement(editorIcon, 24));
}
function updateIconSelection() {
  if (!iconSession) return;
  $('chosen-icon').replaceChildren(iconElement(iconSession.icon, 26));
  $('chosen-icon-name').textContent = iconLabel(iconSession.icon);
  for (const button of iconGrid.querySelectorAll<HTMLElement>(':scope > button')) button.setAttribute('aria-pressed', String(button.dataset.icon === iconSession.icon));
}
const focusIcon = () => iconGrid.querySelector<HTMLElement>(`[data-index="${iconFocus}"]`)?.focus({ preventScroll: true });
const ICON_MOVES: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 };
/** Renders only the icon buttons near the visible scroll window of the 8-column grid. */
function paintIconWindow(force = false) {
  const viewport = iconResults, grid = iconGrid, width = grid.clientWidth;
  if (!width) return;
  const stride = width / 8, rows = Math.ceil(iconMatches.length / 8);
  grid.style.height = `${rows * stride}px`;
  const start = Math.max(0, Math.floor(viewport.scrollTop / stride) - 2) * 8;
  const end = Math.min(iconMatches.length, (Math.ceil((viewport.scrollTop + viewport.clientHeight) / stride) + 2) * 8);
  const windowKey = `${start}:${end}:${width}`;
  if (!force && windowKey === iconWindow) return;
  iconWindow = windowKey;
  const hadFocus = grid.contains(document.activeElement);
  if (iconFocus < start || iconFocus >= end) iconFocus = start;
  grid.replaceChildren(...iconMatches.slice(start, end).map((id, offset) => {
    const i = start + offset, button = document.createElement('button');
    button.type = 'button';
    button.dataset.icon = id;
    button.dataset.index = String(i);
    button.title = iconLabel(id);
    button.setAttribute('aria-label', button.title);
    button.tabIndex = i === iconFocus ? 0 : -1;
    button.append(iconElement(id, 25));
    Object.assign(button.style, { left: `${i % 8 * stride}px`, top: `${Math.floor(i / 8) * stride}px`, width: `${stride - 6}px`, height: `${stride - 6}px` });
    button.onfocus = () => {
      iconFocus = i;
      for (const b of grid.querySelectorAll<HTMLElement>(':scope > button')) b.tabIndex = b === button ? 0 : -1;
    };
    button.onclick = () => {
      if (!iconSession) return;
      iconSession.icon = id;
      updateIconSelection();
    };
    button.onkeydown = e => {
      if (!(e.key in ICON_MOVES) && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      iconFocus = e.key === 'Home' ? 0 : e.key === 'End' ? iconMatches.length - 1 : Math.max(0, Math.min(iconMatches.length - 1, i + ICON_MOVES[e.key]));
      const top = Math.floor(iconFocus / 8) * stride;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + stride > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + stride - viewport.clientHeight;
      paintIconWindow(true);
      focusIcon();
    };
    return button;
  }));
  updateIconSelection();
  if (hadFocus) focusIcon();
}
function renderIconResults() {
  const { items, total } = searchIcons(iconSearch.value);
  iconMatches = items;
  iconFocus = 0;
  iconWindow = '';
  iconResults.scrollTop = 0;
  $('icon-count').textContent = total === 0 ? 'No icons found. Try another search.' : `${total} Icons`;
  paintIconWindow(true);
  updateIconSelection();
}
iconResults.onscroll = () => {
  if (!iconScrollFrame) {
    iconScrollFrame = requestAnimationFrame(() => {
      iconScrollFrame = 0;
      paintIconWindow();
    });
  }
};
new ResizeObserver(() => {
  if (iconDialog.open) paintIconWindow(true);
}).observe(iconResults);
function openIconPicker(target: IconTarget) {
  const pad = findPad(board(), target.bankId, target.index);
  if (!pad) return;
  stopAll();
  const importing = target.mode === 'import';
  iconSession = { ...target, icon: importing ? safeIcon(pad.icon) : editorIcon };
  $('icon-title').textContent = importing ? 'Your sound is saved' : 'Choose icon';
  $('icon-intro').textContent = importing ? `An icon is already saved for “${pad.name || 'your sound'}”. Choose another or keep it.` : 'Choose an icon for this pad. It will be saved with the sound settings.';
  $('skip-icon').textContent = importing ? 'Keep icon' : 'Cancel';
  iconSearch.value = '';
  iconError.textContent = '';
  renderIconResults();
  if (!iconDialog.open) iconDialog.showModal();
  paintIconWindow(true);
  iconSearch.focus();
}
$('choose-icon').onclick = () => openIconPicker({ mode: 'editor', bankId: current().id, index: selected });
iconSearch.oninput = renderIconResults;
$('close-icons').onclick = $('skip-icon').onclick = () => iconDialog.close();
iconDialog.addEventListener('close', () => {
  iconSession = null;
});
$('random-icon').onclick = () => {
  if (iconSession) {
    iconSession.icon = randomIcon();
    updateIconSelection();
  }
};
function setEditorIcon(icon: string) {
  editorIcon = icon;
  editorIconChosen = true;
  renderEditorIcon();
}
applyIcon.onclick = async () => {
  const session = iconSession;
  if (!session) return;
  const chosen = session.icon;
  if (session.mode === 'editor') {
    if (current().id !== session.bankId || selected !== session.index) {
      iconError.textContent = 'The selected pad changed. Open the picker again.';
      return;
    }
    setEditorIcon(chosen);
    iconDialog.close();
    return;
  }
  applyIcon.disabled = true;
  try {
    await queueChange(next => {
      const pad = findPad(next, session.bankId, session.index);
      if (!pad || pad.audio !== session.audioId || !session.generation || !importCurrent(session.generation)) throw new Error('The sound changed. Open the icon picker again.');
      pad.icon = chosen;
      pad.iconChosen = true;
    });
    if (dialog.open && current().id === session.bankId && selected === session.index) setEditorIcon(chosen);
    if (iconSession === session) iconDialog.close();
  } catch (e) {
    if (iconSession === session) iconError.textContent = errorMessage(e);
  } finally {
    applyIcon.disabled = false;
  }
};

Object.defineProperty(window, '__soundboardDiagnostics', {
  value: () => ({
    ready: !!state,
    bankCount: state?.banks.length,
    bankName: state ? current().name : null,
    pads: state ? current().pads.map(p => ({ name: p.name, binding: p.binding, hasAudio: !!p.audio, demo: p.demo, icon: p.icon, iconChosen: !!p.iconChosen })) : [],
    meet: meet.diagnostics(),
    activeSounds: active.size,
    cachedBuffers: buffers.size,
    pendingBuffers: pendingBuffers.size,
    audioState: context?.state ?? 'not-created',
    ...scene.diagnostics()
  }),
  writable: false
});

try {
  db = await openDB();
  const stored = await request<Board | undefined>(db.transaction('settings').objectStore('settings').get('board'));
  if (!stored) {
    state = { current: 0, banks: [makeBank('My sounds', true)] };
    await persist(state);
  } else {
    state = stored;
    const migration = migrateBoard(stored);
    if (migration.changed) {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(migration.next, 'board');
      await commit(tx);
      state = migration.next;
    }
  }
  render();
  void warmBank();
  if (window.soundboard) {
    const shortcut = await window.soundboard.getShortcut();
    if (!shortcut.registered) notice('⌘ ⇧ Space is already in use. Open Klangdeck from the Dock.', true);
  }
} catch (e) {
  notice('Your sounds could not be loaded. Please restart Klangdeck.', true);
  console.error(e);
}
