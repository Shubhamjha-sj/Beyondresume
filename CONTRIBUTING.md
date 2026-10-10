# Contributing

Live demo: https://industryproof.up.railway.app. Standalone FabTwin is at `/index.html`.

If you use a coding AI (Claude Code, Codex, Cursor), point it at this file and `docs/INTEGRATION.md` first. Together they cover setup, branch rules and how the parts fit together.

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
ELEVENLABS_AGENT_ID=agent_0401m4jgd5j3enz9rhvbrrjw0t6m
```

This is Sam's public agent id. It isn't a secret: the live site serves it from `/api/config`.

- Without `ELEVENLABS_AGENT_ID`, the call plays a scripted sample instead of the live Sam.
- The credential signing key (`ISSUER_PRIVATE_JWK`) is generated automatically on first start. Local credentials are signed with your own key, so they won't verify on the live site, and that's expected.
- You don't need `ELEVENLABS_API_KEY`. To change Sam, edit `agent/prompt.md` or `agent/agent.config.json` in a PR. After it merges, the key holder runs `npm run agent` to apply it to the live agent. Don't create your own copy of Sam for the demo.

Use Chrome with headphones. Sam's voice and the alarm horn leak into a laptop microphone.

## Where things live

| Area | Files | Notes |
| --- | --- | --- |
| Product screens (company, candidate, public) | `prototype/index.html` | One file, vanilla JS |
| Live call (Sam, cues, client tools) | `prototype/lib/live-call.js` | Director cues and timing constants are at the top |
| Voice signals | `prototype/lib/voice-metrics.js`, `signal-panel.js` | Tests in `tests/voice-metrics.test.mjs` |
| Scoring, rubric, competencies, sample candidates | `prototype/lib/assessment.js`, `samples.js` | Tests in `tests/assessment.test.mjs` |
| Skills badge, share links, link previews | `prototype/lib/badge.js`, `prototype/badge-og.png` | Tests in `tests/badge.test.mjs`; served at `/badge/<id>` |
| Credentials (verify) | `prototype/lib/credential-client.js`, `server.mjs` | ECDSA P-256 over `JSON.stringify(record)` |
| 3D twin | `index.html`, `src/` | Embed mode is `?embed=1`; the bridge is `src/bridge.js` |
| Scenario | `scenarios/etch2-pressure-fault.json` | Timeline, reactions, expectations, penalties |
| Sam (ElevenLabs agent) | `agent/prompt.md`, `agent/agent.config.json`, `scripts/create-agent.mjs` | Apply changes with `npm run agent` |
| Server | `server.mjs` | Static files plus `/api/*`; zero dependencies |

How the parts talk to each other (postMessage types, director cues, tool names, result and credential shapes) is defined in `docs/INTEGRATION.md`. If you change one side, update the other side and that doc in the same PR.

## Common changes

- **Copy or layout on a screen**: edit `prototype/index.html`. Check the page at 1280×800 and 1440×900.
- **What Sam says or when**: the lines are in `agent/prompt.md` (then run `npm run agent`); the timing is in `prototype/lib/live-call.js`.
- **Scoring**: `prototype/lib/assessment.js`. Keep the 8 rubric ids (`a1`–`a4`, `v1`–`v4`) and the 11 competency ids, or update the dashboard, the badge and `docs/INTEGRATION.md` together. Competency levels are signed into the credential, so changing how they're scored means a new `rubric_version`.
- **A new scenario**: copy `scenarios/etch2-pressure-fault.json`. FabTwin loads it with `?scenario=<name>`. The shell, rubric and Sam's prompt are written for Etch 2, so a new scenario needs all three.

## Secrets and accounts

- Railway (`industryproof-demo`) and the ElevenLabs account are owned by the team lead. You don't need access to either: merging to `main` deploys, and Sam changes go through a PR as described above.
- Until Railway is connected to GitHub, deploys after a merge are run by hand with `railway up`. If the live site doesn't update within a few minutes of your merge, post in #future-of-work-hackathon.
- Railway holds `BIND_HOST`, `ELEVENLABS_AGENT_ID`, `ISSUER_KEY_ID` and `ISSUER_PRIVATE_JWK`. The ElevenLabs API key is not on Railway; the server doesn't need it.
