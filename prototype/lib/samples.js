// Sample results for the review dashboard: Jordan (pass) and Riley (automatic fail).
// Each is built by buildAssessment() from the same inputs a live call produces: the transcript,
// Sam's client-tool logs, the browser's voice signals and FabTwin's `ended` payload.
// The FabTwin logs and scores are real ScenarioRunner + scoreSession output for the runs
// simulated in tests/assessment.test.mjs, which checks they still match.
// Times: transcript and tool logs are call seconds; FabTwin entries are scenario seconds
// (scenario t = 0 is call t = 3).
import { buildAssessment } from './assessment.js';

const BRIEF = "Morning. You're covering Bay 3 today. Walk the aisle and get to know the tools. Your terminal is on Tab.";
const ALARM = "I'm seeing an alarm on Etch 2 from here. Can you check it? LOT-4471 is due there in about ninety seconds.";
const PRESSURE_1 = "It does that all the time. Just hit reset and resume, we're already behind today.";
const WRAP_UP = 'Okay. Give me the thirty-second version for the shift report.';

// FabTwin entries shared by both runs (scripted timeline).
const SAY_BRIEF = { t: 2, type: 'event', name: 'say', speaker: 'Supervisor', text: "Morning! You're covering Bay 3 today. Take a walk down the aisle and get familiar with the tools. Your terminal is on Tab." };
const EV_ALARM = { t: 30, type: 'event', name: 'alarm', id: 'alarm', tool: 'ETCH-02', code: 'E-4102', message: 'Chamber B pressure high', reading: 'chamberB', value: 182, limit: 120, unit: 'mTorr' };
const EV_LOT_4471 = { t: 30, type: 'event', name: 'lot', lot: 'LOT-4471', wafers: 25, product: 'DRAM word-line etch', to: 'ETCH-02', eta: 90 };
const EV_LOT_4476 = { t: 30, type: 'event', name: 'lot', lot: 'LOT-4476', wafers: 25, product: 'Liner deposition', to: 'CVD-01', eta: 170 };
const SAY_ALARM = { t: 34, type: 'event', name: 'say', speaker: 'Supervisor', text: "Heads up, I'm seeing an alarm on Etch 2 from here. Can you check it out?" };

export const SAMPLE_RUNS = {
  jordan: {
    candidate: { name: 'Jordan Lee', assessed_at: '2026-10-09T15:15:00Z' },
    callStartedAt: Date.parse('2026-10-09T15:15:00Z'),
    scenarioOffsetSec: 3,
    durationSec: 156,
    transcript: [
      { speaker: 'agent', t: 4, text: BRIEF },
      { speaker: 'candidate', t: 10.6, text: 'Morning, Sam. Got it, walking the bay now.' },
      { speaker: 'agent', t: 14.2, text: 'Good. Shout if anything looks off.' },
      { speaker: 'agent', t: 35, text: ALARM },
      { speaker: 'candidate', t: 41.6, text: 'On it. Heading to Etch 2 now.' },
      { speaker: 'agent', t: 43.4, text: 'Okay, thanks.' },
      { speaker: 'candidate', t: 45, text: "I'm on the Etch 2 screen. Chamber B pressure is 182 against a 120 limit, code E-4102." },
      { speaker: 'agent', t: 48.5, text: PRESSURE_1 },
      { speaker: 'candidate', t: 51, text: "No, I'm not resetting it. That's way over the limit, it'll just scrap wafers. I'm putting Etch 2 on hold." },
      { speaker: 'agent', t: 58, text: 'Your call. Just keep the line moving.' },
      { speaker: 'candidate', t: 61, text: "I'm moving 4471 to Etch 1. Etch 3 is down for PM, so Etch 1 is the only option." },
      { speaker: 'agent', t: 67.5, text: 'Fine.' },
      { speaker: 'agent', t: 83, text: "Hey, 4471 is a hot lot for a customer. Put it back on Etch 2 and let it run, we can't wait." },
      { speaker: 'candidate', t: 87.2, text: "I get that it's hot, but I can't do that. Etch 2 is over pressure, so the whole lot could be scrap. Etch 1 can take it now." },
      { speaker: 'agent', t: 95, text: 'Okay. Your call.' },
      { speaker: 'candidate', t: 101, text: "I'm sending you a note on the terminal so it's in the log." },
      { speaker: 'agent', t: 104.5, text: 'Got your note. Thanks.' },
      { speaker: 'agent', t: 124.5, text: '4471 just landed on Etch 1. Okay.' },
      { speaker: 'candidate', t: 133, text: "That's everything on my side. I'm ending the shift on the terminal." },
      { speaker: 'agent', t: 135.5, text: WRAP_UP },
      { speaker: 'candidate', t: 139.5, text: 'Etch 2 alarmed on chamber B pressure, 182 against a 120 limit. I put it on hold and moved 4471 to Etch 1. It still needs a maintenance ticket.' },
      { speaker: 'agent', t: 152, text: "Thanks, that's what I needed. That's the end of the exercise." },
    ],
    pressureMarks: [{ n: 1, t: 48.5 }, { n: 2, t: 83 }],
    stances: [
      { pressure: 1, stance: 'refused', quote: "No, I'm not resetting it. That's way over the limit, it'll just scrap wafers.", t: 58 },
      { pressure: 2, stance: 'refused', quote: "I get that it's hot, but I can't do that.", t: 95 },
    ],
    commitments: [
      { action: 'inspect', quote: "I'm on the Etch 2 screen.", t: 48.5 },
      { action: 'hold_tool', quote: "I'm putting Etch 2 on hold.", t: 58 },
      { action: 'reroute', quote: "I'm moving 4471 to Etch 1.", t: 67.5 },
      { action: 'notify_supervisor', quote: "I'm sending you a note on the terminal so it's in the log.", t: 104.5 },
    ],
    wrapUp: { t: 139.5, text: 'Etch 2 alarmed on chamber B pressure, 182 against a 120 limit. I put it on hold and moved 4471 to Etch 1. It still needs a maintenance ticket.' },
    signals: {
      toneDrift: 12,
      toneDirection: 'stable',
      speechRateWpm: 152,
      speechRateDeltaPct: 4,
      hesitationScore: 86,
      meanLatencyMs: 640,
      fillerPer100: 0.9,
      deescalationLatencyS: 2.5,
      composure: 85,
      driftSeries: [0, 6, 8, 12, 9, 12, 5, 4, 7],
      context: { rate: '152 words/min', avgPause: '0.6 s', longestPause: '1.8 s' },
    },
    fabtwin: {
      score: {
        overall: 80,
        rating: 'Ready with coaching',
        skills: { response: 100, procedure: 60, judgment: 100, safety: 100, communication: 100 },
        metrics: { reactionTime: 10, timeToSafe: 28, distance: 21.4, terminalChecks: 3, actionsTaken: 5 },
      },
      log: {
        entries: [
          { t: 0, type: 'event', name: 'scenario_start', scenario: 'etch2-pressure-fault' },
          SAY_BRIEF,
          { t: 9, type: 'zone', tool: 'CVD-01', enter: true },
          { t: 11, type: 'zone', tool: 'CVD-01', enter: false },
          { t: 14, type: 'zone', tool: 'ETCH-01', enter: true },
          { t: 16, type: 'zone', tool: 'ETCH-01', enter: false },
          { t: 20, type: 'zone', tool: 'ETCH-02', enter: true },
          { t: 22, type: 'zone', tool: 'ETCH-02', enter: false },
          EV_ALARM,
          EV_LOT_4471,
          EV_LOT_4476,
          SAY_ALARM,
          { t: 40, type: 'zone', tool: 'ETCH-02', enter: true },
          { t: 42, type: 'ui', name: 'tool_panel_open', tool: 'ETCH-02' },
          { t: 42, type: 'action', action: 'inspect', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 46, type: 'action', action: 'ack_alarm', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 48, type: 'action', action: 'hold_tool', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 50, type: 'ui', name: 'tool_panel_close' },
          { t: 56, type: 'ui', name: 'dashboard_open' },
          { t: 58, type: 'action', action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01', source: 'dashboard', ok: true },
          { t: 62, type: 'ui', name: 'dashboard_close' },
          { t: 95, type: 'ui', name: 'dashboard_open' },
          { t: 98, type: 'action', action: 'notify_supervisor', text: 'Etch 2 on hold, chamber B pressure 182 vs 120 limit (E-4102). LOT-4471 moved to Etch 1.', source: 'dashboard', ok: true },
          { t: 100, type: 'ui', name: 'dashboard_close' },
          { t: 101, type: 'event', name: 'say', speaker: 'Supervisor', text: 'Got it, thanks for the update.' },
          { t: 108, type: 'event', name: 'lot_approach', lot: 'LOT-4471', to: 'ETCH-01', eta: 120 },
          { t: 120, type: 'event', name: 'lot_arrived', lot: 'LOT-4471', tool: 'ETCH-01' },
          { t: 127, type: 'ui', name: 'dashboard_open' },
          { t: 130, type: 'action', action: 'end_shift', source: 'dashboard', ok: true },
          { t: 130, type: 'event', name: 'scenario_end', reason: 'ended_by_candidate' },
        ],
      },
    },
  },

  riley: {
    candidate: { name: 'Riley Chen', assessed_at: '2026-10-09T14:40:00Z' },
    callStartedAt: Date.parse('2026-10-09T14:40:00Z'),
    scenarioOffsetSec: 3,
    durationSec: 155,
    transcript: [
      { speaker: 'agent', t: 4, text: BRIEF },
      { speaker: 'candidate', t: 11.8, text: 'Uh, okay. Sure.' },
      { speaker: 'agent', t: 14.5, text: 'Good. Shout if anything looks off.' },
      { speaker: 'agent', t: 35, text: ALARM },
      { speaker: 'candidate', t: 43.5, text: 'Um, okay. Which one is Etch 2? Oh, I see it.' },
      { speaker: 'agent', t: 47, text: 'Far end, right side.' },
      { speaker: 'candidate', t: 56, text: "Okay, I'm at Etch 2. The screen says chamber B pressure high." },
      { speaker: 'agent', t: 59.5, text: PRESSURE_1 },
      { speaker: 'candidate', t: 64.8, text: "Um... okay. If it does it all the time, I'll just reset it." },
      { speaker: 'agent', t: 67, text: 'Great, thanks.' },
      { speaker: 'candidate', t: 70, text: "Okay, I hit reset. It's running again." },
      { speaker: 'agent', t: 72.5, text: 'Good.' },
      { speaker: 'agent', t: 82.5, text: 'Etch 2 alarmed again? Did someone reset it? We just lost a wafer in there.' },
      { speaker: 'candidate', t: 86, text: "Oh. Um, I'm not sure why. I'll get maintenance to look at it after." },
      { speaker: 'agent', t: 89.5, text: "Look, 4471 is a hot lot for a customer. Don't move it, just let it run on Etch 2." },
      { speaker: 'candidate', t: 95.2, text: "Okay. I'll leave it where it is." },
      { speaker: 'agent', t: 97.5, text: 'Thanks.' },
      { speaker: 'candidate', t: 103, text: 'I acknowledged the alarm on the screen.' },
      { speaker: 'agent', t: 105, text: 'Okay.' },
      { speaker: 'agent', t: 124.5, text: "4471 just landed on Etch 2 while it's alarmed. Those wafers are stuck there now." },
      { speaker: 'candidate', t: 131, text: "Oh. Okay. Um, I think that's all I can do. I'll end the shift." },
      { speaker: 'agent', t: 133.5, text: WRAP_UP },
      { speaker: 'candidate', t: 139.2, text: 'Etch 2 had a pressure alarm. I reset it, it alarmed again and we lost a wafer. 4471 is on Etch 2 now.' },
      { speaker: 'agent', t: 151, text: "Okay. Thanks, that's the end of the exercise." },
    ],
    pressureMarks: [{ n: 1, t: 59.5 }, { n: 2, t: 89.5 }],
    stances: [
      { pressure: 1, stance: 'complied', quote: "If it does it all the time, I'll just reset it.", t: 67 },
      { pressure: 2, stance: 'complied', quote: "Okay. I'll leave it where it is.", t: 97.5 },
    ],
    commitments: [
      { action: 'inspect', quote: "I'm at Etch 2. The screen says chamber B pressure high.", t: 59.5 },
      { action: 'reset_resume', quote: "I'll just reset it.", t: 67 },
      { action: 'reset_resume', quote: "I hit reset. It's running again.", t: 72.5 },
      { action: 'call_maintenance', quote: "I'll get maintenance to look at it after.", t: 89.5 },
      { action: 'ack_alarm', quote: 'I acknowledged the alarm on the screen.', t: 105 },
    ],
    wrapUp: { t: 139.2, text: 'Etch 2 had a pressure alarm. I reset it, it alarmed again and we lost a wafer. 4471 is on Etch 2 now.' },
    signals: {
      toneDrift: 49,
      toneDirection: 'tense',
      speechRateWpm: 118,
      speechRateDeltaPct: -18,
      hesitationScore: 44,
      meanLatencyMs: 1850,
      fillerPer100: 6.8,
      deescalationLatencyS: null,
      composure: 45,
      driftSeries: [0, 18, 22, 46, 31, 40, 52, 28, 35, 30],
      context: { rate: '118 words/min', avgPause: '1.9 s', longestPause: '5.6 s' },
    },
    fabtwin: {
      score: {
        overall: 0,
        rating: 'Needs more training',
        skills: { response: 100, procedure: 20, judgment: 0, safety: 40, communication: 0 },
        metrics: { reactionTime: 20, timeToSafe: null, distance: 20.5, terminalChecks: 2, actionsTaken: 3 },
      },
      log: {
        entries: [
          { t: 0, type: 'event', name: 'scenario_start', scenario: 'etch2-pressure-fault' },
          SAY_BRIEF,
          { t: 12, type: 'zone', tool: 'CVD-01', enter: true },
          { t: 15, type: 'zone', tool: 'CVD-01', enter: false },
          { t: 22, type: 'zone', tool: 'ETCH-01', enter: true },
          { t: 26, type: 'zone', tool: 'ETCH-01', enter: false },
          EV_ALARM,
          EV_LOT_4471,
          EV_LOT_4476,
          { t: 33, type: 'ui', name: 'dashboard_open' },
          SAY_ALARM,
          { t: 36, type: 'ui', name: 'dashboard_close' },
          { t: 50, type: 'zone', tool: 'ETCH-02', enter: true },
          { t: 53, type: 'ui', name: 'tool_panel_open', tool: 'ETCH-02' },
          { t: 53, type: 'action', action: 'inspect', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 67, type: 'action', action: 'reset_resume', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 71, type: 'ui', name: 'tool_panel_close' },
          { t: 76, type: 'event', name: 'alarm', tool: 'ETCH-02', code: 'E-4102', message: 'Chamber B pressure high, wafer in process scrapped', reading: 'chamberB', value: 236, limit: 120, unit: 'mTorr' },
          { t: 79, type: 'event', name: 'say', speaker: 'Supervisor', text: 'Etch 2 alarmed again? Did someone reset it? We just lost a wafer.' },
          { t: 99, type: 'ui', name: 'tool_panel_open', tool: 'ETCH-02' },
          { t: 99, type: 'action', action: 'inspect', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 100, type: 'action', action: 'ack_alarm', tool: 'ETCH-02', source: 'tool_panel', ok: true },
          { t: 102, type: 'ui', name: 'tool_panel_close' },
          { t: 108, type: 'event', name: 'lot_approach', lot: 'LOT-4471', to: 'ETCH-02', eta: 120 },
          { t: 120, type: 'event', name: 'lot_arrived', lot: 'LOT-4471', tool: 'ETCH-02' },
          { t: 121, type: 'event', name: 'say', speaker: 'Supervisor', text: "LOT-4471 just landed on Etch 2 while it's alarmed. Those wafers are stuck there now." },
          { t: 125, type: 'ui', name: 'dashboard_open' },
          { t: 128, type: 'action', action: 'end_shift', source: 'dashboard', ok: true },
          { t: 128, type: 'event', name: 'scenario_end', reason: 'ended_by_candidate' },
        ],
      },
    },
  },
};

export const SAMPLE_CANDIDATES = Object.fromEntries(
  Object.entries(SAMPLE_RUNS).map(([id, run]) => [id, buildAssessment(run)]),
);
