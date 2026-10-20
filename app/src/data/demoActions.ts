// Side effects of the scripted demo showcase: a coffee tag and a dose of a demo medication, flagged as
// demo data like everything else the demo produces (hidden or deleted with the other demo data).
import type { DemoAction } from '../logic/demoGen';
import type { Medication } from '../logic/model';
import { newId } from '../logic/tracker';
import { listMeds, putDose, putMed, putTag } from './db';

const DEMO_MED: Medication = { id: 'm_demo', name: 'Demo medication', dose: '1 tablet', times: ['09:00', '21:00'], days: [], active: false, createdAt: 0, demo: true };

export async function runDemoAction(a: DemoAction) {
  const t = Date.now();
  if (a === 'tag-coffee') await putTag({ id: newId('t', t), t, kind: 'coffee', label: null, demo: true });
  if (a === 'dose') {
    const meds = await listMeds({ includeDemo: true });
    if (!meds.some((m) => m.id === DEMO_MED.id)) await putMed({ ...DEMO_MED, createdAt: t }, false);   // paused: no reminders
    await putDose({ id: newId('d', t), medId: DEMO_MED.id, scheduledFor: null, takenAt: t, status: 'taken', loggedAt: t, demo: true });
  }
}
