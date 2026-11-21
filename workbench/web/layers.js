const element = id => document.getElementById(id);
const millimeters = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

function readPaths(data, report) {
  const { bed_mm: bed, layers } = data;
  if (data.schema_version !== 1 || data.gcode_sha256 !== report.gcode_file?.sha256 ||
      !Array.isArray(bed) || bed.length !== 2 || !bed.every(value => Number.isFinite(value) && value > 0) ||
      !Array.isArray(layers) || !layers.length || layers.length !== report.layer_count) throw new Error('刀路与切片记录不一致');

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let previousHeight = -Infinity;
  for (const layer of layers) {
    if (!Number.isFinite(layer?.z_mm) || layer.z_mm <= previousHeight || !Array.isArray(layer.segments_xy_mm) || !layer.segments_xy_mm.length) {
      throw new Error('刀路层数据不完整');
    }
    previousHeight = layer.z_mm;
    for (const segment of layer.segments_xy_mm) {
      if (!Array.isArray(segment) || segment.length !== 4 || !segment.every(Number.isFinite)) throw new Error('刀路坐标无效');
      const [x1, y1, x2, y2] = segment;
      bounds.minX = Math.min(bounds.minX, x1, x2);
      bounds.minY = Math.min(bounds.minY, y1, y2);
      bounds.maxX = Math.max(bounds.maxX, x1, x2);
      bounds.maxY = Math.max(bounds.maxY, y1, y2);
    }
  }
  if (bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > bed[0] || bounds.maxY > bed[1]) throw new Error('刀路超出离线热床范围');
  return { layers, bounds };
}

function paint(canvas, brush, bounds, segments) {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  brush.setTransform(ratio, 0, 0, ratio, 0, 0);

  const plot = { left: 27, right: width - 18, top: 57, bottom: height - 115 };
  const extentX = Math.max(bounds.maxX - bounds.minX, 1);
  const extentY = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.min((plot.right - plot.left) / (extentX + 9), (plot.bottom - plot.top) / (extentY + 9));
  if (scale <= 0) return;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const screenX = (plot.left + plot.right) / 2;
  const screenY = (plot.top + plot.bottom) / 2;
  const xPx = x => screenX + (x - centerX) * scale;
  const yPx = y => screenY - (y - centerY) * scale;
  const step = Math.max(5, Math.ceil(24 / scale / 5) * 5);

  brush.lineWidth = 1;
  brush.strokeStyle = '#31584c';
  brush.fillStyle = '#a6c7b9';
  brush.font = '9px ui-monospace, Consolas, monospace';
  const xStart = Math.ceil((centerX + (plot.left - screenX) / scale) / step) * step;
  for (let x = xStart; xPx(x) < plot.right; x += step) {
    const position = xPx(x);
    brush.beginPath();
    brush.moveTo(position, plot.top);
    brush.lineTo(position, plot.bottom);
    brush.stroke();
    brush.fillText(String(x), position + 2, plot.bottom + 12);
  }
  const yStart = Math.ceil((centerY + (screenY - plot.bottom) / scale) / step) * step;
  for (let y = yStart; yPx(y) > plot.top; y += step) {
    const position = yPx(y);
    brush.beginPath();
    brush.moveTo(plot.left, position);
    brush.lineTo(plot.right, position);
    brush.stroke();
    brush.fillText(String(y), 5, position + 3);
  }

  brush.lineWidth = Math.max(.75, Math.min(2, scale * .22));
  brush.lineCap = 'round';
  brush.strokeStyle = '#91edb9';
  brush.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    brush.moveTo(xPx(x1), yPx(y1));
    brush.lineTo(xPx(x2), yPx(y2));
  }
  brush.stroke();
}

export function layerViewer() {
  const canvas = element('layer-canvas');
  const brush = canvas.getContext('2d');
  const message = element('layer-message');
  const controls = element('layer-controls');
  const slider = element('layer-index');
  const prev = element('layer-prev');
  const next = element('layer-next');
  let loaded, currentUrl;
  let revision = 0;

  function render() {
    if (!brush || !loaded) return;
    const index = Number(slider.value);
    const layer = loaded.layers[index - 1];
    const position = `第 ${index} / ${loaded.layers.length} 层`;
    const height = `Z ${millimeters.format(layer.z_mm)} mm`;
    element('layer-position').textContent = position;
    element('layer-height').textContent = height;
    slider.setAttribute('aria-valuetext', `${position}，${height}`);
    prev.disabled = index <= 1;
    next.disabled = index >= loaded.layers.length;
    paint(canvas, brush, loaded.bounds, layer.segments_xy_mm);
  }

  slider.addEventListener('input', render);
  prev.addEventListener('click', () => { slider.stepDown(); render(); });
  next.addEventListener('click', () => { slider.stepUp(); render(); });
  const observer = new ResizeObserver(render);
  observer.observe(element('layers-pane'));

  function feedback(text) {
    message.textContent = text;
    message.hidden = !text;
    canvas.hidden = Boolean(text);
    controls.hidden = Boolean(text);
  }

  return async function display(url, report, emptyText) {
    if (!url || !report) feedback(emptyText);
    if (url === currentUrl) return;
    currentUrl = url;
    loaded = undefined;
    const request = ++revision;
    if (!url || !report) return;
    if (!brush) {
      feedback('此浏览器暂时无法绘制刀路。切片文件可从归档下载。');
      return;
    }
    feedback('正在读取分层刀路…');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('找不到分层文件');
      const bytes = await response.arrayBuffer();
      if (report.preview_file && bytes.byteLength !== report.preview_file.bytes) throw new Error('分层文件与报告大小不一致');
      if (crypto.subtle && report.preview_file?.sha256) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        if (hex !== report.preview_file.sha256) throw new Error('分层文件校验失败');
      }
      const data = readPaths(JSON.parse(new TextDecoder().decode(bytes)), report);
      if (request !== revision) return;
      loaded = data;
      slider.max = String(data.layers.length);
      slider.value = '1';
      feedback('');
      render();
    } catch (error) {
      if (request !== revision) return;
      feedback(error instanceof Error ? error.message : '无法读取分层文件');
      currentUrl = undefined;
    }
  };
}
