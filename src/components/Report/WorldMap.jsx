import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ComposableMap, Geographies, Geography, ZoomableGroup } from '@vnedyalk0v/react19-simple-maps';
import { COUNTRIES } from '../../data/countries';
import isoMapping from '../../data/isoMapping.json';
import geoData from '../../data/world-110m.json';
import './WorldMap.css';

export default function WorldMap({ selectedCountries = [], onToggleCountry }) {
  const [tooltipContent, setTooltipContent] = useState('');
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handleMouseEnter = (geo, e) => {
    const alpha2 = isoMapping.numericToAlpha2[geo.id];
    const name = alpha2 ? (COUNTRIES[alpha2] || geo.properties.name) : geo.properties.name;
    
    setTooltipContent(name);
    setTooltipPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseLeave = () => {
    setTooltipContent('');
  };

  const handleMouseMove = (e) => {
    if (tooltipContent) {
      setTooltipPos({ x: e.clientX, y: e.clientY });
    }
  };

  const handleClick = (geo) => {
    const alpha2 = isoMapping.numericToAlpha2[geo.id];
    if (alpha2) {
      onToggleCountry(alpha2);
    }
  };

  return (
    <div className="wm" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
      <ComposableMap 
        projection="geoMercator" 
        projectionConfig={{ scale: 110, center: [0, 30] }}
        width={800}
        height={400}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        <ZoomableGroup 
          zoom={1} 
          minZoom={1} 
          maxZoom={4}
          filterZoomEvent={(event) => {
            // Prevent map from capturing scroll wheel event, allowing natural page scrolling
            return event.type !== 'wheel' && event.type !== 'touchmove';
          }}
        >
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
                    tabIndex={-1}
                  />
                );
              })
            }
          </Geographies>
        </ZoomableGroup>
      </ComposableMap>

      {/* Floating HTML Tooltip via Portal to avoid clipping/transform issues */}
      {tooltipContent && typeof document !== 'undefined' && createPortal(
        <div 
          className="wm-tooltip"
          style={{
            left: tooltipPos.x,
            top: tooltipPos.y - 20
          }}
        >
          {tooltipContent}
        </div>,
        document.body
      )}
    </div>
  );
}
