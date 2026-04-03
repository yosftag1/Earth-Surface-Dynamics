from __future__ import annotations

import math
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend import gee_composite as gee
from backend.layout_service import layout_change_from_arrays, predict_layout_from_array

app = FastAPI(title="EarthWatch Dynamic World Layout Backend", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LayoutRequest(BaseModel):
    """1-band CHW or HWC array (Google Dynamic World class 0-8)."""
    image: list
    mask_png: bool = Field(default=False, description="Include base64 RGBA PNG overlay")


class LayoutChangeRequest(BaseModel):
    before_image: list
    after_image: list
    mask_png: bool = True
    include_dense_transition_map: bool = Field(
        default=False,
        description="If true, include full transition_map as nested lists (can be huge)",
    )
    pixel_size_m: float = Field(default=10.0, ge=1.0, le=500.0)


class GeeLayoutRequest(BaseModel):
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    year: int = Field(default=2024, ge=1984, le=2025)
    mask_png: bool = Field(default=False)
    scale_m: float = Field(default=10.0)


class GeeLayoutChangeRequest(BaseModel):
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    year_before: int = Field(default=2016, ge=1984, le=2025)
    year_after: int = Field(default=2024, ge=1984, le=2025)
    mask_png: bool = Field(default=False)
    include_dense_transition_map: bool = Field(default=False)
    scale_m: float = Field(default=10.0)


def _to_image_array(payload: list) -> np.ndarray:
    array = np.asarray(payload, dtype=np.float32)
    return array

def compute_safe_scale(bbox: list[float], max_pixels: float = 120000.0) -> float:
    # bbox = [west, south, east, north]
    d_lat = bbox[3] - bbox[1]
    d_lng = bbox[2] - bbox[0]
    height_m = abs(d_lat * 111320.0)
    width_m = abs(d_lng * 111320.0 * math.cos(bbox[1] * math.pi / 180.0))
    
    total_area_m2 = height_m * width_m
    required_scale = math.sqrt(total_area_m2 / max_pixels)
    
    return max(10.0, required_scale)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/predict/layout")
def predict_layout(request: LayoutRequest) -> dict:
    try:
        image = _to_image_array(request.image)
        return predict_layout_from_array(
            image,
            encode_mask_png=request.mask_png,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/predict/layout-change")
def predict_layout_change(request: LayoutChangeRequest) -> dict:
    try:
        before_image = _to_image_array(request.before_image)
        after_image = _to_image_array(request.after_image)
        return layout_change_from_arrays(
            before_image,
            after_image,
            encode_mask_png=request.mask_png,
            include_dense_transition_map=request.include_dense_transition_map,
            pixel_size_m=request.pixel_size_m,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/gee/layout")
def gee_layout(request: GeeLayoutRequest) -> dict:
    try:
        gee.initialize_earth_engine()
        region = gee.rectangle_from_bbox_mercator(*request.bbox)
        
        safe_scale = compute_safe_scale(request.bbox)
        final_scale = max(safe_scale, request.scale_m or 10.0)

        composite = gee.build_dw_mode_composite(request.year, region)
        stack = gee.sample_composite_to_numpy(composite, region, scale_m=final_scale)
        result = predict_layout_from_array(
            stack,
            encode_mask_png=request.mask_png,
        )
        result["year"] = request.year
        result["bbox"] = request.bbox
        return result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/gee/layout-change")
def gee_layout_change(request: GeeLayoutChangeRequest) -> dict:
    try:
        gee.initialize_earth_engine()
        region = gee.rectangle_from_bbox_mercator(*request.bbox)
        
        # Earth Engine can reduce roughly up to 1 million pixels in seconds securely. 
        safe_scale = compute_safe_scale(request.bbox, max_pixels=150000.0)
        final_scale = max(safe_scale, request.scale_m or 10.0)

        out = gee.get_layout_change_tiles_and_stats(
            bbox_region=region,
            year_before=request.year_before,
            year_after=request.year_after,
            scale_m=final_scale
        )
        
        out["year_before"] = request.year_before
        out["year_after"] = request.year_after
        out["bbox"] = request.bbox
        return out
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class GeeTimeseriesRequest(BaseModel):
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    year_start: int = Field(default=1985, ge=1984, le=2025)
    year_end: int = Field(default=2024, ge=1984, le=2025)
    scale_m: float = Field(default=10.0)

@app.post("/gee/layout-timeseries")
def gee_layout_timeseries(request: GeeTimeseriesRequest) -> list[dict]:
    try:
        gee.initialize_earth_engine()
        region = gee.rectangle_from_bbox_mercator(*request.bbox)
        
        # Determine efficient math scale, bounding the 9-year iterator to ~500k pixels per year max
        safe_scale = compute_safe_scale(request.bbox, max_pixels=150000.0)
        final_scale = max(safe_scale, request.scale_m or 10.0)
        
        # Fast server-side reduction
        return gee.get_dw_timeseries_stats(
            bbox_region=region,
            start_year=request.year_start,
            end_year=request.year_end,
            scale_m=final_scale
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class GeeSatelliteTimeseriesRequest(BaseModel):
    bbox: list[float] = Field(..., min_length=4, max_length=4)
    year_start: int = Field(default=1985, ge=1984, le=2025)
    year_end: int = Field(default=2024, ge=1984, le=2025)
    quality: str = Field(default="high", pattern="^(draft|standard|high)$")
    method: str = Field(default="median", pattern="^(median|mosaic|best)$")
    dataset: str = Field(default="rgb", pattern="^(rgb|ndvi|night|fire|sar)$")


class GeeTimelapseGifRequest(GeeSatelliteTimeseriesRequest):
    add_timestamps: bool = Field(default=True)
    fps: int = Field(default=4, ge=1, le=20)
    gif_dimensions: int = Field(default=1024, ge=256, le=2048)

@app.post("/gee/satellite-timeseries")
def gee_satellite_timeseries(request: GeeSatelliteTimeseriesRequest) -> list[dict]:
    """Return Landsat visual tile URLs for every sampled year in the range.

    quality: "draft" (fast, 500 m stretch scale) | "standard" (200 m) | "high" (100 m)
    Frames are generated in parallel so latency scales sub-linearly with the
    number of years requested.  A standard 40-year range typically resolves in ~20-30 s.
    """
    try:
        gee.initialize_earth_engine()
        region = gee.rectangle_from_bbox_mercator(*request.bbox)
        # --- Automatic Large-Scale Optimizer 🚀 ---
        # Calculate BBox lateral width in meters
        d_lng = request.bbox[2] - request.bbox[0]
        width_m = abs(d_lng * 111320.0 * math.cos(request.bbox[1] * math.pi / 180.0))
        
        # Dial down resolution and thread concurrency natively based on map width
        workers = 12
        if width_m > 100000:       # > 100 km massive region
            request.quality = "draft"
            workers = 3            # Throttle parallel computation to stop Server 429 Overloads
        elif width_m > 40000:      # > 40 km regional
            if request.quality == "high":
                request.quality = "standard"
            workers = 6
        
        return gee.get_satellite_timeseries_urls(
            bbox_region=region,
            start_year=request.year_start,
            end_year=request.year_end,
            quality=request.quality,
            method=request.method,
            dataset=request.dataset,
            return_thumb_urls=True,
            max_workers=workers
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/gee/timelapse-gif")
def gee_timelapse_gif(request: GeeTimelapseGifRequest):
    """Generates and returns an animated GIF of the requested satellite timeline."""
    try:
        gee.initialize_earth_engine()
        region = gee.rectangle_from_bbox_mercator(*request.bbox)
        
        # Automatic Large-Scale Optimizer for GIF Generation
        d_lng = request.bbox[2] - request.bbox[0]
        width_m = abs(d_lng * 111320.0 * 0.7)  # approx cos dict
        
        # To avoid Server Timeout when compiling huge 1536px GIF composites:
        workers = 6
        if width_m > 100000:       # > 100 km massive region
            request.quality = "draft"
            workers = 2            # Extreme API throttling for huge areas
        elif width_m > 40000:
            if request.quality == "high":
                request.quality = "standard"
            workers = 4

        gif_bytes = gee.get_timelapse_gif_bytes(
            bbox_region=region,
            start_year=request.year_start,
            end_year=request.year_end,
            quality=request.quality,
            method=request.method,
            dataset=request.dataset,
            max_workers=workers,
            fps=request.fps,
            add_timestamps=request.add_timestamps,
            dimensions=request.gif_dimensions,
        )
        return Response(content=gif_bytes, media_type="image/gif")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
