import * as THREE from 'three';
import { getKeycapGeometry, getCapDecalGeometry, CAP_WIDTH } from './keycap.ts';
import { drawPadIcon } from './icons.ts';
import type { Appearance } from './appearance.ts';
import type { Pad } from './board.ts';

// All values are metres. The skirt stays 1.8 mm above the plate at full travel.
const PLATE_TOP = 0.0078;
const REST_Y = PLATE_TOP + 0.004;
const TRAVEL = 0.0022;
const PITCH = 0.0198;
const SHELL_SIZE = 0.110;
const PLATE_SIZE = 0.092;
const VIEW_HALF_HEIGHT = 0.063;

interface Point {
  x: number;
  y: number;
}
interface PadRect extends Point {
  w: number;
  h: number;
  cx: number;
  cy: number;
}
interface Layout {
  pads: PadRect[];
  header: Point;
  tools: Point;
}
interface Key {
  group: THREE.Group;
  cap: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  down: boolean;
  playing: boolean;
  depth: number;
  velocity: number;
  iconKey: string | null;
}

function context2d(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable.');
  return context;
}
function squareCanvas(size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
}
/** A rounded rectangle in the XZ plane, centred on the origin. */
function roundedPath(width: number, depth: number, radius: number) {
  const path = new THREE.Shape(), x = width / 2, z = depth / 2;
  path.moveTo(-x + radius, -z);
  path.lineTo(x - radius, -z);
  path.quadraticCurveTo(x, -z, x, -z + radius);
  path.lineTo(x, z - radius);
  path.quadraticCurveTo(x, z, x - radius, z);
  path.lineTo(-x + radius, z);
  path.quadraticCurveTo(-x, z, -x, z - radius);
  path.lineTo(-x, -z + radius);
  path.quadraticCurveTo(-x, -z, -x + radius, -z);
  return path;
}
/** Extrudes a flat outline into a beveled slab of height `height`, centred vertically. */
function beveledSlab(shape: THREE.Shape, height: number, bevel: number, curveSegments: number) {
  const depth = height - 2 * bevel;
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -depth / 2, 0);
  return geometry;
}
const flatMaterial = (parameters: THREE.MeshBasicMaterialParameters) =>
  new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, ...parameters });
function shadeBowl(ctx: CanvasRenderingContext2D) {
  // Fixed-light cavity shading is baked into the surface-conforming decal.
  // It makes the circular recess legible without shadow maps or extra draws.
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.filter = 'blur(2.5px)';
  const gradient = ctx.createLinearGradient(70, 65, 435, 440);
  gradient.addColorStop(0, 'rgba(72,86,104,.16)');
  gradient.addColorStop(.58, 'rgba(105,120,138,.07)');
  gradient.addColorStop(1, 'rgba(248,251,255,.32)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(256, 256, 231, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function createScene(host: HTMLElement, onLayout: (layout: Layout) => void) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.prepend(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-.063, .063, VIEW_HALF_HEIGHT, -VIEW_HALF_HEIGHT, .01, 1);
  camera.position.set(0, .25, .065);
  camera.lookAt(0, .003, 0);
  camera.updateMatrixWorld(true);
  scene.add(new THREE.HemisphereLight(0xf8fbff, 0x6e7785, 1.65));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.5);
  keyLight.position.set(-.085, .16, -.10);
  scene.add(keyLight);
  const fill = new THREE.DirectionalLight(0xe8efff, .3);
  fill.position.set(.1, .06, .08);
  scene.add(fill);
  const material = (color: THREE.ColorRepresentation, roughness = .62, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  function box(w: number, h: number, d: number, r: number, color: THREE.ColorRepresentation, x: number, y: number, z: number) {
    // RoundedBox clamps its radius to half the thickness, making thin plates
    // almost square. An extruded rounded outline keeps the broad plan radius.
    const bevel = Math.min(.0006, h * .24), hw = w / 2 - bevel, hd = d / 2 - bevel;
    const radius = Math.max(.0001, Math.min(r - bevel, hw, hd));
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial>(beveledSlab(roundedPath(hw * 2, hd * 2, radius), h, bevel, 10), material(color));
    mesh.position.set(x, y, z);
    scene.add(mesh);
    return mesh;
  }
  const lightColor = new THREE.Color('#36a9e9');
  const sweep = { value: .033 }, fillCoverage = { value: .5 };
  const appearance: Appearance = { color: '#36a9e9', motion: true, fill: 50 };
  let sweepPhase = .2;
  function acrylicMaterial(opacity: number, strength: number) {
    const surface = new THREE.MeshPhysicalMaterial({ color: 0xf4f7fa, roughness: .68, metalness: 0, ior: 1.49, clearcoat: .32, clearcoatRoughness: .42, transparent: true, opacity, depthWrite: false });
    surface.onBeforeCompile = shader => {
      shader.uniforms.shellLightColor = { value: lightColor };
      shader.uniforms.shellSweepX = sweep;
      shader.uniforms.shellFill = fillCoverage;
      shader.vertexShader = 'varying vec3 vShellPosition;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvShellPosition = position;');
      shader.fragmentShader = 'uniform vec3 shellLightColor; uniform float shellSweepX; uniform float shellFill; varying vec3 vShellPosition;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float bandDistance = abs(mod(vShellPosition.x-shellSweepX+0.055,0.11)-0.055);
        float halfWidth = shellFill * 0.0506;
        float feather = min(0.016,halfWidth*0.65);
        // Finish the fade at the wrap midpoint so the moving gap has no cusp.
        float fadeEnd = min(0.055,halfWidth+feather);
        float blend = clamp((bandDistance-halfWidth+feather)/max(fadeEnd-halfWidth+feather,0.000001),0.0,1.0);
        float softEdge = blend*blend*blend*(blend*(blend*6.0-15.0)+10.0);
        float shellBand = shellFill > 0.0 ? 1.0-softEdge : 0.0;
        float shellEdge = pow(1.0-abs(dot(normalize(normal),normalize(vViewPosition))),2.0);
        float frontGlow = 0.72+0.28*smoothstep(-0.055,0.055,vShellPosition.z);
        vec2 seamQ = abs(vShellPosition.xz)-vec2(0.039);
        float seamDistance = length(max(seamQ,0.0))+min(max(seamQ.x,seamQ.y),0.0)-0.008;
        float innerSeam = exp(-pow((seamDistance-0.0012)/0.0028,2.0));
        float depthGlow = 1.0-smoothstep(-0.003,-0.0004,vShellPosition.y);
        diffuseColor.rgb = mix(diffuseColor.rgb,mix(vec3(0.90),shellLightColor,0.44),shellBand*0.60);
        totalEmissiveRadiance += vec3(0.13) + shellLightColor * shellBand * (${strength.toFixed(3)} * frontGlow * (0.705+innerSeam*0.85+depthGlow*0.28) + shellEdge * 0.08);
        diffuseColor.a = clamp(diffuseColor.a + shellEdge * 0.12 + shellBand * 0.08,0.0,0.90);
      `);
    };
    surface.customProgramCacheKey = () => `klangdeck-acrylic-${strength}`;
    return surface;
  }
  function acrylicRing(outer: number, inner: number, height: number, radius: number, innerRadius: number, y: number, opacity: number, strength: number, order: number) {
    const bevel = Math.min(.00055, height * .23);
    const shape = roundedPath(outer - 2 * bevel, outer - 2 * bevel, radius - bevel);
    shape.holes.push(roundedPath(inner + 2 * bevel, inner + 2 * bevel, innerRadius + bevel));
    const mesh = new THREE.Mesh(beveledSlab(shape, height, bevel, 14), acrylicMaterial(opacity, strength));
    mesh.position.y = y;
    mesh.renderOrder = order;
    scene.add(mesh);
    return mesh;
  }

  // Thick hollow acrylic layers expose the depth of the rim instead of a
  // painted opaque slab. No transmission pass, bloom, or shadow-map render.
  const base = box(.109, .006, .109, .0135, 0xb9c9d8, 0, -.0066, 0);
  base.material.dispose();
  base.material = acrylicMaterial(.52, .85);
  base.renderOrder = 1;
  acrylicRing(.110, .094, .008, .014, .008, .0005, .70, 1.25, 2);
  const rim = box(.0955, .0018, .0955, .009, 0x9ca7b5, 0, .006, 0);
  rim.material.metalness = .28;
  rim.material.roughness = .38;
  box(.094, .0009, .094, .0085, 0xe3e9ef, 0, .007, 0);
  const plate = box(PLATE_SIZE, .0012, PLATE_SIZE, .008, 0xc5cdd6, 0, .0072, 0);
  plate.material.metalness = .12;
  plate.material.roughness = .65;
  const reflectedLight = new THREE.PointLight(lightColor, .006, .105, 2);
  reflectedLight.position.set(sweep.value, .026, .012);
  scene.add(reflectedLight);

  // The hex socket is cut through the beveled head. Its wall and dark floor
  // sit below the rim, so the recess remains real from the tilted camera.
  const screwMat = material(0x303234, .4, .62), floorMat = material(0x090b0e, .85, .08);
  const screwOutline = new THREE.Shape();
  screwOutline.absarc(0, 0, .0018, 0, Math.PI * 2, false);
  const hexHole = new THREE.Path();
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3, x = Math.cos(angle) * .00105, y = Math.sin(angle) * .00105;
    if (i) hexHole.lineTo(x, y);
    else hexHole.moveTo(x, y);
  }
  hexHole.closePath();
  screwOutline.holes.push(hexHole);
  const screwGeometry = new THREE.ExtrudeGeometry(screwOutline, { depth: .00062, bevelEnabled: true, bevelSize: .00011, bevelThickness: .00010, bevelSegments: 3, curveSegments: 24, steps: 1 });
  screwGeometry.rotateX(-Math.PI / 2);
  const floorGeometry = new THREE.CylinderGeometry(.00108, .00108, .00008, 6);
  floorGeometry.rotateY(Math.PI / 6);
  const screwShadowCanvas = squareCanvas(64);
  const screwContext = context2d(screwShadowCanvas), screwGradient = screwContext.createRadialGradient(32, 32, 13, 32, 32, 31);
  screwGradient.addColorStop(0, 'rgba(16,22,31,.50)');
  screwGradient.addColorStop(1, 'rgba(16,22,31,0)');
  screwContext.fillStyle = screwGradient;
  screwContext.fillRect(0, 0, 64, 64);
  const screwShadowGeometry = new THREE.PlaneGeometry(.0052, .0052), screwShadowMaterial = flatMaterial({ map: new THREE.CanvasTexture(screwShadowCanvas) });
  for (const x of [-.041, .041]) for (const z of [-.041, .041]) {
    const screw = new THREE.Mesh(screwGeometry, screwMat);
    screw.position.set(x, .00808, z);
    scene.add(screw);
    const floor = new THREE.Mesh(floorGeometry, floorMat);
    floor.position.set(x, .00811, z);
    scene.add(floor);
    const shadow = new THREE.Mesh(screwShadowGeometry, screwShadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(x + .0001, PLATE_TOP + .000025, z + .00015);
    scene.add(shadow);
  }

  // One reusable neutral contact-shadow texture, always inside the opaque plate.
  const shadowCanvas = squareCanvas(128);
  const sc = context2d(shadowCanvas);
  sc.shadowColor = 'rgba(20,28,40,.85)';
  sc.shadowBlur = 20;
  sc.shadowOffsetY = 7;
  sc.fillStyle = 'rgba(20,28,40,.76)';
  sc.beginPath();
  sc.roundRect(30, 24, 68, 68, 14);
  sc.fill();
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const shadowGeometry = new THREE.PlaneGeometry(.022, .022);
  const caps = getKeycapGeometry(), decal = getCapDecalGeometry(), keys: Key[] = [];
  // Match visible silhouette gaps, not just world-space grid distances: the
  // near-overhead tilt projects the thick cap skirt into the vertical gap.
  const cameraInverse = camera.quaternion.clone().invert();
  const capBounds = new THREE.Box3();
  const positions = caps.getAttribute('position');
  for (let i = 0; i < positions.count; i++) capBounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(positions, i).applyQuaternion(cameraInverse));
  const projectedCapHeight = capBounds.max.y - capBounds.min.y;
  const zProjection = Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(cameraInverse).y);
  const pitchZ = (projectedCapHeight + PITCH - CAP_WIDTH) / zProjection;
  // Center the visible silhouette on the plate, compensating floating height.
  const upProjection = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraInverse).y;
  const gridZOffset = ((REST_Y - PLATE_TOP) * upProjection + (capBounds.min.y + capBounds.max.y) / 2) / zProjection;
  const keyX = (i: number) => (i % 4 - 1.5) * PITCH;
  const keyZ = (i: number) => (Math.floor(i / 4) - 1.5) * pitchZ + gridZOffset;

  // Bake a broad diffuse shadow wash once. It spans the whole rounded plate,
  // while the small per-key contacts below still contract during a press.
  const diffuseCanvas = squareCanvas(512);
  const dc = context2d(diffuseCanvas), pixelsPerMetre = 512 / PLATE_SIZE;
  dc.shadowColor = 'rgba(20,28,40,.80)';
  dc.shadowBlur = 40;
  dc.shadowOffsetX = 3;
  dc.shadowOffsetY = 9;
  dc.fillStyle = 'rgba(20,28,40,.75)';
  const shadowCore = CAP_WIDTH * .86 * pixelsPerMetre;
  for (let i = 0; i < 16; i++) {
    const x = 256 + keyX(i) * pixelsPerMetre;
    const y = 256 + keyZ(i) * pixelsPerMetre;
    dc.beginPath();
    dc.roundRect(x - shadowCore / 2, y - shadowCore / 2, shadowCore, shadowCore, .003 * pixelsPerMetre);
    dc.fill();
  }
  // Feather the actual rounded plate edge, so no rectangular shadow can spill.
  const pixels = dc.getImageData(0, 0, 512, 512), radius = .008 * pixelsPerMetre;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const qx = Math.abs(x + .5 - 256) - (256 - radius), qy = Math.abs(y + .5 - 256) - (256 - radius);
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    const fade = Math.max(0, Math.min(1, -distance / 5));
    pixels.data[(y * 512 + x) * 4 + 3] *= fade * fade * (3 - 2 * fade);
  }
  dc.putImageData(pixels, 0, 0);
  const diffuseShadow = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_SIZE, PLATE_SIZE), flatMaterial({ map: new THREE.CanvasTexture(diffuseCanvas) }));
  diffuseShadow.rotation.x = -Math.PI / 2;
  diffuseShadow.position.y = PLATE_TOP + .00005;
  scene.add(diffuseShadow);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  for (let i = 0; i < 16; i++) {
    const x = keyX(i), z = keyZ(i);
    const group = new THREE.Group();
    group.position.set(x, REST_Y, z);
    scene.add(group);
    const cap = new THREE.Mesh(caps, material(0xffffff, .47));
    group.add(cap);
    const shadow = new THREE.Mesh(shadowGeometry, flatMaterial({ map: shadowTexture, opacity: .82 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(x + .0005, PLATE_TOP + .0001, z + .0006);
    scene.add(shadow);
    const canvas = squareCanvas(512);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const label = new THREE.Mesh(decal, flatMaterial({ map: texture, polygonOffset: true, polygonOffsetFactor: -1 }));
    group.add(label);
    keys.push({ group, cap, shadow, canvas, texture, down: false, playing: false, depth: 0, velocity: 0, iconKey: null });
  }

  let width = 1, height = 1, raf = 0, last = 0, nextFrameAt = 0, rendered = 0;
  const durations: number[] = [], renderCpuTimes: number[] = [];
  const sweepRunning = () => appearance.fill > 0 && appearance.motion && !reduced.matches;
  const pushSample = (samples: number[], value: number) => {
    samples.push(value);
    if (samples.length > 600) samples.shift();
  };
  function project(x: number, y: number, z: number): Point {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return { x: (p.x + 1) * width / 2, y: (1 - p.y) * height / 2 };
  }
  function layout() {
    const scale = height / (VIEW_HALF_HEIGHT * 2);
    const padRects = keys.map(k => {
      const p = project(k.group.position.x, REST_Y, k.group.position.z);
      return {
        x: p.x + capBounds.min.x * scale,
        y: p.y - capBounds.max.y * scale,
        w: (capBounds.max.x - capBounds.min.x) * scale,
        h: projectedCapHeight * scale,
        cx: p.x,
        cy: p.y - (capBounds.max.y + capBounds.min.y) * scale / 2
      };
    });
    onLayout({ pads: padRects, header: project(-.033, .009, -.0435), tools: project(.022, .009, -.0435) });
  }
  function frame(time: number) {
    raf = 0;
    if (document.hidden) {
      last = 0;
      nextFrameAt = 0;
      return;
    }
    const running = sweepRunning();
    // A 60 Hz render cap avoids spending 120/144 Hz GPU time on a slow light.
    if (running && nextFrameAt && time + 2 < nextFrameAt) {
      raf = requestAnimationFrame(frame);
      return;
    }
    if (running) nextFrameAt = !nextFrameAt || time - nextFrameAt > 100 ? time + 1000 / 60 : nextFrameAt + 1000 / 60;
    else nextFrameAt = 0;
    const dt = last ? Math.min((time - last) / 1000, .05) : 1 / 60;
    if (running) {
      sweepPhase = (sweepPhase + dt / 8) % 1;
      sweep.value = .055 - sweepPhase * .11;
    }
    reflectedLight.position.x = sweep.value;
    // Let the reflected highlight fade naturally before the right-to-left wrap.
    reflectedLight.intensity = .006 * Math.min(1, appearance.fill / 50) * (1 - THREE.MathUtils.smoothstep(Math.abs(sweep.value), .044, .055));
    if (last) pushSample(durations, time - last);
    last = time;
    let moving = false;
    for (const k of keys) {
      const target = k.down ? TRAVEL : 0;
      if (reduced.matches) {
        k.depth = target;
        k.velocity = 0;
      } else {
        const error = k.depth - target, omega = 45, decay = Math.exp(-omega * dt), momentum = k.velocity + omega * error;
        k.depth = target + (error + momentum * dt) * decay;
        k.velocity = (k.velocity - omega * momentum * dt) * decay;
        if (Math.abs(k.depth - target) < .000002 && Math.abs(k.velocity) < .00008) {
          k.depth = target;
          k.velocity = 0;
        } else moving = true;
      }
      k.group.position.y = REST_Y - k.depth;
      const pressed = k.depth / TRAVEL;
      k.shadow.scale.setScalar(1 - pressed * .10);
      k.shadow.material.opacity = .82 + pressed * .13;
      k.shadow.position.z = k.group.position.z + .0006 - pressed * .0002;
      // Sound playback alone does not hold a key down or animate its material.
      k.cap.material.color.set(k.playing ? 0xf5f8fc : 0xffffff);
    }
    const renderStart = performance.now();
    renderer.render(scene, camera);
    rendered++;
    pushSample(renderCpuTimes, performance.now() - renderStart);
    if (moving || running) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  function invalidate() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function resize() {
    width = host.clientWidth;
    height = host.clientHeight;
    renderer.setSize(width, height);
    const aspect = width / height;
    camera.left = -VIEW_HALF_HEIGHT * aspect;
    camera.right = VIEW_HALF_HEIGHT * aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    layout();
    invalidate();
  }
  new ResizeObserver(resize).observe(host);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      nextFrameAt = 0;
    } else invalidate();
  });
  reduced.addEventListener('change', () => {
    last = 0;
    nextFrameAt = 0;
    invalidate();
  });
  return {
    setAppearance(value: Partial<Appearance>) {
      if (typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color)) {
        appearance.color = value.color.toLowerCase();
        lightColor.set(appearance.color);
        reflectedLight.color.copy(lightColor);
      }
      if (typeof value.motion === 'boolean') appearance.motion = value.motion;
      if (typeof value.fill === 'number' && Number.isFinite(value.fill)) appearance.fill = Math.max(0, Math.min(100, value.fill));
      fillCoverage.value = appearance.fill / 100;
      last = 0;
      nextFrameAt = 0;
      invalidate();
    },
    setPads(pads: Pad[]) {
      pads.forEach((p, i) => {
        const k = keys[i], iconKey = `${p.icon}:${p.binding}`;
        if (k && k.iconKey !== iconKey) {
          const ctx = context2d(k.canvas);
          drawPadIcon(ctx, p.icon, p.binding, 512, 512);
          shadeBowl(ctx);
          k.texture.needsUpdate = true;
          k.iconKey = iconKey;
        }
      });
      invalidate();
    },
    press(i: number, down: boolean) {
      const k = keys[i];
      if (k) {
        k.down = down;
        invalidate();
      }
    },
    playing(i: number, playing: boolean) {
      const k = keys[i];
      if (k) {
        k.playing = playing;
        invalidate();
      }
    },
    release() {
      for (const k of keys) k.down = false;
      invalidate();
    },
    diagnostics() {
      return {
        frames: rendered, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        frameTimes: [...durations], renderCpuTimes: [...renderCpuTimes], pixelRatio: renderer.getPixelRatio(), animating: !!raf,
        appearance: { ...appearance }, sweepPhase, sweepX: sweep.value, sweepRunning: sweepRunning() && !document.hidden,
        reducedMotion: reduced.matches, hidden: document.hidden,
        reflectionIntensity: reflectedLight.intensity, reflectionX: reflectedLight.position.x, acrylicLayers: 2,
        fillBandWidth: .1012 * appearance.fill / 100, fillPeriod: .11,
        screwSocketDepth: .00065, screwHeadTop: .0088, screwSocketFloor: .00815,
        keyPitch: PITCH, pitchX: PITCH, pitchZ, projectedGapX: PITCH - CAP_WIDTH, projectedGapY: pitchZ * zProjection - projectedCapHeight,
        capWidth: CAP_WIDTH, capDepth: CAP_WIDTH, capBottomRest: REST_Y, capBottomPressed: REST_Y - TRAVEL,
        plateTop: PLATE_TOP, faceplateTop: PLATE_TOP, capColor: 0xffffff, gridColumns: 4, gridRows: 4,
        shellWidth: SHELL_SIZE, shellDepth: SHELL_SIZE, plateWidth: PLATE_SIZE, plateDepth: PLATE_SIZE,
        gridWidth: 3 * PITCH + CAP_WIDTH, gridZOffset, shadowSize: PLATE_SIZE, diffuseShadow: true,
        diffuseBlurMetres: 40 / pixelsPerMetre, shadowBlurPixels: 40, contactShadowSize: .022, shadowOpacity: .82,
        minimumClearance: REST_Y - TRAVEL - PLATE_TOP,
        keys: keys.map(k => ({ pressed: k.down, depth: k.depth, playing: k.playing, clearance: k.group.position.y - PLATE_TOP }))
      };
    }
  };
}

export type Scene = ReturnType<typeof createScene>;
