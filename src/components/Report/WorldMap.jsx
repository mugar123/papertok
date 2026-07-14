import { useState, useMemo } from 'react';
import { ComposableMap, Geographies, Geography, ZoomableGroup } from '@vnedyalk0v/react19-simple-maps';
import { COUNTRIES } from '../../data/countries';
import isoMapping from '../../data/isoMapping.json';
import geoData from '../../data/world-110m.json';
import './WorldMap.css';

export default function WorldMap({ selectedCountries = [], onToggleCountry }) {
  const [tooltipContent, setTooltipContent] = useState('');
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handleMouseEnter = (geo, e) => {
    // numeric ID to alpha-2
    const alpha2 = isoMapping.numericToAlpha2[geo.id];
    // fallback to properties.name if alpha2 is not found or not in our main list
    const name = alpha2 ? (COUNTRIES[alpha2] || geo.properties.name) : geo.properties.name;
    
    setTooltipContent(name);
    // Rough positioning based on mouse
    const rect = e.target.getBoundingClientRect();
    setTooltipPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeave = () => {
    setTooltipContent('');
  };

  const handleMouseMove = (e) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  };

  const handleClick = (geo) => {
    const alpha2 = isoMapping.numericToAlpha2[geo.id];
    if (alpha2) {
      onToggleCountry(alpha2);
    }
  };

  return (
    <div className="wm" onMouseMove={handleMouseMove}>
      <ComposableMap 
        projection="geoMercator" 
        projectionConfig={{ scale: 110, center: [0, 30] }}
        width={800}
        height={400}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <ZoomableGroup zoom={1} minZoom={1} maxZoom={4}>
          <Geographies geography={geoData}>
            {({ geographies }) =>
              geographies.map((geo) => {
                const alpha2 = isoMapping.numericToAlpha2[geo.id];
                const isSelected = alpha2 && selectedCountries.includes(alpha2);
                
                return (
                  <Geography
                    key={geo.rsmKey}
                    geography={geo}
                    onClick={() => handleClick(geo)}
                    onMouseEnter={(e) => handleMouseEnter(geo, e)}
                    onMouseLeave={handleMouseLeave}
                    className={`wm-geo ${isSelected ? 'selected' : ''}`}
                    style={{
                      default: {
                        fill: isSelected ? 'rgba(99, 102, 241, 0.4)' : 'rgba(255, 255, 255, 0.08)',
                        stroke: isSelected ? 'rgba(99, 102, 241, 0.8)' : 'rgba(255, 255, 255, 0.15)',
                        strokeWidth: 0.5,
                        outline: 'none',
                      },
                      hover: {
                        fill: isSelected ? 'rgba(99, 102, 241, 0.6)' : 'rgba(255, 255, 255, 0.2)',
                        stroke: isSelected ? 'rgba(99, 102, 241, 1)' : 'rgba(255, 255, 255, 0.4)',
                        strokeWidth: 0.5,
                        outline: 'none',
                        cursor: 'pointer'
                      },
                      pressed: {
                        fill: 'rgba(99, 102, 241, 0.8)',
                        stroke: 'rgba(255, 255, 255, 0.5)',
                        strokeWidth: 0.5,
                        outline: 'none',
                      }
                    }}
                  />
                );
              })
            }
          </Geographies>
        </ZoomableGroup>
      </ComposableMap>

      {/* Floating HTML Tooltip */}
      {tooltipContent && (
        <div 
          className="wm-tooltip"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y - 30
          }}
        >
          {tooltipContent}
        </div>
      )}
    </div>
  );
}
