import { useSettings } from '../state/settings';

export default function Settings() {
  const st = useSettings();
  return (
    <div className="page">
      <div className="hero-text"><h1>Settings</h1><p>Stored in this browser only.</p></div>
      <section className="card">
        <div className="card-title"><span>Accessibility</span></div>
        <label className="check"><input type="checkbox" checked={st.largeText} onChange={(e) => st.set({ largeText: e.target.checked })} /> Larger text</label>
        <p className="fine">Animations follow your system's "reduce motion" setting.</p>
      </section>
      <section className="card">
        <div className="card-title"><span>Coming later</span></div>
        <ul className="fine" style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: 4 }}>
          <li>Units, detection thresholds and pose range (milestones 2–3)</li>
          <li>Export your data as JSON or CSV, and "delete all my data" (milestone 2, cloud part in 6)</li>
          <li>Account and cloud sync (milestone 6–7)</li>
        </ul>
      </section>
      <p className="fine"><a href="#/about">About, licences and limitations</a></p>
    </div>
  );
}
