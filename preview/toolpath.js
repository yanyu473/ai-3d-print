const byId = id => document.getElementById(id);

async function verifiedBytes(route, artifact) {
  if (!Number.isSafeInteger(artifact?.bytes) || artifact.bytes <= 0 || !/^[a-f0-9]{64}$/.test(artifact?.sha256)) {
    throw new Error('invalid_metadata');
  }
  const response = await fetch(route);
  if (!response.ok) throw new Error('missing_artifact');
  const bytes = await response.arrayBuffer();
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  if (bytes.byteLength !== artifact.bytes || hex !== artifact.sha256) throw new Error('artifact_mismatch');
  return bytes;
}

function validatePaths(preview, report) {
  const { bed_mm: bed, layers } = preview;
  if (preview.schema_version !== 1 || preview.gcode_sha256 !== report.gcode_file.sha256 ||
      !Array.isArray(bed) || bed.length !== 2 || !bed.every(size => Number.isFinite(size) && size > 0) ||
      !Array.isArray(layers) || layers.length !== report.layer_count || !layers.length) {
    throw new Error('preview_mismatch');
  }

  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let lastZ = -Infinity;
  for (const layer of layers) {
    if (!Number.isFinite(layer?.z_mm) || layer.z_mm <= lastZ || !Array.isArray(layer.segments_xy_mm) || !layer.segments_xy_mm.length) {
      throw new Error('invalid_layer');
    }
    lastZ = layer.z_mm;
    for (const segment of layer.segments_xy_mm) {
      if (!Array.isArray(segment) || segment.length !== 4 || !segment.every(Number.isFinite)) throw new Error('invalid_segment');
      const [x1, y1, x2, y2] = segment;
      bounds.minX = Math.min(bounds.minX, x1, x2);
      bounds.minY = Math.min(bounds.minY, y1, y2);
      bounds.maxX = Math.max(bounds.maxX, x1, x2);
      bounds.maxY = Math.max(bounds.maxY, y1, y2);
    }
  }
  if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > bed[0] || bounds.maxY > bed[1]) throw new Error('out_of_bounds');
  return bounds;
}

function drawLayer(canvas, context, bounds, segments) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const plot = { left: 30, right: width - 20, top: 76, bottom: height - 144 };
  const extentX = Math.max(bounds.maxX - bounds.minX, 1);
  const extentY = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((plot.right - plot.left) / (extentX + 10), (plot.bottom - plot.top) / (extentY + 10));
  if (scale <= 0) return;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const screenX = (plot.left + plot.right) / 2;
  const screenY = (plot.top + plot.bottom) / 2;
  const xPx = x => screenX + (x - centerX) * scale;
  const yPx = y => screenY - (y - centerY) * scale;
  const step = Math.max(10, Math.ceil(25 / scale / 5) * 5);

  context.lineWidth = 1;
  context.strokeStyle = '#31554c';
  context.fillStyle = '#a6c1b6';
  context.font = '10px ui-monospace, Consolas, monospace';
  for (let x = Math.ceil((centerX + (plot.left - screenX) / scale) / step) * step;
      xPx(x) < plot.right; x += step) {
    const position = xPx(x);
    context.beginPath();
    context.moveTo(position, plot.top);
    context.lineTo(position, plot.bottom);
    context.stroke();
    context.fillText(String(x), position + 2, plot.bottom + 13);
  }
  for (let y = Math.ceil((centerY + (screenY - plot.bottom) / scale) / step) * step;
      yPx(y) > plot.top; y += step) {
    const position = yPx(y);
    context.beginPath();
    context.moveTo(plot.left, position);
    context.lineTo(plot.right, position);
    context.stroke();
    context.fillText(String(y), 7, position + 3);
  }

  context.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    context.moveTo(xPx(x1), yPx(y1));
    context.lineTo(xPx(x2), yPx(y2));
  }
  context.lineWidth = Math.max(.8, Math.min(2, scale * .22));
  context.lineCap = 'round';
  context.strokeStyle = '#8ce7bb';
  context.stroke();
}

export function setupToolpath(onSwitch) {
  const modelMode = byId('model-mode');
  const layerMode = byId('layer-mode');
  const mount = byId('layer-mount');
  const controls = byId('layer-controls');
  const message = byId('layer-message');
  const canvas = byId('layer-canvas');
  const slider = byId('layer-index');
  const previous = byId('layer-prev');
  const next = byId('layer-next');
  let render = () => {};

  function switchMode(isModel) {
    modelMode.setAttribute('aria-pressed', String(isModel));
    layerMode.setAttribute('aria-pressed', String(!isModel));
    mount.hidden = isModel;
    onSwitch(isModel);
    if (!isModel) render();
  }

  modelMode.addEventListener('click', () => switchMode(true));
  layerMode.addEventListener('click', () => switchMode(false));

  async function loadPaths() {
    const reportResponse = await fetch('/slice/verification.json');
    if (!reportResponse.ok) throw new Error('missing_slice');
    const report = await reportResponse.json();
    const [previewBytes] = await Promise.all([
      verifiedBytes('/slice/toolpath-preview.json', report.preview_file),
      verifiedBytes('/slice/toolpath.gcode', report.gcode_file),
    ]);
    const preview = JSON.parse(new TextDecoder().decode(previewBytes));
    const bounds = validatePaths(preview, report);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('missing_canvas');
    const { layers } = preview;
    slider.max = String(layers.length);
    render = () => {
      const index = Number(slider.value);
      const layer = layers[index - 1];
      const height = `Z ${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(layer.z_mm)} mm`;
      const position = `第 ${index} / ${layers.length} 层`;
      byId('layer-position').textContent = position;
      byId('layer-height').textContent = height;
      slider.setAttribute('aria-valuetext', `${position}，${height}`);
      previous.disabled = index <= 1;
      next.disabled = index >= layers.length;
      drawLayer(canvas, context, bounds, layer.segments_xy_mm);
    };

    slider.addEventListener('input', render);
    previous.addEventListener('click', () => { slider.stepDown(); render(); });
    next.addEventListener('click', () => { slider.stepUp(); render(); });
    const observer = new ResizeObserver(render);
    observer.observe(mount);
    message.hidden = true;
    controls.hidden = false;
    canvas.hidden = false;
    byId('slice-download').hidden = false;
    render();
  }

  loadPaths().catch(error => {
    message.textContent = ['missing_slice', 'missing_artifact'].includes(error.message)
      ? '尚未生成可预览的离线切片。生成后刷新页面。'
      : '未能核对切片文件与验证报告，分层刀路暂不可用。';
  });
}
