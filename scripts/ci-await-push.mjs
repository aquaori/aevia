const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN, PR_HEAD_SHA, PR_HEAD_REF, PR_HEAD_REPO } = process.env;
if (!GITHUB_TOKEN || !/^[a-f0-9]{40}$/i.test(PR_HEAD_SHA || '') || PR_HEAD_REPO !== GITHUB_REPOSITORY) {
  throw new Error('Push evidence requires a same-repository PR and a valid head SHA');
}
const headers = { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const deadline = Date.now() + 15 * 60 * 1000;
const workflows = ['quick.yml', 'ci.yml'];
while (Date.now() < deadline) {
  let pending = false;
  for (const workflow of workflows) {
    const url = new URL(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs`);
    url.search = new URLSearchParams({ event: 'push', head_sha: PR_HEAD_SHA, branch: PR_HEAD_REF, per_page: '100' });
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Cannot read ${workflow} runs: HTTP ${response.status}`);
    const data = await response.json();
    const run = data.workflow_runs?.find(item => item.head_sha === PR_HEAD_SHA && item.event === 'push' && item.head_repository?.full_name === GITHUB_REPOSITORY);
    if (!run || run.status !== 'completed') { pending = true; continue; }
    if (run.conclusion !== 'success') throw new Error(`${workflow} failed for ${PR_HEAD_SHA}: ${run.conclusion}`);
    console.log(`${workflow}: ${run.html_url} passed for ${PR_HEAD_SHA}`);
  }
  if (!pending) process.exit(0);
  await new Promise(resolve => setTimeout(resolve, 15000));
}
throw new Error('Timed out waiting for push checks on the current PR head');
