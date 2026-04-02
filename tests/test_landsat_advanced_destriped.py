import sys
import os
import requests
from pathlib import Path

sys.path.append(os.getcwd())

from backend.gee_composite import initialize_earth_engine, rectangle_from_bbox_mercator, ee

def save_pan_sharpened_destriped(year: int, bbox: list, out_file: str):
    initialize_earth_engine()
    region = rectangle_from_bbox_mercator(*bbox)
    
    start = f"{year}-01-01"
    end   = f"{year}-12-31"

    if year >= 1999 and year < 2013:
        coll_name = "LANDSAT/LE07/C02/T1_TOA"
        rgb_bands = ["B3", "B2", "B1"]
        pan_band = "B8"
        nir_band = "B4"
    else:
        print("This specific script targets Landsat 7 (1999-2012) for 15m pan-sharpening.")
        return

    # Add cloud score and mask clouds loosely
    def mask_clouds_toa(img):
        scored = ee.Algorithms.Landsat.simpleCloudScore(img)
        # BQA has cirrus/cloud flags but simpleCloudScore is easy
        mask = scored.select(['cloud']).lt(20)
        return img.updateMask(mask)

    def add_ndvi(img):
        return img.addBands(img.normalizedDifference([nir_band, rgb_bands[0]]).rename('NDVI'))

    coll = ee.ImageCollection(coll_name).filterBounds(region).filterDate(start, end)
    
    # Apply cloud mask and compute NDVI for quality Mosaic
    clean_coll = coll.map(mask_clouds_toa).map(add_ndvi)
    
    # We use median() or qualityMosaic. Median is best for removing SLC stripes.
    # Because qualityMosaic might pick a cloud-edge pixel if it has high NDVI, median smooths it.
    best_img = clean_coll.median().clip(region)

    rgb = best_img.select(rgb_bands)
    pan = best_img.select(pan_band)

    stats = rgb.reduceRegion(
        reducer=ee.Reducer.percentile([2, 98]),
        geometry=region,
        scale=30,
        maxPixels=1e9,
        bestEffort=True
    )
    
    def min_max_stretch(img):
        stat_dict = stats.getInfo() or {}
        mins = [max(0.0, stat_dict.get(f"{b}_p2", 0.0)) for b in rgb_bands]
        maxs = [max(m + 0.1, stat_dict.get(f"{b}_p98", 0.3)) for b,m in zip(rgb_bands, mins)]
        return img.visualize(bands=rgb_bands, min=mins, max=maxs).divide(255.0)

    rgb_stretched = min_max_stretch(rgb)

    hsv = rgb_stretched.rgbToHsv()
    
    pan_stats = pan.reduceRegion(
        reducer=ee.Reducer.percentile([2, 98]),
        geometry=region,
        scale=15,
        maxPixels=1e9,
        bestEffort=True
    ).getInfo() or {}
    pan_min = pan_stats.get(f"{pan_band}_p2", 0.0)
    pan_max = pan_stats.get(f"{pan_band}_p98", 0.4)
    pan_stretched = pan.clamp(pan_min, pan_max).subtract(pan_min).divide(pan_max - pan_min)

    sharpened = ee.Image.cat([
        hsv.select('hue'),
        hsv.select('saturation').multiply(1.3).clamp(0, 1),
        pan_stretched
    ]).hsvToRgb()

    native_proj = pan.projection()
    final_img = sharpened.setDefaultProjection(crs=native_proj, scale=15.0).clip(region)

    thumb_url = final_img.getThumbURL({
        "dimensions": 1024,
        "region": region,
        "format": "png",
        "min": 0,
        "max": 1,
        "bands": ["red", "green", "blue"]
    })
    
    print(f"Downloading Destriped 15m Pan-Sharpened {year} from: {thumb_url}")
    r = requests.get(thumb_url)
    if r.status_code == 200:
        with open(out_file, 'wb') as f:
            f.write(r.content)
        print(f"Saved to {out_file}")
    else:
        print(f"Failed to download: {r.status_code} {r.text}")

if __name__ == "__main__":
    bbox_sf = [-122.5, 37.7, -122.3, 37.8]
    save_pan_sharpened_destriped(2010, bbox_sf, "landsat_15m_pan_destriped_2010.png")
