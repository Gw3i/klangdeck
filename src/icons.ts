import { icons, type IconNode } from 'lucide';

const library: Readonly<Record<string, IconNode>> = icons;
export const iconIds = Object.freeze(Object.keys(library).sort());
export const isIcon = (id: unknown): id is string => typeof id === 'string' && Object.hasOwn(library, id);
export const safeIcon = (id: unknown) => isIcon(id) ? id : 'Music';
export const randomIcon = (random = Math.random) =>
  iconIds[Math.min(iconIds.length - 1, Math.max(0, Math.floor(random() * iconIds.length)))];
/** "CirclePlay" becomes "Circle Play". */
export const iconLabel = (id: string) => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

const favorites = ['Music', 'Zap', 'Heart', 'Check', 'X', 'Mic', 'Bell', 'Smile', 'Volume2', 'Sparkles', 'Waves', 'Drum', 'Star', 'Flame', 'Hand', 'Rocket', 'Cloud', 'Moon', 'Sun', 'CirclePlay', 'Headphones', 'Guitar', 'PartyPopper', 'Coffee'];
const searchWords = new Map(iconIds.map(id => [id, iconLabel(id).toLowerCase()]));
const german: Record<string, string> = { musik: 'music', herz: 'heart', blitz: 'zap', mikrofon: 'mic', glocke: 'bell', lachen: 'laugh', lächeln: 'smile', stern: 'star', feuer: 'flame', trommel: 'drum', gitarre: 'guitar', klang: 'audio', ton: 'volume', laut: 'volume', leise: 'volume', wolke: 'cloud', sonne: 'sun', mond: 'moon', pfeil: 'arrow', kreis: 'circle', haken: 'check', stopp: 'square', rakete: 'rocket', katze: 'cat', hund: 'dog', kaffee: 'coffee', telefon: 'phone', uhr: 'clock', regen: 'rain', welle: 'waves', kopf: 'head', applaus: 'clap' };

export function searchIcons(query = '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(word => german[word] || word);
  const matches = words.length
    ? iconIds.filter(id => words.every(word => searchWords.get(id)?.includes(word)))
    : [...favorites.filter(isIcon), ...iconIds.filter(id => !favorites.includes(id))];
  return { items: matches, total: matches.length };
}

interface IconFields {
  icon?: unknown;
  iconChosen?: boolean;
}

// Add only icon metadata. Existing banks, bindings, names and audio references survive unchanged.
export function migratePadIcons<T extends { banks: { pads: IconFields[] }[] }>(board: T, random = Math.random) {
  const next = structuredClone(board);
  let changed = false;
  for (const bank of next.banks) for (const pad of bank.pads) {
    if (!isIcon(pad.icon)) {
      pad.icon = randomIcon(random);
      pad.iconChosen = false;
      changed = true;
    }
  }
  return { next, changed };
}

export function iconElement(id: unknown, size = 24) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const attributes = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, String(value));
  for (const [tag, attrs] of library[safeIcon(id)]) {
    const node = document.createElementNS(namespace, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}

interface IconPath {
  path: Path2D;
  filled: boolean;
}
const paths = new Map<string, IconPath[]>();
function iconPaths(id: string) {
  const cached = paths.get(id);
  if (cached) return cached;
  const result = library[id].map(([tag, a]) => {
    const p = new Path2D(tag === 'path' ? String(a.d) : undefined);
    const n = (key: string) => Number(a[key] || 0);
    if (tag === 'circle') p.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
    if (tag === 'ellipse') p.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
    if (tag === 'rect') p.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx') || n('ry'));
    if (tag === 'line') {
      p.moveTo(n('x1'), n('y1'));
      p.lineTo(n('x2'), n('y2'));
    }
    if (tag === 'polyline' || tag === 'polygon') {
      const points = String(a.points).trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i < points.length; i += 2) p[i ? 'lineTo' : 'moveTo'](points[i], points[i + 1]);
      if (tag === 'polygon') p.closePath();
    }
    return { path: p, filled: a.fill === 'currentColor' };
  });
  paths.set(id, result);
  if (paths.size > 96) {
    const oldest = paths.keys().next().value;
    if (oldest !== undefined) paths.delete(oldest);
  }
  return result;
}

export function drawPadIcon(ctx: CanvasRenderingContext2D, iconId: unknown, binding: string, width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  const size = Math.min(width, height) * .40;
  ctx.translate((width - size) / 2, height * .47 - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = ctx.fillStyle = '#17191a';
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const entry of iconPaths(safeIcon(iconId))) {
    ctx.stroke(entry.path);
    if (entry.filled) ctx.fill(entry.path);
  }
  ctx.restore();
  ctx.save();
  ctx.fillStyle = '#252727';
  ctx.font = `500 ${Math.round(height * .065)}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(binding || '').toUpperCase().slice(0, 2), width * .84, height * .85);
  ctx.restore();
}
