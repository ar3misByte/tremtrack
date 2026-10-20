export default function About() {
  return (
    <div className="page">
      <div className="hero-text"><h1>About</h1><p>Head Tremor Monitor, prototype {__APP_VERSION__}</p></div>
      <section className="card">
        <div className="card-title"><span>What this is, and is not</span></div>
        <p className="muted">A demonstration prototype that tracks head motion from a head-worn ESP32 and MPU6050, and heart rate from a MAX30102 hobby sensor.
          It is <b>not a medical device</b>. It does not diagnose any condition, its measurements have not been clinically validated, and its SpO₂ value is an uncalibrated estimate.
          Talk to a doctor about any health concern.</p>
      </section>
      <section className="card">
        <div className="card-title"><span>Known limits</span></div>
        <ul className="fine" style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: 4 }}>
          <li>Tremor alerts take about 1.7 s to appear.</li>
          <li>While walking, a tremor at a multiple of the step rate can't be separated from step bounce.</li>
          <li>Turn (yaw) drifts until the magnetometer is added (milestone 8).</li>
          <li>The detector has been tested on simulated motion only, not on real heads.</li>
          <li>Fall detection is a heuristic: it misses slow slumps and soft landings, and dropping the headset looks like a fall. Caregiver alerts are not set up yet (milestone 6).</li>
          <li>Posture is measured against your own calibrated neutral position; recalibrate if the headset shifts.</li>
          <li>The SpO₂ value, including resting values, is an uncalibrated estimate.</li>
          <li>Insights show associations in your own data, never causes; the pattern wording has not been clinically reviewed.</li>
          <li>Medication reminders only work while the app is open; the app gives no medical advice.</li>
        </ul>
      </section>
      <section className="card">
        <div className="card-title"><span>Credits and licences</span></div>
        <ul className="fine" style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: 4 }}>
          <li>3D head: built procedurally in code for this project (no third-party model).</li>
          <li>Manrope typeface by Mikhail Sharanda, SIL Open Font License 1.1.</li>
          <li>JetBrains Mono, SIL Open Font License 1.1.</li>
          <li>three.js and React Three Fiber, MIT licence. React, MIT licence.</li>
        </ul>
      </section>
    </div>
  );
}
