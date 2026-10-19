// Connects the live stream to local storage: one Session per connection, Episodes and 1 Hz Samples,
// flushed every few seconds so a closed tab loses at most a few seconds. Also keeps a live
// "today so far" summary for the Live screen.
import { useSyncExternalStore } from 'react';
import { live } from '../device/live';
import type { SourceKind } from '../device/sources';
import { SESSIONS } from '../config/thresholds';
import type { Frame } from '../logic/csv';
import type { Episode, Sample, Source } from '../logic/model';
import { dailyScore, type DailyScore } from '../logic/severity';
import { SessionTracker } from '../logic/tracker';
import { nextDay, startOfDay } from '../logic/daily';
import { useSettings } from '../state/settings';
import { closeStaleSessions, listEpisodes, listSessions, onDataChanged, pruneSamples, saveBatch } from './db';

export interface RecorderSnapshot {
  recording: boolean;
  sessionId: string | null;
  sessionEpisodes: number;
  sessionTremorS: number;
  sessionMonitoredS: number;
  current: Episode | null;          // episode in progress
  lastEpisode: Episode | null;
  today: DailyScore | null;         // stored today + this session so far
  storageError: string | null;
}

class Recorder {
  private tracker: SessionTracker | null = null;
  private pendingEps: Episode[] = [];
  private pendingSamples: Sample[] = [];
  private lastFrameAt = 0;
  private lastFlush = 0;
  private lastEpisode: Episode | null = null;
  private todayStored: { episodes: Episode[]; monitoredS: number; dayStart: number } = { episodes: [], monitoredS: 0, dayStart: 0 };
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private snap: RecorderSnapshot = this.makeSnap();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    live.onFrame((f, t) => this.onFrame(f, t));
    live.onConn((_kind, state) => { if (state === 'idle' || state === 'error') void this.closeSession(); });
    useSettings.subscribe((s, prev) => { if (s.sensitivity !== prev.sensitivity) this.tracker?.setSensitivity(s.sensitivity); if (s.showDemoData !== prev.showDemoData) void this.loadToday(); });
    onDataChanged(() => void this.loadToday());
    setInterval(() => this.tick(), 1000);
    addEventListener('pagehide', () => void this.flush());
    void this.loadToday();
    void closeStaleSessions().then(() => this.loadToday()).catch(() => {});
    void pruneSamples().catch(() => {});
  }

  private onFrame(f: Frame, t: number) {
    if (!this.tracker) {
      const kind = live.sourceKind;
      if (!kind) return;
      this.tracker = new SessionTracker(kind as Source, t, useSettings.getState().sensitivity);
      this.sessionEps = [];
      this.lastFlush = t;
    }
    this.lastFrameAt = t;
    for (const ev of this.tracker.push(f, t)) {
      if (ev.type === 'episode') { this.pendingEps.push(ev.episode); this.sessionEps.push(ev.episode); this.lastEpisode = ev.episode; }
      else this.pendingSamples.push(ev.sample);
    }
  }

  private tick() {
    const now = Date.now();
    if (this.tracker && now - this.lastFrameAt > SESSIONS.staleS * 1000) void this.closeSession();
    else if (this.tracker && now - this.lastFlush >= SESSIONS.flushEveryS * 1000) void this.flush();
    if (this.todayStored.dayStart && now >= nextDay(this.todayStored.dayStart)) void this.loadToday();   // midnight rollover
    this.emit();
  }

  private async closeSession() {
    if (!this.tracker) return;
    for (const ev of this.tracker.close()) {
      if (ev.type === 'episode') { this.pendingEps.push(ev.episode); this.sessionEps.push(ev.episode); this.lastEpisode = ev.episode; }
      else this.pendingSamples.push(ev.sample);
    }
    await this.flush();
    this.tracker = null;
    this.sessionEps = [];
    await this.loadToday();
  }

  private async flush() {
    const t = this.tracker;
    if (!t) return;
    this.lastFlush = Date.now();
    const episodes = this.pendingEps, samples = this.pendingSamples;
    this.pendingEps = []; this.pendingSamples = [];
    try {
      await saveBatch({ session: { ...t.session }, episodes, samples });
      this.error = null;
    } catch (e) {
      this.error = 'Could not save to this browser\'s storage: ' + (e as Error).message;
      this.pendingEps.unshift(...episodes);                 // keep for the next attempt
    }
  }

  private async loadToday() {
    const dayStart = startOfDay(Date.now());
    const includeDemo = useSettings.getState().showDemoData;
    try {
      const [eps, sessions] = await Promise.all([
        listEpisodes(dayStart, nextDay(dayStart) - 1, { includeDemo }),
        listSessions(dayStart, nextDay(dayStart) - 1, { includeDemo }),
      ]);
      const cur = this.tracker?.session.id;
      let monitoredS = 0;
      for (const s of sessions) {
        if (s.id === cur) continue;
        const span = Math.max(1, s.end - s.start);
        const overlap = Math.max(0, Math.min(s.end, nextDay(dayStart)) - Math.max(s.start, dayStart));
        monitoredS += (s.monitoredS * overlap) / span;
      }
      this.todayStored = { episodes: eps.filter((e) => e.sessionId !== cur), monitoredS, dayStart };
    } catch (e) {
      this.error = 'Could not read local storage: ' + (e as Error).message;
    }
    this.emit();
  }

  // ----- React bridge -----
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snap;
  private emit() { this.snap = this.makeSnap(); this.listeners.forEach((l) => l()); }

  private makeSnap(): RecorderSnapshot {
    const t = this.tracker;
    const includeLive = t && (useSettings.getState().showDemoData || !t.session.demo);
    const current = t?.currentEpisode() ?? null;
    const sessionEps = includeLive ? [...(this.todayStored.episodes ?? []), ...this.liveEpisodesToday(), ...(current ? [current] : [])] : this.todayStored.episodes ?? [];
    const monitored = (this.todayStored.monitoredS ?? 0) + (includeLive ? t!.session.monitoredS : 0);
    return {
      recording: !!t, sessionId: t?.session.id ?? null,
      sessionEpisodes: t?.session.episodes ?? 0, sessionTremorS: t?.session.tremorS ?? 0, sessionMonitoredS: t?.session.monitoredS ?? 0,
      current, lastEpisode: this.lastEpisode,
      today: this.todayStored.dayStart ? dailyScore({ episodes: sessionEps.map((e) => ({ ampDps: e.ampDps, freqHz: e.freqHz, durationS: e.durationS })), monitoredS: monitored }) : null,
      storageError: this.error,
    };
  }

  /** Episodes of the current session already finished (stored or pending), today only. */
  private liveEpisodesToday(): Episode[] {
    const id = this.tracker?.session.id;
    if (!id) return [];
    const seen = new Set(this.todayStored.episodes.map((e) => e.id));
    const day = this.todayStored.dayStart;
    return this.sessionEps.filter((e) => !seen.has(e.id) && e.start >= day);
  }

  private sessionEps: Episode[] = [];
}

export const recorder = new Recorder();
export const useRecorder = () => useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
export type { SourceKind };
