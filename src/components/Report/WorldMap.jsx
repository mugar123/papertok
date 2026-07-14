import { useState, useMemo } from 'react';
import { COUNTRIES } from '../../data/countries';
import './WorldMap.css';

/**
 * Simplified world map SVG with clickable country regions.
 * Uses approximate rectangular regions per country for performance.
 * Each region is a <rect> or <path> with hover/click interaction.
 */

// Country regions: approximate [x, y, width, height] on a 1000x500 viewBox
// Grouped into rough continental positions
const COUNTRY_REGIONS = {
  // North America
  US: { x: 100, y: 120, w: 140, h: 70, label: 'EE.UU.' },
  CA: { x: 100, y: 50, w: 160, h: 70, label: 'Canadá' },
  MX: { x: 110, y: 200, w: 60, h: 50, label: 'México' },

  // Central & South America
  CO: { x: 180, y: 260, w: 40, h: 35, label: 'Colombia' },
  BR: { x: 220, y: 270, w: 90, h: 90, label: 'Brasil' },
  AR: { x: 210, y: 360, w: 45, h: 70, label: 'Argentina' },
  CL: { x: 195, y: 340, w: 15, h: 90, label: 'Chile' },

  // Western Europe
  GB: { x: 430, y: 90, w: 25, h: 30, label: 'UK' },
  IE: { x: 415, y: 90, w: 15, h: 20, label: 'IE' },
  FR: { x: 435, y: 125, w: 35, h: 35, label: 'Francia' },
  ES: { x: 420, y: 155, w: 40, h: 30, label: 'España' },
  PT: { x: 410, y: 155, w: 10, h: 30, label: 'PT' },
  DE: { x: 470, y: 100, w: 30, h: 35, label: 'Alemania' },
  IT: { x: 475, y: 140, w: 20, h: 40, label: 'Italia' },
  CH: { x: 462, y: 130, w: 15, h: 15, label: 'CH' },
  AT: { x: 485, y: 115, w: 20, h: 15, label: 'AT' },
  NL: { x: 458, y: 95, w: 15, h: 12, label: 'NL' },
  BE: { x: 450, y: 108, w: 15, h: 12, label: 'BE' },

  // Northern Europe
  SE: { x: 490, y: 40, w: 20, h: 55, label: 'Suecia' },
  NO: { x: 472, y: 30, w: 18, h: 60, label: 'Noruega' },
  FI: { x: 510, y: 30, w: 25, h: 45, label: 'Finlandia' },
  DK: { x: 475, y: 85, w: 15, h: 12, label: 'DK' },

  // Eastern Europe
  PL: { x: 500, y: 95, w: 25, h: 25, label: 'Polonia' },
  CZ: { x: 490, y: 107, w: 18, h: 12, label: 'CZ' },
  HU: { x: 505, y: 120, w: 18, h: 12, label: 'HU' },
  RO: { x: 520, y: 125, w: 25, h: 18, label: 'Rumanía' },
  UA: { x: 535, y: 95, w: 35, h: 25, label: 'Ucrania' },
  GR: { x: 510, y: 155, w: 18, h: 20, label: 'Grecia' },
  TR: { x: 540, y: 145, w: 45, h: 22, label: 'Turquía' },

  // Russia & Central Asia
  RU: { x: 540, y: 30, w: 200, h: 80, label: 'Rusia' },

  // Middle East
  IL: { x: 560, y: 175, w: 10, h: 18, label: 'IL' },
  SA: { x: 570, y: 190, w: 50, h: 40, label: 'A. Saudí' },
  IR: { x: 610, y: 165, w: 40, h: 30, label: 'Irán' },

  // Africa
  EG: { x: 540, y: 195, w: 30, h: 30, label: 'Egipto' },
  NG: { x: 468, y: 260, w: 30, h: 30, label: 'Nigeria' },
  ZA: { x: 520, y: 350, w: 40, h: 35, label: 'Sudáfrica' },
  KE: { x: 560, y: 280, w: 25, h: 25, label: 'Kenia' },

  // South Asia
  IN: { x: 660, y: 180, w: 50, h: 65, label: 'India' },
  PK: { x: 645, y: 170, w: 25, h: 30, label: 'Pakistán' },

  // East Asia
  CN: { x: 700, y: 110, w: 80, h: 65, label: 'China' },
  JP: { x: 810, y: 120, w: 25, h: 50, label: 'Japón' },
  KR: { x: 790, y: 140, w: 18, h: 20, label: 'Corea' },
  TW: { x: 790, y: 175, w: 12, h: 15, label: 'TW' },
  HK: { x: 775, y: 185, w: 10, h: 10, label: 'HK' },

  // Southeast Asia
  TH: { x: 720, y: 210, w: 22, h: 30, label: 'Tailandia' },
  MY: { x: 730, y: 255, w: 25, h: 15, label: 'Malasia' },
  SG: { x: 740, y: 270, w: 10, h: 8, label: 'SG' },
  ID: { x: 735, y: 275, w: 60, h: 25, label: 'Indonesia' },

  // Oceania
  AU: { x: 780, y: 320, w: 80, h: 60, label: 'Australia' },
  NZ: { x: 880, y: 380, w: 25, h: 30, label: 'NZ' },
};

export default function WorldMap({ selectedCountries = [], onToggleCountry }) {
  const [hoveredCountry, setHoveredCountry] = useState(null);

  const tooltipInfo = useMemo(() => {
    if (!hoveredCountry) return null;
    const region = COUNTRY_REGIONS[hoveredCountry];
    if (!region) return null;
    return {
      name: COUNTRIES[hoveredCountry] || hoveredCountry,
      x: region.x + region.w / 2,
      y: region.y - 8,
    };
  }, [hoveredCountry]);

  return (
    <div className="wm">
      <svg
        viewBox="0 0 1000 480"
        className="wm-svg"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Background grid lines for aesthetics */}
        <defs>
          <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,0.02)" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="1000" height="480" fill="url(#grid)" />

        {/* Country regions */}
        {Object.entries(COUNTRY_REGIONS).map(([code, region]) => {
          const isSelected = selectedCountries.includes(code);
          const isHovered = hoveredCountry === code;

          return (
            <g key={code}>
              <rect
                x={region.x}
                y={region.y}
                width={region.w}
                height={region.h}
                rx={3}
                className={`wm-country ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''}`}
                onClick={() => onToggleCountry(code)}
                onMouseEnter={() => setHoveredCountry(code)}
                onMouseLeave={() => setHoveredCountry(null)}
              />
              {/* Label for larger countries */}
              {region.w >= 25 && region.h >= 20 && (
                <text
                  x={region.x + region.w / 2}
                  y={region.y + region.h / 2 + 1}
                  className={`wm-label ${isSelected ? 'selected' : ''}`}
                  onClick={() => onToggleCountry(code)}
                  onMouseEnter={() => setHoveredCountry(code)}
                  onMouseLeave={() => setHoveredCountry(null)}
                >
                  {region.label}
                </text>
              )}
            </g>
          );
        })}

        {/* Tooltip */}
        {tooltipInfo && (
          <g className="wm-tooltip-group">
            <rect
              x={tooltipInfo.x - 45}
              y={tooltipInfo.y - 20}
              width={90}
              height={22}
              rx={6}
              className="wm-tooltip-bg"
            />
            <text
              x={tooltipInfo.x}
              y={tooltipInfo.y - 6}
              className="wm-tooltip-text"
            >
              {tooltipInfo.name}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
