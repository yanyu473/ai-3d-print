import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const port = Number(process.env.CAD_PREVIEW_PORT ?? 4783);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CAD_PREVIEW_PORT must be between 1 and 65535.');
const base = `http://127.0.0.1:${port}`;
const request = (path, options) => fetch(base + path, { signal: AbortSignal.timeout(10000), ...options });

const html = await request('/');
assert.equal(html.status, 200);
assert.match(html.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
assert.match(await html.text(), /<title>几何工作台 · 四孔安装板<\/title>/);
assert.equal((await request('/preview.js', { method: 'HEAD' })).status, 200);
assert.equal((await request('/cad/model.glb', { method: 'POST' })).status, 405);
assert.equal((await request('/cad/cad-spec.json')).status, 404);

const reportResponse = await request('/cad/verification.json');
assert.equal(reportResponse.status, 200, 'Generate the verified CAD artifacts before running this check.');
const report = await reportResponse.json();
const downloads = await Promise.all(['step', 'stl', 'glb'].map(async type => {
  const response = await request(`/cad/model.${type}`);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, report.assets[type].bytes);
  assert.equal(sha256, report.assets[type].sha256);
  return { format: type, bytes: bytes.length, sha256 };
}));

const sliceResponse = await request('/slice/verification.json');
assert.equal(sliceResponse.status, 200);
const slice = await sliceResponse.json();
const [gcode, preview] = await Promise.all([
  ['/slice/toolpath.gcode', slice.gcode_file],
  ['/slice/toolpath-preview.json', slice.preview_file],
].map(async ([path, artifact]) => {
  const response = await request(path);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, artifact.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  return bytes;
}));
const pathData = JSON.parse(preview);
assert.equal(pathData.schema_version, 1);
assert.equal(pathData.gcode_sha256, createHash('sha256').update(gcode).digest('hex'));
assert.equal(pathData.layers.length, slice.layer_count);
const segmentCount = pathData.layers.reduce((total, layer) => total + layer.segments_xy_mm.length, 0);
assert.ok(segmentCount > 0);

console.log(JSON.stringify({ downloadsVerified: downloads, sliceLayers: slice.layer_count, segmentCount }, null, 2));
