// The app's cloud client: setup, sign-in, devices, history, live view and sync, as one store for the Cloud screen.
// The app works fully without it; nothing here runs until the user has entered a cloud setup.
import { create } from 'zustand';
import { live } from '../device/live';
import type { DeviceEvent, Status } from '../logic/protocol';
import { Api, ApiError, getCredentials, getIdentityId, type CloudEventRow, type DayRow, type DeviceRow } from './aws';
import { Auth } from './auth';
import { CONFIG_KEY, clearConfig, loadConfig, saveConfig, safeStorage, type CloudConfig } from './config';
import { CloudSource } from './liveSource';
import { localIO, syncNow, type SyncResult } from './sync';
import type { Credentials } from './sigv4';

export interface RemoteStatus { online: boolean; ts: number; fw?: string; rate?: number }
export interface CloudAlert { thing: string; kind: 'fall'; text: string; at: number }

export interface CloudState {
  config: CloudConfig | null;
  signedIn: boolean;
  email: string | null;
  identityId: string | null;
  devices: DeviceRow[];
  days: DayRow[];
  events: CloudEventRow[];
  remote: Record<string, RemoteStatus>;      // from the live view's status messages
  liveEvents: { thing: string; ev: DeviceEvent }[];
  alert: CloudAlert | null;
  watching: string | null;                   // thing being watched live
  busy: string | null;
  error: string | null;
  notice: string | null;
  sync: { at: number; includeMeds: boolean; last: SyncResult | null };
  loadedAt: number;
}

const PREFS_KEY = 'htm.cloud.sync.v1';
const readPrefs = (): { at: number; includeMeds: boolean } => { try { const v = JSON.parse(safeStorage()?.getItem(PREFS_KEY) ?? 'null'); return { at: Number(v?.at) || 0, includeMeds: !!v?.includeMeds }; } catch { return { at: 0, includeMeds: false }; } };
const writePrefs = (p: { at: number; includeMeds: boolean }) => { try { safeStorage()?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } };

export const useCloud = create<CloudState>(() => ({
  config: null, signedIn: false, email: null, identityId: null, devices: [], days: [], events: [], remote: {}, liveEvents: [], alert: null,
  watching: null, busy: null, error: null, notice: null, sync: { ...readPrefs(), last: null }, loadedAt: 0,
}));
const set = useCloud.setState;
const get = useCloud.getState;

const dayStr = (t: number, tzMin = 330) => new Date(t + tzMin * 60_000).toISOString().slice(0, 10);
const redirectUri = () => location.origin + import.meta.env.BASE_URL;
const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

class CloudClient {
  private auth: Auth | null = null;
  private api: Api | null = null;
  private creds: { creds: Credentials; expiresAt: number } | null = null;

  /** At app start: load the setup, finish a sign-in that just returned from the login page, load the data. */
  async init() {
    const cfg = loadConfig();
    if (!cfg) return;
    this.use(cfg);
    const u = new URL(location.href);
    if (u.searchParams.has('code') || u.searchParams.has('error')) {
      const r = await this.auth!.completeLogin(location.href);
      history.replaceState(null, '', location.pathname);          // take ?code=… out of the address bar
      if (r && !r.ok) set({ error: r.error });
      location.hash = '#/cloud';                                  // a real change, so the router moves to the Cloud screen
    }
    this.syncAuthState();
    if (this.auth!.isSignedIn()) await this.refresh();
  }

  private use(cfg: CloudConfig) {
    this.auth = new Auth(cfg, { redirectUri: redirectUri() });
    this.api = new Api(cfg, () => this.auth!.idToken());
    this.creds = null;
    set({ config: cfg, error: null });
    this.syncAuthState();
  }

  private syncAuthState() {
    const c = this.auth?.claims() ?? null;
    set({ signedIn: !!this.auth?.isSignedIn(), email: c?.email ?? null });
  }

  setup(cfg: CloudConfig) { saveConfig(cfg); this.use(cfg); set({ notice: 'Cloud setup saved. Sign in to continue.' }); }

  async forgetSetup() {
    await this.stopWatching();
    this.auth?.signOut();
    clearConfig();
    this.auth = null; this.api = null; this.creds = null;
    set({ config: null, signedIn: false, email: null, identityId: null, devices: [], days: [], events: [], remote: {}, liveEvents: [], alert: null, error: null, notice: null });
  }

  async signIn() {
    if (!this.auth) return;
    try { location.assign(await this.auth.loginUrl()); }
    catch (e) { set({ error: msg(e) }); }
  }

  async signOut() {
    await this.stopWatching();
    this.auth?.signOut();
    this.creds = null;
    set({ signedIn: false, email: null, identityId: null, devices: [], days: [], events: [], remote: {}, liveEvents: [], alert: null, notice: 'Signed out on this device.' });
  }

  private async identity(): Promise<string> {
    const cur = get().identityId;
    if (cur) return cur;
    const tok = await this.auth!.idToken();
    if (!tok) throw new ApiError(401, 'Sign in first.');
    const id = await getIdentityId(get().config!, tok);
    set({ identityId: id });
    return id;
  }

  /** Reloads profile, devices, 30 days of summaries and 14 days of events. Links this user to their cloud identity the first time. */
  async refresh() {
    if (!this.api || !this.auth) return;
    set({ busy: 'Loading from the cloud…', error: null });
    try {
      let me = await this.api.me();
      if (!me.identityId) { await this.api.link(await this.identity()); me = await this.api.me(); }
      set({ identityId: me.identityId, email: me.email ?? get().email, devices: me.devices });
      const now = Date.now();
      const [days, events] = await Promise.all([this.api.days(dayStr(now - 29 * 86_400_000), dayStr(now)), this.api.events(now - 14 * 86_400_000, now)]);
      set({ days: days.days.sort((a, b) => a.day.localeCompare(b.day)), events: events.events.sort((a, b) => b.ts - a.ts), loadedAt: now });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { this.auth.signOut(); this.syncAuthState(); set({ error: 'Your sign-in expired. Sign in again.' }); }
      else set({ error: 'Could not load from the cloud: ' + msg(e) });
    } finally { set({ busy: null }); }
  }

  /** Live view of one headset through the cloud (the Live screen shows it). */
  async watch(thing: string) {
    const cfg = get().config;
    if (!cfg || !this.auth) return;
    set({ error: null, alert: null });
    try {
      const id = await this.identity();
      const session = {
        identityId: async () => id,
        credentials: async () => {
          if (this.creds && this.creds.expiresAt - Date.now() > 5 * 60_000) return this.creds.creds;
          const tok = await this.auth!.idToken();
          if (!tok) throw new ApiError(401, 'Sign in first.');
          this.creds = await getCredentials(cfg, tok, id);
          return this.creds.creds;
        },
      };
      const src = new CloudSource(cfg, session, thing, {
        event: (th, ev) => {
          set((s) => ({ liveEvents: [{ thing: th, ev }, ...s.liveEvents].slice(0, 30) }));
          if (ev.type === 'fall' && (ev.fall.outcome === 'confirmed' || ev.fall.outcome === 'no-response')) {
            set({ alert: { thing: th, kind: 'fall', at: ev.ts, text: ev.fall.outcome === 'confirmed' ? 'The wearer asked for help after a fall.' : 'A fall was detected and nobody answered the countdown.' } });
          }
        },
        status: (th, s: Status) => set((st) => ({ remote: { ...st.remote, [th]: { online: s.online, ts: s.ts ?? Date.now(), fw: s.fw, rate: s.rate } } })),
      });
      set({ watching: thing });
      await live.connect('cloud', undefined, src);
      if (live.getSnapshot().conn === 'error') set({ watching: null });
    } catch (e) { set({ watching: null, error: msg(e) }); }
  }

  async stopWatching() {
    if (live.sourceKind === 'cloud') await live.disconnect();
    set({ watching: null });
  }

  async syncNow(includeMeds: boolean) {
    if (!this.api) return;
    set({ busy: 'Syncing…', error: null });
    try {
      await this.identity();
      const since = get().sync.at;
      const last = await syncNow(this.api, localIO, { includeMeds, since });
      const prefs = { at: last.at - 60_000, includeMeds };       // re-ask for the last minute next time: clocks differ between devices
      writePrefs(prefs);
      set({ sync: { ...prefs, last } });
    } catch (e) { set({ error: 'Sync failed: ' + msg(e) }); }
    finally { set({ busy: null }); }
  }

  setIncludeMeds(v: boolean) { const p = { ...get().sync, includeMeds: v }; writePrefs({ at: p.at, includeMeds: v }); set({ sync: p }); }

  async deleteCloudData(account: boolean) {
    if (!this.api) return;
    set({ busy: 'Deleting…', error: null });
    try {
      const r = await this.api.deleteMe(account);
      writePrefs({ at: 0, includeMeds: get().sync.includeMeds });
      set({ sync: { at: 0, includeMeds: get().sync.includeMeds, last: null }, devices: [], days: [], events: [], notice: `Deleted ${r.deleted} items from the cloud${account ? ' and the account' : ''}.` });
      if (account) await this.signOut();
    } catch (e) { set({ error: 'Delete failed: ' + msg(e) }); }
    finally { set({ busy: null }); }
  }

  /** Test hook: the key the setup is stored under. */
  static CONFIG_KEY = CONFIG_KEY;
}

export const cloud = new CloudClient();
