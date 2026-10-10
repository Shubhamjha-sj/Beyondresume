// Embed bridge tests (no browser needed): `node tests/bridge.test.mjs`
// Checks the postMessage rules and that a full scenario run forwards every log entry exactly once.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Bridge, readInbound, entryMessages, mirrorLog, scenarioSummary, candidateName } from '../src/bridge.js';
import { ScenarioRunner } from '../src/scenario.js';
import { SessionLog } from '../src/log.js';

const def = JSON.parse(readFileSync(new URL('../scenarios/etch2-pressure-fault.json', import.meta.url), 'utf8'));
const ORIGIN = 'http://localhost:5173';

// A stand-in for the iframe's window: its parent records what we post (structured-cloned, like the browser).
function fakeWindow() {
  const listeners = [];
  const parent = {
    sent: [],
    postMessage(msg, targetOrigin) {
      this.sent.push({ msg: structuredClone(msg), targetOrigin });
    },
  };
  const win = { parent, location: { origin: ORIGIN }, addEventListener: (type, fn) => type === 'message' && listeners.push(fn) };
  return { win, parent, dispatch: (event) => listeners.forEach((fn) => fn(event)) };
}

const tests = {
  'only the parent window on our origin can send messages'() {
    const parent = {};
    const ok = { origin: ORIGIN, source: parent, data: { target: 'fabtwin', type: 'start', candidate: 'Alex' } };
    assert.equal(readInbound(ok, ORIGIN, parent), ok.data);
    assert.equal(readInbound({ ...ok, origin: 'https://evil.example' }, ORIGIN, parent), null);
    assert.equal(readInbound({ ...ok, source: {} }, ORIGIN, parent), null);
    assert.equal(readInbound({ ...ok, data: { source: 'fabtwin', type: 'ready' } }, ORIGIN, parent), null); // our own echo
    assert.equal(readInbound({ ...ok, data: 'start' }, ORIGIN, parent), null);
    assert.equal(readInbound({ ...ok, data: { target: 'fabtwin' } }, ORIGIN, parent), null);
  },

  'posts { source, type, ...data } to the parent and routes inbound types'() {
    const { win, parent, dispatch } = fakeWindow();
    const bridge = new Bridge({ win });
    bridge.post('clock', { t: 12 });
    assert.deepEqual(parent.sent, [{ msg: { source: 'fabtwin', type: 'clock', t: 12 }, targetOrigin: ORIGIN }]);

    const got = [];
    bridge.on('start', (m) => got.push(['start', m.candidate])).on('end', (m) => got.push(['end', m.reason]));
    dispatch({ origin: ORIGIN, source: parent, data: { target: 'fabtwin', type: 'start', candidate: 'Alex' } });
    dispatch({ origin: ORIGIN, source: parent, data: { target: 'fabtwin', type: 'subtitle', speaker: 'Sam', text: 'Hi' } }); // no handler
    dispatch({ origin: 'https://evil.example', source: parent, data: { target: 'fabtwin', type: 'end', reason: 'x' } });
    dispatch({ origin: ORIGIN, source: parent, data: { target: 'fabtwin', type: 'end', reason: 'agent_ended' } });
    assert.deepEqual(got, [['start', 'Alex'], ['end', 'agent_ended']]);
  },

  'a payload that cannot be cloned is sent as plain JSON'() {
    const { win, parent } = fakeWindow();
    new Bridge({ win }).post('ended', { reason: 'complete', score: { overall: 90, fn: () => 1 } });
    assert.deepEqual(parent.sent[0].msg, { source: 'fabtwin', type: 'ended', reason: 'complete', score: { overall: 90 } });
  },

  'a full run forwards every event, action and zone entry exactly once'() {
    const log = new SessionLog();
    const posted = [];
    mirrorLog(log, (type, data) => posted.push({ type, data }));
    const runner = new ScenarioRunner(def, { log });
    runner.start();
    const plan = {
      40: [{ action: 'inspect', tool: 'ETCH-02' }],
      46: [{ action: 'ack_alarm', tool: 'ETCH-02' }],
      50: [{ action: 'hold_tool', tool: 'ETCH-02' }],
      58: [{ action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01' }],
      66: [{ action: 'call_maintenance', tool: 'ETCH-02' }],
      75: [{ action: 'notify_supervisor', text: 'Etch 2 on hold, lot moved, maintenance called.' }],
    };
    for (let t = 0; t <= 400 && !runner.ended; t = Math.round((t + 0.1) * 10) / 10) {
      log.t = t;
      runner.update(t);
      if (t === 38) log.add('zone', { tool: 'ETCH-02', enter: true });
      if (t === 39) log.add('ui', { name: 'tool_panel_open', tool: 'ETCH-02' });
      if (t === 70) log.add('zone', { tool: 'ETCH-02', enter: false });
      for (const a of plan[t] || []) runner.act({ ...a, ok: a.action === 'reroute' ? runner.reroute(a.lot, a.to) : true });
    }
    assert.equal(runner.endReason, 'complete');

    // Every forwarded entry, in log order; 'ui' stays local.
    const forwarded = log.entries.filter((e) => e.type !== 'ui');
    const main = posted.filter((p) => p.type !== 'say');
    assert.equal(main.length, forwarded.length);
    main.forEach((p, i) => {
      const e = forwarded[i];
      assert.equal(p.type, e.type);
      assert.deepEqual(Object.keys(p.data), [e.type]);
      if (e.type === 'zone') assert.deepEqual(p.data.zone, { t: e.t, tool: e.tool, enter: e.enter });
      else assert.equal(p.data[e.type], e); // the log entry itself
    });
    assert.ok(main.some((p) => p.type === 'action' && p.data.action.action === 'reroute' && p.data.action.ok === true));
    assert.equal(main.at(-1).data.event.name, 'scenario_end');

    // Each scripted line also goes out as { t, speaker, text }, right after its event.
    const lines = log.entries.filter((e) => e.type === 'event' && e.name === 'say');
    const says = posted.filter((p) => p.type === 'say');
    assert.deepEqual(says.map((p) => p.data), lines.map((e) => ({ t: e.t, speaker: e.speaker, text: e.text })));
    assert.ok(says.some((p) => p.data.speaker === 'Maintenance'));
    posted.forEach((p, i) => {
      if (p.type === 'say') assert.equal(posted[i - 1].data.event?.name, 'say');
    });
  },

  'entry messages and helpers'() {
    assert.deepEqual(entryMessages({ t: 1, type: 'ui', name: 'dashboard_open' }), []);
    assert.deepEqual(entryMessages({ t: 2, type: 'event', name: 'say', text: 'Hi' })[1], ['say', { t: 2, speaker: 'Supervisor', text: 'Hi' }]);
    assert.deepEqual(scenarioSummary(def), { id: 'etch2-pressure-fault', title: 'Etch 2 chamber pressure fault', role: def.role, focusTool: 'ETCH-02', timeLimit: 330 });
    assert.equal(candidateName('  Alex Chen '), 'Alex Chen');
    assert.equal(candidateName({ name: 'Priya' }), 'Priya');
    assert.equal(candidateName(undefined), 'Candidate');
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
