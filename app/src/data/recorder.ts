// Connects the live stream to local storage: one Session per connection, Episodes, 1 Hz Samples,
// resting vitals and fall events, flushed every few seconds so a closed tab loses at most a few seconds.
// Also runs the live-only flows: the fall cancel countdown, posture prompts, neutral-pose calibration,
// and a "today so far" summary for the Live screen.
import { useSyncExternalStore } from 'react';
import { live } from '../device/live';
import { SESSIONS } from '../config/thresholds';
import type { Frame } from '../logic/csv';
import type { Episode, FallEvent, Sample, Source } from '../logic/model';
import { dailyScore, type DailyScore } from '../logic/severity';
import { SessionTracker, newId, type TrackerContext } from '../logic/tracker';
import { nextDay, startOfDay } from '../logic/daily';
import { PoseCalibrator, type PoseZone } from '../logic/posture';
import type { RestingReading } from '../logic/vitals';
import { thresholds, useSettings } from '../state/settings';
import { closeStaleSessions, listEpisodes, listSessions, onDataChanged, pruneSamples, saveBatch } from './db';

export interface TodayPosture { stillS: number; restlessS: number; poseMonitoredS: number; outsidePoseS: number }

export interface RecorderSnapshot {
  recording: boolean;
  sessionId: string | null;
  sessionEpisodes: number;
  sessionTremorS: number;
  sessionMonitoredS: number;
  current: Episode | null;          // episode in progress
  lastEpisode: Episode | null;
  today: DailyScore | null;         // stored today + this session so far
  todayPosture: TodayPosture;
  lastSample: Sample | null;
  lastResting: RestingReading | null;
  fall: { event: FallEvent; deadline: number } | null;   // waiting for "I'm OK" / "Get help"
  lastFall: FallEvent | null;
  fallSupported: boolean;
  posturePrompt: Exclude<PoseZone, 'ok'> | null;
  calibration: { state: 'idle' } | { state: 'collecting'; progress: number } | { state: 'done' } | { state: 'failed'; reason: string };
  storageError: string | null;
}

const ZERO_POSTURE: TodayPosture = { stillS: 0, restlessS: 0, poseMonitoredS: 0, outsidePoseS: 0 };

class Recorder {
  private tracker: SessionTracker | null = null;
  private pendingEps: Episode[] = [];
  private pendingSamples: Sample[] = [];
  private pendingVitals: RestingReading[] = [];
  private sessionEps: Episode[] = [];
  private lastFrameAt = 0;
  private lastFlush = 0;
  private lastEpisode: Episode | null = null;
  private lastSample: Sample | null = null;
  private lastResting: RestingReading | null = null;
  private todayStored: { episodes: Episode[]; monitoredS: number; dayStart: number; posture: TodayPosture } = { episodes: [], monitoredS: 0, dayStart: 0, posture: ZERO_POSTURE };
  private fall: { event: FallEvent; deadline: number } | null = null;
  private lastFall: FallEvent | null = null;
  private fallListeners = new Set<(e: FallEvent) => void>();
  private posturePrompt: Exclude<PoseZone, 'ok'> | null = null;
  private calibrator: PoseCalibrator | null = null;
  private calibration: RecorderSnapshot['calibration'] = { state: 'idle' };
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private snap: RecorderSnapshot = this.makeSnap();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    live.onFrame((f, t) => this.onFrame(f, t));
    live.onConn((_kind, state) => { if (state === 'idle' || state === 'error') void this.closeSession(); });
    useSettings.subscribe((s, prev) => {
      if (s.sensitivity !== prev.sensitivity) this.tracker?.setSensitivity(s.sensitivity);
      if (s.neutralPose !== prev.neutralPose || s.mapping !== prev.mapping) this.tracker?.setContext(this.context());
      if (s.showDemoData !== prev.showDemoData) void this.loadToday();
    });
    onDataChanged(() => void this.loadToday());
    setInterval(() => this.tick(), 1000);
    addEventListener('pagehide', () => void this.flush());
    void closeStaleSessions().then(() => this.loadToday()).catch(() => {});
    void pruneSamples().catch(() => {});
  }

  private context(): TrackerContext {
    const s = useSettings.getState();
    const th = thresholds();
    return { neutral: s.neutralPose, mapping: s.mapping, fall: th.fall, posture: th.posture, resting: th.resting };
  }

  // ----- stream -----
  private onFrame(f: Frame, t: number) {
    if (this.calibrator) {
      const r = this.calibrator.push(f, t);
      if (r.state === 'collecting') this.calibration = r;
      else {
        this.calibrator = null;
        if (r.state === 'done') { useSettings.getState().set({ neutralPose: r.pose }); this.calibration = { state: 'done' }; }
        else this.calibration = r;
        this.emit();
      }
    }
    if (!this.tracker) {
      const kind = live.sourceKind;
      if (!kind) return;
      this.tracker = new SessionTracker(kind as Source, t, useSettings.getState().sensitivity, this.context());
      this.sessionEps = [];
      this.lastFlush = t;
    }
    this.lastFrameAt = t;
    this.handle(this.tracker.push(f, t));
  }

  private handle(events: ReturnType<SessionTracker['push']>) {
    for (const ev of events) {
      if (ev.type === 'episode') { this.pendingEps.push(ev.episode); this.sessionEps.push(ev.episode); this.lastEpisode = ev.episode; }
      else if (ev.type === 'sample') { this.pendingSamples.push(ev.sample); this.lastSample = ev.sample; }
      else if (ev.type === 'resting') { this.pendingVitals.push(ev.reading); this.lastResting = ev.reading; }
      else if (ev.type === 'posture') { if (useSettings.getState().postureMonitoring) { this.posturePrompt = ev.zone; this.emit(); } }
      else if (ev.type === 'fall') this.onFallCandidate(ev.candidate);
    }
  }

  // ----- falls -----
  private onFallCandidate(c: { t: number; path: FallEvent['path']; peakG: number; freeFallMs: number; orientationChangeDeg: number }) {
    if (!useSettings.getState().fallDetection || !this.tracker || this.fall) return;   // one countdown at a time
    const event: FallEvent = {
      id: newId('f', c.t), sessionId: this.tracker.session.id, demo: this.tracker.session.demo, t: c.t, path: c.path,
      peakG: c.peakG, freeFallMs: c.freeFallMs, orientationChangeDeg: c.orientationChangeDeg,
      outcome: 'pending', resolvedAt: null, caregiverAlert: 'not-configured',
    };
    this.fall = { event, deadline: Date.now() + thresholds().fall.cancelCountdownS * 1000 };
    void saveBatch({ events: [event] }).catch(() => {});
    this.fallListeners.forEach((l) => l(event));
    this.emit();
  }

  /** The user answered the countdown, or it ran out. Caregiver alerts need the cloud (milestone 6). */
  resolveFall(outcome: 'cancelled' | 'confirmed' | 'no-response') {
    if (!this.fall) return;
    const event: FallEvent = { ...this.fall.event, outcome, resolvedAt: Date.now(), caregiverAlert: outcome === 'cancelled' ? 'not-needed' : 'not-configured' };
    this.fall = null;
    this.lastFall = event;
    void saveBatch({ events: [event] }).catch((e) => { this.error = 'Could not save the fall event: ' + (e as Error).message; });
    this.emit();
  }

  onFall(fn: (e: FallEvent) => void) { this.fallListeners.add(fn); return () => { this.fallListeners.delete(fn); }; }
  dismissPosturePrompt() { this.posturePrompt = null; this.emit(); }

  /** Starts neutral-pose calibration on the next frames (hold still). */
  calibrate() {
    if (!live.getSnapshot().fresh) { this.calibration = { state: 'failed', reason: 'No live data. Connect the headset first.' }; this.emit(); return; }
    this.calibrator = new PoseCalibrator(useSettings.getState().mapping, thresholds().posture);
    this.calibration = { state: 'collecting', progress: 0 };
    this.emit();
  }

  // ----- housekeeping -----
  private tick() {
    const now = Date.now();
    if (this.tracker && now - this.lastFrameAt > SESSIONS.staleS * 1000) void this.closeSession();
    else if (this.tracker && now - this.lastFlush >= SESSIONS.flushEveryS * 1000) void this.flush();
    if (this.fall && now >= this.fall.deadline) this.resolveFall('no-response');
    if (this.todayStored.dayStart && now >= nextDay(this.todayStored.dayStart)) void this.loadToday();   // midnight rollover
    this.emit();
  }

  private async closeSession() {
    if (!this.tracker) return;
    this.handle(this.tracker.close());
    await this.flush();
    this.tracker = null;
    this.sessionEps = [];
    await this.loadToday();
  }

  private async flush() {
    const t = this.tracker;
    if (!t) return;
    this.lastFlush = Date.now();
    const episodes = this.pendingEps, samples = this.pendingSamples, vitals = this.pendingVitals;
    this.pendingEps = []; this.pendingSamples = []; this.pendingVitals = [];
    try {
      await saveBatch({ session: { ...t.session }, episodes, samples, vitals });
      this.error = null;
    } catch (e) {
      this.error = 'Could not save to this browser\'s storage: ' + (e as Error).message;
      this.pendingEps.unshift(...episodes);                 // keep for the next attempt
      this.pendingVitals.unshift(...vitals);
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
      const posture = { ...ZERO_POSTURE };
      for (const s of sessions) {
        if (s.id === cur) continue;
        const span = Math.max(1, s.end - s.start);
        const k = Math.max(0, Math.min(s.end, nextDay(dayStart)) - Math.max(s.start, dayStart)) / span;
        monitoredS += s.monitoredS * k;
        posture.stillS += (s.stillS ?? 0) * k;
        posture.restlessS += (s.restlessS ?? 0) * k;
        posture.poseMonitoredS += (s.poseMonitoredS ?? 0) * k;
        posture.outsidePoseS += (s.outsidePoseS ?? 0) * k;
      }
      this.todayStored = { episodes: eps.filter((e) => e.sessionId !== cur), monitoredS, dayStart, posture };
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
    const includeLive = !!t && (useSettings.getState().showDemoData || !t.session.demo);
    const current = t?.currentEpisode() ?? null;
    const stored = this.todayStored;
    const seen = new Set(stored.episodes.map((e) => e.id));
    const liveEps = includeLive ? this.sessionEps.filter((e) => !seen.has(e.id) && e.start >= stored.dayStart) : [];
    const eps = [...stored.episodes, ...liveEps, ...(includeLive && current ? [current] : [])];
    const monitored = stored.monitoredS + (includeLive ? t!.session.monitoredS : 0);
    const sp = stored.posture;
    const s = t?.session;
    const todayPosture: TodayPosture = includeLive && s
      ? { stillS: sp.stillS + (s.stillS ?? 0), restlessS: sp.restlessS + (s.restlessS ?? 0), poseMonitoredS: sp.poseMonitoredS + (s.poseMonitoredS ?? 0), outsidePoseS: sp.outsidePoseS + (s.outsidePoseS ?? 0) }
      : sp;
    return {
      recording: !!t, sessionId: s?.id ?? null,
      sessionEpisodes: s?.episodes ?? 0, sessionTremorS: s?.tremorS ?? 0, sessionMonitoredS: s?.monitoredS ?? 0,
      current, lastEpisode: this.lastEpisode,
      today: stored.dayStart ? dailyScore({ episodes: eps.map((e) => ({ ampDps: e.ampDps, freqHz: e.freqHz, durationS: e.durationS })), monitoredS: monitored }) : null,
      todayPosture, lastSample: t ? this.lastSample : null, lastResting: this.lastResting,
      fall: this.fall, lastFall: this.lastFall, fallSupported: !!t?.fallSupported,
      posturePrompt: this.posturePrompt, calibration: this.calibration, storageError: this.error,
    };
  }
}

export const recorder = new Recorder();
export const useRecorder = () => useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
