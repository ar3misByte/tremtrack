import { cloud, useCloud } from '../cloud/client';

/** Shown on the Live screen while the view comes from the cloud instead of a cable or Bluetooth. */
export default function CloudNote() {
  const c = useCloud();
  return (
    <>
      <div className="notice" role="status">
        <span>
          Remote view through the cloud{c.watching ? `: ${c.watching}` : ''}. It updates every second while you watch, with no waveform and no vitals trace.
          Nothing from this view is saved on this device.
        </span>
        <button className="btn sm" onClick={() => void cloud.stopWatching()}>Stop watching</button>
      </div>
      {c.alert && (
        <div className="notice warn" role="alert">
          <span><b>{c.alert.thing}</b>: {c.alert.text}</span>
          <button className="btn sm" onClick={() => useCloud.setState({ alert: null })}>Dismiss</button>
        </div>
      )}
    </>
  );
}
