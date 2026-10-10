# Contributing

Live demo: https://industryproof.up.railway.app (redirects to `/prototype/`). Standalone FabTwin is at `/index.html`.

## Branches and deploys

- `main` is the demo. Every push to `main` deploys to Railway automatically (service `web` in the Railway project `industryproof-demo`).
- Don't push to `main` directly. Work on a branch and open a pull request into `main`.
- Name branches `<your-name>/<topic>`, e.g. `claire/dashboard-copy` or `shubham/new-scenario`.
- Keep pull requests small and merge them quickly. We have one deadline and one demo.

```bash
git fetch origin
git checkout main && git pull
git checkout -b <your-name>/<topic>
# ... work, then:
npm test
git push -u origin <your-name>/<topic>
gh pr create --base main --fill      # or open the PR on GitHub
```

Before you merge, run `npm test` and click through the flow locally (below). Once your PR is merged, check the live site a minute or two later.

## Run it locally

Use Node 22 or later. There are no npm dependencies.

```bash
npm start            # http://localhost:5173 -> /prototype/
```

Create `.env.local` in the repo root. It is gitignored: never commit it and never paste the API key in Slack.

```
ELEVENLABS_AGENT_ID=<ask Sang; it is the public agent id>
```

- Without `ELEVENLABS_AGENT_ID`, the call plays a scripted sample instead of the live Sam.
- The credential signing key (`ISSUER_PRIVATE_JWK`) is generated automatically on first start. Local credentials are signed with your own key, so they won't verify on the live site, and that's expected.
- `ELEVENLABS_API_KEY` is needed only to change Sam's settings (`npm run agent`). Ask Sang before changing Sam: the live demo uses the same agent.

Use Chrome with headphones. Sam's voice and the alarm horn leak into a laptop microphone.

## Where things live

| Area | Files | Notes |
| --- | --- | --- |
| Product screens (company, candidate, public) | `prototype/index.html` | One file, vanilla JS |
| Live call (Sam, cues, client tools) | `prototype/lib/live-call.js` | Director cues and timing constants are at the top |
| Voice signals | `prototype/lib/voice-metrics.js`, `signal-panel.js` | Tests in `tests/voice-metrics.test.mjs` |
| Scoring, rubric, sample candidates | `prototype/lib/assessment.js`, `samples.js` | Tests in `tests/assessment.test.mjs` |
| Credentials (verify) | `prototype/lib/credential-client.js`, `server.mjs` | ECDSA P-256 over `JSON.stringify(record)` |
| 3D twin | `index.html`, `src/` | Embed mode is `?embed=1`; the bridge is `src/bridge.js` |
| Scenario | `scenarios/etch2-pressure-fault.json` | Timeline, reactions, expectations, penalties |
| Sam (ElevenLabs agent) | `agent/prompt.md`, `agent/agent.config.json`, `scripts/create-agent.mjs` | Apply changes with `npm run agent` |
| Server | `server.mjs` | Static files plus `/api/*`; zero dependencies |

How the parts talk to each other (postMessage types, director cues, tool names, result and credential shapes) is defined in `docs/INTEGRATION.md`. If you change one side, update the other side and that doc in the same PR.

## Common changes

- **Copy or layout on a screen**: edit `prototype/index.html`. Check the page at 1280×800 and 1440×900.
- **What Sam says or when**: the lines are in `agent/prompt.md` (then run `npm run agent`); the timing is in `prototype/lib/live-call.js`.
- **Scoring**: `prototype/lib/assessment.js`. Keep the 8 rubric ids (`a1`–`a4`, `v1`–`v4`), or update the dashboard and `docs/INTEGRATION.md` together.
- **A new scenario**: copy `scenarios/etch2-pressure-fault.json`. FabTwin loads it with `?scenario=<name>`. The shell, rubric and Sam's prompt are written for Etch 2, so a new scenario needs all three.

## Secrets and accounts

- Railway (`industryproof-demo`) and ElevenLabs are on Sang's accounts. Ask Sang for access or for deploy changes.
- Railway holds `BIND_HOST`, `ELEVENLABS_AGENT_ID`, `ISSUER_KEY_ID` and `ISSUER_PRIVATE_JWK`. The ElevenLabs API key is not on Railway; the server doesn't need it.
