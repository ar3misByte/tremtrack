import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { live, useLive } from './device/live';
import { useRoute } from './router';
import { useSettings } from './state/settings';
import ConnectSheet from './components/ConnectSheet';
import FallAlert from './components/FallAlert';
import ReminderBanner from './components/ReminderBanner';
import TabBar from './components/TabBar';
import { BrandMark, IconCloud, IconGear } from './components/icons';
import Live from './screens/Live';
// screens other than Live load on demand, keeping the first load small
const Settings = lazy(() => import('./screens/Settings'));
const About = lazy(() => import('./screens/About'));
const Trends = lazy(() => import('./screens/Trends'));
const Log = lazy(() => import('./screens/Log'));
const Insights = lazy(() => import('./screens/Insights'));
const Report = lazy(() => import('./screens/Report'));
const Cloud = lazy(() => import('./screens/Cloud'));

function ConnPill({ onClick }: { onClick: () => void }) {
  const s = useLive();
  const label = s.fresh
    ? `${s.source === 'demo' ? 'Demo' : s.source === 'replay' ? 'Replay' : s.source === 'serial' ? 'USB' : s.source === 'websocket' ? 'Wi-Fi' : s.source === 'ble' ? 'Bluetooth' : s.source === 'cloud' ? 'Cloud' : 'Live'} · ${s.rate}/s`
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

  // Only people who set up the cloud load its code at start (it finishes a sign-in that just returned from the login page).
  useEffect(() => { try { if (localStorage.getItem('htm.cloud.config.v1')) void import('./cloud/client').then((m) => m.cloud.init()); } catch { /* storage blocked */ } }, []);
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
            <a className="icon-btn" href="#/cloud" aria-label="Cloud"><IconCloud /></a>
            <a className="icon-btn" href="#/settings" aria-label="Settings"><IconGear /></a>
          </div>
        </div>
      </header>

      <ReminderBanner />
      <main>
        <Suspense fallback={<p className="page fine">Loading…</p>}>
        {route === 'live' && <Live onConnect={open} />}
        {route === 'trends' && <Trends />}
        {route === 'log' && <Log />}
        {route === 'insights' && <Insights />}
        {route === 'report' && <Report />}
        {route === 'settings' && <Settings />}
        {route === 'about' && <About />}
        {route === 'cloud' && <Cloud />}
        </Suspense>
        <p className="disclaimer">Prototype for demonstration. Not a medical device. <a href="#/about">Limits</a></p>
      </main>

      <TabBar route={route} />
      {sheet && <ConnectSheet onClose={close} />}
      <FallAlert />
    </div>
  );
}
