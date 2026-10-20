// In-app medication reminder, shown on every screen while a dose is due.
import { reminders, useDueDoses } from '../data/reminders';
import { MEDS } from '../config/thresholds';

export default function ReminderBanner() {
  const due = useDueDoses();
  if (!due.length) return null;
  const o = due[0];
  const time = new Date(o.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="reminder" role="status" aria-live="polite">
      <div>
        <b>Time for {o.med.name}</b>
        <span className="fine"> {o.med.dose ? `${o.med.dose} · ` : ''}scheduled {time}{due.length > 1 ? ` · ${due.length - 1} more due` : ''}</span>
      </div>
      <div className="btn-row">
        <button className="btn sm primary" onClick={() => void reminders.log(o, 'taken')}>Taken</button>
        <button className="btn sm" onClick={() => reminders.snooze(o)}>{MEDS.snoozeMin} min</button>
        <button className="btn sm ghost" onClick={() => void reminders.log(o, 'skipped')}>Skip</button>
      </div>
    </div>
  );
}
