import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { setupToolpath } from '/toolpath.js';

const byId = id => document.getElementById(id);
const viewport = byId('viewport');
const mount = byId('mount');
const message = byId('view-message');
const isometric = byId('isometric');
const top = byId('top');
const wireframe = byId('wireframe');
const tools = [isometric, top, wireframe];
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let showModel = true;

for (const link of document.querySelectorAll('a[download]')) {
  link.addEventListener('click', event => {
    if (link.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
}

function value(id, reading, suffix = '') {
  byId(id).textContent = Number.isFinite(reading) ? format.format(reading) + suffix : '—';
}

async function report() {
  const response = await fetch('/cad/verification.json');
  if (!response.ok) throw new Error('sample_report_missing');
  const data = await response.json();
  const step = data.assets?.step?.checks;
  const dimensions = step?.dimensions_mm_xyz;
  if (!Array.isArray(dimensions) || dimensions.length !== 3) throw new Error('sample_report_invalid');
  ['width', 'length', 'height'].forEach((id, index) => value(id, dimensions[index]));
  value('volume', step.volume_mm3, ' mm³');
  value('solids', step.solid_count, ' 个');
  const holes = step.through_holes_xy_diameter_depth_mm;
  if (Array.isArray(holes)) {
    const diameters = holes.map(hole => Array.isArray(hole) ? hole[2] : hole.diameter_mm);
    const diameter = diameters[0];
    const sameDiameter = Number.isFinite(diameter) && diameters.every(other => Math.abs(other - diameter) < 1e-5);
    byId('holes').textContent = holes.length + ' 个' + (sameDiameter ? ` · Ø${format.format(diameter)} mm` : '');
  }
  await Promise.allSettled(['step', 'stl', 'glb'].map(async type => {
    const bytes = data.assets[type]?.bytes;
    if (!Number.isInteger(bytes) || bytes <= 0) return;
    const asset = await fetch(`/cad/model.${type}`, { method: 'HEAD' });
    if (!asset.ok || Number(asset.headers.get('content-length')) !== bytes) return;
    const label = byId(`${type}-size`);
    label.textContent = `${format.format(bytes / 1024)} KB`;
    label.closest('a').removeAttribute('aria-disabled');
  }));
  byId('verification-link').removeAttribute('aria-disabled');
}

function setViewport(state, text = '') {
  viewport.dataset.viewState = state;
  message.textContent = text;
  message.hidden = !showModel || !text;
  for (const button of tools) button.disabled = state !== 'ready';
}

setupToolpath(isModel => {
  showModel = isModel;
  mount.hidden = !isModel;
  byId('model-tools').hidden = !isModel;
  byId('model-footer').hidden = !isModel;
  message.hidden = !isModel || !message.textContent;
});

async function loadPreview() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    setViewport('unavailable', '当前浏览器无法运行 WebGL 2。可查看验证结果或下载模型文件。');
    return;
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(37, 1, .01, 60);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.setAttribute('aria-label', '安装板三维模型');
  mount.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = true;
  controls.minDistance = 2;
  controls.maxDistance = 26;
  controls.maxPolarAngle = Math.PI * .93;
  controls.target.set(0, 0, 0);

  const ambient = new THREE.HemisphereLight(0xcbeedf, 0x49655b, 2.1);
  const light = new THREE.DirectionalLight(0xffffff, 2.75);
  light.position.set(2.2, 7, 4.6);
  const edgeLight = new THREE.DirectionalLight(0x8cddcd, 1.15);
  edgeLight.position.set(-6, 2, -2);
  scene.add(ambient, light, edgeLight);

  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);
  controls.addEventListener('start', () => {
    isometric.setAttribute('aria-pressed', 'false');
    top.setAttribute('aria-pressed', 'false');
  });
  const fit = () => {
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  };
  const resize = new ResizeObserver(fit);
  resize.observe(mount);

  try {
    const { scene: model } = await new GLTFLoader().loadAsync('/cad/model.glb');
    const boundary = new THREE.Box3().setFromObject(model);
    const size = boundary.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (boundary.isEmpty() || !Number.isFinite(extent) || extent <= 0) throw new Error('empty_geometry');
    const scale = 3.45 / extent;
    const center = boundary.getCenter(new THREE.Vector3());
    const group = new THREE.Group();
    group.scale.setScalar(scale);
    group.position.copy(center).multiplyScalar(-scale);
    group.add(model);
    const surface = new THREE.MeshStandardMaterial({ color: 0x71cba8, roughness: .58, metalness: .12 });
    model.traverse(node => {
      if (node.isMesh) node.material = surface;
    });
    const grid = new THREE.GridHelper(13, 28, 0x47796c, 0x31554c);
    grid.position.y = -.5 * size.y * scale - .012;
    grid.material.transparent = true;
    grid.material.opacity = .68;
    scene.add(group, grid);

    const setAngle = overhead => {
      const aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
      const distance = Math.max(1, .88 / aspect);
      camera.position.set(...(overhead ? [.0001, 7.55, .0001] : [4.1, 3.85, 5.35])).multiplyScalar(distance);
      controls.target.set(0, 0, 0);
      controls.update();
      isometric.setAttribute('aria-pressed', String(!overhead));
      top.setAttribute('aria-pressed', String(overhead));
      render();
    };
    isometric.addEventListener('click', () => setAngle(false));
    top.addEventListener('click', () => setAngle(true));
    wireframe.addEventListener('click', () => {
      surface.wireframe = !surface.wireframe;
      wireframe.setAttribute('aria-pressed', String(surface.wireframe));
      render();
    });
    setAngle(false);
    fit();
    setViewport('ready');
  } catch {
    controls.dispose();
    resize.disconnect();
    renderer.dispose();
    mount.replaceChildren();
    setViewport('unavailable', '未能加载 GLB 样件。确认生成完成后刷新页面。');
  }
}

try {
  await report();
  await loadPreview();
} catch {
  setViewport('unavailable', '找不到可用的样件验证报告。生成 CAD 样件后刷新页面。');
}
