// What every transport (USB, Bluetooth, Wi-Fi, cloud, demo, replay) implements. Kept free of browser APIs so tools can import it.
export type SourceKind = 'serial' | 'websocket' | 'ble' | 'demo' | 'replay' | 'cloud';
export type ConnState = 'idle' | 'connecting' | 'open' | 'error';

export interface SourceCallbacks {
  line: (line: string) => void;
  state: (s: ConnState, message?: string) => void;
}

export interface DeviceSource {
  readonly kind: SourceKind;
  /** How long without data before the view calls it stale (default 1.5 s; the cloud sends a summary every 1-5 s). */
  readonly staleMs?: number;
  start(cb: SourceCallbacks): Promise<void>;
  stop(): Promise<void>;
  /** Sends text to the device (sensitivity '1'..'5'). Not all sources support it. */
  send?(text: string): Promise<void>;
}
