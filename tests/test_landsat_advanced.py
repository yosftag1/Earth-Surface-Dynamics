import sys
import os
import requests
from pathlib import Path

sys.path.append(os.getcwd())

from backend.gee_composite import initialize_earth_engine, rectangle_from_bbox_mercator, ee

def save_pan_sharpened(year: int, bbox: list, out_file: str):
    initialize_earth_engine()
    region = rectangle_from_bbox_mercator(*bbox)
    
    start = f"{year}-01-01"
    end   = f"{year}-12-31"

    # We use TOA (Top of Atmosphere) to access the Panchromatic band (Band 8 for L7)
    if year >= 1999 and year < 2013:
        coll_name = "LANDSAT/LE07/C02/T1_TOA"
        rgb_bands = ["B3", "B2", "B1"] # Red, Green, Blue
        pan_band = "B8"
    else:
        # If outside L7, fallback or handle differently. For our test we only care about 2010 (L7).
        print("This specific script targets Landsat 7 (1999-2012) for 15m pan-sharpening.")
        return

    # 1. Fetch Collection & Filter
    coll = ee.ImageCollection(coll_name).filterBounds(region).filterDate(start, end)
    
    # 2. Get the "best" clearest image instead of median blur
    # We sort by cloud cover and take the clearest one.
    best_img = coll.filter(ee.Filter.lt('CLOUD_COVER', 10)).sort('CLOUD_COVER').first()
    
    # If no image <10% cloud exists, fallback to standard lowest
    best_img = ee.Image(ee.Algorithms.If(
        best_img, 
        best_img, 
        coll.sort('CLOUD_COVER').first()
    )).clip(region)

    # Convert TOA to 0-1 range roughly. TOA is reflectance.
    # Usually TOA doesn't need scaling down by 10000, but we can visualize it well with min/max
    rgb = best_img.select(rgb_bands)
    pan = best_img.select(pan_band)

    # 3. Contrast & Saturation Boost on RGB
    # We stretch the RGB before converting to HSV to ensure good color depth
    stats = rgb.reduceRegion(
        reducer=ee.Reducer.percentile([2, 98]),
        geometry=region,
        scale=30,
        maxPixels=1e9,
        bestEffort=True
    )
    
    # Apply stretch
    def min_max_stretch(img):
        stat_dict = stats.getInfo() or {}
        mins = [max(0.0, stat_dict.get(f"{b}_p2", 0.0)) for b in rgb_bands]
        maxs = [max(m + 0.1, stat_dict.get(f"{b}_p98", 0.3)) for b,m in zip(rgb_bands, mins)]
        return img.visualize(bands=rgb_bands, min=mins, max=maxs).divide(255.0)

    rgb_stretched = min_max_stretch(rgb)

    # 4. Pan Sharpening (HSV transform)
    # Convert RGB to HSV
    hsv = rgb_stretched.rgbToHsv()
    
    # Stretch Pan band to match
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


    # Replace Value (V) with stretched Pan band
    # HSV is Hue, Saturation, Value
    sharpened = ee.Image.cat([
        hsv.select('hue'),
        hsv.select('saturation').multiply(1.3).clamp(0, 1), # Boost saturation by 30%
        pan_stretched
    ]).hsvToRgb()

    # Final Image for export
    # 15m resolution projection
    native_proj = pan.projection()
    final_img = sharpened.setDefaultProjection(crs=native_proj, scale=15.0).clip(region)

    # Download
    thumb_url = final_img.getThumbURL({
        "dimensions": 1024,
        "region": region,
        "format": "png", "min": 0, "max": 1
    })
    
    print(f"Downloading 15m Pan-Sharpened {year} from: {thumb_url}")
    r = requests.get(thumb_url)
    if r.status_code == 200:
        with open(out_file, 'wb') as f:
            f.write(r.content)
        print(f"Saved to {out_file}")
    else:
        print(f"Failed to download: {r.status_code} {r.text}")


if __name__ == "__main__":
    bbox_sf = [-122.5, 37.7, -122.3, 37.8]
    # Test year 2010 (Landsat 7)
    save_pan_sharpened(2010, bbox_sf, "landsat_15m_pan_2010.png")
