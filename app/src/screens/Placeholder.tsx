// Screens that arrive in later milestones. They say plainly what will be here and when.
export default function Placeholder({ title, milestone, items }: { title: string; milestone: number; items: string[] }) {
  return (
    <div className="page">
      <div className="hero-text"><h1>{title}</h1><p>Arrives in milestone {milestone}.</p></div>
      <section className="card placeholder">
        <div className="card-title"><span>What this screen will show</span><span className="chip quiet">Not built yet</span></div>
        <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
      </section>
    </div>
  );
}
