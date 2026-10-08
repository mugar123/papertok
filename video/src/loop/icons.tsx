import React from "react";

// Lucide geometry (the icon set the app uses), inlined for the video bundle.
const Icon: React.FC<{ size: number; color: string; fill?: string; children: React.ReactNode }> = ({
  size,
  color,
  fill = "none",
  children,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

type P = { size?: number; color?: string; fill?: string };

export const Heart: React.FC<P> = ({ size = 24, color = "currentColor", fill }) => (
  <Icon size={size} color={color} fill={fill}>
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </Icon>
);

export const Bookmark: React.FC<P> = ({ size = 24, color = "currentColor", fill }) => (
  <Icon size={size} color={color} fill={fill}>
    <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
  </Icon>
);

export const FileText: React.FC<P> = ({ size = 24, color = "currentColor" }) => (
  <Icon size={size} color={color}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </Icon>
);

export const Sparkles: React.FC<P> = ({ size = 24, color = "currentColor" }) => (
  <Icon size={size} color={color}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
  </Icon>
);

export const Pointer: React.FC<{ size?: number }> = ({ size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <path
      d="M4.5 2.8 19 12.1l-6.4 1.3 3.7 7.1-2.6 1.3-3.6-7.2L5.3 19.2Z"
      fill="#111318"
      stroke="#ffffff"
      strokeWidth={1.4}
      strokeLinejoin="round"
    />
  </svg>
);
