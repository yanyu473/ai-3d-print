import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const VERSION = '0.4.3';
const SOURCE_REVISION = '70e03a8a54786d4215776b36ce4e70caa076e213';
const WASM_SHA256 = 'd6002df76a1d0435d2a139d044e988fdff488fd2733dfa994f07db58f052df70';
const MAX_GCODE_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_SEGMENTS = 200_000;
const Z_TOLERANCE_MM = 0.001;
const engineRoot = new URL(`../.tools/alternative-slicers/three-slicer-${VERSION}/package/`, import.meta.url);
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function verifyGcode(gcode, layers, params) {
  const requiredModes = new Set(['G21', 'G90', 'M83']);
  const limits = { X: params.bed_width, Y: params.bed_depth, Z: params.printable_height };
  const checkedLayers = [];
  let position = {};
  let moves = 0;
  let depositionMoves = 0;
  for (const line of gcode.split('\n')) {
    const header = /^; LAYER (\d+) Z([\d.]+)\s*$/.exec(line);
    if (header) {
      if (checkedLayers.length >= layers.length) throw new Error('Unexpected extra G-code layer');
      checkedLayers.push({ index: Number(header[1]), z_mm: Number(header[2]), segments_xy_mm: [] });
      continue;
    }
    const executable = line.split(';', 1)[0].trim();
    requiredModes.delete(executable);
    if (/^(?:G20|G91|G2|G3|G28|G29|M82)(?:\s|$)/.test(executable)
      || (/^G92(?:\s|$)/.test(executable) && !/^G92 E[-+]?\d+(?:\.\d+)?$/.test(executable))) {
      throw new Error(`Unexpected motion mode in offline G-code: ${executable}`);
    }
    if (!/^G[01]\s/.test(executable)) continue;
    if (requiredModes.size) throw new Error('G-code must declare millimeters, absolute XY and relative extrusion');

    const coordinates = {};
    for (const token of executable.split(/\s+/).slice(1)) {
      const parsed = /^([XYZEF])([-+]?\d+(?:\.\d+)?)$/.exec(token);
      if (!parsed || parsed[1] in coordinates || !Number.isFinite(Number(parsed[2]))) {
        throw new Error(`Invalid linear move in offline G-code: ${executable}`);
      }
      coordinates[parsed[1]] = Number(parsed[2]);
    }
    const next = {};
    for (const [axis, limit] of Object.entries(limits)) {
      next[axis] = coordinates[axis] ?? position[axis];
      if (axis in coordinates && !(next[axis] >= 0 && next[axis] <= limit)) {
        throw new Error(`G-code ${axis} motion is outside the offline build volume`);
      }
    }
    if (coordinates.E > 0 && (next.X !== position.X || next.Y !== position.Y)) {
      const layer = checkedLayers.at(-1);
      const segment = [position.X, position.Y, next.X, next.Y];
      if (!layer || !segment.every(Number.isFinite)
        || ![position.Z, next.Z].every((z) => Math.abs(z - layer.z_mm) <= Z_TOLERANCE_MM)) {
        throw new Error('XY deposition must start and end at known positions on the declared layer');
      }
      depositionMoves += 1;
      if (depositionMoves > MAX_PREVIEW_SEGMENTS) throw new Error('Toolpath preview exceeds its segment limit');
      layer.segments_xy_mm.push(segment);
    }
    position = next;
    moves += 1;
  }
  if (checkedLayers.length !== layers.length || checkedLayers.some((layer, index) => (
    layer.index !== layers[index].index || Math.abs(layer.z_mm - layers[index].z_mm) > Z_TOLERANCE_MM
    || !layer.segments_xy_mm.length
  ))) {
    throw new Error('G-code layer markers or extrusion disagree with the engine layer stream');
  }
  return {
    checks: { checked_linear_moves: moves, positive_deposition_moves: depositionMoves },
    layers: checkedLayers.map(({ z_mm, segments_xy_mm }) => ({ z_mm, segments_xy_mm })),
  };
}

async function sliceCad(cadDirectory, outputDirectory, profilePath = new URL('profile.json', import.meta.url)) {
  const manifest = await readJson(join(cadDirectory, 'verification.json'));
  const asset = manifest.assets?.stl;
  if (manifest.status !== 'verified' || asset?.file !== 'model.stl' || !asset.checks?.watertight) {
    throw new Error('Expected a verified and watertight model.stl from the CAD probe');
  }
  const model = await readFile(join(cadDirectory, 'model.stl'));
  if (model.length < 84 || model.readUInt32LE(80) * 50 + 84 !== model.length || sha256(model) !== asset.sha256) {
    throw new Error('STL binary framing or verified SHA-256 does not match');
  }

  const profileBytes = await readFile(profilePath);
  const profile = JSON.parse(profileBytes.toString('utf8'));
  const { params } = profile;
  const [width, depth, height] = asset.checks.dimensions_mm_xyz;
  if (!(width > 0 && width < params.bed_width && depth > 0 && depth < params.bed_depth
    && height > 0 && height <= params.printable_height)) {
    throw new Error('CAD bounds exceed the configured offline build volume');
  }

  if (!existsSync(new URL('engine/index.js', engineRoot))) {
    throw new Error('Slicer package missing. Run slicer-wasm/provision.py first.');
  }
  const installed = await readJson(new URL('package.json', engineRoot));
  if (installed.name !== 'three-slicer' || installed.version !== VERSION) {
    throw new Error('Unexpected slicer package');
  }
  const wasm = await readFile(new URL('engine/src/slicer_core.wasm', engineRoot));
  if (sha256(wasm) !== WASM_SHA256) throw new Error('Offline slicer WASM failed its pinned SHA-256 check');
  const { createSlicer } = await import(new URL('engine/index.js', engineRoot));
  const slicer = await createSlicer();
  const gcodeParts = ['; OFFLINE DIAGNOSTIC ONLY. NO TARGET PRINTER. DO NOT SEND THIS FILE TO HARDWARE.\n'];
  let gcodeBytes = Buffer.byteLength(gcodeParts[0]);
  const layers = [];
  let result;
  try {
    result = slicer.slice(model, params, {
      onLayer(layer) {
        gcodeBytes += Buffer.byteLength(layer.gcode);
        if (gcodeBytes > MAX_GCODE_BYTES) throw new Error('Offline slice exceeds its G-code size limit');
        gcodeParts.push(layer.gcode);
        if (layer.paths?.length) {
          layers.push({ index: layer.idx, z_mm: layer.z, preview_segments: layer.widths.length });
        }
      },
    });
  } finally {
    slicer.dispose();
  }
  if (result.error) throw new Error(result.error);
  const stats = result.stats;
  const gcode = gcodeParts.join('');
  if (result.warnings?.length || stats.over_bed || stats.over_bed_model || !stats.streamed) {
    throw new Error(`Slice failed the offline build-volume check: ${JSON.stringify(result.warnings ?? [])}`);
  }
  if (stats.layers !== layers.length || !layers.length
      || layers.some((layer, i) => !Number.isFinite(layer.z_mm) || layer.z_mm <= (layers[i - 1]?.z_mm ?? 0))
      || Math.abs(layers.at(-1).z_mm - height) > params.layer_height + 0.001
      || !Number.isFinite(stats.filament_mm) || stats.filament_mm <= 0
      || !Number.isFinite(stats.time_estimate) || stats.time_estimate <= 0) {
    throw new Error('Slicer output has missing or inconsistent toolpath, layer or estimate data');
  }
  const toolpath = verifyGcode(gcode, layers, params);
  const gcodeSha = sha256(gcode);
  const preview = `${JSON.stringify({
    schema_version: 1,
    gcode_sha256: gcodeSha,
    bed_mm: [params.bed_width, params.bed_depth],
    layers: toolpath.layers,
  })}\n`;

  const materialArea = Math.PI * (params.filament_diameter / 2) ** 2;
  const output = {
    status: 'verified_offline_slice',
    ready_for_device: false,
    profile_sha256: sha256(profileBytes),
    engine: {
      npm: installed.name, version: installed.version, family: 'OrcaSlicer-derived WASM', node: process.version,
      source_revision: SOURCE_REVISION, wasm_sha256: WASM_SHA256,
    },
    stl: { bytes: model.length, sha256: asset.sha256, dimensions_mm_xyz: [width, depth, height] },
    gcode_file: { name: 'toolpath.gcode', bytes: gcodeBytes, sha256: gcodeSha, ...toolpath.checks },
    preview_file: { name: 'toolpath-preview.json', bytes: Buffer.byteLength(preview), sha256: sha256(preview) },
    layer_count: layers.length,
    time_s_estimate: stats.time_estimate,
    filament_length_mm_estimate: stats.filament_mm,
    filament_mass_g_estimate: stats.filament_mm * materialArea * profile.material_model.assumed_density_g_cm3 / 1000,
    path_segments: stats.path_segments,
    warnings: result.warnings,
  };

  const destination = resolve(outputDirectory);
  if (existsSync(destination)) throw new Error(`Choose a new output folder: ${destination}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), '.slice-'));
  try {
    await writeFile(join(temporary, 'toolpath.gcode'), gcode);
    await writeFile(join(temporary, 'toolpath-preview.json'), preview);
    await writeJson(join(temporary, 'layers.json'), layers);
    await writeFile(join(temporary, 'profile.json'), profileBytes);
    await writeJson(join(temporary, 'verification.json'), output);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(output, null, 2));
}

try {
  if (process.argv.length < 4 || process.argv.length > 5) {
    throw new Error('Usage: node slicer-wasm/probe.mjs <verified-cad-output-directory> <new-output-directory> [profile.json]');
  }
  await sliceCad(process.argv[2], process.argv[3], process.argv[4]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
