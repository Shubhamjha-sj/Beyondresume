# Integration contract: live demo

One demo, three parts:

- **Shell**: Claire's IndustryProof prototype (`prototype/index.html`): company, candidate and public screens.
- **3D twin**: Shubham's FabTwin (`index.html` + `src/`), embedded in the shell's call screen in an iframe.
- **Voice agent**: "Sam", the AI shift lead. Sam is an ElevenLabs Agent using GPT-6 Luna with the Adam voice, and the shell talks to Sam through `@elevenlabs/client`.

Scenario: **Etch 2 chamber pressure fault** (`scenarios/etch2-pressure-fault.json`). The wet-bench copy in the prototype is replaced with this scenario.

## Serving

`npm start` runs `node server.mjs` on port 5173. The server has zero npm dependencies and reads `.env.local`.

| Route | What |
| --- | --- |
| `/` | FabTwin (unchanged when opened directly) |
| `/index.html?embed=1&dev=0&debug=0` | FabTwin in embed mode (used by the shell iframe) |
| `/prototype/` | The shell (the demo entry point) |
| `GET /api/config` | `{ agentId, issuerKeyId }`. The agentId is public because the agent is public for the demo. |
| `GET /api/issuer-keys` | `{ keys: { "<kid>": <public JWK P-256> } }` |
| `POST /api/credentials` | Body `{ record }`. Returns `{ id, record, signature, key }` and stores it. |
| `GET /api/credentials/:id` | A stored credential (`404` if unknown) |
| `GET /api/credentials` | List of `{ id, candidate, assessed_at, status }` |

`.env.local` keys: `ELEVENLABS_API_KEY` (server and scripts only, never sent to the browser), `ELEVENLABS_AGENT_ID`, `ISSUER_PRIVATE_JWK` (one-line JSON, P-256), `ISSUER_KEY_ID`.

### Credential format (must match the prototype's verifier)

`{ id: "cred_<12 hex>", record: {...}, signature: <base64url raw r||s>, key: <kid> }`.
`signature = ECDSA P-256 / SHA-256 over UTF-8 bytes of JSON.stringify(record)`, with keys in the exact order the record was given. Node signs with `crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })`. The browser verifies with `crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, key, sig, data)`, choosing the public key by `key` from `/api/issuer-keys`.

Record fields, in this order: `issuer, assessment, scenario_id, company, rubric_version, rubric_approved_by, candidate, role, assessed_at, status, score, max_score, auto_fail, items, signals, evidence_digest`.
- `items`: `{ <rubricId>: boolean }`
- `signals`: `{ tone_drift, speech_rate_delta_pct, hesitation_score, deescalation_latency_s, composure }`
- `evidence_digest`: `"sha256:<hex>"` of the JSON transcript and action log

The sample candidates are re-signed by the server at startup with the live key, so every credential verifies with the same published key.

## iframe ↔ shell protocol (`window.postMessage`)

All messages are plain objects. The child sends `{ source: "fabtwin", type, ... }` and the parent sends `{ target: "fabtwin", type, ... }`. Each side checks `event.origin === location.origin`.

**Child → parent**
| type | payload |
| --- | --- |
| `ready` | `{ scenario: { id, title, role, focusTool, timeLimit } }` once assets are loaded |
| `started` | `{ t: 0 }` when the scenario clock starts |
| `clock` | `{ t }` every 1 s while running (scenario seconds) |
| `event` | `{ event }`, a SessionLog entry of type `event` (`alarm`, `lot`, `lot_approach`, `lot_arrived`, `scenario_end`, ...) |
| `action` | `{ action }`, a SessionLog entry of type `action` (`inspect`, `ack_alarm`, `hold_tool`, `reroute`, `call_maintenance`, `notify_supervisor`, `reset_resume`, `emo`, `end_shift`), including `ok` |
| `zone` | `{ zone: { t, tool, enter } }` |
| `say` | `{ t, speaker, text }`. A scripted line FabTwin would have spoken. In embed mode FabTwin does **not** speak it: Supervisor lines become cues for Sam, and other speakers (Maintenance) appear as a subtitle in FabTwin only. |
| `ended` | `{ reason, score, log, def }`, where `score` is the `scoreSession()` output, `log` is `SessionLog.toJSON()` and `def` is the scenario JSON. In embed mode FabTwin does **not** show its own results page. |

**Parent → child**
| type | payload |
| --- | --- |
| `start` | `{ candidate }`. Unlocks audio and starts the scenario; the candidate then clicks into the 3D view to walk (pointer lock needs a click inside the iframe). |
| `end` | `{ reason }`. Ends the scenario now (`runner.end(reason)`), which leads to `ended`. |
| `subtitle` | `{ speaker, text }`. Accepted but ignored: the call screen already captions Sam right below the 3D view, so FabTwin doesn't repeat it. |

## Sam (ElevenLabs agent)

The agent is created by `scripts/create-agent.mjs`, which writes `ELEVENLABS_AGENT_ID` to `.env.local`.
- LLM: `gpt-6-luna`, reasoning effort `none`
- Voice: Adam `pNInz6obpgDQGcFmaJgB`
- Turn eagerness: `normal`
- Turn timeout: 7 s
- Max duration: 360 s
- Interruptions: on
- Language: English

Sam is Bay 3's shift lead: realistic, busy and under output pressure. He is not a villain and accepts a firm, reasoned refusal. His spoken lines are short (25 words or fewer, no lists or markdown). He never coaches the candidate or reveals the right procedure.

**Director cues.** The shell sends events Sam must react to aloud via `sendUserMessage("[FAB EVENT] ...")`. It sends silent state via `sendContextualUpdate("[FAB STATE] ...")`. Sam's prompt says that `[FAB EVENT]` / `[FAB STATE]` messages come from the simulator, not the candidate, and must never be read aloud or mentioned. The shell queues `[FAB EVENT]` cues until Sam is listening and the candidate has been silent for 700 ms or more. Cue lines are filtered out of the visible transcript.

| Cue | When (scenario time) | Sam should |
| --- | --- | --- |
| `BRIEF` | `started` | Greet, say they're covering Bay 3, ask them to walk the bay; terminal is on Tab |
| `ALARM` | `alarm` event (t≈30) | "I'm seeing an alarm on Etch 2 from here, can you check it?" (mention LOT-4471 is due there in about 90 s) |
| `PRESSURE_1` | right after the first successful `inspect` of ETCH-02, or alarm + 30 s if no inspect | Push: it does this all the time, just hit reset and resume, we're behind |
| `PRESSURE_2` | t = LOT-4471 ETA − 40 s (≈ t 80) | Push: 4471 is a hot lot for a customer, don't move it, let it run on Etch 2 |
| `LOT_ARRIVED` | `lot_arrived` for LOT-4471 | React to where it landed |
| `MAINT` | `call_maintenance` action | Brief acknowledgment that maintenance is coming (FabTwin also shows a Maintenance subtitle) |
| `WRAP_UP` | FabTwin `ended`, or t ≥ timeLimit − 45 s | Ask for "the thirty-second version for the shift report" |
| `END` | after the candidate answers WRAP_UP | Thank them and call `end_exercise` |

**Client tools** (defined on the agent; implemented in the shell; each returns a short string):
| Tool | Params | Use |
| --- | --- | --- |
| `mark_pressure` | `{ n: 1 \| 2 }` | Call when delivering a pressure line (timestamps the pressure moment) |
| `log_candidate_stance` | `{ pressure: 1 \| 2, stance: "refused" \| "complied" \| "unclear", quote: string }` | Call right after the candidate answers a pressure line |
| `log_verbal_commitment` | `{ action: "inspect" \| "ack_alarm" \| "hold_tool" \| "reroute" \| "call_maintenance" \| "notify_supervisor" \| "reset_resume" \| "emo", quote: string }` | Whenever the candidate says they will do or have done one of these |
| `end_exercise` | `{ reason: string }` | After the debrief answer |

## Assessment result (the prototype's `CANDIDATES` shape, Etch version)

Rubric for the UI (`RUBRIC_ETCH`). There are 8 items in two sections, so the existing dashboard layout works.
| id | section | label | source |
| --- | --- | --- | --- |
| `a1` | Procedure | Checked the Etch 2 control screen | action `inspect` ETCH-02 |
| `a2` | Procedure | Put Etch 2 on hold | action `hold_tool` ETCH-02 |
| `a3` | Procedure | Rerouted LOT-4471 to ETCH-01 | action `reroute` LOT-4471 → ETCH-01 |
| `a4` | Procedure | Called maintenance for Etch 2 | action `call_maintenance` ETCH-02 |
| `v1` | Under pressure | Refused the "reset and resume" shortcut | stance p1 = refused **and** no `reset_resume` action |
| `v2` | Under pressure | Kept LOT-4471 off the faulted tool | stance p2 ≠ complied **and** LOT-4471 not delivered to ETCH-02 |
| `v3` | Under pressure | Gave a clear shift report | WRAP_UP answer, or a `notify_supervisor` with content |
| `v4` | Under pressure | Did what they said | every verbal commitment has a matching action (said vs did) |

The section names "Procedure" and "Under pressure" replace "Precaution" and "Recovery" in the dashboard.
- **Auto-fail**: `reset_resume` executed on ETCH-02 (bypassed safety), or an EMO when nobody was in danger.
- **Pass**: no auto-fail and a score of 6/8 or higher.

```
{
  candidate: { name, initials, role: "Equipment Technician", assessed_at },
  scenario: { id: "etch2-pressure-fault", title: "Etch 2 chamber pressure fault", duration_sec },
  result: { status, score, max_score: 8, auto_fail, auto_fail_reason },
  items: { a1: { passed, evidence, t, via: "action"|"voice"|"both", critical? }, ... },
  timing: {
    pressure: { value, label: "Pressure line to refusal", detail },
    safe:     { value, label: "Alarm to safe state (hold + reroute)", detail },
    context:  { rate, avgPause, longestPause }
  },
  signals: { toneDrift, toneDirection, speechRateWpm, speechRateDeltaPct, hesitationScore,
             meanLatencyMs, fillerPer100, deescalationLatencyS, composure, driftSeries: [] },
  saidVsDid: [ { action, said: { t, quote } | null, did: { t } | null } ],
  transcript: [ { speaker: "agent"|"candidate", t, text } ],
  fabtwin: { overall, rating, skills, metrics }
}
```
`t` is call time in seconds since the call started. Scenario time and call time are aligned at `started`.

## File ownership (parallel build)

| Owner | Files |
| --- | --- |
| Server and credentials | `server.mjs`, `scripts/gen-issuer-key.mjs`, `package.json` (scripts only), `data/` (runtime store, gitignored) |
| Agent | `scripts/create-agent.mjs`, `agent/prompt.md`, `agent/agent.config.json` |
| FabTwin embed | `src/bridge.js` (new), `src/main.js`, `src/audio.js`, `src/config.js`, `src/hud.js`, `src/styles.css`, `index.html`, `tests/` |
| Voice signals | `prototype/lib/voice-metrics.js`, `prototype/lib/signal-panel.js`, `tests/voice-metrics.test.mjs` |
| Assessment and samples | `prototype/lib/assessment.js`, `prototype/lib/samples.js`, `tests/assessment.test.mjs` |
| Shell integration | `prototype/index.html`, `prototype/lib/live-call.js`, `prototype/lib/credential-client.js` |
