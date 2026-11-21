import hashlib
import re
from pathlib import Path


WORD = re.compile(r"([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))")
LAYER_COMMENT = re.compile(r"^;\s*(?:LAYER_CHANGE\s*$|LAYER\s*[: ]\s*\d+|CHANGE_LAYER\s*$)", re.I)


def inspect_gcode(path: Path) -> dict:
    raw = path.read_bytes()
    position = dict.fromkeys("XYZE", 0.0)
    absolute_xyz = absolute_e = True
    deposition_layers = set()
    extrusion = 0.0
    extrusion_moves = 0
    layer_markers = 0

    for line in raw.decode("utf-8", errors="replace").splitlines():
        if LAYER_COMMENT.match(line):
            layer_markers += 1
        words = WORD.findall(line.partition(";")[0].upper())
        if not words:
            continue
        code, value = words[0]
        command = code + value
        axes = {axis: float(amount) for axis, amount in words[1:] if axis in position}

        if command in {"G90", "G91"}:
            absolute_xyz = absolute_e = command == "G90"
        elif command in {"M82", "M83"}:
            absolute_e = command == "M82"
        elif command == "G92":
            position.update(axes)
        elif command in {"G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03"}:
            target = position.copy()
            for axis, amount in axes.items():
                absolute = absolute_e if axis == "E" else absolute_xyz
                target[axis] = amount if absolute else position[axis] + amount
            e_delta = target["E"] - position["E"]
            planar_motion = any(target[axis] != position[axis] for axis in "XY")
            if planar_motion and e_delta > 0:
                extrusion += e_delta
                extrusion_moves += 1
                deposition_layers.add(round(target["Z"], 5))
            position = target

    if len(deposition_layers) < 2 or extrusion_moves == 0:
        raise ValueError("G-code does not contain XY extrusion across multiple Z levels")
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
        "deposition_z_levels": len(deposition_layers),
        "deposition_z_range_mm": [min(deposition_layers), max(deposition_layers)],
        "layer_comment_markers": layer_markers,
        "planar_extrusion_moves": extrusion_moves,
        "positive_planar_e_axis_mm": round(extrusion, 3),
    }
