// Live view of a remote headset: MQTT over a signed WebSocket straight to AWS IoT Core, with the temporary
// credentials of this user's identity (the identity pool's role only allows this user's own topics).
//
//   subscribe  tremor/v1/<identity>/<thing>/{telemetry,event,status}
//   publish    .../viewer  (retained) "someone is watching" -> the headset sends 1 summary per second instead of 1 per 5 s,
//                          and falls back by itself when the flag expires (a forgotten tab cannot keep the rate high)
//              .../cmd     sensitivity changes
//
// The summaries are turned into the same '$' lines the headset streams over USB, so the Live screen needs no special case.
import type { DeviceSource, SourceCallbacks } from '../device/types';
import { topic, validateEvent, validateStatus, validateTelemetry, type DeviceEvent, type Status } from '../logic/protocol';
import type { CloudConfig } from './config';
import { telemetryToLine } from './cloudLine';
import { presignIotWebSocket, type Credentials } from './sigv4';

export interface LiveSession {
  identityId(): Promise<string>;
  credentials(): Promise<Credentials>;
}
export interface LiveHandlers {
  event?: (thing: string, ev: DeviceEvent) => void;
  status?: (thing: string, s: Status) => void;
}

export const WATCH_TTL_MS = 90_000;
export const WATCH_RENEW_MS = 30_000;
const MAX_RECONNECTS = 6;

type MqttModule = typeof import('mqtt');
type MqttClient = ReturnType<MqttModule['connect']>;

export class CloudSource implements DeviceSource {
  readonly kind = 'cloud' as const;
  /** Summaries arrive every 1-5 s: the Live screen must not call that "no data" after 1.5 s. */
  readonly staleMs = 12_500;
  private client: MqttClient | null = null;
  private stopped = false;
  private retries = 0;
  private renew: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cb: SourceCallbacks | null = null;
  private owner = '';

  constructor(
    private readonly cfg: CloudConfig,
    private readonly session: LiveSession,
    readonly thing: string,
    private readonly handlers: LiveHandlers = {},
    private readonly loadMqtt: () => Promise<MqttModule> = async () => ((await import('mqtt')) as unknown as { default: MqttModule }).default ?? (await import('mqtt')),
  ) {}

  async start(cb: SourceCallbacks): Promise<void> {
    this.cb = cb;
    this.stopped = false;
    this.retries = 0;
    cb.state('connecting', 'Connecting to the cloud…');
    this.owner = await this.session.identityId();
    await this.connect();
  }

  private async url(): Promise<string> {
    if (this.cfg.mqttUrl) return this.cfg.mqttUrl;                       // local test backend: no signature
    return presignIotWebSocket(this.cfg.iotEndpoint, this.cfg.region, await this.session.credentials());
  }

  private async connect(): Promise<void> {
    const cb = this.cb!;
    const mqtt = await this.loadMqtt();
    const url = await this.url();
    const t = (k: Parameters<typeof topic>[2]) => topic(this.owner, this.thing, k);
    const client = mqtt.connect(url, {
      clientId: `${this.owner}-web-${Math.random().toString(36).slice(2, 8)}`,   // the policy allows client ids "<identity>" and "<identity>-*"
      protocolVersion: 4, keepalive: 30, clean: true, reconnectPeriod: 0, connectTimeout: 15_000,
    });
    this.client = client;

    client.on('connect', () => {
      this.retries = 0;
      client.subscribe([t('telemetry'), t('event'), t('status')], { qos: 1 }, (err) => {
        if (err) { cb.state('error', 'Subscribing failed: ' + err.message); return; }
        cb.state('open', `Watching ${this.thing} through the cloud.`);
        this.announce(true);
        this.renew = setInterval(() => this.announce(true), WATCH_RENEW_MS);
      });
    });
    client.on('message', (tp, payload) => {
      let m: unknown;
      try { m = JSON.parse(payload.toString()); } catch { return; }
      if (tp.endsWith('/telemetry')) { const v = validateTelemetry(m); if (v.ok) cb.line(telemetryToLine(v.value)); }
      else if (tp.endsWith('/event')) { const v = validateEvent(m); if (v.ok) this.handlers.event?.(this.thing, v.value); }
      else if (tp.endsWith('/status')) { const v = validateStatus(m); if (v.ok) this.handlers.status?.(this.thing, v.value); }
    });
    client.on('error', (e) => { if (!this.stopped) cb.state('connecting', 'Cloud connection problem: ' + e.message); });
    client.on('close', () => {
      if (this.renew) { clearInterval(this.renew); this.renew = null; }
      if (this.stopped || this.client !== client) return;
      this.reconnect();
    });
  }

  /** New signed URL each attempt: the old one expires within minutes and the credentials within an hour. */
  private reconnect() {
    const cb = this.cb!;
    if (this.retries >= MAX_RECONNECTS) { cb.state('error', 'The cloud connection was lost. Open Cloud and watch again.'); return; }
    const delay = Math.min(30_000, 1000 * 2 ** this.retries++);
    cb.state('connecting', `Cloud connection lost. Reconnecting in ${(delay / 1000).toFixed(0)} s…`);
    this.timer = setTimeout(() => { if (!this.stopped) this.connect().catch((e) => { if (!this.stopped) { cb.state('connecting', String(e.message ?? e)); this.reconnect(); } }); }, delay);
  }

  private announce(watching: boolean) {
    const c = this.client;
    if (!c?.connected) return;
    c.publish(topic(this.owner, this.thing, 'viewer'), JSON.stringify({ v: 1, watching, until: watching ? Date.now() + WATCH_TTL_MS : 0 }), { qos: 1, retain: true });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.renew) clearInterval(this.renew);
    const c = this.client;
    this.client = null;
    if (c) {
      this.announce2(c);
      await new Promise<void>((r) => { const t = setTimeout(r, 800); c.end(false, {}, () => { clearTimeout(t); r(); }); });
    }
    this.cb?.state('idle');
  }
  private announce2(c: MqttClient) {
    if (c.connected) c.publish(topic(this.owner, this.thing, 'viewer'), JSON.stringify({ v: 1, watching: false, until: 0 }), { qos: 1, retain: true });
  }

  /** Sensitivity 1-5, as a command to the headset. */
  async send(text: string): Promise<void> {
    const m = /^([1-5])\n?$/.exec(text);
    if (!m || !this.client?.connected) return;
    this.client.publish(topic(this.owner, this.thing, 'cmd'), JSON.stringify({ v: 1, sens: Number(m[1]) }), { qos: 1 });
  }
}
