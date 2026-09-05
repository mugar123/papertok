import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Toggle } from '@base-ui/react/toggle';
import { ComposableMap, Geographies, Geography, ZoomableGroup } from '@vnedyalk0v/react19-simple-maps';
import { getCountryName, SUPPORTED_COUNTRY_CODES } from '../../data/countries';
import isoMapping from '../../data/isoMapping.json';
import geoData from '../../data/world-110m.json';
import { useLanguage } from '../../context/LanguageContext';
import './WorldMap.css';

const SUPPORTED_COUNTRIES = new Set(SUPPORTED_COUNTRY_CODES);

export default function WorldMap({ selectedCountries = [], onToggleCountry }) {
  const { language, isEnglish } = useLanguage();
  const [tooltipContent, setTooltipContent] = useState('');
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const handleMouseEnter = (geo, e) => {
    const alpha2 = isoMapping.numericToAlpha2[geo.id];
    if (!SUPPORTED_COUNTRIES.has(alpha2)) return;
    const name = alpha2 ? getCountryName(alpha2, language) : geo.properties.name;

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
                const isSupported = SUPPORTED_COUNTRIES.has(alpha2);

                /* A country we cannot filter by is drawn but is not a control:
                   no role, no name, out of the tab order. */
                if (!isSupported) {
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      className="wm-geo unsupported"
                      tabIndex={-1}
                      aria-hidden="true"
                    />
                  );
                }

                const isSelected = selectedCountries.includes(alpha2);
                const countryName = getCountryName(alpha2, language);

                /* A supported country is a Base UI Toggle drawn as its own
                   <path>: with `nativeButton={false}` the primitive gives the
                   path `role="button"`, the tab stop, Enter and Space, and
                   writes `aria-pressed` / `data-pressed` from `pressed` — the
                   stylesheet keys the selected fill off the latter. The ui
                   chip Toggle is not used here because its chip classes have
                   no meaning on an SVG path. */
                return (
                  <Toggle
                    key={geo.rsmKey}
                    nativeButton={false}
                    pressed={isSelected}
                    onPressedChange={() => onToggleCountry(alpha2)}
                    aria-label={`${isEnglish ? 'Filter by' : 'Filtrar por'} ${countryName}`}
                    render={(
                      <Geography
                        geography={geo}
                        className="wm-geo"
                        onMouseEnter={(e) => handleMouseEnter(geo, e)}
                        onMouseLeave={handleMouseLeave}
                      />
                    )}
                  />
                );
              })
            }
          </Geographies>
        </ZoomableGroup>
      </ComposableMap>

      {/* The name follows the pointer across the map. It stays a portaled
          element rather than a ui Tooltip: the tooltip primitive anchors to a
          trigger element, and here there are ~170 paths under one pointer
          whose label is re-positioned on every move — the ui TooltipContent
          exposes no `anchor` for a virtual pointer element. The label is
          decorative for assistive technology: each country already carries
          its name on `aria-label`. */}
      {tooltipContent && typeof document !== 'undefined' && createPortal(
        <div 
          className="wm-tooltip"
          aria-hidden="true"
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
