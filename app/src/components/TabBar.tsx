import type { ReactElement } from 'react';
import { IconInsights, IconLive, IconLog, IconReport, IconTrends } from './icons';
import type { Route } from '../router';

const TABS: { route: Route; label: string; icon: ReactElement }[] = [
  { route: 'live', label: 'Live', icon: <IconLive /> },
  { route: 'trends', label: 'Trends', icon: <IconTrends /> },
  { route: 'log', label: 'Log', icon: <IconLog /> },
  { route: 'insights', label: 'Insights', icon: <IconInsights /> },
  { route: 'report', label: 'Report', icon: <IconReport /> },
];

export default function TabBar({ route }: { route: Route }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <a key={t.route} href={`#/${t.route}`} aria-current={route === t.route ? 'page' : undefined}>
          {t.icon}
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}
