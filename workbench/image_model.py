"""Build a print mesh by extruding a flat, high-contrast photo or image silhouette.

Use a single front-facing view against a plain background with space around the
part. The supplied width sets the scale and the supplied thickness sets depth
along the extrusion axis. Images are reduced to at most 160 pixels on the
longest side before segmentation. Very small features can disappear. Angled
photos preserve perspective distortion. This is a single projected outline
with visible through-holes and uniform thickness.
"""

import argparse
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from scipy import ndimage
import trimesh


MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_SOURCE_PIXELS = 25_000_000
MAX_RASTER_EDGE = 160
MIN_CONTRAST = 45


def read_silhouette(path):
    with path.open("rb") as handle:
        data = handle.read(MAX_IMAGE_BYTES + 1)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Select a still image up to 20 MiB")

    with Image.open(BytesIO(data)) as source:
        image_format = source.format
        if image_format not in {"JPEG", "PNG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
            raise ValueError("Select a still JPEG, PNG or WebP image")
        if min(source.size) < 16 or math.prod(source.size) > MAX_SOURCE_PIXELS:
            raise ValueError("Image must be at least 16 pixels on each side and at most 25 megapixels")
        image = ImageOps.exif_transpose(source).convert("RGBA")

    oriented_size = image.size
    image.thumbnail((MAX_RASTER_EDGE, MAX_RASTER_EDGE), Image.Resampling.LANCZOS)
    if min(image.size) < 8:
        raise ValueError("Image aspect ratio is too extreme for this silhouette reconstruction")

    alpha = np.asarray(image.getchannel("A"))
    use_alpha = np.median(border_pixels(alpha)) < 64 and alpha.max() > 191
    if use_alpha:
        gray = 255 - alpha
    else:
        background = Image.new("RGBA", image.size, "white")
        gray = np.asarray(Image.alpha_composite(background, image).convert("L"))

    threshold = otsu(gray)
    dark = gray <= threshold
    foreground = dark if np.mean(border_pixels(dark)) < 0.5 else ~dark
    if np.mean(border_pixels(foreground)) > 0.08:
        raise ValueError("Use a plain background with a visible margin around the silhouette")
    contrast = abs(float(np.median(gray[foreground])) - float(np.median(gray[~foreground])))
    if contrast < MIN_CONTRAST:
        raise ValueError("The subject and background need stronger contrast")

    labels, _ = ndimage.label(foreground)
    sizes = np.bincount(labels.ravel())[1:]
    largest = int(sizes.argmax())
    primary = int(sizes[largest])
    if primary < max(20, gray.size * 0.01) or primary > gray.size * 0.90:
        raise ValueError("Show one clear, reasonably sized silhouette with space around it")
    if primary < sizes.sum() * 0.90:
        raise ValueError("Show one connected silhouette against a clean background")
    mask = labels == largest + 1
    if border_pixels(mask).any():
        raise ValueError("The main silhouette is clipped at the edge of the image")

    # At an ambiguous diagonal, the mesh preserves 4-connectivity of the solid
    # and 8-connectivity of the surrounding air.
    air_neighbors = np.ones((3, 3), dtype=bool)
    hole_mask = ndimage.binary_fill_holes(mask, structure=air_neighbors) & ~mask
    _, hole_count = ndimage.label(hole_mask, structure=air_neighbors)
    return mask, {
        "file": path.name,
        "sha256": sha256(data).hexdigest(),
        "format": image_format,
        "oriented_dimensions_px": oriented_size,
        "processed_dimensions_px": image.size,
        "segmentation_source": "alpha" if use_alpha else "grayscale",
        "threshold_0_255": threshold,
        "median_contrast_0_255": contrast,
        "foreground_pixels": primary,
        "discarded_foreground_pixels": int(sizes.sum()) - primary,
        "through_hole_count": hole_count,
    }


def border_pixels(raster):
    return np.concatenate((raster[0], raster[-1], raster[1:-1, 0], raster[1:-1, -1]))


def otsu(gray):
    if int(gray.max()) - int(gray.min()) < MIN_CONTRAST:
        raise ValueError("The subject and background need stronger contrast")
    levels = np.arange(256)
    counts = np.bincount(gray.ravel(), minlength=256)
    cumulative_count = np.cumsum(counts)
    cumulative_sum = np.cumsum(levels * counts)
    denominator = cumulative_count * (gray.size - cumulative_count)
    numerator = (cumulative_sum.astype(float) * gray.size - cumulative_count * cumulative_sum[-1]) ** 2
    scores = np.divide(numerator, denominator, out=np.zeros(256), where=denominator > 0)
    return int(scores.argmax())


def cell_polygons(x, y, filled):
    """Marching squares in integer half-pixel coordinates, counterclockwise."""
    corners = ((x, y), (x + 2, y), (x + 2, y + 2), (x, y + 2))
    midpoints = ((x + 1, y), (x + 2, y + 1), (x + 1, y + 2), (x, y + 1))
    if sum(filled) == 2 and filled[0] == filled[2]:
        return [(corners[i], midpoints[i], midpoints[i - 1]) for i in range(4) if filled[i]]
    polygon = []
    for i in range(4):
        if filled[i]:
            polygon.append(corners[i])
        if filled[i] != filled[(i + 1) % 4]:
            polygon.append(midpoints[i])
    return [polygon]


def extrude_silhouette(mask, width, thickness):
    grid = np.pad(np.flipud(mask), 1)
    corners = (grid[:-1, :-1], grid[:-1, 1:], grid[1:, 1:], grid[1:, :-1])
    points = {}
    triangles = []
    boundary = set()
    for y, x in np.argwhere(np.logical_or.reduce(corners)):
        occupied = tuple(bool(corner[y, x]) for corner in corners)
        for polygon in cell_polygons(int(x * 2), int(y * 2), occupied):
            ids = [points.setdefault(point, len(points)) for point in polygon]
            triangles.extend((ids[0], ids[i], ids[i + 1]) for i in range(1, len(ids) - 1))
            for start, end in zip(ids, ids[1:] + ids[:1], strict=True):
                if (end, start) in boundary:
                    boundary.remove((end, start))
                else:
                    boundary.add((start, end))

    xy = np.asarray(list(points), dtype=float)
    low, high = xy.min(axis=0), xy.max(axis=0)
    xy = (xy - (low + high) / 2) * (width / (high[0] - low[0]))
    count = len(xy)
    bottom = np.column_stack((xy, np.zeros(count)))
    top = np.column_stack((xy, np.full(count, thickness)))
    caps = np.asarray(triangles, dtype=np.int64)
    side_faces = []
    for start, end in sorted(boundary):
        side_faces.extend(((start, end, end + count), (start, end + count, start + count)))
    return trimesh.Trimesh(
        vertices=np.vstack((bottom, top)),
        faces=np.vstack((caps[:, ::-1], caps + count, side_faces)),
        process=False,
    )


def verify_mesh(mesh, expected_dimensions, hole_count):
    if (not mesh.is_volume or mesh.body_count != 1 or mesh.euler_number != 2 - 2 * hole_count
        or not np.allclose(mesh.extents, expected_dimensions, rtol=0, atol=0.001)
        or not math.isclose(mesh.bounds[0, 2], 0, abs_tol=0.001)):
        raise ValueError("The extruded silhouette must round-trip as one watertight solid with its through-holes")
    return {
        "dimensions_mm_xyz": mesh.extents.tolist(),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "connected_components": int(mesh.body_count),
        "through_hole_count": hole_count,
        "triangles": len(mesh.faces),
        "volume_mm3": float(mesh.volume),
    }


def build_image(input_path, width, thickness, output):
    if not (0.1 <= width <= 1000 and 0.1 <= thickness <= 1000):
        raise ValueError("Width and thickness must be between 0.1 and 1000 mm")
    if output.exists():
        raise FileExistsError(f"Choose a new output directory: {output}")

    mask, source = read_silhouette(input_path)
    hole_count = source["through_hole_count"]
    mesh = extrude_silhouette(mask, width, thickness)
    verify_mesh(mesh, (width, mesh.extents[1], thickness), hole_count)
    preview = mesh.copy()
    preview.visual.vertex_colors = [54, 163, 152, 255]
    preview.apply_transform(trimesh.transformations.rotation_matrix(-math.pi / 2, [1, 0, 0]))
    preview.apply_scale(0.001)

    payloads = {"stl": mesh.export(file_type="stl"), "glb": preview.export(file_type="glb")}
    assets = {}
    for extension, payload in payloads.items():
        reopened = trimesh.load_scene(BytesIO(payload), file_type=extension).to_mesh()
        if extension == "glb":
            reopened.apply_scale(1000)
            reopened.apply_transform(trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0]))
        reopened.merge_vertices(merge_tex=True, merge_norm=True)
        checks = verify_mesh(reopened, mesh.extents, hole_count)
        assets[extension] = {
            "file": f"model.{extension}", "sha256": sha256(payload).hexdigest(),
            "bytes": len(payload), "checks": checks,
        }

    report = {
        "status": "verified",
        "mode": "local_image_silhouette",
        "geometry_type": "silhouette_extrusion_mesh",
        "method": "single_view_silhouette_extrusion",
        "editability": "regenerable_from_image_and_dimensions",
        "source": source,
        "geometry": {
            "dimensions_mm_xyz": mesh.extents.tolist(),
            "width_source": "user_declared",
            "height_source": "segmented_image_aspect_ratio",
            "thickness_source": "user_declared",
            "base_z_mm": 0,
        },
        "assets": assets,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="silhouette-", dir=output.parent) as temporary:
        work = Path(temporary) / "model"
        work.mkdir()
        for extension, payload in payloads.items():
            (work / assets[extension]["file"]).write_bytes(payload)
        (work / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        work.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser(
        description=(__doc__ or "").strip(), formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--width", type=float, required=True, help="Overall silhouette width in millimeters")
    parser.add_argument("--thickness", type=float, required=True, help="Extrusion thickness in millimeters")
    parser.add_argument("--out", type=Path, required=True, help="New output directory")
    args = parser.parse_args()
    try:
        build_image(args.input, args.width, args.thickness, args.out)
    except UnidentifiedImageError:
        parser.exit(1, "Image modeling failed: the input is not a readable JPEG, PNG or WebP image\n")
    except (ValueError, OSError, Image.DecompressionBombError) as error:
        parser.exit(1, f"Image modeling failed: {error}\n")
    print(f"Verified silhouette STL and GLB: {args.out.absolute()}")


if __name__ == "__main__":
    main()
