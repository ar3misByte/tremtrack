// Tiny hash router: #/live, #/trends, ... Works on any static host and offline.
import { useEffect, useState } from 'react';

export type Route = 'live' | 'trends' | 'log' | 'insights' | 'report' | 'settings' | 'about';
const ROUTES: Route[] = ['live', 'trends', 'log', 'insights', 'report', 'settings', 'about'];

function current(): Route {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0] as Route;
  return ROUTES.includes(r) ? r : 'live';
}

export function useRoute(): Route {
  const [r, setR] = useState(current);
  useEffect(() => {
    const on = () => { setR(current()); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return r;
}
