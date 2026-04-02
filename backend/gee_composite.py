from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import numpy as np
import yaml

try:
    import ee
    from PIL import ImageDraw, ImageFont
except ImportError as exc:
    ee = None  # type: ignore[assignment]
    _EE_IMPORT_ERROR = exc
else:
    _EE_IMPORT_ERROR = None

# GEE Dynamic World band (1 band containing the class index 0-8)
GEE_BANDS = ["label"]

# Dynamic World Classes:
# 0: water, 1: trees, 2: grass, 3: flooded_vegetation, 4: crops
# 5: shrub_and_scrub, 6: built, 7: bare, 8: snow_and_ice


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_gee_layout_settings() -> dict[str, Any]:
    cfg_path = _repo_root() / "configs" / "layout_model.yaml"
    with open(cfg_path, "r", encoding="utf-8") as f:
        full = yaml.safe_load(f)
    return full["gee"]


def initialize_earth_engine() -> None:
    if ee is None:
        raise RuntimeError(f"earthengine-api is not installed: {_EE_IMPORT_ERROR}")
    key_path = os.environ.get("GEE_SERVICE_ACCOUNT_JSON") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    project = os.environ.get("GEE_PROJECT_ID")
    try:
        ee.Initialize(project=project)
        return
    except Exception:
        pass
    if key_path and Path(key_path).is_file():
        info = json.loads(Path(key_path).read_text(encoding="utf-8"))
        email = info.get("client_email")
        scopes = ['https://www.googleapis.com/auth/earthengine', 'https://www.googleapis.com/auth/cloud-platform']
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_file(key_path).with_scopes(scopes)
        ee.Initialize(creds, project=project or info.get("project_id"))
        return
    raise RuntimeError(
        "Earth Engine failed to initialize. Run `earthengine authenticate` or set "
        "GEE_SERVICE_ACCOUNT_JSON + GEE_PROJECT_ID (or GOOGLE_APPLICATION_CREDENTIALS)."
    )


def build_dw_mode_composite(year: int, region: Any, gee_cfg: dict[str, Any] | None = None) -> Any:
    """Pull the most frequent (mode) land cover class from Dynamic World over the specified season."""
    gee_cfg = gee_cfg or load_gee_layout_settings()
    start = f"{year}-{gee_cfg['season_start_month']:02d}-{gee_cfg['season_start_day']:02d}"
    end = f"{year}-{gee_cfg['season_end_month']:02d}-{gee_cfg['season_end_day']:02d}"
    coll = (
        ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1")
        .filterBounds(region)
        .filterDate(start, end)
        .select("label")
    )
    # The mode() reduces the collection by taking the most frequent class for each pixel
    composite = coll.mode().clip(region)
    return composite


def rectangle_from_bbox_mercator(
    west: float, south: float, east: float, north: float
) -> Any:
    if ee is None:
        raise RuntimeError("earthengine-api is not installed")
    return ee.Geometry.Rectangle([west, south, east, north], proj="EPSG:4326", geodesic=False)


def sample_composite_to_numpy(
    image: Any,
    region: Any,
    scale_m: float | None = None,
    max_dimension: int | None = None,
) -> np.ndarray:
    """Sample all GEE_BANDS to a (10, H, W) float32 array via sampleRectangle."""
    if ee is None:
        raise RuntimeError("earthengine-api is not installed")
    gee_cfg = load_gee_layout_settings()
    scale_m = float(scale_m if scale_m is not None else gee_cfg["export_scale_m"])
    max_dimension = int(max_dimension if max_dimension is not None else gee_cfg["max_export_dimension"])

    # Fix 'Reproject Trap': We provide the desired scale directly to sampleRectangle's proj param
    # to avoid GEE forcing a coarse internal downsample.
    proj = image.projection().atScale(scale_m)
    sampled = image.sampleRectangle(region=region, defaultValue=0, proj=proj)
    info = sampled.getInfo()
    props = info.get("properties") or info
    arrays = []
    for b in GEE_BANDS:
        if b not in props:
            raise KeyError(
                f"Band {b} missing from sampleRectangle feature properties; "
                f"keys={list(props.keys())[:25]}"
            )
        arrays.append(np.array(props[b], dtype=np.float32))
    stack = np.stack(arrays, axis=0)  # [1, H, W] for Dynamic World
    h, w = stack.shape[1], stack.shape[2]
    if max(h, w) > max_dimension:
        raise ValueError(
            f"Requested region is {h}x{w}px (> max_export_dimension={max_dimension}). "
            "Use a smaller bbox or tiling on the client."
        )
    return stack

def get_dw_timeseries_stats(bbox_region: Any, start_year: int = 2016, end_year: int = 2024, scale_m: float = 10.0) -> list[dict[str, Any]]:
    """Query Dynamic World pixel frequency dynamically per year over a region."""
    if ee is None:
        raise RuntimeError("earthengine-api is not installed")
    
    # We map over years on the EE server side to compute frequency histograms
    def process_year(y):
        y_num = ee.Number(y)
        
        # Branch logic: Legacy MODIS vs Dynamic World
        is_legacy = y_num.lt(2016)
        
        # 1. Dynamic World Path
        gee_cfg = load_gee_layout_settings()
        start = ee.Date.fromYMD(y_num, gee_cfg["season_start_month"], gee_cfg["season_start_day"])
        end = ee.Date.fromYMD(y_num, gee_cfg["season_end_month"], gee_cfg["season_end_day"])
        
        dw_img = ee.ImageCollection("GOOGLE/DYNAMICWORLD/V1") \
            .filterBounds(bbox_region) \
            .filterDate(start, end) \
            .select("label") \
            .mode() \
            .clip(bbox_region)
            
        # 2. MODIS Path (Mapped)
        mod_coll = ee.ImageCollection("MODIS/061/MCD12Q1") \
                    .filterDate(start.update(month=1, day=1), end.update(month=12, day=31)) \
                    .select("LC_Type1")
        
        # Check if MODIS collection actually has images for this year
        has_modis = mod_coll.size().gt(0)
        
        # Mapping logic
        igbp = [1, 2, 3, 4, 5, 8, 6, 7, 9, 10, 11, 12, 14, 13, 15, 16, 17]
        dw_map = [1, 1, 1, 1, 1, 1, 5, 5, 5,  2,  3,  4,  4,  6,  8,  7,  0]
        
        mod_mapped = ee.Image(ee.Algorithms.If(
            has_modis,
            mod_coll.first().clip(bbox_region).remap(igbp, dw_map, 7).rename("label"),
            ee.Image.constant(0).mask(0).rename("label") # Empty image if no data
        ))
        
        final_img = ee.Image(ee.Algorithms.If(is_legacy, mod_mapped, dw_img))
            
        # Reducer creates dictionary of { class_str: pixel_count_float }
        # Force much coarser scale (100m+) for charts to maintain speed across huge regions
        # Lower resolution floor from 100m to 30m for higher-precision metrics
        chart_scale = ee.Number(scale_m).max(30.0)
        # For legacy modis, use 500m scale for absolute speed
        yr_scale = ee.Number(ee.Algorithms.If(is_legacy, 500.0, chart_scale))
        
        stats = final_img.reduceRegion(
            reducer=ee.Reducer.frequencyHistogram(),
            geometry=bbox_region,
            scale=yr_scale,
            maxPixels=1e13,
            bestEffort=True
        ).get("label")
        
        return ee.Feature(None, {"year": y_num, "stats": stats, "is_legacy": is_legacy, "scale": yr_scale})

    # Speed Upgrade: Sequence 1985-2010 by 5-year gaps. 2011-2024 annually.
    s_yr = int(start_year)
    e_yr = int(end_year)
    
    years_py = []
    # 5 year steps for old history
    curr = s_yr
    while curr <= min(2010, e_yr):
        years_py.append(curr)
        if curr + 5 > 2010: 
            break
        curr += 5
    # Annual steps for modern history
    curr_modern = max(2011, s_yr)
    while curr_modern <= e_yr:
        years_py.append(curr_modern)
        curr_modern += 1
        
    years = ee.List(sorted(list(set(years_py))))
    results = ee.FeatureCollection(years.map(process_year)).getInfo()
    
    # Parse the EE FeatureCollection back into a list of cleanly formatted python dicts
    out_timeline = []
    # Dynamic world typical labels
    dw_labels = ["water", "trees", "grass", "flooded_vegetation", "crops", "shrub_and_scrub", "built", "bare", "snow_and_ice"]
    
    if "features" in results:
        for f in results["features"]:
            props = f.get("properties", {})
            yr = int(props.get("year", 0))
            raw_stats = props.get("stats", {})
            is_leg = props.get("is_legacy", False)
            if not raw_stats:
                continue
            
            # Area math
            curr_scale = float(props.get("scale", 100.0))
            pixel_area_km2 = (curr_scale * curr_scale) / 1_000_000.0

            # Reconstruct class areas. Keys in EE dict are strings like "1", "6".
            year_data = {"year": yr, "is_legacy": bool(is_leg)}
            for cls_idx in range(9):
                count = float(raw_stats.get(str(cls_idx), 0.0))
                area_km2 = count * pixel_area_km2
                year_data[dw_labels[cls_idx]] = area_km2
                
            out_timeline.append(year_data)
            
    
    return sorted(out_timeline, key=lambda x: x["year"])

def get_modis_landcover(year: int, region: Any) -> Any:
    """Load MODIS LC and remap to Dynamic World 9-class schema."""
    # MODIS 500m starts in 2001
    yr = max(2001, min(year, 2022))
    coll = ee.ImageCollection("MODIS/061/MCD12Q1") \
            .filterDate(f"{yr}-01-01", f"{yr}-12-31") \
            .select("LC_Type1")
            
    # IGBP to DW Mapping:
    igbp = [1, 2, 3, 4, 5, 8, 6, 7, 9, 10, 11, 12, 14, 13, 15, 16, 17]
    dw   = [1, 1, 1, 1, 1, 1, 5, 5, 5,  2,  3,  4,  4,  6,  8,  7,  0]
    
    return ee.Image(ee.Algorithms.If(
        coll.size().gt(0),
        coll.first().clip(region).remap(igbp, dw, 7).rename("label"),
        ee.Image.constant(0).mask(0).rename("label")
    ))

def _mask_ls_sr_clouds(image: Any) -> Any:
    """Mask clouds/shadows in Landsat C2 L2 using the QA_PIXEL bitmask."""
    qa = image.select('QA_PIXEL')
    # Bits: 1: Dilated Cloud, 2: Cirrus, 3: Cloud, 4: Cloud Shadow
    mask = qa.bitwiseAnd(1 << 1).eq(0) \
        .And(qa.bitwiseAnd(1 << 2).eq(0)) \
        .And(qa.bitwiseAnd(1 << 3).eq(0)) \
        .And(qa.bitwiseAnd(1 << 4).eq(0))
    return image.updateMask(mask)


def _mask_s2_sr_clouds(image: Any) -> Any:
    """Mask clouds in Sentinel-2 SR using the QA60 bitmask."""
    qa = image.select('QA60')
    cloud_bit = 1 << 10
    cirrus_bit = 1 << 11
    mask = qa.bitwiseAnd(cloud_bit).eq(0).And(qa.bitwiseAnd(cirrus_bit).eq(0))
    return image.updateMask(mask)


def get_satellite_visual_map(year: int, region: Any, percentile_scale: float = 30.0, method: str = "median", return_thumb_url: bool = False, dimensions: int = 1024) -> str:
    """Generate a high-res (10-30m) visual tile URL using Sentinel-2 or Landsat."""
    start = f"{year}-01-01"
    end   = f"{year}-12-31"

    def _soften_rgb(img: Any, amount: float = 0.14) -> Any:
        """Apply a mild anti-sharpen blend to reduce harsh edges without losing structure."""
        soft = img.focal_mean(radius=1, units='pixels')
        return img.multiply(1.0 - amount).add(soft.multiply(amount)).clamp(0, 1)

    # UHD Mode detection: percentile_scale of <= 35m (High/Standard Quality) triggers the Greenest-Pixel Mosaic
    is_high = (percentile_scale <= 35.0)
    if year >= 2016:
        native_scale = 10.0
        coll = (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
                .filterBounds(region)
                .filterDate(start, end))
        
        strict = coll.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
        final_coll = ee.ImageCollection(ee.Algorithms.If(
            strict.size().gt(0),
            strict,
            coll.sort('CLOUDY_PIXEL_PERCENTAGE').limit(5)
        )).map(_mask_s2_sr_clouds)

        if method == "mosaic" or (method == "median" and is_high):
            raw = (final_coll.map(lambda img: img.addBands(img.normalizedDifference(['B8', 'B4']).rename('NDVI')))
                   .qualityMosaic('NDVI').clip(region))
        elif method == "best":
            raw = final_coll.sort('CLOUDY_PIXEL_PERCENTAGE').first().clip(region)
        else:
            raw = final_coll.median().clip(region)

        bands = ["B4", "B3", "B2"]
        scaled = raw.select(bands).divide(10000.0).clamp(0.0, 1.0)
        
        data_mask = scaled.mask().reduce(ee.Reducer.min())
        masked_scaled = scaled.updateMask(data_mask)

        # Determine a safe scaling footprint that computes fast without hitting sub-pixel outlier anomalies
        safe_stat_scale = max(percentile_scale, 300.0)

        stats = masked_scaled.reduceRegion(
            reducer=ee.Reducer.percentile([5, 95]),
            geometry=region,
            scale=safe_stat_scale,
            maxPixels=1e7,
            bestEffort=True,
        ).getInfo() or {}

        mn = [max(0.0,  stats.get(f"{b}_p5",  0.02)) for b in bands]
        mx = [min(0.95, stats.get(f"{b}_p95", 0.40)) for b in bands]
        mx = [max(mx[i], mn[i] + 0.05) for i in range(len(bands))]

        viz = {"bands": bands, "min": mn, "max": mx, "gamma": 1.4}
        final_img = _soften_rgb(scaled.clip(region), amount=0.12)
        if return_thumb_url:
            return final_img.getThumbURL({"dimensions": dimensions, "region": region, "format": "png", **viz})
        return final_img.getMapId(viz)["tile_fetcher"].url_format

    else:
        # 🟡 Landsat (1985-2015) - TOA Pipeline with 15m Pan-Sharpening Gap Fill
        native_scale = 30.0
        has_pan = False
        is_landsat7 = (1999 <= year < 2013)
        is_legacy_landsat = (year < 2013)
        if year >= 2013:
            s_coll_name = "LANDSAT/LC08/C02/T1_TOA"
            bands = ["B4", "B3", "B2"]
            pan_band = "B8"
            has_pan = True
        elif is_landsat7:
            s_coll_name = "LANDSAT/LE07/C02/T1_TOA"
            bands = ["B3", "B2", "B1"]
            pan_band = "B8"
            has_pan = True
        else:
            s_coll_name = "LANDSAT/LT05/C02/T1_TOA"
            bands = ["B3", "B2", "B1"]

        def _mask_ls_toa_clouds(img):
            scored = ee.Algorithms.Landsat.simpleCloudScore(img)
            mask = scored.select(['cloud']).lt(20)
            return img.updateMask(mask)

        # Older sensors often need a wider date window to avoid masked holes in sparse scenes.
        if is_legacy_landsat:
            ls_start = f"{max(1984, year - 1)}-01-01"
            ls_end = f"{min(2025, year + 1)}-12-31"
            cloud_cover_max = 35
            fallback_limit = 16
        else:
            ls_start = start
            ls_end = end
            cloud_cover_max = 30
            fallback_limit = 8

        full_coll = ee.ImageCollection(s_coll_name).filterBounds(region).filterDate(ls_start, ls_end)
        strict = full_coll.filter(ee.Filter.lt('CLOUD_COVER', cloud_cover_max))
        final_coll = ee.ImageCollection(ee.Algorithms.If(
            strict.size().gt(0),
            strict,
            full_coll.sort('CLOUD_COVER').limit(fallback_limit)
        )).map(_mask_ls_toa_clouds)

        # Always median for Landsat to perfectly wipe out SLC-off sensor missing pixels
        best_img = final_coll.median().clip(region)

        # Fill only masked pixels from local neighbors to reduce legacy striping/holes.
        if is_legacy_landsat:
            best_img = best_img.unmask(best_img.focal_median(radius=1, units='pixels'))

        rgb = best_img.select(bands)

        # Establish safe bounding scale for Landsat stats
        safe_stat_scale = max(percentile_scale, 300.0)

        # Stretch RGB
        stats = rgb.reduceRegion(
            reducer=ee.Reducer.percentile([2, 98]),
            geometry=region,
            scale=safe_stat_scale,
            maxPixels=1e7,
            bestEffort=True
        ).getInfo() or {}

        mins = [max(0.0, stats.get(f"{b}_p2", 0.0)) for b in bands]
        maxs = [max(mins[i] + 0.1, stats.get(f"{b}_p98", 0.3)) for i, b in enumerate(bands)]
        gamma_landsat = 1.1 if is_landsat7 else 1.2
        sat_boost = 1.15 if is_landsat7 else 1.3
        rgb_stretched = rgb.visualize(bands=bands, min=mins, max=maxs, gamma=gamma_landsat).divide(255.0)

        if has_pan and is_high:
            # Inject 15m structural detail
            pan = best_img.select(pan_band)
            pan_stats = pan.reduceRegion(
                reducer=ee.Reducer.percentile([2, 98]),
                geometry=region,
                scale=safe_stat_scale / 2.0,
                maxPixels=1e7,
                bestEffort=True
            ).getInfo() or {}

            p_min = pan_stats.get(f"{pan_band}_p2", 0.0)
            p_max = pan_stats.get(f"{pan_band}_p98", 0.4)
            pan_stretched = pan.clamp(p_min, p_max).subtract(p_min).divide(p_max - p_min)

            hsv = rgb_stretched.rgbToHsv()
            sharpened = ee.Image.cat([
                hsv.select('hue'),
                hsv.select('saturation').multiply(sat_boost).clamp(0, 1),
                pan_stretched
            ]).hsvToRgb()

            final_img = _soften_rgb(sharpened.clip(region), amount=0.16)
            if return_thumb_url:
                return final_img.getThumbURL({"dimensions": dimensions, "region": region, "format": "png", "min": 0, "max": 1, "bands": ["red", "green", "blue"]})
            return final_img.getMapId({"min": 0, "max": 1, "bands": ["red", "green", "blue"]})["tile_fetcher"].url_format
        else:
            final_img = _soften_rgb(rgb_stretched.clip(region), amount=0.14)
            if return_thumb_url:
                return final_img.getThumbURL({"dimensions": dimensions, "region": region, "format": "png", "min": 0, "max": 1, "bands": ["vis-red", "vis-green", "vis-blue"]})
            return final_img.getMapId({"min": 0, "max": 1, "bands": ["vis-red", "vis-green", "vis-blue"]})["tile_fetcher"].url_format


def get_satellite_timeseries_urls(
    bbox_region: Any,
    start_year: int = 1985,
    end_year: int = 2024,
    max_workers: int = 12,
    quality: str = "high",
    method: str = "median",
    dataset: str = "rgb",
    return_thumb_urls: bool = False,
    dimensions: int = 1024,
) -> list[dict[str, Any]]:
    """Return visual tile URLs for a range of years using adaptive sampling.

    quality controls the per-scene percentile stretch precision:
      "draft"    → 500 m  (fastest, ~15 s for 40 yr range)
      "standard" → 200 m  (default, good balance)
      "high"     → 100 m  (sharpest stretch, ~30–40 s for 40 yr range)

    Sampling strategy:
      1985-1999  → every 5 years
      2000-2012  → every 2 years
      2013-2024  → every year
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not installed")

    # UHD Scales: Draft (100m), Standard (30m), High (10m)
    scale_map = {"draft": 100.0, "standard": 30.0, "high": 10.0}
    pct_scale = scale_map.get(quality, 30.0)

    # Build the year list with adaptive spacing
    years: list[int] = []
    y = int(start_year)
    e = int(end_year)
    # Annual spacing guaranteed!
    while y <= e:
        years.append(y)
        y += 1


    def _fetch(year: int) -> dict[str, Any] | None:
        try:
            if dataset == "ndvi":
                img = ee.ImageCollection("MODIS/061/MOD13Q1").filterDate(f"{year}-06-01", f"{year}-08-31").median().select('NDVI')
                styled = img.visualize(min=0, max=8000, palette=['#FFFFFF', '#CE7E45', '#DF923D', '#F1B555', '#FCD163', '#99B718', '#74A901', '#66A000', '#529400', '#3E8601', '#207401', '#056201', '#004C00', '#023B01', '#012E01', '#011D01', '#011301']).clip(bbox_region)
                url = styled.getThumbURL({"dimensions": dimensions, "region": bbox_region, "format": "png"}) if return_thumb_urls else styled.getMapId()["tile_fetcher"].url_format
            elif dataset == "night":
                if year < 2012: return {"year": year, "tile_url": None}
                # Composite with Black Background
                bg = ee.Image(0).visualize(palette=['000000']).clip(bbox_region)
                img = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG").filterDate(f"{year}-01-01", f"{year}-12-31").median().select('avg_rad')
                styled = img.visualize(min=0, max=40, palette=['000000', '1E4D2B', 'FDB813', 'FFFFFF'])
                final = ee.ImageCollection([bg, styled]).mosaic().clip(bbox_region)
                url = final.getThumbURL({"dimensions": dimensions, "region": bbox_region, "format": "png"}) if return_thumb_urls else final.getMapId()["tile_fetcher"].url_format
            elif dataset == "water":
                # JRC Occurrence is static. JRC YearlyHistory is dynamic but max date 2021.
                # Let's use GlobalSurfaceWater Occurrence for visual impact as requested (static map fallback, time-lapse renders same water)
                img = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select('occurrence')
                styled = img.visualize(min=0, max=100, palette=['#0000ff', '#00ffff']).clip(bbox_region)
                url = styled.getThumbURL({"dimensions": dimensions, "region": bbox_region, "format": "png"}) if return_thumb_urls else styled.getMapId()["tile_fetcher"].url_format
            elif dataset == "fire":
                if year < 2000: return {"year": year, "tile_url": None}
                # Max thermal signatures over summer months
                img = ee.ImageCollection("FIRMS").filterDate(f"{year}-06-01", f"{year}-11-30").select('T21').max()
                styled = img.visualize(min=325, max=400, palette=['red', 'orange', 'yellow']).clip(bbox_region)
                url = styled.getThumbURL({"dimensions": dimensions, "region": bbox_region, "format": "png"}) if return_thumb_urls else styled.getMapId()["tile_fetcher"].url_format
            elif dataset == "sar":
                if year < 2015: return {"year": year, "tile_url": None}
                img = ee.ImageCollection("COPERNICUS/S1_GRD").filterBounds(bbox_region).filterDate(f"{year}-01-01", f"{year}-12-31").filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV')).filter(ee.Filter.eq('instrumentMode', 'IW')).select('VV').median()
                styled = img.visualize(min=-20, max=0, palette=['000000', 'FFFFFF']).clip(bbox_region)
                url = styled.getThumbURL({"dimensions": dimensions, "region": bbox_region, "format": "png"}) if return_thumb_urls else styled.getMapId()["tile_fetcher"].url_format
            else:
                url = get_satellite_visual_map(year, bbox_region, percentile_scale=pct_scale, method=method, return_thumb_url=return_thumb_urls)
            return {"year": year, "tile_url": url}
        except Exception as exc:  # noqa: BLE001
            return {"year": year, "tile_url": None, "error": str(exc)}

    results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch, yr): yr for yr in years}
        for fut in as_completed(futures):
            res = fut.result()
            if res and res.get("tile_url"):
                results.append({"year": res["year"], "tile_url": res["tile_url"]})

    return sorted(results, key=lambda x: x["year"])


def get_timelapse_gif_bytes(
    bbox_region: Any,
    start_year: int = 1985,
    end_year: int = 2024,
    max_workers: int = 12,
    quality: str = "high",
    method: str = "median",
    dataset: str = "rgb",
    fps: int = 4,
    add_timestamps: bool = True,
    dimensions: int = 1024,
) -> bytes:
    results = get_satellite_timeseries_urls(
        bbox_region,
        start_year,
        end_year,
        max_workers,
        quality,
        method,
        dataset,
        return_thumb_urls=True,
        dimensions=dimensions,
    )
    import io
    import requests
    from PIL import Image, ImageDraw, ImageFont
    from concurrent.futures import ThreadPoolExecutor

    def _stamp_year(image: Image.Image, year: int) -> Image.Image:
        img = image.convert("RGB")
        draw = ImageDraw.Draw(img)
        text = str(year)

        w, h = img.size
        font_size = max(18, int(min(w, h) * 0.06))
        try:
            font = ImageFont.truetype("DejaVuSans-Bold.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()

        text_bbox = draw.textbbox((0, 0), text, font=font)
        text_w = text_bbox[2] - text_bbox[0]
        text_h = text_bbox[3] - text_bbox[1]

        pad_x = max(12, int(font_size * 0.35))
        pad_y = max(8, int(font_size * 0.25))
        box_w = text_w + pad_x * 2
        box_h = text_h + pad_y * 2

        x0 = 14
        y0 = 14
        x1 = x0 + box_w
        y1 = y0 + box_h

        draw.rounded_rectangle(
            [(x0, y0), (x1, y1)],
            radius=max(8, int(font_size * 0.25)),
            fill=(0, 0, 0, 165),
            outline=(255, 255, 255, 210),
            width=2,
        )
        draw.text((x0 + pad_x, y0 + pad_y), text, font=font, fill=(255, 255, 255, 255))
        return img

    def _download(res: dict):
        url = res.get("tile_url")
        if not url: return None
        try:
            r = requests.get(url, timeout=25)
            if r.status_code == 200:
                frame_img = Image.open(io.BytesIO(r.content)).convert("RGB")
                if add_timestamps:
                    frame_img = _stamp_year(frame_img, int(res["year"]))
                return {"year": res["year"], "img": frame_img}
        except:
            pass
        return None

    valid_frames = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for val in pool.map(_download, results):
            if val:
                valid_frames.append(val)

    if not valid_frames:
        raise RuntimeError("No frames could be downloaded for GIF creation.")

    valid_frames.sort(key=lambda x: x["year"])
    imgs = [v["img"] for v in valid_frames]

    out = io.BytesIO()
    dur = int(1000 / fps)
    imgs[0].save(out, format='GIF', save_all=True, append_images=imgs[1:], duration=dur, loop=0)
    return out.getvalue()

def get_layout_change_tiles_and_stats(bbox_region: Any, year_before: int, year_after: int, scale_m: float = 10.0) -> dict[str, Any]:
    """Generates EE MapId Tile URLs and computes the Area change transitioning math heavily on the EE side."""
    if ee is None:
        raise RuntimeError("earthengine-api is not installed")
        
    palette = ["419bdf", "397d49", "88b053", "7a87c6", "e49635", "dfc35a", "c4281b", "a59b8f", "b39fe1"]
    dw_labels = ["water", "trees", "grass", "flooded_vegetation", "crops", "shrub_and_scrub", "built", "bare", "snow_and_ice"]
    viz = {"min": 0, "max": 8, "palette": palette}
    
    # 1. Image Selection (Dynamic World vs Legacy MODIS/Landsat)
    # Visual (Landsat) URLs are generated for EVERY year regardless of DW availability
    def get_img_for_year(y):
        if y >= 2016:
            return build_dw_mode_composite(y, bbox_region)
        else:
            return get_modis_landcover(y, bbox_region)

    before = get_img_for_year(year_before)
    after  = get_img_for_year(year_after)

    # Determine safe internal scale first; this controls both stats runtime and
    # (for very large areas) coarser visual generation speed.
    def compute_internal_scale(region: Any, requested_scale_m: float) -> float:
        # Rough degree^2 area estimate from bbox corners (good enough for scale tiering).
        coords = region.coordinates().get(0).getInfo()
        w = coords[2][0] - coords[0][0]
        h = coords[2][1] - coords[0][1]
        area_deg2 = abs(w * h)

        # Coarser tiers for larger requests to avoid long reduceRegion calls.
        if area_deg2 > 5.0:      # continental-ish
            tier_scale = 500.0
        elif area_deg2 > 1.5:    # very large multi-region
            tier_scale = 300.0
        elif area_deg2 > 0.5:    # large metro/state scale
            tier_scale = 180.0
        elif area_deg2 > 0.1:    # city/region scale
            tier_scale = 90.0
        else:
            tier_scale = 30.0

        # Never go finer than caller-requested adaptive scale.
        return max(float(requested_scale_m), tier_scale)

    calc_scale = compute_internal_scale(bbox_region, scale_m) if (year_before >= 2016 and year_after >= 2016) else 250.0

    # Always generate Landsat visual tiles (parallel for speed)
    # For large-area comparisons, avoid expensive high-res contrast stats.
    visual_scale = max(30.0, min(calc_scale, 300.0))
    def _visual(y):
        try:
            return get_satellite_visual_map(y, bbox_region, percentile_scale=visual_scale)
        except Exception:  # noqa: BLE001
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut_b = pool.submit(_visual, year_before)
        fut_a = pool.submit(_visual, year_after)
        visual_url_before = fut_b.result()
        visual_url_after  = fut_a.result()
    
    # 2. Extract standard X/Y/Z Map Tile URLs
    url_before = before.getMapId(viz)["tile_fetcher"].url_format
    url_after = after.getMapId(viz)["tile_fetcher"].url_format
    
    # 3. Offload massive transition math directly to GEE server infrastructure
    # Combine classes safely mapping c1->c2  => e.g. Trees->Built becomes 16
    combo = before.multiply(10).add(after).rename("transition")
    
    stats_raw = combo.reduceRegion(
        reducer=ee.Reducer.frequencyHistogram(),
        geometry=bbox_region,
        scale=calc_scale,
        maxPixels=1e13,
        bestEffort=True
    ).get("transition").getInfo()
    
    # Parse the frequency dict natively into structured area
    # Scale calculation for area math
    eff_pixel_area_km2 = (calc_scale * calc_scale) / 1_000_000.0

    area_km2_before = {lab: 0.0 for lab in dw_labels}
    area_km2_after = {lab: 0.0 for lab in dw_labels}
    
    if stats_raw:
        for trans_code, pixel_count in stats_raw.items():
            trans_code_int = int(trans_code)
            c1 = trans_code_int // 10
            c2 = trans_code_int % 10
            
            if 0 <= c1 < 9 and 0 <= c2 < 9:
                area_km2 = pixel_count * eff_pixel_area_km2
                area_km2_before[dw_labels[c1]] += area_km2
                area_km2_after[dw_labels[c2]] += area_km2

    # Build a transition-specific diff tile using top transition classes in this AOI.
    # Example legend entries: Trees -> Crops, Trees -> Built, etc.
    transition_candidates: list[tuple[int, float]] = []
    if stats_raw:
        for trans_code, pixel_count in stats_raw.items():
            trans_code_int = int(trans_code)
            c1 = trans_code_int // 10
            c2 = trans_code_int % 10
            if not (0 <= c1 < 9 and 0 <= c2 < 9):
                continue
            if c1 == c2:
                continue
            area_km2 = float(pixel_count) * eff_pixel_area_km2
            if area_km2 <= 0:
                continue
            transition_candidates.append((trans_code_int, area_km2))

    transition_candidates.sort(key=lambda x: x[1], reverse=True)
    top_transitions = transition_candidates[:8]

    transition_palette = [
        "ff5252",  # red
        "ff9800",  # orange
        "ffc107",  # amber
        "8bc34a",  # light green
        "00bcd4",  # cyan
        "42a5f5",  # blue
        "7e57c2",  # purple
        "ec407a",  # pink
    ]

    if top_transitions:
        transition_codes = [code for code, _ in top_transitions]
        transition_ids = list(range(1, len(transition_codes) + 1))
        transition_img = combo.remap(transition_codes, transition_ids, 0).rename("transition_key")
        transition_img = transition_img.updateMask(transition_img.neq(0))
        diff_viz = {
            "min": 1,
            "max": len(transition_ids),
            "palette": transition_palette[:len(transition_ids)],
        }
        url_diff = transition_img.getMapId(diff_viz)["tile_fetcher"].url_format
        diff_legend = []
        for idx, (code, area_km2) in enumerate(top_transitions):
            c1 = code // 10
            c2 = code % 10
            diff_legend.append(
                {
                    "key": f"{dw_labels[c1]}_to_{dw_labels[c2]}",
                    "label": f"{dw_labels[c1].replace('_', ' ').title()} -> {dw_labels[c2].replace('_', ' ').title()}",
                    "color": f"#{transition_palette[idx]}",
                    "area_km2": area_km2,
                }
            )
    else:
        # Fallback: if there are no changed pixels, keep a transparent/empty diff map contract.
        diff_mask = before.neq(after)
        diff_img = diff_mask.updateMask(diff_mask)
        diff_viz = {"min": 1, "max": 1, "palette": ["ff0000"]}
        url_diff = diff_img.getMapId(diff_viz)["tile_fetcher"].url_format
        diff_legend = []
                
    return {
        "tile_url_before": url_before,
        "tile_url_after": url_after,
        "tile_url_diff": url_diff,
        "diff_legend": diff_legend,
        "visual_url_before": visual_url_before,
        "visual_url_after": visual_url_after,
        "effective_scale_m": calc_scale,
        "change_summary": {
            "area_km2_by_class_before": area_km2_before,
            "area_km2_by_class_after": area_km2_after,
        }
    }
