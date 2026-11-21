import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';

const id = name => document.getElementById(name);
const UP = new THREE.Vector3(0, 1, 0);
const ISO_DIRECTION = new THREE.Vector3(1.04, .84, 1.48).normalize();
const OPEN_TRAY_DIRECTION = new THREE.Vector3(1.04, 1.23, 1.48).normalize();
const TOP_DIRECTION = new THREE.Vector3(0, 1, .0001).normalize();
const MODEL_SPAN = 3.6;
const SAMPLE_FINISHES = new Map([
  ['reinforced_bracket', 0x487f89],
  ['electronics_tray', 0xc68b60],
  ['washer', 0xaab1c7],
]);

function releaseMaterials(materials) {
  const textures = new Set();
  for (const material of materials) {
    for (const property of Object.values(material)) {
      if (property?.isTexture) textures.add(property);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

function disposeModel(model) {
  const geometries = new Set();
  const materials = new Set();
  model.traverse(node => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    for (const material of [].concat(node.material)) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  releaseMaterials(materials);
}

function frameDistance(size, target, direction, aspect, fov) {
  const right = new THREE.Vector3().crossVectors(UP, direction).normalize();
  const screenUp = new THREE.Vector3().crossVectors(direction, right);
  const vertical = Math.tan(THREE.MathUtils.degToRad(fov) / 2) * .74;
  const horizontal = vertical * aspect;
  let distance = 5.7;
  for (const x of [-size.x / 2, size.x / 2]) {
    for (const z of [-size.z / 2, size.z / 2]) {
      for (const y of [0, size.y]) {
        const corner = new THREE.Vector3(x, y, z).sub(target);
        const depth = direction.dot(corner);
        distance = Math.max(distance, depth + Math.max(
          Math.abs(right.dot(corner)) / horizontal,
          Math.abs(screenUp.dot(corner)) / vertical,
        ));
      }
    }
  }
  return distance;
}

function addStudioSky(scene) {
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    uniforms: {
      ink: { value: new THREE.Color(0x0b1017) },
      wash: { value: new THREE.Color(0x243b47) },
      rim: { value: new THREE.Color(0x363345) },
    },
    vertexShader: `
      varying vec2 windowPoint;
      void main() {
        windowPoint = uv;
        gl_Position = vec4(position.xy, 0.999, 1.0);
      }
    `,
    fragmentShader: `
      #include <common>
      #include <dithering_pars_fragment>
      uniform vec3 ink;
      uniform vec3 wash;
      uniform vec3 rim;
      varying vec2 windowPoint;
      void main() {
        vec2 glowOffset = (windowPoint - vec2(0.28, 0.55)) * vec2(1.66, 2.1);
        float glow = exp(-2.8 * dot(glowOffset, glowOffset));
        float horizon = exp(-pow((windowPoint.y - 0.46) * 6.3, 2.0));
        float falloff = exp(-pow((windowPoint.x - 0.77) * 2.6, 2.0));
        vec3 color = mix(ink, wash, glow * 0.80);
        color = mix(color, rim, horizon * falloff * 0.52);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
        #include <dithering_fragment>
      }
    `,
    dithering: true,
  }));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
}

function addStage(scene) {
  addStudioSky(scene);
  const geometry = new THREE.PlaneGeometry(72, 72);
  const contactExtent = { value: new THREE.Vector2(0, 0) };
  const floor = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      baseColor: { value: new THREE.Color(0x141922) },
      poolColor: { value: new THREE.Color(0x465058) },
      edgeColor: { value: new THREE.Color(0x3d3745) },
      contactExtent,
    },
    vertexShader: `
      varying vec2 floorPoint;
      varying float eyeDepth;
      void main() {
        floorPoint = position.xy;
        vec4 viewPoint = modelViewMatrix * vec4(position, 1.0);
        eyeDepth = -viewPoint.z;
        gl_Position = projectionMatrix * viewPoint;
      }
    `,
    fragmentShader: `
      #include <common>
      #include <dithering_pars_fragment>
      uniform vec3 baseColor;
      uniform vec3 poolColor;
      uniform vec3 edgeColor;
      uniform vec2 contactExtent;
      varying vec2 floorPoint;
      varying float eyeDepth;

      float floorGrain(vec2 point) {
        vec2 cells = point * 115.0;
        float resolved = 1.0 - smoothstep(0.38, 1.2, length(fwidth(cells)));
        vec2 grain = floor(cells);
        float pattern = fract(52.9829189 * fract(dot(grain, vec2(0.06711056, 0.00583715))));
        return (pattern - 0.5) * resolved;
      }

      void main() {
        vec2 poolOffset = (floorPoint - vec2(-1.75, 0.8)) * vec2(0.22, 0.27);
        vec2 edgeOffset = (floorPoint - vec2(4.45, 3.75)) * vec2(0.20, 0.17);
        float pool = exp(-dot(poolOffset, poolOffset));
        float edge = exp(-dot(edgeOffset, edgeOffset));
        float distanceFade = 1.0 - smoothstep(8.0, 23.0, eyeDepth);
        float radialFade = 1.0 - smoothstep(4.0, 18.0, length(floorPoint));
        float footprint = length(floorPoint / max(contactExtent, vec2(0.001)));
        float contact = exp(-2.8 * pow(footprint, 4.0)) * step(0.02, contactExtent.x);
        vec3 color = mix(baseColor, poolColor, pool * 0.66);
        color = mix(color, edgeColor, edge * 0.47);
        color *= 1.0 + floorGrain(floorPoint) * 0.15 - contact * 0.36;
        gl_FragColor = vec4(color, radialFade * distanceFade * (0.63 + 0.32 * pool));
        #include <colorspace_fragment>
        #include <dithering_fragment>
      }
    `,
    dithering: true,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -.012;
  floor.renderOrder = 1;

  const shadow = new THREE.Mesh(geometry, new THREE.ShadowMaterial({
    color: 0x090a10, opacity: .59, depthWrite: false,
  }));
  shadow.rotation.x = floor.rotation.x;
  shadow.position.y = -.007;
  shadow.receiveShadow = true;
  shadow.renderOrder = 2;
  shadow.visible = false;
  scene.add(floor, shadow);
  return { shadow, contactExtent };
}

function studioEnvironment(renderer) {
  const room = new THREE.Scene();
  room.background = new THREE.Color(0x273039);
  const sources = [
    { position: [-3.4, 4.4, 2.4], size: [3.9, 3.5], light: [4.8, 4.35, 3.95] },
    { position: [4.4, 2.4, -1.8], size: [2.2, 4.1], light: [1.85, 2.55, 3.5] },
    { position: [1.2, 5.1, -2.6], size: [4.6, 1.3], light: [3.3, 3.5, 4.1] },
  ];
  for (const { position, size, light } of sources) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(...size), new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(...light), toneMapped: false,
    }));
    panel.position.set(...position);
    panel.lookAt(0, 0, 0);
    room.add(panel);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, .055, .1, 20).texture;
  pmrem.dispose();
  disposeModel(room);
  return environment;
}

function finishMaterial(kind, unitsPerMillimeter, layerHeight, sectionHeight) {
  const material = new THREE.MeshPhysicalMaterial({
    color: SAMPLE_FINISHES.get(kind) ?? 0xc9bdab,
    roughness: .54,
    metalness: 0,
    ior: 1.46,
    clearcoat: .08,
    clearcoatRoughness: .54,
    envMapIntensity: .87,
    clipShadows: true,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.millimetersPerUnit = { value: 1 / unitsPerMillimeter };
    shader.uniforms.printLayerHeight = { value: Number.isFinite(layerHeight) && layerHeight > 0 ? layerHeight : .20 };
    shader.uniforms.sectionHeight = sectionHeight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 stagePosition;')
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        stagePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 stagePosition;
        uniform float millimetersPerUnit;
        uniform float printLayerHeight;
        uniform float sectionHeight;
        float filamentRidge(float position) {
          float resolved = 1.0 - smoothstep(0.25, 0.60, fwidth(position));
          float seam = 0.5 + 0.5 * cos(position * 6.2831853);
          return smoothstep(0.39, 0.98, seam) * resolved;
        }
      `)
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        vec3 viewUp = normalize(mat3(viewMatrix) * vec3(0.0, 1.0, 0.0));
        float topFace = smoothstep(0.31, 0.91, abs(dot(normal, viewUp)));
        vec3 pointMm = stagePosition * millimetersPerUnit;
        float seam = filamentRidge(pointMm.y / printLayerHeight);
        float topTracks = filamentRidge(dot(pointMm.xz, vec2(0.7071, 0.7071)) / 0.46);
        float surfacePattern = mix(seam * 0.19, topTracks * 0.071, topFace);
        float foot = 1.0 - smoothstep(0.0, 1.4, pointMm.y);
        diffuseColor.rgb *= (1.0 - surfacePattern - (1.0 - topFace) * foot * 0.10);
        roughnessFactor = min(0.88, roughnessFactor + surfacePattern * 0.28);
        if (!gl_FrontFacing) diffuseColor.rgb *= 0.80;
        if (sectionHeight >= 0.0) {
          float sectionDistance = abs(stagePosition.y - sectionHeight);
          float lineWidth = clamp(fwidth(stagePosition.y) * 1.6, 0.004, 0.032);
          float trace = 1.0 - smoothstep(0.0, lineWidth, sectionDistance);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.41, 0.77, 0.73), trace * 0.86);
        }
      `);
  };
  return material;
}

function parameterOutline(kind, params) {
  const keys = {
    rectangle: ['length', 'width', 'thickness'],
    four_hole_plate: ['length', 'width', 'thickness', 'hole_diameter', 'x_spacing', 'y_spacing'],
    cylinder: ['diameter', 'thickness'],
    washer: ['diameter', 'inner_diameter', 'thickness'],
  }[kind];
  if (!keys || !params) return undefined;
  const values = Object.fromEntries(keys.map(key => [key, params[key]?.value ?? params[key]]));
  if (!Object.values(values).every(value => Number.isFinite(value) && value > 0)) return undefined;
  const { length, width, thickness, hole_diameter, x_spacing, y_spacing, diameter, inner_diameter } = values;
  if (kind === 'washer' && inner_diameter >= diameter) return undefined;
  if (kind === 'four_hole_plate' && (
    hole_diameter >= Math.min(x_spacing, y_spacing) ||
    x_spacing + hole_diameter >= length ||
    y_spacing + hole_diameter >= width
  )) return undefined;
  const round = kind === 'washer' || kind === 'cylinder';
  const shape = new THREE.Shape();
  if (round) {
    shape.absarc(0, 0, diameter / 2, 0, Math.PI * 2, false);
  } else {
    shape.moveTo(-length / 2, -width / 2);
    shape.lineTo(length / 2, -width / 2);
    shape.lineTo(length / 2, width / 2);
    shape.lineTo(-length / 2, width / 2);
    shape.closePath();
  }
  if (kind === 'washer') {
    shape.holes.push(new THREE.Path().absarc(0, 0, inner_diameter / 2, 0, Math.PI * 2, true));
  }
  if (kind === 'four_hole_plate') {
    for (const x of [-x_spacing / 2, x_spacing / 2]) {
      for (const y of [-y_spacing / 2, y_spacing / 2]) {
        shape.holes.push(new THREE.Path().absarc(x, y, hole_diameter / 2, 0, Math.PI * 2, true));
      }
    }
  }
  return {
    shape, thickness, width: round ? diameter : width, length: round ? diameter : length,
    signature: JSON.stringify([kind, ...Object.values(values)]),
  };
}

export function modelViewer() {
  const mount = id('model-mount');
  const message = id('model-message');
  const hint = id('model-hint');
  const iso = id('isometric');
  const top = id('top-view');
  const wire = id('wireframe');
  const buttons = [iso, top, wire];
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0));
  const clippingPlanes = [sectionPlane];
  const sectionHeight = { value: -1 };
  let scene, camera, renderer, orbit, model, size, shadow, surface, contactExtent;
  let archived, draft, draftOutline, unitsPerMillimeter;
  let isometricDirection = ISO_DIRECTION;
  let sectionFraction = null;
  let preset = 'isometric';
  let currentUrl;
  let revision = 0;
  let frame = 0;
  let planarScale = 1;
  let thicknessScale = 1;

  function feedback(text) {
    message.textContent = text;
    message.hidden = !text;
    hint.hidden = Boolean(text);
    for (const button of buttons) button.disabled = Boolean(text);
  }

  function draw() {
    if (frame || !renderer) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (mount.clientWidth && mount.clientHeight) renderer.render(scene, camera);
    });
  }

  function modelSize() {
    return draft ? new THREE.Vector3(draftOutline.length, draftOutline.thickness, draftOutline.width)
      .multiplyScalar(unitsPerMillimeter) : size.clone().multiply(model.scale);
  }

  function refreshStage() {
    if (!model || !surface) return;
    const activeSize = modelSize();
    const clipped = sectionFraction !== null && sectionFraction < 1;
    sectionPlane.constant = clipped ? activeSize.y * sectionFraction : activeSize.y;
    sectionHeight.value = clipped ? sectionPlane.constant : -1;
    const activePlanes = clipped ? clippingPlanes : null;
    if (surface.clippingPlanes !== activePlanes) {
      surface.clippingPlanes = activePlanes;
      surface.side = clipped ? THREE.DoubleSide : THREE.FrontSide;
      // Keep the exposed interior clear of self-shadow artifacts on the cutting plane.
      model.traverse(node => {
        if (node.isMesh) node.receiveShadow = !clipped;
      });
      surface.needsUpdate = true;
    }
    if (surface.wireframe || sectionFraction === 0) contactExtent.value.set(0, 0);
    else contactExtent.value.set(activeSize.x * .56, activeSize.z * .56);
    renderer.shadowMap.needsUpdate = true;
    draw();
  }

  function setSection(fraction) {
    if (fraction !== null && !Number.isFinite(fraction)) return;
    const normalized = fraction === null ? null : THREE.MathUtils.clamp(fraction, 0, 1);
    if (normalized === sectionFraction) return;
    sectionFraction = normalized;
    refreshStage();
  }

  function angle(view) {
    if (!model) return;
    preset = view;
    const overhead = view === 'top';
    const direction = overhead ? TOP_DIRECTION : isometricDirection;
    const activeSize = modelSize();
    const target = new THREE.Vector3(0, activeSize.y * .43, 0);
    const distance = frameDistance(activeSize, target, direction, camera.aspect, camera.fov);
    orbit.target.copy(target);
    camera.position.copy(target).addScaledVector(direction, distance);
    orbit.update();
    top.setAttribute('aria-pressed', String(overhead));
    iso.setAttribute('aria-pressed', String(!overhead));
    draw();
  }

  function resize() {
    const { clientWidth: width, clientHeight: height } = mount;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (preset && model) angle(preset);
    draw();
  }

  function initialize() {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.localClippingEnabled = true;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.domElement.setAttribute('aria-label', '生成模型的三维画面');
    mount.append(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x171d25, 18, 46);
    scene.environment = studioEnvironment(renderer);
    camera = new THREE.PerspectiveCamera(36, 1, .02, 68);
    camera.position.copy(ISO_DIRECTION).multiplyScalar(7);
    orbit = new OrbitControls(camera, renderer.domElement);
    orbit.minDistance = 1.5;
    orbit.maxDistance = 42;
    orbit.maxPolarAngle = Math.PI * .93;
    orbit.addEventListener('change', draw);
    orbit.addEventListener('start', () => {
      preset = null;
      iso.setAttribute('aria-pressed', 'false');
      top.setAttribute('aria-pressed', 'false');
    });

    const ambient = new THREE.HemisphereLight(0xe0e9f0, 0x625345, 1.05);
    const key = new THREE.DirectionalLight(0xffead5, 2.25);
    key.position.set(-3.8, 8.1, 4.7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -7;
    key.shadow.camera.right = key.shadow.camera.top = 7;
    key.shadow.camera.near = .2;
    key.shadow.camera.far = 28;
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.radius = 4;
    key.shadow.bias = -.00016;
    key.shadow.normalBias = .012;
    key.shadow.intensity = .82;

    const edge = new THREE.DirectionalLight(0xadcce9, 1.44);
    edge.position.set(4.5, 5.6, -6);
    const fill = new THREE.DirectionalLight(0xf0ebd9, .66);
    fill.position.set(5, 2.8, 5);
    scene.add(ambient, key, edge, fill);
    ({ shadow, contactExtent } = addStage(scene));
    new ResizeObserver(resize).observe(mount);
  }

  function resizeModel(planar, thickness) {
    if (!Number.isFinite(planar) || !Number.isFinite(thickness) || planar <= 0 || thickness <= 0) return;
    planarScale = planar;
    thicknessScale = thickness;
    if (!model || draft) return;
    model.scale.set(planarScale, thicknessScale, planarScale);
    refreshStage();
  }

  function showParameterPreview(outline) {
    const geometry = new THREE.ExtrudeGeometry(outline.shape, {
      depth: outline.thickness,
      bevelEnabled: false,
      curveSegments: 32,
    });
    geometry.rotateX(-Math.PI / 2);
    geometry.scale(unitsPerMillimeter, unitsPerMillimeter, unitsPerMillimeter);
    if (draft) {
      model.remove(draft);
      draft.geometry.dispose();
    }
    draft = new THREE.Mesh(geometry, surface);
    draft.castShadow = true;
    draft.receiveShadow = sectionFraction === null || sectionFraction >= 1;
    archived.visible = false;
    model.scale.setScalar(1);
    model.add(draft);
    refreshStage();
  }

  function previewParameters(kind, params) {
    const outline = parameterOutline(kind, params);
    if (!outline) return false;
    if (outline.signature === draftOutline?.signature) return true;
    draftOutline = outline;
    if (model) showParameterPreview(outline);
    return true;
  }

  function clearParameterPreview() {
    draftOutline = undefined;
    if (!draft) return;
    model.remove(draft);
    draft.geometry.dispose();
    draft = undefined;
    archived.visible = true;
    resizeModel(planarScale, thicknessScale);
  }

  iso.addEventListener('click', () => angle('isometric'));
  top.addEventListener('click', () => angle('top'));
  wire.addEventListener('click', () => {
    if (!surface) return;
    surface.wireframe = !surface.wireframe;
    shadow.visible = !surface.wireframe;
    wire.setAttribute('aria-pressed', String(surface.wireframe));
    refreshStage();
  });

  function clear() {
    if (!model) return;
    scene.remove(model);
    disposeModel(model);
    archived = draft = model = surface = undefined;
    shadow.visible = false;
    contactExtent.value.set(0, 0);
    renderer.shadowMap.needsUpdate = true;
    draw();
  }

  async function display(url, emptyText, dimensionsMm, appearance = {}) {
    if (!url) feedback(emptyText || '生成模型后显示三维预览。');
    if (url === currentUrl) return Boolean(model);
    currentUrl = url;
    const request = ++revision;
    planarScale = thicknessScale = 1;
    draftOutline = undefined;
    clear();
    if (!url) return false;
    feedback('正在加载三维文件…');
    try {
      if (!renderer) initialize();
    } catch {
      currentUrl = undefined;
      feedback('当前浏览器无法运行 WebGL 2。模型可从归档文件下载。');
      return false;
    }

    try {
      const { scene: root } = await new GLTFLoader().loadAsync(url);
      if (request !== revision) {
        disposeModel(root);
        return false;
      }
      const bounds = new THREE.Box3().setFromObject(root);
      size = bounds.getSize(new THREE.Vector3());
      const extent = Math.max(size.x, size.y, size.z);
      if (bounds.isEmpty() || !Number.isFinite(extent) || extent <= 0) {
        disposeModel(root);
        throw new Error('empty geometry');
      }

      const normalize = MODEL_SPAN / extent;
      const extentMm = Array.isArray(dimensionsMm) && dimensionsMm.length === 3 &&
        dimensionsMm.every(value => Number.isFinite(value) && value > 0) ? Math.max(...dimensionsMm) : extent * 1000;
      unitsPerMillimeter = MODEL_SPAN / extentMm;
      const center = bounds.getCenter(new THREE.Vector3());
      const anchored = new THREE.Group();
      anchored.scale.setScalar(normalize);
      anchored.position.set(-center.x, -bounds.min.y, -center.z).multiplyScalar(normalize);
      anchored.add(root);
      size.multiplyScalar(normalize);

      isometricDirection = appearance.kind === 'electronics_tray' ? OPEN_TRAY_DIRECTION : ISO_DIRECTION;
      surface = finishMaterial(appearance.kind, unitsPerMillimeter, appearance.layerHeight, sectionHeight);
      const replacedMaterials = new Set();
      root.traverse(node => {
        if (!node.isMesh) return;
        for (const material of [].concat(node.material)) if (material) replacedMaterials.add(material);
        node.material = surface;
        node.castShadow = true;
        node.receiveShadow = true;
      });
      releaseMaterials(replacedMaterials);
      model = new THREE.Group();
      model.add(anchored);
      archived = anchored;
      scene.add(model);
      shadow.visible = true;
      wire.setAttribute('aria-pressed', 'false');
      resizeModel(planarScale, thicknessScale);
      if (draftOutline) showParameterPreview(draftOutline);
      preset = 'isometric';
      resize();
      feedback('');
      return true;
    } catch {
      if (request === revision) {
        clear();
        feedback('无法加载预览文件。重新打开这条历史记录可重试。');
        currentUrl = undefined;
      }
      return false;
    }
  }

  return { display, resizeModel, previewParameters, clearParameterPreview, setSection };
}
