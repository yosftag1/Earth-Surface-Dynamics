import sys
import os
import requests
from pathlib import Path

# Add the project root to sys.path
sys.path.append(os.getcwd())

from backend.gee_composite import initialize_earth_engine, rectangle_from_bbox_mercator, ee

def save_landsat_quality(year: int, bbox: list, out_file: str):
    initialize_earth_engine()
    region = rectangle_from_bbox_mercator(*bbox)
    percentile_scale = 30.0
    method = "median"
    
    start = f"{year}-01-01"
    end   = f"{year}-12-31"

    is_high = (percentile_scale <= 110.0)
    
    if year >= 2013:
        s_coll_name = "LANDSAT/LC08/C02/T1_L2"
        bands = ["SR_B4", "SR_B3", "SR_B2"]
        n_bands = ["SR_B5", "SR_B4"]
    elif year >= 1999:
        s_coll_name = "LANDSAT/LE07/C02/T1_L2"
        bands = ["SR_B3", "SR_B2", "SR_B1"]
        n_bands = ["SR_B4", "SR_B3"]
    else:
        s_coll_name = "LANDSAT/LT05/C02/T1_L2"
        bands = ["SR_B3", "SR_B2", "SR_B1"]
        n_bands = ["SR_B4", "SR_B3"]

    full_coll = ee.ImageCollection(s_coll_name).filterBounds(region).filterDate(start, end)
    
    def _mask_ls_sr_clouds(image):
        qa = image.select('QA_PIXEL')
        mask = qa.bitwiseAnd(1 << 1).eq(0) \
            .And(qa.bitwiseAnd(1 << 2).eq(0)) \
            .And(qa.bitwiseAnd(1 << 3).eq(0)) \
            .And(qa.bitwiseAnd(1 << 4).eq(0))
        return image.updateMask(mask)
        
    strict = full_coll.filter(ee.Filter.lt('CLOUD_COVER', 30))
    final_coll = ee.ImageCollection(ee.Algorithms.If(
        strict.size().gt(0),
        strict,
        full_coll.sort('CLOUD_COVER').limit(5)
    )).map(_mask_ls_sr_clouds)

    raw = (final_coll.map(lambda img: img.addBands(img.normalizedDifference(n_bands).rename('NDVI')))
           .qualityMosaic('NDVI').clip(region))

    scaled = raw.select(bands).multiply(0.0000275).add(-0.2).clamp(0.0, 1.0)

    data_mask = scaled.mask().reduce(ee.Reducer.min())
    masked_scaled = scaled.updateMask(data_mask)

    stats = masked_scaled.reduceRegion(
        reducer=ee.Reducer.percentile([5, 95]),
        geometry=region,
        scale=percentile_scale,
        maxPixels=1e11,
        bestEffort=False,
    ).getInfo() or {}

    mn = [max(0.0,  stats.get(f"{b}_p5",  0.02)) for b in bands]
    mx = [min(0.95, stats.get(f"{b}_p95", 0.40)) for b in bands]
    mx = [max(mx[i], mn[i] + 0.05) for i in range(len(bands))]

    viz = {"bands": bands, "min": mn, "max": mx, "gamma": 1.4}
    
    native_proj = scaled.projection()
    final_img = (scaled.setDefaultProjection(crs=native_proj, scale=percentile_scale)
                 .resample("bilinear")
                 .clip(region))

    thumb_url = final_img.getThumbURL({
        "dimensions": 1024,
        "region": region,
        "format": "png",
        "min": viz["min"],
        "max": viz["max"],
        "bands": viz["bands"],
        "gamma": viz["gamma"]
    })
    
    print(f"Downloading {year} from: {thumb_url}")
    r = requests.get(thumb_url)
    if r.status_code == 200:
        with open(out_file, 'wb') as f:
            f.write(r.content)
        print(f"Saved to {out_file}")
    else:
        print(f"Failed to download image: {r.status_code} {r.text}")


if __name__ == "__main__":
    bbox_sf = [-122.5, 37.7, -122.3, 37.8]
    for y in [1990, 2000, 2010]:
        print(f"Processing year {y}...")
        save_landsat_quality(y, bbox_sf, f"landsat_test_{y}.png")
