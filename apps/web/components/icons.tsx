import type { SVGProps } from "react";

/** Ícones de linha mínimos (sem dependência externa). 1.6px stroke, currentColor. */
function Svg(props: SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  const { children, ...rest } = props;
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  );
}

export const IconHome = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M3 10.5 12 4l9 6.5" /><path d="M5 9.5V20h14V9.5" /></Svg>
);
export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M4 5h16v11H8l-4 3z" /></Svg>
);
export const IconLeads = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M4 6h16M4 12h16M4 18h10" /></Svg>
);
export const IconFlask = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M9 3h6M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3" /></Svg>
);
export const IconCalendar = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></Svg>
);
export const IconLogout = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></Svg>
);
export const IconGear = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></Svg>
);
export const IconUser = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></Svg>
);
export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18" /></Svg>
);
export const IconBuilding = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16M15 21V9h3a1 1 0 0 1 1 1v11M8 8h2M8 12h2M8 16h2" /></Svg>
);
export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5" /></Svg>
);
export const IconCheckShield = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3z" /><path d="m9 11 2 2 4-4" /></Svg>
);
export const IconTemplate = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></Svg>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M12 4 2 20h20L12 4z" /><path d="M12 10v4M12 17h.01" /></Svg>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);
export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6zM10 19a2 2 0 0 0 4 0" /></Svg>
);
export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
