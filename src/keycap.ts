import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

// The perimeter-grid construction is adapted from wass08/keyboard-configurator.
// The circular bowl profile and rounded opaque body are specific to Klangdeck.
// See THIRD_PARTY_NOTICES.md for the upstream provenance.
export const CAP_WIDTH = 0.0184;
export const CAP_HEIGHT = 0.0055;
const TOP_WIDTH = 0.01677;
const CORNER_RADIUS = 0.00295;
const BOWL_RADIUS = 0.00701;
const BOWL_DEPTH = 0.0016;
const EDGE_ROLL = (CAP_WIDTH - TOP_WIDTH) / 2;
let cachedCap: BufferGeometry;
let cachedDecal: BufferGeometry;

/** Smooth circular dish, with a flat rim outside the bowl. */
export function capTopHeight(x: number, z: number) {
  const bowl = Math.max(0, 1 - (x * x + z * z) / BOWL_RADIUS ** 2);
  return CAP_HEIGHT - BOWL_DEPTH * bowl * bowl;
}

function topNormal(x: number, z: number) {
  const bowl = Math.max(0, 1 - (x * x + z * z) / BOWL_RADIUS ** 2);
  const slope = 4 * BOWL_DEPTH * bowl / BOWL_RADIUS ** 2;
  return new Vector3(-slope * x, 1, -slope * z).normalize();
}

export function getKeycapGeometry() {
  if (cachedCap) return cachedCap;
  const n = 36;
  const positions: number[] = [], indices: number[] = [];
  const normals = new Map<number, Vector3>();
  const half = TOP_WIDTH / 2;
  for (let j = 0; j <= n; j++) {
    const z = Math.sin((j / n - 0.5) * Math.PI) * half;
    const cornerZ = Math.max(0, Math.abs(z) - (half - CORNER_RADIUS));
    const limit = half - CORNER_RADIUS + Math.sqrt(Math.max(0, CORNER_RADIUS ** 2 - cornerZ ** 2));
    for (let i = 0; i <= n; i++) {
      const x = (i / n * 2 - 1) * limit;
      normals.set(positions.length / 3, topNormal(x, z));
      positions.push(x, capTopHeight(x, z), z);
    }
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + n + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const boundary: number[] = [];
  for (let i = n; i > 0; i--) boundary.push(n * (n + 1) + i);
  for (let j = n; j > 0; j--) boundary.push(j * (n + 1));
  for (let i = 0; i < n; i++) boundary.push(i);
  for (let j = 0; j < n; j++) boundary.push(j * (n + 1) + n);
  const outline = boundary.map(index => {
    const x = positions[index * 3], z = positions[index * 3 + 2];
    const cx = Math.max(-half + CORNER_RADIUS, Math.min(half - CORNER_RADIUS, x));
    const cz = Math.max(-half + CORNER_RADIUS, Math.min(half - CORNER_RADIUS, z));
    const length = Math.hypot(x - cx, z - cz);
    return { x, z, ox: (x - cx) / length, oz: (z - cz) / length };
  });
  let previous = boundary;
  function connect(next: number[]) {
    for (let i = 0; i < boundary.length; i++) {
      const j = (i + 1) % boundary.length;
      indices.push(previous[i], previous[j], next[i], previous[j], next[j], next[i]);
    }
    previous = next;
  }
  // A quarter-circle rolls the broad rim into soft, almost vertical sidewalls.
  for (let strip = 1; strip <= 6; strip++) {
    const angle = strip / 6 * Math.PI / 2;
    connect(outline.map(({ x, z, ox, oz }) => {
      const index = positions.length / 3;
      positions.push(x + ox * EDGE_ROLL * Math.sin(angle), CAP_HEIGHT - EDGE_ROLL * (1 - Math.cos(angle)), z + oz * EDGE_ROLL * Math.sin(angle));
      normals.set(index, new Vector3(ox * Math.sin(angle), Math.cos(angle), oz * Math.sin(angle)));
      return index;
    }));
  }
  for (const [y, inset] of [[0.00065, 0], [0.00012, 0.00028], [0, 0.0005]]) {
    connect(outline.map(({ x, z, ox, oz }) => {
      const index = positions.length / 3;
      positions.push(x + ox * (EDGE_ROLL - inset), y, z + oz * (EDGE_ROLL - inset));
      return index;
    }));
  }
  const center = positions.length / 3;
  positions.push(0, 0, 0);
  for (let i = 0; i < previous.length; i++) indices.push(previous[i], previous[(i + 1) % previous.length], center);
  cachedCap = new BufferGeometry();
  cachedCap.setAttribute('position', new Float32BufferAttribute(positions, 3));
  cachedCap.setIndex(indices);
  cachedCap.computeVertexNormals();
  const attribute = cachedCap.getAttribute('normal');
  normals.forEach((normal, index) => attribute.setXYZ(index, normal.x, normal.y, normal.z));
  cachedCap.computeBoundingBox();
  return cachedCap;
}

/** The icon follows the bowl and flat rim, including the tiny corner shortcut. */
export function getCapDecalGeometry() {
  if (cachedDecal) return cachedDecal;
  const n = 24, extent = TOP_WIDTH * 0.46;
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const x = (i / n * 2 - 1) * extent, z = (j / n * 2 - 1) * extent;
    positions.push(x, capTopHeight(x, z) + 0.000035, z);
    uv.push(i / n, 1 - j / n);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + n + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  cachedDecal = new BufferGeometry();
  cachedDecal.setAttribute('position', new Float32BufferAttribute(positions, 3));
  cachedDecal.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  cachedDecal.setIndex(indices);
  cachedDecal.computeVertexNormals();
  return cachedDecal;
}
