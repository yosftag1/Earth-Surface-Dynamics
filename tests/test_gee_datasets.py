import sys
import os
import requests
from pathlib import Path

sys.path.append(os.getcwd())

from backend.gee_composite import initialize_earth_engine, rectangle_from_bbox_mercator, ee

def download_image(img, region, viz_params, out_file):
    styled = img.visualize(**viz_params).clip(region)
    # Ensure background isn't simply transparent/white if it's supposed to be black
    # e.g., for Night Lights, FIRMS. We can use unmask(0) if it's a floating point image.
    thumb_url = styled.getThumbURL({
        "dimensions": 800,
        "region": region,
        "format": "png",
    })
    print(f"Downloading {out_file}...")
    r = requests.get(thumb_url)
    if r.status_code == 200:
        with open(out_file, 'wb') as f:
            f.write(r.content)
        print(f"Saved {out_file}")
    else:
        print(f"Failed to download {out_file}: {r.status_code} {r.text}")


def test_custom_datasets():
    initialize_earth_engine()
    
    # Let's use San Francisco Bay Area for most, and maybe a specific fire area for FIRMS.
    bbox_sf = [-122.5, 37.2, -121.8, 38.0]
    region = rectangle_from_bbox_mercator(*bbox_sf)

    # 1. Night Lights (VIIRS Monthly)
    viirs = ee.ImageCollection("NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG") \
        .filterDate("2019-01-01", "2019-12-31") \
        .median() \
        .select('avg_rad')
    
    # Base map of water/land for contrast so it isn't floating in void
    # Create black background
    bg = ee.Image(0).visualize(palette=['000000']).clip(region)
    night_styled = viirs.visualize(min=0, max=40, palette=['000000', '1E4D2B', 'FDB813', 'FFFFFF'])
    night_final = ee.ImageCollection([bg, night_styled]).mosaic()
    
    download_image(night_final, region, {}, "test_night_lights.png")


    # 2. Surface Water Dynamics (JRC Occurrence)
    water = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select('occurrence')
    bg_land = ee.Image(1).visualize(palette=['#111111']).clip(region) # Dark gray base
    water_styled = water.visualize(min=0, max=100, palette=['#0000ff', '#00ffff'])
    water_final = ee.ImageCollection([bg_land, water_styled]).mosaic()
    download_image(water_final, region, {}, "test_surface_water.png")


    # 3. Thermal / Wildfire (FIRMS)
    # August 2020: CZU Lightning Complex fire around Santa Cruz (south of SF)
    bbox_fire = [-122.4, 37.0, -122.0, 37.3]
    region_fire = rectangle_from_bbox_mercator(*bbox_fire)
    
    firms = ee.ImageCollection("FIRMS") \
        .filterDate('2020-08-15', '2020-08-30') \
        .select('T21') \
        .max()
        
    s2_base = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED") \
        .filterBounds(region_fire) \
        .filterDate("2020-08-10", "2020-08-15") \
        .median() \
        .visualize(bands=['B4', 'B3', 'B2'], min=0, max=3000)
        
    fire_styled = firms.visualize(min=325, max=400, palette=['red', 'orange', 'yellow'])
    fire_final = ee.ImageCollection([s2_base.clip(region_fire), fire_styled.clip(region_fire)]).mosaic()
    download_image(fire_final, region_fire, {}, "test_thermal_fire.png")


    # 4. NDVI (MODIS)
    modis_ndvi = ee.ImageCollection("MODIS/061/MOD13Q1") \
        .filterDate("2020-04-01", "2020-06-30") \
        .median() \
        .select('NDVI')
    # MODIS NDVI is scaled by 10000
    download_image(modis_ndvi, region, {
        "min": 0, "max": 8000, 
        "palette": ['#FFFFFF', '#CE7E45', '#DF923D', '#F1B555', '#FCD163', '#99B718', '#74A901', '#66A000', '#529400', '#3E8601', '#207401', '#056201', '#004C00', '#023B01', '#012E01', '#011D01', '#011301']
    }, "test_ndvi.png")


    # 5. SAR (Sentinel-1)
    s1_sar = ee.ImageCollection("COPERNICUS/S1_GRD") \
        .filterBounds(region) \
        .filterDate("2020-06-01", "2020-06-30") \
        .filter(ee.Filter.eq('instrumentMode', 'IW')) \
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV')) \
        .select('VV') \
        .median()
        
    download_image(s1_sar, region, {"min": -20, "max": 0, "palette": ['#000000', '#FFFFFF']}, "test_sar.png")

if __name__ == "__main__":
    test_custom_datasets()
