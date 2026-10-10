import type { CSSProperties } from "react";
const paths: Record<string, React.ReactNode> = {
  chat: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 10 10 0 0 1-4-1l-5 2 1.5-5a9 9 0 0 1-1.5-4.5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z"/><path d="M8 9h8M8 13h5"/></>,
  minus: <path d="M5 12h14"/>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  equipment: <><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V3h8v3M3 11h18M8 15h2m4 0h2"/></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/><rect x="10" y="10" width="4" height="4" rx=".5"/></>,
  wrench: <path d="m14 6 4 4 3-3a6 6 0 0 1-8 7l-6 6a2 2 0 0 1-3-3l6-6a6 6 0 0 1 7-8z"/>,
  pulse: <path d="M2 12h4l3-8 5 16 3-8h5"/>,
  wave: <path d="M2 12c2-10 4-10 6 0s4 10 6 0 4-10 6 0h2"/>,
  thermometer: <><path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 8v9"/><circle cx="12" cy="18" r="1"/></>,
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7z"/>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  scan: <><path d="M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4M3 12h18"/><path d="M8 8h8v8H8z"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/></>,
  warning: <><path d="m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2 2 0 0 0-4 0Z"/><path d="M12 9v4m0 4h.01"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  pin: <><path d="M19 10c0 6-7 11-7 11S5 16 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,
  x: <path d="m6 6 12 12M6 18 18 6"/>,
  camera: <><path d="M8 5H5a2 2 0 0 0-2 2v12h18V7a2 2 0 0 0-2-2h-3l-2-2h-4z"/><circle cx="12" cy="12" r="4"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
  download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
  link: <><path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
};
export default function Icon({ name, size = 20, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true">{paths[name] || paths.pulse}</svg>;
}
