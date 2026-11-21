import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url));
const port = 4794;
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const python = join(root, '.venv', 'Scripts', 'python.exe');
const exec = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function buildImageFixtures(directory) {
  const script = `
from pathlib import Path
import sys
from PIL import Image, ImageDraw

directory = Path(sys.argv[1])
bounds = (22, 18, 73, 57)
photo = Image.new('RGB', (96, 76), 'black')
ImageDraw.Draw(photo).rectangle(bounds, fill='white')
photo.save(directory / 'photo.jpg', quality=94)

image = Image.new('RGBA', (96, 76), (0, 0, 0, 0))
pen = ImageDraw.Draw(image)
pen.rectangle(bounds, fill='white')
pen.ellipse((40, 29, 55, 46), fill=(0, 0, 0, 0))
image.save(directory / 'image.png')
`;
  await exec(python, ['-B', '-c', script, directory], { cwd: root, timeout: 30_000, windowsHide: true });
  const [jpeg, png] = await Promise.all(['photo.jpg', 'image.png'].map((file) => readFile(join(directory, file))));
  return {
    photo: { source: 'photo', image_name: 'photo.jpg', image_data: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    image: { source: 'image', image_name: 'image.png', image_data: `data:image/png;base64,${png.toString('base64')}` },
  };
}

async function assertPortAvailable() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, host, () => probe.close(resolve));
  });
}

function launch(dataDirectory) {
  const child = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_PORT: String(port),
      WORKBENCH_DATA_DIR: dataDirectory,
      PYTHONDONTWRITEBYTECODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let stopped = false;
  const capture = (chunk) => { output = (output + chunk).slice(-12_000); };
  child.stdout.setEncoding('utf8').on('data', capture);
  child.stderr.setEncoding('utf8').on('data', capture);
  const closed = new Promise((resolve) => {
    child.once('close', resolve);
    child.once('error', (error) => { capture(String(error)); });
  }).then(() => { stopped = true; });
  return {
    get logs() { return output; },
    get stopped() { return stopped || child.exitCode !== null || child.signalCode !== null; },
    async close() {
      if (!this.stopped) child.kill();
      await closed;
    },
  };
}

function request(path, options) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'The test should contact only its local workbench');
  return fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual', ...options });
}

async function jsonResponse(path, expectedStatus = 200, options) {
  const response = await request(path, options);
  const body = await response.text();
  assert.equal(response.status, expectedStatus, `${path}: HTTP ${response.status} ${body.slice(0, 1000)}`);
  return JSON.parse(body);
}

async function waitForServer(server) {
  const deadline = Date.now() + 20_000;
  while (!server.stopped && Date.now() < deadline) {
    if (server.logs.includes(origin)) {
      const response = await request('/api/health', { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).app, 'local-3d-workbench-v1');
      return;
    }
    await sleep(100);
  }
  assert.fail(`Workbench did not start on port ${port}\n${server.logs}`);
}

function projectUrl(id) {
  return `/api/projects/${encodeURIComponent(id)}`;
}

async function submit(input) {
  const { project } = await jsonResponse('/api/projects', 202, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.equal(typeof project?.id, 'string');
  assert.equal(project.source, input.source);
  return project;
}

function resize(project, changes, expectedStatus = 202) {
  return jsonResponse(`${projectUrl(project.id)}/resize`, expectedStatus, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
}

function rebuild(project, changes, expectedStatus = 202) {
  return jsonResponse(`${projectUrl(project.id)}/rebuild`, expectedStatus, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  });
}

function preview(project, parameters, expectedStatus = 200) {
  return jsonResponse(`${projectUrl(project.id)}/preview`, expectedStatus, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters }), signal: AbortSignal.timeout(50_000),
  });
}

async function waitForProject(initial, expectedStatus) {
  const deadline = Date.now() + 120_000;
  let latest = initial;
  while (Date.now() < deadline) {
    ({ project: latest } = await jsonResponse(projectUrl(initial.id)));
    if (['completed', 'blocked', 'failed'].includes(latest.status)) {
      assert.equal(latest.status, expectedStatus, `${latest.source} ${latest.stage}: ${latest.error ?? latest.status}`);
      return latest;
    }
    await sleep(250);
  }
  assert.fail(`${initial.source} timed out on ${latest.stage} (${latest.status})`);
}

async function download(project, name) {
  const path = project.files[name];
  assert.ok(path, `${project.source} project must expose ${name}`);
  const response = await request(path);
  assert.equal(response.status, 200, `Failed to download ${name} for ${project.source}`);
  return Buffer.from(await response.arrayBuffer());
}

async function checkModel(project) {
  const [input, profile, model, glb, stl, dfm] = await Promise.all(
    ['input', 'profile', 'model', 'glb', 'stl', 'dfm'].map((name) => download(project, name)),
  );
  assert.equal(project.input.sha256, sha256(input));
  assert.deepEqual(JSON.parse(model.toString('utf8')), project.model);
  assert.equal(project.model.status, 'verified');
  assert.equal(project.model.assets.stl.sha256, sha256(stl));
  assert.equal(project.model.assets.glb.sha256, sha256(glb));
  assert.equal(stl.length, 84 + 50 * stl.readUInt32LE(80), 'Expected binary STL');
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  assert.equal(glb.readUInt32LE(4), 2);
  assert.equal(project.model.assets.stl.checks.watertight, true);
  assert.deepEqual(JSON.parse(dfm.toString('utf8')), project.dfm);
  assert.equal(project.dfm.model_sha256, sha256(stl));
  assert.equal(project.dfm.profile_sha256, sha256(profile));
  assert.equal(project.dfm.checks.find(({ id }) => id === 'watertight')?.status, 'pass');

  if (project.source === 'text') {
    const [step, spec] = await Promise.all([download(project, 'step'), download(project, 'spec')]);
    assert.equal(project.model.geometry_type, 'BRep');
    assert.match(step.toString('ascii', 0, 80), /^ISO-10303-21;/);
    assert.equal(project.model.assets.step.sha256, sha256(step));
    assert.equal(JSON.parse(spec.toString('utf8')).kind, project.model.kind);
  } else {
    assert.equal(project.model.geometry_type, 'silhouette_extrusion_mesh');
    assert.equal(project.model.source.sha256, sha256(input));
    assert.equal(project.model.source.format, project.source === 'photo' ? 'JPEG' : 'PNG');
    assert.equal(project.model.source.through_hole_count, project.source === 'photo' ? 0 : 1);
    assert.equal(project.model.assets.step, undefined);
    assert.equal(project.files.step, undefined);
    assert.equal((await request(`${projectUrl(project.id)}/files/step`)).status, 404);
  }
}

async function checkSlice(project, expectedLayers) {
  assert.equal(project.stage, 'complete');
  assert.equal(project.dfm.can_slice, true);
  assert.equal(project.slice.status, 'verified_offline_slice');
  assert.equal(project.slice.ready_for_device, false);
  assert.equal(project.slice.layer_count, expectedLayers);
  assert.equal(project.slice.stl.sha256, project.dfm.model_sha256);
  assert.equal(project.slice.profile_sha256, project.dfm.profile_sha256);

  const [slice, gcode, toolpath] = await Promise.all(
    ['slice', 'gcode', 'toolpath'].map((name) => download(project, name)),
  );
  assert.deepEqual(JSON.parse(slice.toString('utf8')), project.slice);
  assert.equal(project.slice.gcode_file.bytes, gcode.length);
  assert.equal(project.slice.gcode_file.sha256, sha256(gcode));
  assert.equal(project.slice.preview_file.sha256, sha256(toolpath));
  const preview = JSON.parse(toolpath.toString('utf8'));
  assert.equal(preview.schema_version, 1);
  assert.equal(preview.gcode_sha256, sha256(gcode));
  assert.equal(preview.layers.length, expectedLayers);
  const deposits = preview.layers.reduce((sum, layer) => sum + layer.segments_xy_mm.length, 0);
  assert.ok(deposits > 0);
  assert.equal(deposits, project.slice.gcode_file.positive_deposition_moves);
}

async function checkResize(original, thickness) {
  const scale = 1.25;
  const { project: queued } = await resize(original, { scale, thickness });
  assert.equal(typeof queued.id, 'string');
  assert.notEqual(queued.id, original.id);
  assert.equal(queued.source, original.source);
  const revision = await waitForProject(queued, 'completed');
  assert.equal(revision.parent_id, original.id);
  await checkModel(revision);
  const expectedDimensions = original.dfm.geometry.dimensions_mm.slice(0, 2).map((span) => span * scale);
  expectedDimensions.push(thickness);
  assert.equal(revision.dfm.geometry.dimensions_mm.length, 3);
  for (const [index, span] of revision.dfm.geometry.dimensions_mm.entries()) {
    assert.ok(Math.abs(span - expectedDimensions[index]) < 0.001,
      `Expected ${original.source} ${'XYZ'[index]} ${expectedDimensions[index]} mm, got ${span} mm in the STL`);
  }
  for (const [extension, asset] of Object.entries(revision.model.assets)) {
    assert.notEqual(asset.sha256, original.model.assets[extension].sha256);
    assert.ok(asset.checks.dimensions_mm_xyz.every((span, index) => Math.abs(span - expectedDimensions[index]) < 0.001));
  }
  const idealLayerCount = thickness / 0.2;
  assert.ok([Math.floor(idealLayerCount), Math.ceil(idealLayerCount)].includes(revision.slice.layer_count));
  await checkSlice(revision, revision.slice.layer_count);
  assert.notEqual(revision.slice.gcode_file.sha256, original.slice.gcode_file.sha256);

  const { project: savedOriginal } = await jsonResponse(projectUrl(original.id));
  assert.deepEqual(savedOriginal, original);
  await checkModel(savedOriginal);
  await checkSlice(savedOriginal, original.slice.layer_count);
  if (original.source === 'photo') {
    assert.equal(revision.input.width, original.input.width * scale);
    assert.equal(revision.input.thickness, thickness);
    const [parentImage, childImage] = await Promise.all([download(original, 'input'), download(revision, 'input')]);
    assert.deepEqual(childImage, parentImage);
  }
  return revision;
}

test('text, JPEG photo and PNG image projects build, edit, slice and survive restart', { timeout: 280_000 }, async (t) => {
  await assertPortAvailable();
  const directory = await mkdtemp(join(root, '.workbench-test-'));
  const data = join(directory, 'data');
  let server;
  try {
    await mkdir(data);
    const fixtures = await buildImageFixtures(directory);
    server = launch(data);
    await waitForServer(server);
    assert.deepEqual((await jsonResponse('/api/projects')).projects, []);

    const inputs = [
      { source: 'text', text: '制作一块 60×40×5 毫米的四孔安装板，孔径 4 毫米，孔距 46×26 毫米。' },
      { ...fixtures.photo, width: 48, thickness: 3 },
      { ...fixtures.image, width: 48, thickness: 3 },
    ];
    const projects = [];
    for (const [index, input] of inputs.entries()) {
      const item = await waitForProject(await submit(input), 'completed');
      await checkModel(item);
      await checkSlice(item, [25, 15, 15][index]);
      projects.push(item);
      t.diagnostic(`${input.source}: ${item.slice.layer_count} layers, ${item.slice.gcode_file.positive_deposition_moves} deposits`);
    }

    const [text, photo, image] = projects;
    assert.deepEqual(text.process, { layer_height: 0.20, infill_percent: 15 });
    for (const extension of ['stl', 'glb']) {
      const photoOutput = photo.model.assets[extension];
      const imageOutput = image.model.assets[extension];
      assert.notEqual(photoOutput.sha256, imageOutput.sha256);
      assert.ok(photoOutput.checks.volume_mm3 > imageOutput.checks.volume_mm3, 'The input hole must remove geometry');
    }

    const revisions = [];
    for (const [original, thickness] of [[text, 6], [photo, 4.5]]) {
      const revision = await checkResize(original, thickness);
      revisions.push(revision);
      const size = revision.dfm.geometry.dimensions_mm.map((span) => span.toFixed(2)).join(' × ');
      t.diagnostic(`${original.source} resize: ${size} mm, ${revision.slice.layer_count} layers, parent artifacts preserved`);
    }
    await resize(text, { scale: 0, thickness: 6 }, 400);
    await resize(photo, { scale: 1, thickness: 3 }, 400);
    assert.equal((await jsonResponse('/api/projects')).projects.length, projects.length + revisions.length);
    t.diagnostic('Invalid and unchanged resize requests left project history intact');

    const { project: holeRequest } = await rebuild(text, {
      parameters: { hole_diameter: 6 }, process: { layer_height: 0.25, infill_percent: 25 },
    });
    const edited = await waitForProject(holeRequest, 'completed');
    await checkModel(edited);
    await checkSlice(edited, 20);
    assert.equal(edited.parent_id, text.id);
    assert.deepEqual(edited.dfm.geometry.dimensions_mm, text.dfm.geometry.dimensions_mm);
    assert.notEqual(edited.model.assets.stl.sha256, text.model.assets.stl.sha256);
    assert.deepEqual(edited.model.assets.step.checks.through_holes_xy_diameter_depth_mm.map(h => h[2]), [6, 6, 6, 6]);
    assert.deepEqual(edited.process, { layer_height: 0.25, infill_percent: 25 });
    const profile = JSON.parse((await download(edited, 'profile')).toString('utf8'));
    assert.equal(profile.params.first_layer_height, 0.25);
    assert.equal(profile.params.infill_density, 0.25);
    t.diagnostic('4→6 mm true hole edit, independent outer dimensions preserved, 0.25 mm profile cut 20 G-code layers');

    const { project: infillRequest } = await rebuild(edited, { process: { infill_percent: 0 } });
    const noInfill = await waitForProject(infillRequest, 'completed');
    await checkModel(noInfill);
    await checkSlice(noInfill, 20);
    assert.equal(noInfill.input.sha256, edited.input.sha256);
    assert.equal(noInfill.model.assets.stl.sha256, edited.model.assets.stl.sha256);
    assert.notEqual(noInfill.slice.gcode_file.sha256, edited.slice.gcode_file.sha256);
    assert.ok(noInfill.slice.filament_length_mm_estimate < edited.slice.filament_length_mm_estimate);
    assert.deepEqual(noInfill.process, { layer_height: 0.25, infill_percent: 0 });
    t.diagnostic('Process-only rebuild changed actual G-code and filament use at 0% infill, preserving input and STL');

    await rebuild(text, { parameters: { x_spacing: 61 } }, 400);
    await rebuild(text, { parameters: { unknown: 6 } }, 400);
    await rebuild(edited, { process: { layer_height: 0.31 } }, 400);
    await rebuild(edited, { process: { layer_height: 0.251 } }, 400);
    await rebuild(edited, { process: { infill_percent: 101 } }, 400);
    await rebuild(photo, { parameters: { width: '60' } }, 400);
    await rebuild(noInfill, { process: { infill_percent: 0 } }, 400);
    assert.equal((await jsonResponse('/api/projects')).projects.length, projects.length + revisions.length + 2);

    const blocked = await waitForProject(await submit({
      ...fixtures.image, width: 48, thickness: 0.1, parent_id: image.id,
    }), 'blocked');
    assert.equal(blocked.parent_id, image.id);
    await checkModel(blocked);
    assert.equal(blocked.dfm.status, 'blocked');
    assert.equal(blocked.dfm.can_slice, false);
    assert.equal(blocked.dfm.checks.find(({ id }) => id === 'extrusion_height')?.status, 'fail');
    assert.equal(blocked.files.gcode, undefined);
    assert.equal(blocked.slice, undefined);
    assert.equal((await request(`${projectUrl(blocked.id)}/files/gcode`)).status, 404);
    await assert.rejects(access(join(data, blocked.id, 'slice', 'toolpath.gcode')), { code: 'ENOENT' });
    t.diagnostic('0.1 mm revision: manufacturing check blocked slicing and G-code download');

    await server.close();
    const { process: _process, ...legacy } = text;
    await writeFile(join(data, text.id, 'project.json'), JSON.stringify(legacy), 'utf8');
    server = launch(data);
    await waitForServer(server);
    const { projects: history } = await jsonResponse('/api/projects');
    const expected = [...projects, ...revisions, edited, noInfill, blocked];
    assert.equal(history.length, expected.length);
    for (const previous of expected) {
      assert.deepEqual(history.find(({ id }) => id === previous.id), previous);
      const { project } = await jsonResponse(projectUrl(previous.id));
      assert.deepEqual(project, previous);
      if (project.status === 'completed') await checkSlice(project, previous.slice.layer_count);
    }
    t.diagnostic(`Reloaded ${history.length} archived projects after restarting the process`);
  } catch (error) {
    if (server?.logs) t.diagnostic(server.logs);
    throw error;
  } finally {
    await server?.close();
    const testDirectory = await realpath(directory);
    assert.equal(dirname(testDirectory), await realpath(root));
    await rm(testDirectory, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
});

test('structural parts produce verified STEP features, real slicing, and edited descendants', { timeout: 300_000 }, async (t) => {
  await assertPortAvailable();
  const directory = await mkdtemp(join(root, '.structural-test-'));
  let server;
  try {
    server = launch(join(directory, 'data'));
    await waitForServer(server);
    let bracket = await waitForProject(await submit({
      source: 'text', text: '加强角码，长 48 mm，宽 38 mm，高 36 mm，壁厚 4 mm，孔径 5 mm',
    }), 'completed');
    assert.equal(bracket.model.kind, 'reinforced_bracket');
    await checkModel(bracket);
    await checkSlice(bracket, 180);
    assert.equal(bracket.model.features.base_holes.count, 2);
    assert.equal(bracket.model.features.base_holes.axis, 'Z');
    assert.equal(bracket.model.features.upright_holes.count, 2);
    assert.equal(bracket.model.features.upright_holes.axis, 'Y');
    assert.equal(bracket.model.features.gussets.count, 1);
    assert.equal(bracket.model.features.gussets.thickness_mm, 4);
    assert.equal(bracket.dfm.checks.find(({ id }) => id === 'extrusion_height').status, 'not_checked');
    t.diagnostic(`Bracket: 4 STEP-verified bores on two axes, reinforced center web, ${bracket.slice.layer_count} real layers`);

    // Reopen an earlier archive whose model metadata did not include editable counts.
    await server.close();
    const directoryData = join(directory, 'data');
    const previousBracket = structuredClone(bracket);
    for (const key of ['rib_count', 'base_hole_count', 'upright_hole_count']) {
      delete previousBracket.model.parameters[key];
    }
    await writeFile(join(directoryData, bracket.id, 'project.json'), JSON.stringify(previousBracket), 'utf8');
    server = launch(directoryData);
    await waitForServer(server);
    bracket = (await jsonResponse(projectUrl(bracket.id))).project;
    assert.deepEqual(bracket, previousBracket);
    assert.equal((await preview(bracket, { rib_count: 1 })).preview.glb, bracket.files.glb);
    await preview(bracket, { rib_count: 3 }, 400);
    await preview(bracket, { base_hole_count: '4' }, 400);
    await preview(bracket, { hole_diameter: 23 }, 400);
    await rebuild(bracket, { parameters: { hole_diameter: 23 } }, 400);
    const bracketParameters = { height: 40, hole_diameter: 6, rib_count: 2, base_hole_count: 4, upright_hole_count: 0 };
    const { preview: bracketPreview } = await preview(bracket, bracketParameters);
    assert.equal(bracketPreview.kind, 'reinforced_bracket');
    assert.deepEqual(bracketPreview.dimensions_mm_xyz, [48, 38, 40]);
    assert.equal(bracketPreview.features.base_holes.count, 4);
    assert.equal(bracketPreview.features.upright_holes.count, 0);
    assert.equal(bracketPreview.features.gussets.count, 2);
    assert.match(bracketPreview.glb, /^\/api\/previews\/[a-f0-9-]+\/model\.glb$/);
    const previewResponse = await request(bracketPreview.glb);
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.headers.get('content-type'), 'model/gltf-binary');
    const bracketGlb = Buffer.from(await previewResponse.arrayBuffer());
    assert.equal(bracketGlb.subarray(0, 4).toString('ascii'), 'glTF');
    assert.notEqual(sha256(bracketGlb), bracket.model.assets.glb.sha256);
    assert.equal((await request(bracketPreview.glb, { method: 'HEAD' })).status, 200);
    assert.equal((await request(bracketPreview.glb.replace('model.glb', 'source.txt'))).status, 404);
    assert.equal((await jsonResponse('/api/projects')).projects.length, 1);
    assert.deepEqual(await readdir(join(directoryData, '.previews')), []);
    const { project: bracketDraft } = await rebuild(bracket, {
      parameters: bracketParameters, process: { layer_height: 0.25 },
    });
    const bracketRevision = await waitForProject(bracketDraft, 'completed');
    assert.equal(bracketRevision.parent_id, bracket.id);
    await checkModel(bracketRevision);
    await checkSlice(bracketRevision, 160);
    assert.equal(bracketRevision.model.features.upright_holes.diameter_mm, 6);
    assert.deepEqual(bracketRevision.model.features, bracketPreview.features);
    assert.equal(bracketRevision.model.assets.glb.sha256, sha256(bracketGlb));
    assert.deepEqual(bracketRevision.model.assets.step.checks.dimensions_mm_xyz, [48, 38, 40]);
    assert.notEqual(bracketRevision.slice.gcode_file.sha256, bracket.slice.gcode_file.sha256);

    const tray = await waitForProject(await submit({
      source: 'text', text: '电子盒底座，长 62 mm，宽 44 mm，高 20 mm，壁厚 2.4 mm，螺丝柱直径 7 mm，孔径 2.8 mm',
    }), 'completed');
    assert.equal(tray.model.kind, 'electronics_tray');
    await checkModel(tray);
    await checkSlice(tray, 100);
    assert.equal(tray.model.features.cavity.open_top, true);
    assert.deepEqual(tray.model.features.cavity.dimensions_mm_xyz, [57.2, 39.2, 17.6]);
    assert.equal(tray.model.features.screw_posts.count, 4);
    assert.equal(tray.model.features.screw_posts.pilot_diameter_mm, 2.8);
    assert.equal(tray.dfm.checks.find(({ id }) => id === 'extrusion_height').status, 'not_checked');
    t.diagnostic(`Tray: open cavity and 4 STEP-verified blind pilot holes, ${tray.slice.layer_count} real layers`);
    await rebuild(tray, { parameters: { hole_diameter: 7 } }, 400);
    const trayParameters = { post_diameter: 8, hole_diameter: 3, compartment_count: 3, post_count: 0, cable_notch: 1 };
    const { preview: trayPreview } = await preview(tray, trayParameters);
    assert.equal(trayPreview.kind, 'electronics_tray');
    assert.deepEqual(trayPreview.dimensions_mm_xyz, [62, 44, 20]);
    assert.equal(trayPreview.features.dividers.compartment_count, 3);
    assert.equal(trayPreview.features.screw_posts.count, 0);
    assert.equal(trayPreview.features.cable_notch.enabled, true);
    const trayGlb = await download({ files: { glb: trayPreview.glb }, source: '电子盒预览' }, 'glb');
    assert.equal(trayGlb.subarray(0, 4).toString('ascii'), 'glTF');
    assert.notEqual(sha256(trayGlb), tray.model.assets.glb.sha256);
    assert.equal((await jsonResponse('/api/projects')).projects.length, 3);
    const { project: trayDraft } = await rebuild(tray, {
      parameters: trayParameters, process: { layer_height: 0.25 },
    });
    const trayRevision = await waitForProject(trayDraft, 'completed');
    assert.equal(trayRevision.parent_id, tray.id);
    await checkModel(trayRevision);
    await checkSlice(trayRevision, 80);
    assert.equal(trayRevision.model.features.screw_posts.diameter_mm, 8);
    assert.equal(trayRevision.model.features.screw_posts.pilot_diameter_mm, 3);
    assert.deepEqual(trayRevision.model.features, trayPreview.features);
    assert.equal(trayRevision.model.assets.glb.sha256, sha256(trayGlb));
    assert.notEqual(trayRevision.slice.gcode_file.sha256, tray.slice.gcode_file.sha256);
    assert.equal((await jsonResponse('/api/projects')).projects.length, 4);
    assert.deepEqual((await jsonResponse(projectUrl(bracket.id))).project, bracket);
    assert.deepEqual((await jsonResponse(projectUrl(tray.id))).project, tray);
    t.diagnostic('Both temporary previews matched the archived GLBs after rebuild; each STEP and G-code changed while the original projects were preserved');
  } catch (error) {
    if (server?.logs) t.diagnostic(server.logs);
    throw error;
  } finally {
    await server?.close();
    const testDirectory = await realpath(directory);
    assert.equal(dirname(testDirectory), await realpath(root));
    await rm(testDirectory, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
});
