import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, '.venv', 'Scripts', 'python.exe');
const workbench = join(root, 'workbench');
const defaultProfile = join(root, 'slicer-wasm', 'profile.json');
export const imageLimit = 10 * 1024 * 1024;
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const imageTypes = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const phaseNames = { model: '建模', dfm: '制造检查', slice: '切片' };
const assetPaths = {
  glb: 'model/model.glb', step: 'model/model.step', stl: 'model/model.stl',
  model: 'model/verification.json', spec: 'model/cad-spec.json',
  dfm: 'dfm.json', gcode: 'slice/toolpath.gcode', toolpath: 'slice/toolpath-preview.json',
  slice: 'slice/verification.json', profile: 'profile.json',
};
const textParameterKeys = {
  reinforced_bracket: ['length', 'width', 'height', 'thickness', 'hole_diameter'],
  electronics_tray: ['length', 'width', 'height', 'thickness', 'post_diameter', 'hole_diameter'],
  four_hole_plate: ['length', 'width', 'thickness', 'hole_diameter', 'x_spacing', 'y_spacing'],
  rectangle: ['length', 'width', 'thickness'],
  washer: ['diameter', 'inner_diameter', 'thickness'],
  cylinder: ['diameter', 'thickness'],
};
const structureDefaults = {
  reinforced_bracket: { rib_count: 1, base_hole_count: 2, upright_hole_count: 2 },
  electronics_tray: { compartment_count: 1, post_count: 4, cable_notch: 0 },
};
const structureChoices = {
  rib_count: [0, 1, 2],
  base_hole_count: [0, 2, 4],
  upright_hole_count: [0, 2, 4],
  compartment_count: [1, 2, 3],
  post_count: [0, 4],
  cable_notch: [0, 1],
};
const parameterLabels = {
  length: '长度', width: '宽度', height: '高度', thickness: '厚度', diameter: '外径', post_diameter: '螺丝柱直径',
  hole_diameter: '孔径', inner_diameter: '内径', x_spacing: '横向孔距', y_spacing: '纵向孔距',
  layer_height: '层高', infill_percent: '填充率',
  rib_count: '加强筋数量', base_hole_count: '底板孔数', upright_hole_count: '立板孔数',
  compartment_count: '仓数', post_count: '螺丝柱数量', cable_notch: '出线口',
};
const previewTTL = 30 * 60_000;
const previewCacheLimit = 6;
const previewSizeLimit = 8 * 1024 * 1024;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const digest = data => createHash('sha256').update(data).digest('hex');

export class ProjectError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function optionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, path);
}

function imagePayload(value) {
  if (typeof value !== 'string') throw new ProjectError('请选择要建模的照片或图片。');
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) throw new ProjectError('请选择有效的 JPEG、PNG 或 WebP 图片。');
  const [, format, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.length > imageLimit) throw new ProjectError('图片大小须在 10 MB 以内。', 413);
  const fileType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg' :
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png' :
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
  if (fileType !== format) throw new ProjectError('图片格式与文件内容不一致。');
  return { bytes, filename: `source.${imageTypes[format]}`, mime: `image/${format}` };
}

function validateInput(body, projects) {
  if (!body || !['text', 'photo', 'image'].includes(body.source)) throw new ProjectError('请选择文字、拍照或图片。');
  let parentId;
  if (body.parent_id !== undefined) {
    if (typeof body.parent_id !== 'string' || !projects.has(body.parent_id)) {
      throw new ProjectError('找不到要继续编辑的历史项目。', 404);
    }
    parentId = body.parent_id;
  }
  if (body.source === 'text') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 1200) throw new ProjectError('请输入 1 至 1200 字的零件描述。');
    const bytes = Buffer.from(text, 'utf8');
    return {
      parentId, title: text.split(/\r?\n/, 1)[0].slice(0, 64),
      input: { text, sha256: digest(bytes), filename: 'source.txt', mime: 'text/plain; charset=utf-8' }, bytes,
    };
  }
  const { width, thickness } = body;
  if (!Number.isFinite(width) || !Number.isFinite(thickness) || width < 1 || width > 500 ||
      thickness < 0.1 || thickness > 200) {
    throw new ProjectError('请填写实测宽度和期望厚度。宽度为 1 至 500 mm，厚度为 0.1 至 200 mm。');
  }
  const { bytes, filename, mime } = imagePayload(body.image_data);
  const imageName = typeof body.image_name === 'string' ?
    body.image_name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) : '';
  return {
    parentId, title: imageName || (body.source === 'photo' ? '照片轮廓' : '图片轮廓'), bytes,
    input: { image_name: imageName || filename, width, thickness, sha256: digest(bytes), filename, mime },
  };
}

function describeText(kind, parameters) {
  const { length, width, height, thickness, diameter, inner_diameter, post_diameter, hole_diameter, x_spacing, y_spacing } = parameters;
  switch (kind) {
    case 'reinforced_bracket':
      return `加强角码，长 ${length} mm，宽 ${width} mm，高 ${height} mm，壁厚 ${thickness} mm，孔径 ${hole_diameter} mm，加强筋 ${parameters.rib_count} 条，底板 ${parameters.base_hole_count} 孔，立板 ${parameters.upright_hole_count} 孔`;
    case 'electronics_tray':
      return `电子盒底座，长 ${length} mm，宽 ${width} mm，高 ${height} mm，壁厚 ${thickness} mm，螺丝柱直径 ${post_diameter} mm，孔径 ${hole_diameter} mm，${parameters.compartment_count} 仓，${parameters.post_count} 个螺丝柱，出线口 ${parameters.cable_notch ? '开启' : '关闭'}`;
    case 'four_hole_plate':
      return `${length}×${width}×${thickness} mm 四孔安装板，孔径 ${hole_diameter} mm，孔距 ${x_spacing}×${y_spacing} mm`;
    case 'rectangle':
      return `${length}×${width}×${thickness} mm 矩形板`;
    case 'washer':
      return `外径 ${diameter} mm，内径 ${inner_diameter} mm，厚 ${thickness} mm 的垫圈`;
    case 'cylinder':
      return `直径 ${diameter} mm，高 ${thickness} mm 的圆柱`;
    default:
      throw new ProjectError('此项目的几何规格暂不支持尺寸调整。');
  }
}

function modelParameters(item) {
  if (item.source !== 'text') return { width: item.input.width, thickness: item.input.thickness };
  const keys = textParameterKeys[item.model?.kind];
  const archived = item.model.parameters;
  if (!keys || keys.some(key => !Number.isFinite(archived?.[key]?.value))) {
    throw new ProjectError('此项目缺少可编辑的尺寸记录。', 409);
  }
  const parameters = Object.fromEntries(keys.map(key => [key, archived[key].value]));
  for (const [key, fallback] of Object.entries(structureDefaults[item.model.kind] ?? {})) {
    const value = archived[key]?.value ?? fallback;
    if (!structureChoices[key].includes(value)) throw new ProjectError('此项目的结构参数记录无效。', 409);
    parameters[key] = value;
  }
  return parameters;
}

function requestObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectError(`${label}无效。`);
  }
  return value;
}

function mergeNumbers(patch, values, bounds, label) {
  const merged = { ...values };
  if (patch === undefined) return merged;
  for (const [key, value] of Object.entries(requestObject(patch, label))) {
    if (!Object.hasOwn(values, key)) throw new ProjectError(`${label}不支持参数 ${key}。`);
    if (value === values[key]) continue;
    const choices = structureChoices[key];
    if (choices) {
      if (!choices.includes(value)) {
        throw new ProjectError(`${parameterLabels[key]}可选 ${choices.join('、')}。`);
      }
      merged[key] = value;
      continue;
    }
    const [minimum, maximum, precision] = bounds(key);
    const factor = 10 ** precision;
    const rounded = Number.isFinite(value) ? Math.round(value * factor) / factor : NaN;
    if (!Number.isFinite(value) || value < minimum || value > maximum || Math.abs(value - rounded) > 1e-8) {
      const unit = key === 'infill_percent' ? '%' : ' mm';
      throw new ProjectError(`${parameterLabels[key]}须在 ${minimum}${unit} 至 ${maximum}${unit} 之间，最多 ${precision} 位小数。`);
    }
    merged[key] = rounded;
  }
  return merged;
}

function geometryBounds(source, key) {
  if (source === 'text') return [0.1, 500, 3];
  return key === 'width' ? [1, 500, 3] : [0.1, 200, 3];
}

function validateBracketHoles(p) {
  // Match the mounting rows and rib centers used by structural_parts.py.
  const baseRows = { 0: [], 2: [-0.25], 4: [-0.30, -0.02] }[p.base_hole_count];
  const uprightRows = { 0: [], 2: [0.65], 4: [0.38, 0.73] }[p.upright_hole_count];
  const xClearance = p.rib_count ? p.length / (p.rib_count === 2 ? 8 : 4) - p.thickness / 2 : p.length / 4;
  const radius = p.hole_diameter / 2;
  for (const [rows, extent, lower, upper] of [
    [baseRows, p.width, -p.width / 2, p.width / 2 - p.thickness],
    [uprightRows, p.height, p.thickness, p.height],
  ]) {
    if (rows.some(fraction => radius >= Math.min(xClearance, fraction * extent - lower, upper - fraction * extent))) {
      throw new ProjectError('安装孔与板边、折角或加强筋相交，请缩小孔径或调整布局。');
    }
    if (rows.length === 2 && p.hole_diameter >= (rows[1] - rows[0]) * extent) {
      throw new ProjectError('同一面的安装孔相交，请缩小孔径或减少孔位。');
    }
  }
}

function validateGeometry(kind, p) {
  if (kind === 'washer' && p.inner_diameter >= p.diameter) {
    throw new ProjectError('垫圈的内径须小于外径。');
  }
  if (kind === 'four_hole_plate' && (
    p.hole_diameter >= Math.min(p.x_spacing, p.y_spacing) ||
    p.x_spacing + p.hole_diameter >= p.length || p.y_spacing + p.hole_diameter >= p.width
  )) {
    throw new ProjectError('孔距和孔径会造成孔相交或超出板边缘。请调整尺寸。');
  }
  if (kind === 'reinforced_bracket') {
    if (Math.min(p.length, p.width, p.height) <= 3 * p.thickness) {
      throw new ProjectError('加强角码的长、宽和高须大于三倍壁厚。');
    }
    if (p.rib_count === 2 && p.length <= 4 * p.thickness) {
      throw new ProjectError('使用两条加强筋时，角码长度须大于四倍壁厚。');
    }
    validateBracketHoles(p);
  }
  if (kind === 'electronics_tray') {
    if (p.height <= 3 * p.thickness) {
      throw new ProjectError('电子盒的高度须大于三倍壁厚，以留出内腔。');
    }
    const pitch = (p.length - 2 * p.thickness) / p.compartment_count;
    if (Math.min(p.length, p.width) <= 2.4 * p.thickness ||
        ((p.compartment_count > 1 || p.cable_notch) && pitch <= p.thickness)) {
      throw new ProjectError('电子盒的内部尺寸不足以容纳所选分仓。');
    }
    if (!p.post_count) return;
    if (Math.min(p.length, p.width) <= 3 * p.thickness + 2 * p.post_diameter) {
      throw new ProjectError('电子盒的内腔不足以容纳四根独立螺丝柱，请调整底面尺寸、壁厚或柱径。');
    }
    if (p.hole_diameter >= p.post_diameter) {
      throw new ProjectError('螺丝孔径须小于螺丝柱外径。');
    }
    // Divider positions are symmetric, so checking the positive screw-post X suffices.
    const postX = p.length / 2 - 1.5 * p.thickness - p.post_diameter / 2;
    for (let index = 1; index < p.compartment_count; index++) {
      const dividerX = p.thickness - p.length / 2 + index * pitch;
      if (Math.abs(postX - dividerX) <= (p.post_diameter + p.thickness) / 2) {
        throw new ProjectError('隔板与螺丝柱相交，请减小柱径、放大盒体或减少仓数。');
      }
    }
  }
}

function editedGeometry(base, patch) {
  const original = modelParameters(base);
  const parameters = mergeNumbers(patch, original, key => geometryBounds(base.source, key), '几何参数');
  validateGeometry(base.model.kind, parameters);
  return { parameters, changed: !sameNumbers(original, parameters) };
}

function processSettings(profile) {
  const params = profile?.params;
  if (!params || !Number.isFinite(params.nozzle_diameter) || params.nozzle_diameter <= 0 ||
      !Number.isFinite(params.layer_height) || params.layer_height <= 0 ||
      !Number.isFinite(params.infill_density) || params.infill_density < 0 || params.infill_density > 1) {
    throw new ProjectError('切片配置无法读取。', 409);
  }
  return {
    layer_height: params.layer_height,
    infill_percent: Number((params.infill_density * 100).toFixed(10)),
  };
}

function sameNumbers(first, second) {
  return Object.keys(first).every(key => Math.abs(first[key] - second[key]) < 1e-8);
}

export class Projects {
  constructor(directory = join(root, 'data', 'workbench')) {
    this.directory = resolve(directory);
    this.items = new Map();
    this.queue = [];
    this.workers = new Set();
    this.previews = new Map();
    this.activePreviews = 0;
    this.processing = false;
    this.stopping = false;
  }

  async load() {
    await mkdir(this.directory, { recursive: true });
    const directory = await realpath(this.directory);
    const scratch = join(directory, '.previews');
    await mkdir(scratch, { recursive: true });
    this.previewDirectory = await realpath(scratch);
    if (this.previewDirectory !== scratch) throw new Error('Preview scratch is outside the project directory');
    const expiredBefore = Date.now() - previewTTL;
    for (const entry of await readdir(scratch, { withFileTypes: true })) {
      if (entry.isDirectory()) await this.removePreviewFiles(entry.name, expiredBefore);
    }
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
      try {
        const item = await readJson(join(this.directory, entry.name, 'project.json'));
        if (item.id !== entry.name) continue;
        try {
          item.process = processSettings(await readJson(this.path(item.id, 'profile.json')));
        } catch (error) {
          console.error(`无法读取项目 ${entry.name} 的切片配置：${error.message}`);
        }
        this.items.set(item.id, item);
      } catch (error) {
        console.error(`无法读取项目 ${entry.name}：${error.message}`);
      }
    }
    this.queue = this.list().filter(item => ['queued', 'running'].includes(item.status)).reverse().map(item => item.id);
    this.drain();
  }

  list() {
    return [...this.items.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id) {
    const item = this.items.get(id);
    if (!item) throw new ProjectError('找不到项目。', 404);
    return item;
  }

  async create(body, profileBytes) {
    if (this.stopping || this.queue.length >= 12) throw new ProjectError('待处理的项目较多，请稍后重试。', 429);
    const { input, title, parentId, bytes } = validateInput(body, this.items);
    const snapshot = profileBytes ?? await readFile(defaultProfile);
    const process = processSettings(JSON.parse(snapshot.toString('utf8')));
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const files = { input: this.link(id, 'input'), profile: this.link(id, 'profile') };
    const item = {
      id, source: body.source, title, input, files, process, parent_id: parentId,
      created_at: createdAt, updated_at: createdAt, status: 'queued', stage: 'model',
    };
    const staging = join(this.directory, `.new-${id}`);
    await mkdir(staging);
    await Promise.all([
      writeFile(join(staging, input.filename), bytes, { flag: 'wx' }),
      writeFile(join(staging, 'profile.json'), snapshot, { flag: 'wx' }),
    ]);
    await writeJson(join(staging, 'project.json'), item);
    await rename(staging, this.path(id));
    this.items.set(id, item);
    this.queue.push(id);
    this.drain();
    return item;
  }

  editable(id) {
    const base = this.get(id);
    const dimensions = base.model?.assets?.stl?.checks?.dimensions_mm_xyz;
    if (!dimensions || ['running', 'queued'].includes(base.status)) {
      throw new ProjectError('请先等待这个模型完成处理。', 409);
    }
    return base;
  }

  async resize(id, values) {
    const base = this.editable(id);
    const { scale, thickness } = values ?? {};
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 2 || !Number.isFinite(thickness) ||
        thickness < 0.1 || thickness > (base.source === 'text' ? 500 : 200)) {
      throw new ProjectError('请填写有效的平面比例和厚度。');
    }
    const parameters = modelParameters(base);
    if (Math.abs(scale - 1) < 1e-6 && Math.abs(thickness - parameters.thickness) < 1e-6) {
      throw new ProjectError('尺寸没有变化。');
    }
    for (const [key, value] of Object.entries(parameters)) {
      if (key === 'height' || structureChoices[key]) continue;
      parameters[key] = Math.round((key === 'thickness' ? thickness : value * scale) * 1000) / 1000;
    }
    return this.rebuild(id, { parameters });
  }

  async rebuild(id, body) {
    const base = this.editable(id);
    const request = requestObject(body, '重建请求');
    if (Object.keys(request).some(key => !['parameters', 'process'].includes(key))) {
      throw new ProjectError('重建请求只接受尺寸与切片设置。');
    }
    const { parameters, changed: geometryChanged } = editedGeometry(base, request.parameters);

    const profileBytes = await readFile(this.path(id, 'profile.json'));
    const profile = JSON.parse(profileBytes.toString('utf8'));
    const settings = processSettings(profile);
    const maxLayer = Math.min(0.3, Math.floor(profile.params.nozzle_diameter * 75) / 100);
    const process = mergeNumbers(request.process, settings, key => (
      key === 'layer_height' ? [0.08, maxLayer, 2] : [0, 100, 1]
    ), '切片设置');
    const processChanged = !sameNumbers(settings, process);
    if (!geometryChanged && !processChanged) throw new ProjectError('几何参数和切片设置均未变化。');

    let snapshot = profileBytes;
    if (processChanged) {
      if (process.layer_height !== settings.layer_height) {
        profile.params.layer_height = process.layer_height;
        profile.params.first_layer_height = process.layer_height;
      }
      if (process.infill_percent !== settings.infill_percent) {
        profile.params.infill_density = process.infill_percent / 100;
      }
      snapshot = Buffer.from(JSON.stringify(profile, null, 2) + '\n', 'utf8');
    }
    const input = { source: base.source, parent_id: id };
    if (base.source === 'text') {
      input.text = geometryChanged ? describeText(base.model.kind, parameters) : base.input.text;
    } else {
      const bytes = await readFile(this.file(id, 'input').path);
      if (digest(bytes) !== base.input.sha256) throw new ProjectError('原图已更改，请重新选择源文件。', 409);
      input.image_data = `data:${base.input.mime};base64,${bytes.toString('base64')}`;
      input.image_name = base.input.image_name;
      Object.assign(input, parameters);
    }
    return this.create(input, snapshot);
  }

  async preview(id, body) {
    const base = this.editable(id);
    const kind = base.model.kind;
    if (base.source !== 'text' || !Object.hasOwn(structureDefaults, kind)) {
      throw new ProjectError('结构预览支持加强角码和电子盒底座。');
    }
    const request = requestObject(body, '结构预览请求');
    if (Object.keys(request).some(key => key !== 'parameters')) {
      throw new ProjectError('结构预览只接受几何参数。');
    }
    const { parameters, changed } = editedGeometry(base, request.parameters);
    if (!changed) {
      if (!base.files.glb) throw new ProjectError('此项目缺少可预览的模型。', 409);
      return {
        glb: this.link(id, 'glb'),
        dimensions_mm_xyz: base.model.assets.stl.checks.dimensions_mm_xyz,
        kind, features: base.model.features ?? {},
      };
    }
    if (this.stopping || this.activePreviews >= 2) {
      throw new ProjectError('正在生成其他结构预览，请稍后重试。', 429);
    }
    this.activePreviews++;
    const previewId = randomUUID();
    const scratch = join(this.previewDirectory, previewId);
    const input = join(scratch, 'source.txt');
    const output = join(scratch, 'model');
    let created = false;
    try {
      await mkdir(scratch);
      created = true;
      await writeFile(input, describeText(kind, parameters), { encoding: 'utf8', flag: 'wx' });
      const result = await this.runWorker(scratch, python, [
        '-I', '-B', '-X', 'utf8', join(workbench, 'text_model.py'), '--input', input, '--out', output,
      ], 45_000);
      if (result.code !== 0) {
        throw this.workerFailure(result, '结构预览', '请检查几何参数。');
      }
      const model = await readJson(join(output, 'verification.json'));
      const glbPath = join(output, 'model.glb');
      const dimensions = model.assets?.stl?.checks?.dimensions_mm_xyz;
      if ((await stat(glbPath)).size > previewSizeLimit) {
        throw new ProjectError('模型超出临时预览大小，请简化结构后重试。', 413);
      }
      const glb = await readFile(glbPath);
      if (model.status !== 'verified' || model.kind !== kind || !Array.isArray(dimensions) ||
          dimensions.length !== 3 || dimensions.some(value => !Number.isFinite(value) || value <= 0) ||
          model.assets?.glb?.sha256 !== digest(glb) || glb.toString('ascii', 0, 4) !== 'glTF') {
        throw new Error('Verified preview does not match the GLB');
      }
      this.removeExpiredPreviews();
      if (this.previews.size >= previewCacheLimit) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(previewId, { glb, expires: Date.now() + previewTTL });
      return {
        glb: `/api/previews/${previewId}/model.glb`,
        dimensions_mm_xyz: dimensions, kind, features: model.features ?? {},
      };
    } finally {
      if (created) await this.removePreviewFiles(previewId);
      this.activePreviews--;
    }
  }

  removeExpiredPreviews() {
    const now = Date.now();
    for (const [id, preview] of this.previews) {
      if (preview.expires <= now) this.previews.delete(id);
    }
  }

  previewGlb(id) {
    this.removeExpiredPreviews();
    const preview = idPattern.test(id) && this.previews.get(id);
    if (!preview) throw new ProjectError('结构预览已失效，请重新生成。', 404);
    return preview.glb;
  }

  async removePreviewFiles(id, olderThan = Infinity) {
    if (!idPattern.test(id)) return;
    const target = join(this.previewDirectory, id);
    try {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs >= olderThan) return;
      const resolved = await realpath(target);
      if (dirname(resolved) === this.previewDirectory && basename(resolved) === id) {
        await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 75 });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`无法清理预览目录 ${id}：${error.message}`);
    }
  }

  path(id, ...segments) {
    return join(this.directory, id, ...segments);
  }

  link(id, key) {
    return `/api/projects/${id}/files/${key}`;
  }

  file(id, key) {
    const item = this.get(id);
    if (!Object.hasOwn(item.files, key)) throw new ProjectError('这个文件尚未生成。', 404);
    const filename = key === 'input' ? item.input.filename : assetPaths[key];
    if (!filename || (key === 'input' && !/^source\.(txt|jpg|png|webp)$/.test(filename))) {
      throw new ProjectError('找不到文件。', 404);
    }
    return { path: this.path(id, filename), mime: key === 'input' ? item.input.mime : undefined };
  }

  async update(id, values, fileKeys = []) {
    const previous = this.get(id);
    const files = { ...previous.files };
    for (const key of fileKeys) files[key] = this.link(id, key);
    const item = { ...previous, ...values, files, updated_at: new Date().toISOString() };
    await writeJson(this.path(id, 'project.json'), item);
    this.items.set(id, item);
    return item;
  }

  async drain() {
    if (this.processing || this.stopping) return;
    this.processing = true;
    try {
      while (!this.stopping && this.queue.length) {
        const id = this.queue.shift();
        try {
          await this.run(id);
        } catch (error) {
          if (this.stopping) break;
          const current = this.get(id);
          console.error(`[${id}] ${error.message}`);
          try {
            await this.update(id, {
              status: 'failed',
              error: error instanceof ProjectError ? error.message :
                `${phaseNames[current.stage] ?? '处理'}失败。可重新输入或查看项目目录中的日志。`,
            });
          } catch (updateError) {
            console.error(`无法保存项目状态：${updateError.message}`);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  stop() {
    this.stopping = true;
    for (const child of this.workers) child.kill();
    this.previews.clear();
  }

  async worker(id, phase, executable, args, acceptedCodes = [0]) {
    const result = await this.runWorker(this.path(id), executable, args, 180_000);
    await writeFile(this.path(id, `${phase}.log`),
      `Exit code: ${result.code}\n${result.output}${result.errors}`, 'utf8');
    if (!acceptedCodes.includes(result.code)) {
      throw this.workerFailure(result, phaseNames[phase], '请检查输入，或查看项目日志。');
    }
  }

  workerFailure(result, label, fallback) {
    const message = result.errors.trim();
    const readable = message && !/Traceback|(?:[A-Za-z]:\\)|Exception/i.test(message) && message.length <= 300;
    return new ProjectError(result.timedOut ? `${label}超时，请用较小的模型重试。` :
      readable ? message : `${label}失败。${fallback}`);
  }

  runWorker(directory, executable, args, timeout) {
    if (this.stopping) throw new Error('Workbench is shutting down');
    return new Promise((resolveResult, reject) => {
      const child = spawn(executable, args, {
        cwd: directory, windowsHide: true, shell: false,
        env: { ...process.env, OPENBLAS_NUM_THREADS: '1' },
      });
      this.workers.add(child);
      let output = '';
      let errors = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-20_000); });
      child.stderr.setEncoding('utf8').on('data', chunk => { errors = (errors + chunk).slice(-20_000); });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer);
        this.workers.delete(child);
        resolveResult({ code, output, errors, timedOut });
      });
    });
  }

  async run(id) {
    const { source, input } = this.get(id);
    const sourcePath = this.path(id, input.filename);
    if (digest(await readFile(sourcePath)) !== input.sha256) throw new Error('Input hash mismatch');
    const modelDir = this.path(id, 'model');
    const sliceDir = this.path(id, 'slice');
    const profile = this.path(id, 'profile.json');
    const profileSha = digest(await readFile(profile));
    const modelPath = join(modelDir, 'verification.json');
    const dfmPath = this.path(id, 'dfm.json');
    const slicePath = join(sliceDir, 'verification.json');
    await this.update(id, { status: 'running', stage: 'model' });

    if (!await optionalJson(modelPath)) {
      const workerScript = join(workbench, source === 'text' ? 'text_model.py' : 'image_model.py');
      const command = ['-I', '-B', '-X', 'utf8', workerScript, '--input', sourcePath, '--out', modelDir];
      if (source !== 'text') command.push('--width', String(input.width), '--thickness', String(input.thickness));
      await this.worker(id, 'model', python, command);
    }
    const model = await readJson(modelPath);
    const actualSha = digest(await readFile(join(modelDir, 'model.stl')));
    if (model.status !== 'verified' || model.assets?.stl?.sha256 !== actualSha) {
      throw new Error('Verified model does not match the STL');
    }
    const modelKeys = ['model', 'stl', 'glb'];
    if (model.assets.step) modelKeys.push('step', 'spec');
    await this.update(id, { model, stage: 'dfm' }, modelKeys);

    if (!await optionalJson(dfmPath)) {
      await this.worker(id, 'dfm', python, ['-I', '-B', '-X', 'utf8', join(workbench, 'dfm.py'),
        '--model', modelDir, '--profile', profile, '--out', dfmPath], [0, 2]);
    }
    const dfm = await readJson(dfmPath);
    if (dfm.model_sha256 !== actualSha || dfm.profile_sha256 !== profileSha) {
      throw new Error('DFM report does not match the archived input');
    }
    if (dfm.status === 'blocked') {
      await this.update(id, {
        dfm, status: 'blocked', error: '制造检查发现阻断项，请查看报告并调整后重新提交。',
      }, ['dfm']);
      return;
    }
    if (dfm.can_slice !== true || !['pass', 'warn'].includes(dfm.status)) throw new Error('DFM status not recognized');
    await this.update(id, { dfm, stage: 'slice' }, ['dfm']);

    if (!await optionalJson(slicePath)) {
      await this.worker(id, 'slice', process.execPath, [join(root, 'slicer-wasm', 'probe.mjs'), modelDir, sliceDir, profile]);
    }
    const slice = await readJson(slicePath);
    const [gcode, preview] = await Promise.all(['toolpath.gcode', 'toolpath-preview.json'].map(name => readFile(join(sliceDir, name))));
    if (slice.status !== 'verified_offline_slice' || slice.stl.sha256 !== actualSha ||
        (slice.profile_sha256 !== undefined && slice.profile_sha256 !== profileSha) ||
        digest(gcode) !== slice.gcode_file.sha256 || digest(preview) !== slice.preview_file.sha256) {
      throw new Error('Slice evidence does not match the archived output');
    }
    await this.update(id, { slice, status: 'completed', stage: 'complete' }, ['slice', 'gcode', 'toolpath']);
  }
}
