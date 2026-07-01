import fs from 'fs';
import * as d3Geo from 'd3-geo';
import * as topojson from 'topojson-client';
import fetch from 'node-fetch';

async function generate() {
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    const world = await res.json();
    
    // Convert TopoJSON to GeoJSON
    const countries = topojson.feature(world, world.objects.countries);
    
    // Create an equirectangular projection that matches the app's coordinate math
    // App math: x: ((lng + 180) / 360) * 1000, y: ((90 - lat) / 180) * 500
    const projection = d3Geo.geoEquirectangular()
      .fitExtent([[0, 0], [1000, 500]], { type: "Sphere" });
      
    const pathGenerator = d3Geo.geoPath().projection(projection);
    
    const svgPath = pathGenerator(countries);
    
    fs.writeFileSync('D:\\projects\\netshield\\map-path.txt', svgPath);
    console.log('Map path generated successfully!');
  } catch (error) {
    console.error('Error:', error);
  }
}

generate();
