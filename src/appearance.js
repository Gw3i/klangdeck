import './appearance.css';

const STORAGE_KEY = 'klangdeck.appearance.v1';
const OCEAN = '#36a9e9';
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export function createAppearanceControls(editor, scene, notice) {
  let settings = { color: OCEAN, motion: true, fill: 50 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && validColor(saved.color)) settings.color = saved.color.toLowerCase();
    if (saved && typeof saved.motion === 'boolean') settings.motion = saved.motion;
    if (saved && typeof saved.fill === 'number' && Number.isFinite(saved.fill) && saved.fill >= 0 && saved.fill <= 100) settings.fill = saved.fill;
  } catch { /* Invalid or unavailable storage must not prevent opening the board. */ }
  const panel = document.createElement('fieldset');
  panel.className = 'appearance-controls';
  panel.innerHTML = `<legend>Shell lighting</legend><div class="appearance-color-row"><label for="shell-color">Color<input id="shell-color" type="color" aria-label="Shell light color"></label><button type="button" id="shell-ocean"><span aria-hidden="true"></span>Ocean blue</button></div><div class="appearance-fill"><label for="shell-fill">Color fill <output id="shell-fill-value" for="shell-fill">50%</output></label><input id="shell-fill" type="range" min="0" max="100" step="1" value="50" aria-describedby="shell-fill-help"><p id="shell-fill-help">0% turns the color off. 100% fills the shell, leaving a narrow moving gap.</p></div><label class="appearance-motion"><input id="shell-motion" type="checkbox">Move light slowly</label><p>Saved automatically. The light stays still when Reduce Motion is enabled.</p>`;
  editor.insertBefore(panel, editor.querySelector('footer'));
  const color = panel.querySelector('#shell-color');
  const motion = panel.querySelector('#shell-motion');
  const fill = panel.querySelector('#shell-fill');
  const fillValue = panel.querySelector('#shell-fill-value');
  function apply() {
    color.value = settings.color;
    motion.checked = settings.motion;
    fill.value = settings.fill;
    fillValue.value = `${settings.fill}%`;
    fill.setAttribute('aria-valuetext', `${settings.fill}%`);
    scene.setAppearance(settings);
  }
  function save() {
    apply();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { notice('The lighting settings could not be saved. Please check available storage.', true); }
  }
  color.addEventListener('input', () => {
    if (validColor(color.value)) { settings.color = color.value.toLowerCase(); save(); }
  });
  fill.addEventListener('input', () => {
    const value = fill.valueAsNumber;
    if (Number.isFinite(value)) { settings.fill = Math.max(0, Math.min(100, value)); save(); }
  });
  motion.addEventListener('change', () => { settings.motion = motion.checked; save(); });
  panel.querySelector('#shell-ocean').addEventListener('click', () => { settings.color = OCEAN; save(); });
  apply();
}
