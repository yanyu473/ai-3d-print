import { modelViewer } from '/viewer.js';
import { layerViewer } from '/layers.js';

const id = name => document.getElementById(name);
const sourceNames = { text: '文字', photo: '拍照', image: '图片' };
const statusNames = { queued: '等待中', running: '处理中', completed: '已归档', blocked: '已阻断', failed: '失败' };
const stageNames = { model: '建模', dfm: '可打印性检查', slice: '切片', complete: '归档' };
const stages = Object.keys(stageNames);
const formats = {
  step: ['STEP 工程实体', '.step'], stl: ['STL 打印网格', '.stl'], glb: ['GLB 预览模型', '.glb'],
  gcode: ['离线 G-code', '.gcode'], dfm: ['可打印性报告', '.json'], model: ['模型验证报告', '.json'],
  slice: ['切片验证报告', '.json'], toolpath: ['分层刀路数据', '.json'], spec: ['建模参数', '.json'],
  profile: ['切片配置', '.json'], input: ['原始图片', ''],
};
const imageTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const acceptedImageTypes = new Set(Object.values(imageTypes));
const imageLimit = 10 * 1024 * 1024;
const decimals = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const localDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const tabs = Array.from(document.querySelectorAll('[data-source]'));
const description = id('description');
const camera = id('camera-file');
const gallery = id('gallery-file');
const cameraPanel = id('camera-panel');
const cameraPreview = id('camera-preview');
const capturePhoto = id('capture-photo');
const widthField = id('input-width');
const thicknessField = id('input-thickness');
const generate = id('generate');
const historyList = id('history-list');
const historyMessage = id('history-message');
const { display: displayModel, resizeModel, previewParameters, clearParameterPreview, setSection } = modelViewer();
const displayLayers = layerViewer();
const sizeEditor = id('size-editor');
const planarControl = id('edit-scale');
const thicknessControl = id('edit-thickness');
const resetSize = id('edit-reset');
const applySize = id('edit-apply');
const structureControls = id('structure-controls');
const structuralFields = id('structural-fields');
const previewStructure = id('preview-structure');
const previewSummary = id('preview-summary');
const backVersion = id('back-version');
const specimenList = id('specimen-list');
const specimenStatus = id('specimen-status');
const sectionToggle = id('section-toggle');
const sectionControls = id('section-controls');
const sectionPosition = id('section-position');
const sectionValue = id('section-value');
const studioSpecimens = [
  { kind: 'reinforced_bracket', key: 'bracket', name: '加强角码',
    prompt: '加强角码，长 48 mm，宽 38 mm，高 36 mm，壁厚 4 mm，孔径 5 mm' },
  { kind: 'electronics_tray', key: 'tray', name: '电子盒底座',
    prompt: '电子盒底座，长 62 mm，宽 44 mm，高 20 mm，壁厚 2.4 mm，螺丝柱直径 7 mm，孔径 2.8 mm' },
  { kind: 'washer', key: 'washer', name: '环形垫圈',
    prompt: '外径 36 mm，内径 16 mm，厚 6 mm 的垫圈' },
];
const parameterFields = id('parameter-fields');
const processFields = {
  layer_height: id('process-layer-height'),
  infill_percent: id('process-infill'),
};
const parameterNames = {
  length: '长度', width: '宽度', thickness: '厚度', diameter: '外径', inner_diameter: '内径',
  hole_diameter: '孔径', x_spacing: '横向孔距', y_spacing: '纵向孔距', height: '高度', post_diameter: '螺丝柱直径',
};
const shapeParameters = {
  four_hole_plate: ['length', 'width', 'thickness', 'hole_diameter', 'x_spacing', 'y_spacing'],
  rectangle: ['length', 'width', 'thickness'],
  cylinder: ['diameter', 'thickness'],
  washer: ['diameter', 'inner_diameter', 'thickness'],
  reinforced_bracket: ['length', 'width', 'height', 'thickness', 'hole_diameter'],
  electronics_tray: ['length', 'width', 'height', 'thickness', 'post_diameter', 'hole_diameter'],
};
const mountHoles = [[0, '无孔'], [2, '两孔'], [4, '四孔']];
const shapeStructures = {
  reinforced_bracket: {
    rib_count: { label: '加强筋', initial: 1, options: [[0, '无加强筋'], [1, '中央单筋'], [2, '双筋']] },
    base_hole_count: { label: '底板安装孔', initial: 2, options: mountHoles },
    upright_hole_count: { label: '立板安装孔', initial: 2, options: mountHoles },
  },
  electronics_tray: {
    compartment_count: { label: '内腔分仓', initial: 1, options: [[1, '单仓'], [2, '双仓'], [3, '三仓']] },
    post_count: { label: '螺丝柱', initial: 4, options: [[0, '无螺丝柱'], [4, '四角带孔柱']] },
    cable_notch: { label: '出线口', initial: 0, options: [[0, '闭合侧壁'], [1, '开槽']] },
  },
};
const editNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
let sizeDraft;
let sizePending = false;
let previewFrame;
let source = 'text';
let imageSelection;
let parentId;
let project;
let selectedId;
let selectionToken = 0;
let imageToken = 0;
let imageReading = false;
let submitting = false;
let cameraStream;
let cameraToken = 0;
let polling;
let projects = [];
let historySignature;
let activeMode = 'model';
let sectionEnabled = false;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function fileUrl(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value, location.origin);
    if (url.origin === location.origin && /^https?:$/.test(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Unrecognized artifact URLs are absent from the UI. */ }
  return undefined;
}

async function api(path, payload) {
  const options = payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined;
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? data.message ?? data.detail;
    throw new Error(typeof error === 'string' ? error : `请求失败（${response.status}）`);
  }
  return data;
}

function setFormMessage(text) {
  const message = id('form-message');
  message.textContent = text;
  message.hidden = !text;
}

function formState() {
  const textOnly = source === 'text';
  for (const tab of tabs) {
    const active = tab.dataset.source === source;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  id('input-text').hidden = !textOnly;
  description.disabled = !textOnly;
  id('input-visual').hidden = textOnly;
  id('input-visual').setAttribute('aria-labelledby', `tab-${source}`);
  id('take-photo').hidden = source !== 'photo';
  id('native-photo').hidden = source !== 'photo';
  id('pick-file').textContent = source === 'photo' ? '从相册选择' : '选择图片';
  widthField.disabled = textOnly;
  thicknessField.disabled = textOnly;
  widthField.required = !textOnly;
  thicknessField.required = !textOnly;
  generate.disabled = submitting || (!textOnly && imageReading);
  generate.textContent = submitting ? '正在提交…' : imageReading && !textOnly ? '正在读取图片…' : '生成模型';
}

function setSource(value) {
  if (value !== source) closeCamera();
  source = value;
  formState();
  setFormMessage('');
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => setSource(tab.dataset.source));
  tab.addEventListener('keydown', event => {
    const menu = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    if (!(event.key in menu)) return;
    event.preventDefault();
    const target = tabs[menu[event.key]];
    setSource(target.dataset.source);
    target.focus();
  });
}

for (const example of document.querySelectorAll('[data-example]')) {
  example.addEventListener('click', () => {
    description.value = example.dataset.example;
    description.focus();
    setFormMessage('');
  });
}

function setImage(selection) {
  imageSelection = selection;
  id('selection').hidden = !selection;
  id('source-filename').textContent = selection?.name ?? '';
  if (selection) id('source-thumbnail').src = selection.data;
  else id('source-thumbnail').removeAttribute('src');
}

function readImage(blob, name) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const mime = acceptedImageTypes.has(blob.type) ? blob.type : imageTypes[extension];
  if (!mime) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (blob.size > imageLimit) throw new Error('图片应小于或等于 10 MB，请裁剪后重新选择。');
  if (!blob.size) throw new Error('这个图片文件为空。');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve({ name, data: reader.result }));
    reader.addEventListener('error', () => reject(new Error('读取图片失败，请重新选择。')));
    reader.readAsDataURL(blob.type === mime ? blob : new Blob([blob], { type: mime }));
  });
}

async function chooseImage(read) {
  const token = ++imageToken;
  imageReading = true;
  setImage(undefined);
  setFormMessage('');
  formState();
  try {
    const selection = await read();
    if (token === imageToken) setImage(selection);
  } catch (error) {
    if (token === imageToken && source !== 'text') setFormMessage(error.message);
  } finally {
    if (token === imageToken) {
      imageReading = false;
      formState();
    }
  }
}

function closeCamera() {
  cameraToken++;
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = undefined;
  cameraPreview.srcObject = null;
  cameraPanel.hidden = true;
  capturePhoto.disabled = true;
}

id('take-photo').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setFormMessage('当前页面无法调用相机。请选择系统拍照或从相册选择。');
    return;
  }
  closeCamera();
  setFormMessage('');
  cameraPanel.hidden = false;
  const attempt = cameraToken;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (attempt !== cameraToken) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    cameraStream = stream;
    cameraPreview.srcObject = stream;
    await cameraPreview.play();
    if (attempt === cameraToken) capturePhoto.disabled = false;
  } catch (error) {
    if (attempt !== cameraToken) return;
    closeCamera();
    setFormMessage(error.name === 'NotAllowedError' ? '相机权限不可用。可使用系统拍照或相册。' : '未能打开相机。可使用系统拍照或相册。');
  }
});

capturePhoto.addEventListener('click', () => {
  const { videoWidth, videoHeight } = cameraPreview;
  if (!cameraStream || !videoWidth || !videoHeight) return;
  const scale = Math.min(1, 1600 / Math.max(videoWidth, videoHeight));
  const snapshot = document.createElement('canvas');
  snapshot.width = Math.max(1, Math.round(videoWidth * scale));
  snapshot.height = Math.max(1, Math.round(videoHeight * scale));
  const paint = snapshot.getContext('2d');
  if (!paint) {
    closeCamera();
    setFormMessage('当前浏览器无法保存相机画面。可使用系统拍照。');
    return;
  }
  paint.drawImage(cameraPreview, 0, 0, snapshot.width, snapshot.height);
  closeCamera();
  void chooseImage(async () => {
    const file = await new Promise(resolve => snapshot.toBlob(resolve, 'image/jpeg', .9));
    if (!file) throw new Error('保存相机画面失败，请重新拍摄。');
    return readImage(file, `相机照片-${Date.now()}.jpg`);
  });
});

id('stop-camera').addEventListener('click', closeCamera);
window.addEventListener('pagehide', closeCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); });
id('native-photo').addEventListener('click', () => { closeCamera(); camera.click(); });
id('pick-file').addEventListener('click', () => { closeCamera(); gallery.click(); });
for (const input of [camera, gallery]) {
  input.addEventListener('change', () => {
    const [file] = input.files;
    if (file) void chooseImage(() => readImage(file, file.name));
    input.value = '';
  });
}
id('clear-image').addEventListener('click', () => {
  imageToken++;
  imageReading = false;
  setImage(undefined);
  setFormMessage('');
  formState();
});

function setParent(item) {
  parentId = item?.id;
  id('parent-note').hidden = !item;
  id('parent-label').textContent = item ? `从 ${item.title || '历史模型'} 修改` : '';
}
id('unlink-parent').addEventListener('click', () => setParent(undefined));

id('revise').addEventListener('click', () => {
  if (!project || !(project.source in sourceNames)) return;
  const prior = project;
  setParent(prior);
  setSource(prior.source);
  if (prior.source === 'text') description.value = prior.input?.text ?? '';
  else {
    widthField.value = prior.input?.width ?? '';
    thicknessField.value = prior.input?.thickness ?? '';
    const imageUrl = fileUrl(prior.files?.input);
    if (imageUrl) {
      void chooseImage(async () => {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error('归档图片无法读取，请重新选择。');
        const lastName = new URL(imageUrl).pathname.split('/').at(-1);
        return readImage(await response.blob(), prior.input?.image_name || lastName || '图片.png');
      });
    } else {
      setImage(undefined);
      setFormMessage('请选择用于这次重建的原图。');
    }
  }
  id('compose').scrollIntoView({ block: 'start' });
  if (prior.source === 'text') description.focus({ preventScroll: true });
  else widthField.focus({ preventScroll: true });
});

function showMode(mode) {
  const modelMode = mode === 'model';
  activeMode = mode;
  id('model-pane').hidden = !modelMode;
  id('layers-pane').hidden = modelMode;
  id('model-controls').hidden = !modelMode;
  id('view-model').setAttribute('aria-pressed', String(modelMode));
  id('view-layers').setAttribute('aria-pressed', String(!modelMode));
  refreshSection();
}

function labelStructurePreview(visible) {
  id('model-hint').textContent = visible ? '未归档预览 · 拖动旋转' : '拖动旋转 · 滚轮或双指缩放';
  id('view-layers').textContent = visible ? '已归档刀路' : '分层刀路';
  drawPipeline(project, visible);
}
id('view-model').addEventListener('click', () => showMode('model'));
id('view-layers').addEventListener('click', () => showMode('layers'));

function refreshSection() {
  const available = Boolean(project?.files?.glb);
  const cutting = available && sectionEnabled;
  const fraction = Number(sectionPosition.value) / 100;
  sectionToggle.disabled = !available;
  sectionToggle.setAttribute('aria-pressed', String(cutting));
  sectionControls.hidden = !cutting || activeMode !== 'model';
  const z = sizeDraft?.preview?.dimensions_mm_xyz?.[2] ?? (
    sizeDraft && !sizeDraft.structural ? sizeDraft.parameters.thickness :
      project?.model?.assets?.stl?.checks?.dimensions_mm_xyz?.[2]
  );
  sectionValue.textContent = Number.isFinite(z)
    ? `Z ${editNumber.format(z * fraction)} mm` : `${sectionPosition.value}%`;
  setSection(cutting ? fraction : null);
}
sectionToggle.addEventListener('click', () => {
  sectionEnabled = !sectionEnabled;
  refreshSection();
});
sectionPosition.addEventListener('input', refreshSection);

function tag(text, status) {
  const label = node('span', text, 'status-tag');
  label.dataset.kind = status;
  return label;
}

function structuralSummary(features) {
  if (features?.base_holes && features?.upright_holes && features?.gussets) {
    return `底板 ${features.base_holes.count} 孔 · 立板 ${features.upright_holes.count} 孔 · 加强筋 ${features.gussets.count} 条`;
  }
  if (features?.cavity?.dimensions_mm_xyz && features?.screw_posts) {
    const cavity = features.cavity.dimensions_mm_xyz.map(value => editNumber.format(value)).join(' × ');
    const posts = features.screw_posts.count;
    const details = [`内腔 ${cavity} mm`, posts ? `${posts} 个盲孔柱` : '无螺丝柱'];
    if (Number.isInteger(features.dividers?.count)) details.splice(1, 0, `${features.dividers.count + 1} 仓`);
    if (features.cable_notch?.enabled) details.push('带出线口');
    return details.join(' · ');
  }
  return '';
}

function showGeometry(item) {
  const detail = id('geometry-detail');
  const model = item.model;
  const fallbackChecks = model?.assets?.step?.checks ?? model?.assets?.stl?.checks;
  const dimensions = model?.geometry?.dimensions_mm_xyz ?? fallbackChecks?.dimensions_mm_xyz;
  detail.hidden = !Array.isArray(dimensions) || dimensions.length !== 3 || !dimensions.every(Number.isFinite);
  if (detail.hidden) return;
  const imageModel = item.source !== 'text';
  id('geometry-type').textContent = structuralSummary(model?.features) || (imageModel ? '轮廓拉伸网格' : '参数化 CAD');
  id('model-dimensions').replaceChildren(...dimensions.map((measure, index) => {
    const reading = node('div');
    const axisLabels = imageModel ? ['宽 / mm', '高 / mm', '厚 / mm'] : ['X / mm', 'Y / mm', 'Z / mm'];
    reading.append(node('dt', axisLabels[index]), node('dd', decimals.format(measure)));
    return reading;
  }));
}

function resizeFeedback(message = '') {
  const output = id('edit-message');
  output.textContent = message;
  output.hidden = !message;
}

function showPreviewSummary(message = '', state = '') {
  previewSummary.hidden = !message;
  previewSummary.textContent = message;
  previewSummary.dataset.state = state;
}

const roundedEdit = value => Math.round(value * 1000) / 1000;
const differs = (draft, base) => Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== base[key]));
const geometryChanges = draft => ({
  ...differs(draft.parameters, draft.baseParameters),
  ...differs(draft.structure, draft.baseStructure),
});
const draftSignature = draft => JSON.stringify(geometryChanges(draft));

function archivedModel(item, message = '等待模型生成…') {
  labelStructurePreview(false);
  const dimensions = (item?.model?.assets?.step ?? item?.model?.assets?.stl)?.checks?.dimensions_mm_xyz;
  return displayModel(fileUrl(item?.files?.glb), message, dimensions, {
    kind: item?.model?.kind, layerHeight: item?.process?.layer_height,
  });
}

function clearDraftPreview(draft) {
  draft.previewToken++;
  if (draft.preview) {
    draft.preview = null;
    void archivedModel(project);
    refreshSection();
  }
  showPreviewSummary(draft.previewBusy ? '参数已改，请在本次计算结束后重新预览。' : '', draft.previewBusy ? 'loading' : '');
}

function editBounds(key, image) {
  return [image && key === 'width' ? 1 : 0.1, image && key === 'thickness' ? 200 : 500];
}

function validateDraft(draft) {
  const { parameters: p, process, kind, image } = draft;
  for (const [key, value] of Object.entries(p)) {
    const [min, max] = editBounds(key, image);
    if (!Number.isFinite(value) || value < min || value > max) {
      return { keys: [key], message: `${parameterNames[key]}应为 ${min}–${max} mm。` };
    }
  }
  if (kind === 'washer' && p.inner_diameter >= p.diameter) {
    return { keys: ['inner_diameter'], message: '内径须小于外径。' };
  }
  if (kind === 'four_hole_plate' && (p.hole_diameter >= Math.min(p.x_spacing, p.y_spacing) ||
      p.x_spacing + p.hole_diameter >= p.length || p.y_spacing + p.hole_diameter >= p.width)) {
    return { keys: ['hole_diameter', 'x_spacing', 'y_spacing'], message: '通孔相交或接触板边，请调整孔径、孔距或板尺寸。' };
  }
  if (kind === 'electronics_tray' && draft.structure.post_count > 0 && p.hole_diameter >= p.post_diameter) {
    return { keys: ['hole_diameter', 'post_diameter'], message: '螺丝孔必须小于螺丝柱直径。' };
  }
  for (const [key, field] of Object.entries(processFields)) {
    if (!Number.isFinite(process[key]) || !field.validity.valid) {
      return { keys: [key], message: `请将${key === 'layer_height' ? '层高' : '填充率'}调至输入框允许的范围。` };
    }
  }
  return null;
}

function draftDimensions(draft) {
  const p = draft.parameters;
  if (draft.image) return [p.width, draft.dimensions[1] * p.width / draft.baseParameters.width, p.thickness];
  if (draft.kind === 'washer' || draft.kind === 'cylinder') return [p.diameter, p.diameter, p.thickness];
  return [p.length, p.width, p.height ?? p.thickness];
}

function syncQuickControls(draft) {
  const { parameters, baseParameters } = draft;
  const factors = Object.entries(parameters).filter(([key]) => !['thickness', 'height'].includes(key))
    .map(([key, value]) => value / baseParameters[key]);
  const scale = factors[0];
  const uniform = factors.every(value => Number.isFinite(value) && Math.abs(value - scale) < 0.001);
  planarControl.value = String(uniform ? scale * 100 : 100);
  id('edit-scale-value').textContent = uniform ? `${editNumber.format(scale * 100)}%` : '独立尺寸';
  const thickness = parameters.thickness;
  if (Number.isFinite(thickness) && thickness >= 0.1 && thickness <= editBounds('thickness', draft.image)[1]) {
    thicknessControl.min = String(Math.min(Number(thicknessControl.min), thickness));
    thicknessControl.max = String(Math.max(Number(thicknessControl.max), thickness));
    thicknessControl.value = String(thickness);
  }
  id('edit-thickness-value').textContent = Number.isFinite(thickness) ? `${editNumber.format(thickness)} mm` : '—';
}

function drawSizeDraft() {
  if (!sizeDraft) return;
  const draft = sizeDraft;
  const validation = validateDraft(draft);
  const changedGeometry = Object.keys(geometryChanges(draft)).length > 0;
  const changedProcess = Object.keys(differs(draft.process, draft.baseProcess)).length > 0;
  const changed = changedGeometry || changedProcess;
  sizeEditor.dataset.dirty = String(changed);
  for (const field of [...Object.values(draft.fields), ...Object.values(draft.structureFields), ...Object.values(processFields)]) {
    field.disabled = sizePending;
    if (validation?.keys.includes(field.name)) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  }
  planarControl.disabled = thicknessControl.disabled = sizePending;
  resetSize.disabled = !changed || sizePending;
  applySize.disabled = !changed || Boolean(validation) || sizePending || draft.previewBusy;
  previewStructure.disabled = !changedGeometry || Boolean(validation) || sizePending ||
    draft.previewBusy || draft.preview?.signature === draftSignature(draft);
  syncQuickControls(draft);
  id('edit-dimensions').textContent = validation
    ? '请先校正参数'
    : `${draftDimensions(draft).map(value => editNumber.format(value)).join(' × ')} mm`;
  if (previewFrame) cancelAnimationFrame(previewFrame);
  if (validation) {
    resizeFeedback(validation.message);
    return;
  }
  previewFrame = requestAnimationFrame(() => {
    if (sizeDraft !== draft) return;
    if (draft.image) resizeModel(draft.parameters.width / draft.baseParameters.width, draft.parameters.thickness / draft.baseParameters.thickness);
    else if (changedGeometry && !draft.structural) previewParameters(draft.kind, draft.parameters);
    else clearParameterPreview();
  });
}

function dimensionField(draft, key) {
  const fieldId = `parameter-${key}`;
  const label = node('label', undefined, 'parameter-label');
  const field = node('input');
  const [min, max] = editBounds(key, draft.image);
  label.htmlFor = fieldId;
  label.append(node('span', key === 'thickness' && draft.structural ? '壁厚' : parameterNames[key]), field, node('small', 'mm'));
  field.id = fieldId;
  field.name = key;
  field.type = 'number';
  field.min = min;
  field.max = max;
  field.step = 'any';
  field.inputMode = 'decimal';
  field.value = draft.parameters[key];
  field.addEventListener('input', () => {
    draft.parameters[key] = roundedEdit(field.valueAsNumber);
    if (draft.structural) clearDraftPreview(draft);
    resizeFeedback();
    showMode('model');
    drawSizeDraft();
  });
  draft.fields[key] = field;
  return label;
}

function structureField(draft, key, settings) {
  const label = node('label', undefined, 'structure-field');
  const field = node('select');
  field.id = `structure-${key}`;
  field.name = key;
  label.htmlFor = field.id;
  label.append(node('span', settings.label), field);
  for (const [value, title] of settings.options) {
    const option = node('option', title);
    option.value = value;
    field.append(option);
  }
  field.value = String(draft.structure[key]);
  field.addEventListener('change', () => {
    draft.structure[key] = Number(field.value);
    clearDraftPreview(draft);
    resizeFeedback();
    drawSizeDraft();
  });
  draft.structureFields[key] = field;
  return label;
}

function showSizeEditor(item) {
  const measurements = (item?.model?.assets?.step ?? item?.model?.assets?.stl)?.checks?.dimensions_mm_xyz;
  const image = item?.source !== 'text';
  const kind = item?.model?.kind;
  const keys = image ? ['width', 'thickness'] : shapeParameters[kind] ?? [];
  const source = image ? item?.input : item?.model?.parameters;
  const baseParameters = Object.fromEntries(keys.map(key => [key, roundedEdit(image ? source?.[key] : source?.[key]?.value)]));
  const adjustable = ['completed', 'blocked', 'failed'].includes(item?.status) &&
    item.files?.glb && measurements?.length === 3 && measurements.every(Number.isFinite) &&
    keys.length > 0 && Object.values(baseParameters).every(value => Number.isFinite(value) && value > 0);
  sizeEditor.hidden = !adjustable;
  if (!adjustable) {
    sizeDraft = undefined;
    structureControls.hidden = true;
    return;
  }
  if (sizeDraft?.id === item.id) return;

  const thickness = baseParameters.thickness;
  const maxThickness = editBounds('thickness', image)[1];
  const baseProcess = {
    layer_height: item.process?.layer_height ?? 0.2,
    infill_percent: item.process?.infill_percent ?? 15,
  };
  const structures = shapeStructures[kind] ?? {};
  const baseStructure = Object.fromEntries(Object.entries(structures).map(([key, settings]) => [
    key, item.model.parameters?.[key]?.value ?? settings.initial,
  ]));
  sizeDraft = {
    id: item.id, dimensions: measurements, kind, image, structural: Number.isFinite(baseParameters.height), baseParameters, baseProcess,
    parameters: { ...baseParameters }, process: { ...baseProcess }, fields: {},
    baseStructure, structure: { ...baseStructure }, structureFields: {}, previewToken: 0, previewBusy: false,
  };
  parameterFields.replaceChildren(...keys.map(key => dimensionField(sizeDraft, key)));
  parameterFields.hidden = false;
  structureControls.hidden = Object.keys(structures).length === 0;
  structuralFields.replaceChildren(...Object.entries(structures).map(([key, settings]) => structureField(sizeDraft, key, settings)));
  resetSize.textContent = sizeDraft.structural ? '恢复参数' : '恢复尺寸';
  previewStructure.removeAttribute('aria-busy');
  showPreviewSummary();
  id('edit-help').textContent = sizeDraft.structural
    ? '预览结构先生成三维模型。应用并重建会检查、切片和归档。'
    : '调整可即时预览。应用后生成新版本，并重新检查和切片。';
  id('size-editor').dataset.structural = String(sizeDraft.structural);
  for (const [key, field] of Object.entries(processFields)) {
    field.name = key;
    field.value = baseProcess[key];
  }
  thicknessControl.min = String(Math.max(0.1, Math.floor(thickness * 250) / 1000));
  thicknessControl.max = String(Math.min(maxThickness, Math.max(thickness + 0.1, thickness * 3)));
  thicknessControl.step = '0.001';
  resizeFeedback();
  drawSizeDraft();
}

planarControl.addEventListener('input', () => {
  if (!sizeDraft) return;
  const scale = Number(planarControl.value) / 100;
  for (const [key, original] of Object.entries(sizeDraft.baseParameters)) {
    if (key === 'thickness' || key === 'height') continue;
    const value = roundedEdit(original * scale);
    sizeDraft.parameters[key] = value;
    sizeDraft.fields[key].value = value;
  }
  resizeFeedback();
  showMode('model');
  drawSizeDraft();
});
thicknessControl.addEventListener('input', () => {
  if (!sizeDraft) return;
  sizeDraft.parameters.thickness = thicknessControl.valueAsNumber;
  sizeDraft.fields.thickness.value = thicknessControl.value;
  resizeFeedback();
  showMode('model');
  drawSizeDraft();
});
for (const [key, field] of Object.entries(processFields)) {
  field.addEventListener('input', () => {
    if (!sizeDraft) return;
    sizeDraft.process[key] = roundedEdit(field.valueAsNumber);
    resizeFeedback();
    drawSizeDraft();
  });
}
resetSize.addEventListener('click', () => {
  if (!sizeDraft) return;
  sizeDraft.parameters = { ...sizeDraft.baseParameters };
  sizeDraft.process = { ...sizeDraft.baseProcess };
  sizeDraft.structure = { ...sizeDraft.baseStructure };
  if (sizeDraft.structural) clearDraftPreview(sizeDraft);
  for (const [key, field] of Object.entries(sizeDraft.fields)) field.value = sizeDraft.parameters[key];
  for (const [key, field] of Object.entries(sizeDraft.structureFields)) field.value = sizeDraft.structure[key];
  for (const [key, field] of Object.entries(processFields)) field.value = sizeDraft.process[key];
  resizeFeedback();
  drawSizeDraft();
});
previewStructure.addEventListener('click', async () => {
  if (!sizeDraft?.structural || previewStructure.disabled) return;
  const draft = sizeDraft;
  const token = ++draft.previewToken;
  const signature = draftSignature(draft);
  draft.previewBusy = true;
  previewStructure.setAttribute('aria-busy', 'true');
  drawSizeDraft();
  showPreviewSummary('正在计算三维结构…', 'loading');
  try {
    const { preview } = await api(`/api/projects/${draft.id}/preview`, { parameters: geometryChanges(draft) });
    if (sizeDraft !== draft || token !== draft.previewToken) return;
    const url = fileUrl(preview?.glb);
    if (!url || !Array.isArray(preview.dimensions_mm_xyz) || preview.dimensions_mm_xyz.length !== 3 ||
        !preview.dimensions_mm_xyz.every(Number.isFinite)) throw new Error('预览文件不完整。');
    draft.preview = { ...preview, signature };
    showMode('model');
    const displayed = await displayModel(url, '加载结构预览…', preview.dimensions_mm_xyz, {
      kind: preview.kind, layerHeight: draft.process.layer_height,
    });
    if (sizeDraft === draft && token === draft.previewToken) {
      if (!displayed) throw new Error('结构预览加载失败，可以重新预览。');
      labelStructurePreview(true);
      const details = structuralSummary(preview.features);
      showPreviewSummary(details ? `未归档预览 · ${details}` : '结构预览已生成。应用后重新检查并切片。', 'ready');
    }
  } catch (error) {
    if (sizeDraft === draft && token === draft.previewToken) {
      draft.preview = null;
      void archivedModel(project);
      showPreviewSummary(error.message, 'error');
    }
  } finally {
    draft.previewBusy = false;
    if (sizeDraft === draft) {
      previewStructure.removeAttribute('aria-busy');
      if (token !== draft.previewToken) showPreviewSummary('');
      drawSizeDraft();
    }
  }
});
applySize.addEventListener('click', async () => {
  if (!sizeDraft || sizePending || applySize.disabled) return;
  const previous = sizeDraft.id;
  const payload = { parameters: geometryChanges(sizeDraft), process: differs(sizeDraft.process, sizeDraft.baseProcess) };
  sizePending = true;
  drawSizeDraft();
  resizeFeedback('正在创建新版本…');
  try {
    const { project: item } = await api(`/api/projects/${previous}/rebuild`, payload);
    if (selectedId === previous) acceptNewProject(item, false);
    else mergeSnapshot(item);
  } catch (error) {
    if (sizeDraft?.id === previous) resizeFeedback(error.message);
  } finally {
    sizePending = false;
    drawSizeDraft();
  }
});

const checkLabels = {
  pass: ['通过', 'pass'], passed: ['通过', 'pass'], ok: ['通过', 'pass'],
  warning: ['注意', 'warn'], warn: ['注意', 'warn'], blocked: ['阻断', 'block'],
  blocker: ['阻断', 'block'], fail: ['阻断', 'block'], failed: ['阻断', 'block'],
  unverified: ['待核验', 'unverified'], skipped: ['未执行', 'unverified'], not_checked: ['未检查', 'unverified'],
};

function showDfm(report) {
  const section = id('dfm-detail');
  section.hidden = !report;
  if (!report) return;
  const [text, kind] = checkLabels[report.status] ?? ['详情', 'unverified'];
  const status = id('dfm-status');
  const checks = Array.isArray(report.checks) ? report.checks : [];
  status.textContent = kind === 'pass' && checks.some(check => check.status === 'not_checked') ? '已检项通过' : text;
  status.dataset.kind = kind;
  if (kind === 'block') section.open = true;
  id('dfm-checks').replaceChildren(...checks.map(check => {
    const result = node('li');
    const [text, kind] = checkLabels[check.status] ?? ['详情', 'unverified'];
    result.append(tag(text, kind), node('strong', String(check.label ?? check.id ?? '检查项')));
    if (check.detail) result.append(node('p', String(check.detail)));
    return result;
  }));
}

function showArtifacts(item) {
  const output = [];
  for (const [key, [label, ext]] of Object.entries(formats)) {
    const url = fileUrl(item.files?.[key]);
    if (!url) continue;
    const textInput = key === 'input' && item.source === 'text';
    const link = node('a', textInput ? '原始描述' : label);
    link.href = url;
    link.download = '';
    link.append(node('span', textInput ? '.txt' : ext || '下载'));
    const row = node('li');
    row.append(link);
    output.push(row);
  }
  id('artifact-detail').hidden = !output.length;
  id('artifacts').replaceChildren(...output);
  const summary = id('slice-summary');
  const details = [];
  if (Number.isInteger(item.slice?.layer_count)) details.push(`${item.slice.layer_count} 层`);
  if (Number.isFinite(item.process?.layer_height)) details.push(`层高 ${editNumber.format(item.process.layer_height)} mm`);
  if (Number.isFinite(item.process?.infill_percent)) details.push(`填充 ${editNumber.format(item.process.infill_percent)}%`);
  if (Number.isFinite(item.slice?.filament_mass_g_estimate)) details.push(`估算 ${decimals.format(item.slice.filament_mass_g_estimate)} g`);
  if (Number.isFinite(item.slice?.time_s_estimate)) details.push(`约 ${Math.max(1, Math.round(item.slice.time_s_estimate / 60))} 分钟`);
  summary.hidden = !details.length;
  summary.textContent = details.join(' · ');
}

function drawPipeline(item, previewing = false) {
  const pipeline = id('pipeline');
  const status = id('task-status');
  pipeline.hidden = !item || previewing;
  status.hidden = !item;
  if (!item) return;
  if (previewing) {
    status.dataset.status = 'preview';
    status.textContent = '应用并重建后生成这一版的检查报告和刀路。';
    return;
  }
  const active = stages.indexOf(item.stage);
  for (const step of pipeline.children) {
    const index = stages.indexOf(step.dataset.stage);
    const done = item.status === 'completed' || index < active;
    const current = index === active && !done;
    step.dataset.state = done ? 'done' : current ? (['blocked', 'failed'].includes(item.status) ? 'stopped' : 'active') : 'upcoming';
    if (current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  status.dataset.status = item.status;
  const phase = stageNames[item.stage] ?? '任务';
  status.textContent = {
    queued: '等待本机处理。', running: `正在${phase}…`, completed: '模型、检查报告与刀路已归档。',
    blocked: `${phase}未通过。${item.error ? ` ${item.error}` : '请查看检查结果。'}`,
    failed: `${phase}失败。${item.error ? ` ${item.error}` : '可以修改输入后重试。'}`,
  }[item.status] ?? '任务状态暂不可用。';
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? localDate.format(date) : '';
}

function render(item) {
  if (project?.id !== item?.id) {
    id('dfm-detail').open = false;
    id('artifact-detail').open = false;
    sectionEnabled = false;
    sectionPosition.value = '65';
  }
  project = item;
  id('project-title').textContent = item?.model?.name || item?.input?.image_name || item?.title || '模型预览';
  id('project-meta').hidden = !item;
  id('project-meta').textContent = item ? [sourceNames[item.source], item.input?.image_name, dateLabel(item.created_at)].filter(Boolean).join(' · ') : '';
  id('revise').hidden = !item;
  if (backVersion) backVersion.hidden = !item?.parent_id;
  id('project-details').hidden = !item;
  if (item) {
    showGeometry(item);
    showDfm(item.dfm);
    showArtifacts(item);
  }
  const modelMessage = item && ['failed', 'blocked'].includes(item.status) ? '当前任务还没有可预览的模型。' :
    item ? '等待模型生成…' : '提交需求后在这里查看生成的模型。';
  const layerMessage = item && ['failed', 'blocked'].includes(item.status) ? '当前任务没有可用的切片刀路。' : '切片完成后在这里逐层查看刀路。';
  if (sizeDraft?.id !== item?.id || !sizeDraft?.preview) void archivedModel(item, modelMessage);
  void displayLayers(fileUrl(item?.files?.toolpath), item?.slice, layerMessage);
  showSizeEditor(item);
  refreshSection();
  for (const button of specimenList.querySelectorAll('[data-specimen]')) {
    const specimen = studioSpecimens.find(entry => entry.key === button.dataset.specimen);
    button.setAttribute('aria-pressed', String(item?.input?.text === specimen?.prompt && item?.source === 'text'));
  }
}

function drawHistory() {
  const newSignature = JSON.stringify([selectedId, projects.map(item => [item.id, item.title, item.status, item.updated_at])]);
  if (newSignature === historySignature) return;
  historySignature = newSignature;
  historyMessage.hidden = Boolean(projects.length);
  historyMessage.textContent = '提交后的任务会保存在这里。';
  historyList.hidden = !projects.length;
  historyList.replaceChildren(...projects.map(item => {
    const row = node('li');
    const button = node('button', undefined, 'history-entry');
    button.type = 'button';
    if (item.id === selectedId) button.setAttribute('aria-current', 'true');
    const meta = [sourceNames[item.source], dateLabel(item.created_at)].filter(Boolean).join(' · ');
    button.append(node('span', item.title || '未命名模型', 'entry-title'), tag(statusNames[item.status] ?? '状态未知', item.status));
    if (meta) button.append(node('span', meta, 'entry-meta'));
    button.addEventListener('click', () => void openProject(item.id, true));
    row.append(button);
    return row;
  }));
}

function mergeSnapshot(item) {
  const index = projects.findIndex(prior => prior.id === item.id);
  if (index === -1) projects.unshift(item);
  else projects[index] = item;
  drawHistory();
}

async function refreshHistory() {
  try {
    const data = await api('/api/projects');
    if (!Array.isArray(data.projects)) throw new Error('历史格式无效');
    projects = data.projects;
    historySignature = undefined;
    drawHistory();
    return true;
  } catch (error) {
    historyMessage.hidden = false;
    historyMessage.textContent = `暂时无法读取历史。${error.message}`;
    return false;
  }
}

id('refresh-history').addEventListener('click', () => void refreshHistory());

function saveHash(itemId) {
  const url = new URL(location.href);
  url.searchParams.set('project', itemId);
  url.hash = '';
  history.replaceState(null, '', url);
}

function schedulePoll(itemId, token, timeout = 1100) {
  clearTimeout(polling);
  polling = setTimeout(async () => {
    try {
      const { project: item } = await api(`/api/projects/${encodeURIComponent(itemId)}`);
      if (token !== selectionToken) return;
      applySnapshot(item, token);
    } catch {
      if (token !== selectionToken) return;
      const status = id('task-status');
      status.hidden = false;
      status.textContent = '暂时无法刷新任务，正在重新连接。';
      schedulePoll(itemId, token, 2600);
    }
  }, timeout);
}

function applySnapshot(item, token) {
  render(item);
  mergeSnapshot(item);
  if (['queued', 'running'].includes(item.status)) schedulePoll(item.id, token);
}

function acceptNewProject(item, jump) {
  clearTimeout(polling);
  const token = ++selectionToken;
  selectedId = item.id;
  saveHash(item.id);
  showMode('model');
  setParent(undefined);
  applySnapshot(item, token);
  if (jump) id('results').scrollIntoView({ block: 'start' });
}

function indicateLoadError(error) {
  const status = id('task-status');
  status.hidden = false;
  status.dataset.status = 'failed';
  status.textContent = `未能打开任务。${error.message}`;
}

async function openProject(projectId, jump = false) {
  clearTimeout(polling);
  const token = ++selectionToken;
  try {
    const { project: item } = await api(`/api/projects/${encodeURIComponent(projectId)}`);
    if (token !== selectionToken) return;
    selectedId = item.id;
    saveHash(item.id);
    showMode('model');
    applySnapshot(item, token);
    if (jump) id('results').scrollIntoView({ block: 'start' });
  } catch (error) {
    if (token === selectionToken) indicateLoadError(error);
  }
}

backVersion?.addEventListener('click', () => {
  if (project?.parent_id) void openProject(project.parent_id);
});

specimenList.addEventListener('click', async event => {
  const button = event.target.closest('[data-specimen]');
  const specimen = studioSpecimens.find(entry => entry.key === button?.dataset.specimen);
  if (!specimen || button.disabled) return;
  const available = projects.find(item => item.input?.text === specimen.prompt &&
    !['failed', 'blocked'].includes(item.status) && (!item.model || item.model.kind === specimen.kind));
  specimenStatus.textContent = '';
  if (available) {
    await openProject(available.id, true);
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  specimenStatus.textContent = `正在生成${specimen.name}…`;
  try {
    const { project: item } = await api('/api/projects', { source: 'text', text: specimen.prompt });
    acceptNewProject(item, true);
    specimenStatus.textContent = '';
  } catch (error) {
    specimenStatus.textContent = error.message;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

id('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (submitting) return;
  setFormMessage('');
  const payload = { source };
  if (parentId) payload.parent_id = parentId;
  if (source === 'text') {
    payload.text = description.value.trim();
    if (!payload.text) { setFormMessage('请输入零件描述。'); return; }
  } else {
    if (!imageSelection) { setFormMessage('请先拍照或选择图片。'); return; }
    payload.image_name = imageSelection.name;
    payload.image_data = imageSelection.data;
    payload.width = widthField.valueAsNumber;
    payload.thickness = thicknessField.valueAsNumber;
    if (!Number.isFinite(payload.width) || !Number.isFinite(payload.thickness) || payload.width <= 0 || payload.thickness <= 0) {
      setFormMessage('请输入大于零的轮廓宽度与拉伸厚度。');
      return;
    }
  }

  submitting = true;
  formState();
  try {
    const { project: item } = await api('/api/projects', payload);
    acceptNewProject(item, true);
  } catch (error) {
    setFormMessage(error.message);
  } finally {
    submitting = false;
    formState();
  }
});

formState();
if (await refreshHistory()) {
  const savedId = new URL(location.href).searchParams.get('project');
  const initial = projects.find(item => item.id === savedId) ?? projects[0];
  if (initial) await openProject(initial.id);
}
