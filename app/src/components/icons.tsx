// Small stroke icons (24x24, currentColor). Decorative: always paired with a text label.
import type { ReactNode } from 'react';

const I = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>
);

export const IconLive = () => <I><path d="M3 12h4l2.5-6 4 12 2.5-6H21" /></I>;
export const IconTrends = () => <I><path d="M4 19V5M4 19h16" /><path d="M7.5 15l3.5-4 3 2.5 4.5-6" /></I>;
export const IconLog = () => <I><rect x="5" y="3.5" width="14" height="17" rx="3" /><path d="M9 8.5h6M9 12h6M9 15.5h3.5" /></I>;
export const IconInsights = () => <I><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v5l3 2" /></I>;
export const IconReport = () => <I><path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z" /><path d="M14 3.5V8h4M9 13h6M9 16.5h4" /></I>;
export const IconGear = () => <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>;
export const IconCloud = () => <I><path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9z" /></I>;
export const IconUsb = () => <I><path d="M12 3v14M8.5 6.5 12 3l3.5 3.5M12 13l-4-2.5V8M12 15l4-2.5V10" /><circle cx="12" cy="19" r="2" /></I>;
export const IconBluetooth = () => <I><path d="m7 7 10 10-5 4V3l5 4L7 17" /></I>;
export const IconWifi = () => <I><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1" /></I>;
export const IconPlay = () => <I><circle cx="12" cy="12" r="8.5" /><path d="m10 8.5 5 3.5-5 3.5z" /></I>;
export const IconReplay = () => <I><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="m10.5 9 4.5 3-4.5 3z" /></I>;
export const IconClose = () => <I><path d="M6 6l12 12M18 6 6 18" /></I>;
export const IconRecenter = () => <I><circle cx="12" cy="12" r="3" /><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" /></I>;
export const IconCube = () => <I><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></I>;
export const IconCircle = () => <I><circle cx="12" cy="12" r="8.5" /><circle cx="14" cy="10" r="2.5" /></I>;
export const IconHeart = () => <I><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" /></I>;
export const IconInfo = () => <I><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></I>;
export const BrandMark = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="10" r="5" fill="#fff" /><path d="M3.5 19q2-2 4 0t4 0 4 0 4 0" stroke="#d9602f" strokeWidth="2" strokeLinecap="round" /></svg>
);
