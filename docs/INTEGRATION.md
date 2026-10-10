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
| `/` | The shell (the demo entry point), served from `prototype/index.html` with `<base href="/prototype/">` |
| `/index.html` | FabTwin on its own |
| `/index.html?embed=1&dev=0&debug=0` | FabTwin in embed mode (used by the shell iframe) |
| `/prototype/` | The shell (same page as `/`) |
| `/badge/:id` | The shell opened on the public screen for that credential, with link-preview tags (see Badge). `404` if the id is unknown. |
| `GET /api/config` | `{ agentId, issuerKeyId }`. The agentId is public because the agent is public for the demo. |
| `GET /api/issuer-keys` | `{ keys: { "<kid>": <public JWK P-256> } }` |
| `POST /api/credentials` | Body `{ record }`. Returns `{ id, record, signature, key }` and stores it. |
| `GET /api/credentials/:id` | A stored credential (`404` if unknown) |
| `GET /api/credentials` | List of `{ id, candidate, assessed_at, status }` |

`.env.local` keys: `ELEVENLABS_API_KEY` (server and scripts only, never sent to the browser), `ELEVENLABS_AGENT_ID`, `ISSUER_PRIVATE_JWK` (one-line JSON, P-256), `ISSUER_KEY_ID`.

### Credential format (must match the prototype's verifier)

`{ id: "cred_<12 hex>", record: {...}, signature: <base64url raw r||s>, key: <kid> }`.
`signature = ECDSA P-256 / SHA-256 over UTF-8 bytes of JSON.stringify(record)`, with keys in the exact order the record was given. Node signs with `crypto.sign("sha256", data, { key, dsaEncoding: "ieee-p1363" })`. The browser verifies with `crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"}, key, sig, data)`, choosing the public key by `key` from `/api/issuer-keys`.

Record fields, in this order: `issuer, assessment, scenario_id, company, rubric_version, rubric_approved_by, candidate, role, assessed_at, status, score, max_score, auto_fail, items, competencies, signals, evidence_digest`.
- `items`: `{ <rubricId>: boolean }`
- `competencies`: `{ <competencyId>: 1-5 | null }` in rubric order (rubric `etch-v2` and later). `null` means not assessed. The server accepts records without it, so credentials signed under `etch-v1` still verify; they just have no badge.
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

### Competencies (rubric `etch-v2`)

Eleven competencies, each scored 1-5, sit next to the 8 checks. They never change pass/fail. Each one adds up weighted indicators to a score out of 100, then bands it: 90+ is 5, 75+ is 4, 55+ is 3, 35+ is 2, otherwise 1. Caps apply after banding. An indicator whose data is missing is skipped and the rest are renormalised. A competency with no data at all is `null` ("Not assessed"), never a 1. Definitions, the anchors at levels 1, 3 and 5, and the scoring are in `COMPETENCIES_ETCH` and `scoreCompetencies()` in `prototype/lib/assessment.js`.

Levels: 1 Not yet, 2 Developing, 3 Proficient, 4 Strong, 5 Exemplary.

| id | group | label | from | `null` when | caps |
| --- | --- | --- | --- | --- | --- |
| `procedure` | technical | Following procedure | the scenario's six steps after the alarm, at the scenario's weights; half credit when late | no 3D log | |
| `deliberate_action` | technical | Deliberate action | checked Etch 2 before the first state change; share of purposeful actions (stray and failed tries count against); hold within 30 s of inspecting; went straight to Etch 2 | no 3D log | reset or EMO: max 2 |
| `safety_judgment` | technical | Safety judgment | held Etch 2; lot kept off the faulted tool; nothing sent to ETCH-03; no healthy tool held | no 3D log | reset or EMO: 1 |
| `fab_tools` | technical | Working with semiconductor fab tools | read out the alarm details (by voice or in the note); used Hold; chose ETCH-01; used the terminal; maintenance on the right tool | no 3D log | |
| `situational_awareness` | technical | Situational awareness | time to reach Etch 2; time to a safe state (hold + reroute); where LOT-4471 ended up | no 3D log or no alarm | |
| `composure` | behavioural | Composure under pressure | `signals.composure`, with tone drift, hesitation, pace and pushback time as evidence. Voice-based, so labelled that way. | no voice signals | EMO: max 2 |
| `clarifying_questions` | behavioural | Asking clarifying questions | questions to Sam; checked the Etch 2 screen before answering the reset push; opened the terminal after the alarm | no 3D log | |
| `problem_solving` | behavioural | Problem solving | contained the fault; moved the lot to ETCH-01; explained the reasoning aloud; raised maintenance | no 3D log | |
| `integrity` | behavioural | Integrity under pressure | refused push 1; held firm on push 2; acknowledged the pressure; offered a way forward | neither push delivered | reset: 1 |
| `collaboration` | behavioural | Collaboration and communication | shift-report coverage; spoken updates; written note; maintenance; engaged with Sam | candidate never spoke | |
| `ownership` | behavioural | Ownership and follow-through | share of spoken commitments carried out; gave a report; the report owns their mistakes | no 3D log, or candidate never spoke | broken promise: max 3 |

```
{
  candidate: { name, initials, role: "Equipment Technician", assessed_at },
  scenario: { id: "etch2-pressure-fault", title: "Etch 2 chamber pressure fault", duration_sec },
  result: { status, score, max_score: 8, auto_fail, auto_fail_reason },
  items: { a1: { passed, evidence, t, via: "action"|"voice"|"both", critical? }, ... },
  competencies: { procedure: { level: 1-5|null, score: 0-100|null, via, evidence: [ { ok: true|false|null, text, t, quote? } ] }, ... },
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

## Badge

A credential earns a shareable badge, "Etch Tool Fault Response" (`BADGE_ETCH`), when `status` is `pass`, `auto_fail` is false and the record has `competencies`. `prototype/lib/badge.js` builds everything from the **signed record**, so a shared badge always matches what verifies.
- **Candidate, Submitted screen**:
  - A pass shows the badge card and share options: LinkedIn "Add to profile" (Licenses & certifications), a LinkedIn post, X, Facebook, Copy link, Download image (1200×630 PNG drawn in the browser), and the system share sheet where available.
  - A fail shows a private skills report: the same levels, the two strongest competencies, and the two weakest with the next anchor up. It has no share options.
- **Share link**: `/badge/<id>`. The server serves the shell with `og:*` and `twitter:card=summary_large_image` tags from `shareHead()`. The title and description name the candidate and their top competencies, and the image is the generic `prototype/badge-og.png`, since crawlers can't read SVG and the server has no image library. A failed or unknown credential gets generic tags and `noindex`, so a link preview never shows a failed result.
- **Public screen**: when the signature checks out, the badge card appears above the result. A changed record never shows it.

## File ownership (parallel build)

| Owner | Files |
| --- | --- |
| Server and credentials | `server.mjs`, `scripts/gen-issuer-key.mjs`, `package.json` (scripts only), `data/` (runtime store, gitignored) |
| Agent | `scripts/create-agent.mjs`, `agent/prompt.md`, `agent/agent.config.json` |
| FabTwin embed | `src/bridge.js` (new), `src/main.js`, `src/audio.js`, `src/config.js`, `src/hud.js`, `src/styles.css`, `index.html`, `tests/` |
| Voice signals | `prototype/lib/voice-metrics.js`, `prototype/lib/signal-panel.js`, `tests/voice-metrics.test.mjs` |
| Assessment and samples | `prototype/lib/assessment.js`, `prototype/lib/samples.js`, `tests/assessment.test.mjs` |
| Shell integration | `prototype/index.html`, `prototype/lib/live-call.js`, `prototype/lib/credential-client.js` |
