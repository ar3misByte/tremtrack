import { useCallback, useEffect, useState } from 'react';
import { live, useLive } from './device/live';
import { useRoute } from './router';
import { useSettings } from './state/settings';
import ConnectSheet from './components/ConnectSheet';
import TabBar from './components/TabBar';
import { BrandMark, IconGear } from './components/icons';
import Live from './screens/Live';
import Placeholder from './screens/Placeholder';
import Settings from './screens/Settings';
import About from './screens/About';
import Trends from './screens/Trends';

function ConnPill({ onClick }: { onClick: () => void }) {
  const s = useLive();
  const label = s.fresh
    ? `${s.source === 'demo' ? 'Demo' : s.source === 'replay' ? 'Replay' : s.source === 'serial' ? 'USB' : s.source === 'websocket' ? 'Wi-Fi' : 'Live'} · ${s.rate}/s`
    : s.conn === 'connecting' ? 'Connecting…' : s.conn === 'open' ? 'Waiting…' : s.conn === 'error' ? 'Connection error' : 'Not connected';
  const dot = s.fresh ? 'live' : s.conn === 'connecting' || s.conn === 'open' ? 'wait pulse' : s.conn === 'error' ? 'err' : '';
  return (
    <button className="chip" onClick={onClick} aria-label={`Connection: ${label}. Change connection`} style={{ cursor: 'pointer', minHeight: 36 }}>
      <span className={`dot ${dot}`} />{label}
    </button>
  );
}

export default function App() {
  const route = useRoute();
  const [sheet, setSheet] = useState(false);
  const s = useLive();
  const largeText = useSettings((x) => x.largeText);
  const open = useCallback(() => setSheet(true), []);
  const close = useCallback(() => setSheet(false), []);

  useEffect(() => { document.documentElement.dataset.text = largeText ? 'large' : 'normal'; }, [largeText]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      if ((e.key === 'c' || e.key === 'C') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) && !e.ctrlKey && !e.metaKey) live.recenter();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`shell${s.tremorActive && route === 'live' ? ' alert' : ''}`}>
      <header className="page wide" style={{ paddingBottom: 0 }}>
        <div className="topbar full">
          <a className="brand" href="#/live" style={{ color: 'inherit', textDecoration: 'none' }}>
            <span className="brand-mark"><BrandMark /></span>Tremor
          </a>
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
            <ConnPill onClick={open} />
            <a className="icon-btn" href="#/settings" aria-label="Settings"><IconGear /></a>
          </div>
        </div>
      </header>

      <main>
        {route === 'live' && <Live onConnect={open} />}
        {route === 'trends' && <Trends />}
        {route === 'log' && <Placeholder title="Log" milestone={4} items={['Quick tags: coffee, poor sleep, stress, exercise, alcohol, meal, custom', 'Medication schedule, reminders, taken / skipped / late', 'Adherence percentage']} />}
        {route === 'insights' && <Placeholder title="Insights" milestone={4} items={['Patterns in your tremor (axis, frequency, regularity), worded as things to mention to a doctor, never a diagnosis', 'Tremor after tags and doses compared with baseline, with sample counts and uncertainty', 'Heart rate around tremor episodes']} />}
        {route === 'report' && <Placeholder title="Doctor report" milestone={5} items={['Pick a date range, get a PDF', 'Severity trend, episode table, patterns with their evidence', 'Medication and trigger findings with sample counts, vitals trends, impact events', 'A plain-language disclaimer']} />}
        {route === 'settings' && <Settings />}
        {route === 'about' && <About />}
        <p className="disclaimer">Prototype for demonstration. Not a medical device. <a href="#/about">Limits</a></p>
      </main>

      <TabBar route={route} />
      {sheet && <ConnectSheet onClose={close} />}
    </div>
  );
}
