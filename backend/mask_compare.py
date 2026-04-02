from __future__ import annotations

from typing import Any

import numpy as np


def compare_layout_masks(
    mask_before: np.ndarray,
    mask_after: np.ndarray,
    labels: list[str],
    pixel_size_m: float = 10.0,
    *,
    include_dense_transition_map: bool = False,
) -> dict[str, Any]:
    """Summarize how a per-pixel class map changed between two dates."""
    if mask_before.shape != mask_after.shape:
        raise ValueError("Masks must share shape")
    if mask_before.dtype != np.int64 and mask_before.dtype != np.int32:
        mask_before = mask_before.astype(np.int64)
    if mask_after.dtype != np.int64 and mask_after.dtype != np.int32:
        mask_after = mask_after.astype(np.int64)

    nclass = len(labels)
    flat_a = mask_before.ravel()
    flat_b = mask_after.ravel()
    changed = flat_a != flat_b
    pixel_area_m2 = float(pixel_size_m) ** 2
    total = flat_a.size
    changed_n = int(changed.sum())

    transitions: dict[str, int] = {}
    for c1 in range(nclass):
        for c2 in range(nclass):
            n = int(((flat_a == c1) & (flat_b == c2)).sum())
            if n == 0:
                continue
            key = f"{labels[c1]}->{labels[c2]}"
            transitions[key] = n

    area_before: dict[str, float] = {}
    area_after: dict[str, float] = {}
    for c, name in enumerate(labels):
        area_before[name] = float((flat_a == c).sum()) * pixel_area_m2 / 1_000_000.0
        area_after[name] = float((flat_b == c).sum()) * pixel_area_m2 / 1_000_000.0

    out: dict[str, Any] = {
        "total_pixels": total,
        "changed_pixels": changed_n,
        "changed_fraction": changed_n / max(1, total),
        "changed_area_km2": changed_n * pixel_area_m2 / 1_000_000.0,
        "area_km2_by_class_before": area_before,
        "area_km2_by_class_after": area_after,
        "transitions_pixel_count": transitions,
        "transition_map_encoding": "before_class * num_classes + after_class",
        "num_classes": nclass,
    }
    if include_dense_transition_map:
        transition_map = (mask_before.astype(np.int64) * nclass + mask_after.astype(np.int64)).astype(
            np.int32
        )
        out["transition_map"] = transition_map.tolist()
    return out
