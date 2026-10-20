# Doctor report (milestone 5)

The Report tab makes a PDF for a chosen period (7, 30, 90 days or custom dates) **in the browser**. Nothing is uploaded.

- **Code:** `app/src/logic/reportData.ts` (what goes in, pure and tested), `app/src/report/pdf.ts` (layout, jsPDF), `app/src/screens/Report.tsx`.
- **Tests:** `reportData.test.ts` and `pdf.test.ts` (every section present, the disclaimer, the demo watermark, no disease names), and `npm run e2e:report -w app`, which downloads the PDF from the real app.

## Contents

1. **Cover and summary**
   - period and optional name: printed only, never stored;
   - a plain-language disclaimer: a prototype, not a medical device, not a diagnosis, an engineering score;
   - at-a-glance figures: days monitored, hours, episodes, time with tremor, mean and highest daily score, falls flagged;
   - the daily severity chart (bars plus the 7-day average) and a weekly table.
2. **Patterns and findings**
   - a descriptive tremor pattern: direction shares, frequency median and IQR, combined-axis share and pattern, regularity, walking share;
   - the pattern hints with their confidence and evidence, under the "not clinically reviewed" note;
   - tag comparisons: forest plot plus a table with counts, intervals and verdicts;
   - medication: adherence table (taken, on time, late, skipped, missed), and the paired before/after effect with interval and counts;
   - heart rate during and before episodes.
3. **Posture and stillness**: still, restless, and share of time outside the calibrated neutral pose.
4. **Resting heart rate and SpO₂ estimate**: two single-axis charts and any flags, with the uncalibrated-sensor note.
5. **Falls and sudden impacts**: every candidate with peak g, free fall, how far the head turned, and the user's response.
6. **Episode table**: date, time, duration, axes, pattern, frequency, amplitude, score, walking.
   - Up to 50, 150 or 500 rows.
   - When there are more episodes, the highest-scoring are listed in time order, and the report says so. All episodes still count in the figures.
7. **About this report**: the device, how detection works, limits (simulation-tested only, walking harmonic), and that comparisons are associations.

Every page has a footer: "prototype - not a medical device - generated <date> - page x of y". When demo, replay or sample data is included, every page is marked **CONTAINS DEMO / SAMPLE DATA - NOT FROM A REAL PERSON**.

## Technical notes

- **Loading:** jsPDF is loaded only when you make a report, so the app's first load doesn't change.
- **Charts** are drawn as vectors (sharp when printed).
- **Speed:** a 30-day report is about 7 pages and 30–40 KB, made in under a second on a laptop.
- **Font:** the standard PDF font (Helvetica) only covers Latin-1, so text goes through a small substitution (`SpO₂` → `SpO2`, `≥` → `>=`, dashes → `-`). Medication names in non-Latin scripts would lose characters; embedding a Unicode font is listed as a later improvement.
- **Checking the output:** `node scripts/pdf-shots.mjs <file.pdf>` renders the pages to PNG with pdf.js in Chromium (needs `npm run dev`); `scripts/pdf-preview.html` is a dev-only helper for this.
- **Optional server-side generation** (a Lambda writing the PDF to S3 with a short-lived link) is deferred until the cloud backend exists (milestone 6+).
