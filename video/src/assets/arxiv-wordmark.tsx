import React from "react";

// Wordmark vectorial que sustituye al logotipo rasterizado durante el zoom.
// Coordenadas en px de pantalla (captura CSS 1600 mostrada a 1920, factor 1.2),
// medidas sobre el recorte del logotipo en la captura real.
export const ArxivWordmark: React.FC = () => (
  <svg width={1920} height={80} viewBox="0 0 1920 80">
    <rect x={0} y={0} width={1920} height={80} fill="#1b1b1b" />
    <text
      x={13}
      y={26}
      fontFamily="'Courier New', monospace"
      fontSize={40}
      fontWeight={700}
      fill="#b9b0a2"
      dominantBaseline="middle"
    >
      ar
    </text>
    <text
      x={94}
      y={26}
      fontFamily="'Courier New', monospace"
      fontSize={40}
      fontWeight={700}
      fill="#b9b0a2"
      dominantBaseline="middle"
    >
      iv
    </text>
    {/* La chi, medida sobre la captura: recta roja empinada y polilínea beige
        con codo (el trazo beige pasa por encima en el cruce). */}
    <line x1={74.4} y1={6.9} x2={78.9} y2={49.8} stroke="#b31b1b" strokeWidth={5} strokeLinecap="round" />
    <polyline
      points="94.5,11.1 79.2,30.3 99.3,55.5"
      fill="none"
      stroke="#b9b0a2"
      strokeWidth={5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
