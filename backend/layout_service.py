from __future__ import annotations

import base64
import io
import numpy as np
from typing import Any
from PIL import Image

from backend.mask_compare import compare_layout_masks

# Layout configuration for Google Dynamic World classes (0-8)
LAYOUT_CONFIG = {
    "labels": [
        "Water", "Trees", "Grass", "Crops", "Built", 
        "Bare", "Snow", "Clouds", "Flooded"
    ],
    "label_colors_hex": [
        "#419bdf",  # Water - blue
        "#397d49",  # Trees - dark green
        "#88b053",  # Grass - light green
        "#e6ce55",  # Crops - yellow
        "#d52b1f",  # Built - red
        "#d2b48c",  # Bare - tan
        "#f0f0f0",  # Snow - white
        "#e0e0e0",  # Clouds - light gray
        "#4db8ff",  # Flooded - cyan blue
    ]
}


def rgba_overlay(class_map: np.ndarray, hex_colors: list[str], alpha: float = 0.55) -> Image.Image:
    """RGBA image HxW for overlay (class id → color)."""
    h, w = class_map.shape
    rgb = np.zeros((h, w, 3), dtype=np.uint8)
    for c, hx in enumerate(hex_colors):
        # Handle colors with inline comments e.g. '#419bdf'
        hx = hx.split()[0].lstrip("#")
        r, g, b = int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16)
        m = class_map == c
        rgb[m] = [r, g, b]
    a = np.full((h, w), int(alpha * 255), dtype=np.uint8)
    rgba = np.dstack([rgb, a])
    return Image.fromarray(rgba, mode="RGBA")


def encode_png_rgba(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.standard_b64encode(buf.getvalue()).decode("ascii")


def predict_layout_from_array(
    image: np.ndarray,
    *,
    encode_mask_png: bool = False,
) -> dict[str, Any]:
    """
    Process a Google Dynamic World class map array.
    The 'image' array should be shape [1, H, W] or [H, W] containing indices 0-8.
    """
    # Strip channel dimension if present
    if image.ndim == 3 and image.shape[0] == 1:
        cmap = image[0].astype(np.int32)
    elif image.ndim == 2:
        cmap = image.astype(np.int32)
    else:
        raise ValueError(f"Expected array shape [1, H, W] or [H, W], got {image.shape}")

    result: dict[str, Any] = {
        "height": int(cmap.shape[0]),
        "width": int(cmap.shape[1]),
        "class_map": cmap.tolist(),
        "labels": LAYOUT_CONFIG["labels"],
        "label_colors_hex": LAYOUT_CONFIG["label_colors_hex"],
        "model": "Google_Dynamic_World_V1",
    }
    
    if encode_mask_png:
        rgba = rgba_overlay(cmap, result["label_colors_hex"])
        result["mask_png_base64"] = encode_png_rgba(rgba)
        
    return result


def layout_change_from_arrays(
    before: np.ndarray,
    after: np.ndarray,
    *,
    pixel_size_m: float = 10.0,
    encode_mask_png: bool = True,
    include_dense_transition_map: bool = False,
) -> dict[str, Any]:
    
    a = predict_layout_from_array(before, encode_mask_png=encode_mask_png)
    b = predict_layout_from_array(after, encode_mask_png=encode_mask_png)
    
    ma = np.array(a["class_map"], dtype=np.int32)
    mb = np.array(b["class_map"], dtype=np.int32)
    
    stats = compare_layout_masks(
        ma,
        mb,
        LAYOUT_CONFIG["labels"],
        pixel_size_m=pixel_size_m,
        include_dense_transition_map=include_dense_transition_map,
    )
    
    out: dict[str, Any] = {
        "before": {k: v for k, v in a.items() if k != "class_map"},
        "after": {k: v for k, v in b.items() if k != "class_map"},
        "before_class_map": a["class_map"],
        "after_class_map": b["class_map"],
        "change_summary": stats,
        "labels": LAYOUT_CONFIG["labels"],
        "label_colors_hex": LAYOUT_CONFIG["label_colors_hex"],
    }
    
    if encode_mask_png:
        # Highlight pixels where class differs
        # Dynamic World 'built' class is typically red/magenta tint for diff
        diff = (ma != mb).astype(np.uint8) * 255
        rgba = np.zeros((diff.shape[0], diff.shape[1], 4), dtype=np.uint8)
        rgba[:, :, 0] = diff  # Red channel
        rgba[:, :, 3] = diff  # Alpha channel
        out["diff_mask_png_base64"] = encode_png_rgba(Image.fromarray(rgba, mode="RGBA"))
        
    return out
