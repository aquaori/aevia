import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// Only the run ID written by this Actions job can select the report.
let verdict='inconclusive';
try {
  const runId=readFileSync(process.env.AEVIA_CI_RUN_ID_FILE,'utf8').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) throw new Error('Invalid run ID');
  const report=JSON.parse(readFileSync(join('tests','reports','summary','runs',runId,'lab-report.json'),'utf8'));
  const run=report.run;
  if (run.id!==runId || run.profile!=='nightly' || run.source?.revision!==process.env.GITHUB_SHA || run.validity?.status!=='valid' || run.recorded!==true) throw new Error('Report does not qualify');
  if (run.performanceVerdict==='failed') verdict='failed';
  else if (run.performanceVerdict==='passed' && run.status==='passed') verdict='passed';
} catch { /* Missing or untrusted evidence remains inconclusive. */ }
appendFileSync(process.env.GITHUB_OUTPUT,`verdict=${verdict}\n`);
console.log(`Performance qualification: ${verdict}`);
