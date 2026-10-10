// Scenario + scoring tests (no browser needed): `npm test`
// Simulates candidate runs against the scenario file and checks the scores make sense.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { ScenarioRunner } from '../src/scenario.js';
import { SessionLog } from '../src/log.js';
import { scoreSession } from '../src/scoring.js';

const def = JSON.parse(readFileSync(new URL('../scenarios/etch2-pressure-fault.json', import.meta.url), 'utf8'));

function simulate(plan, { arriveAt } = {}) {
  const log = new SessionLog();
  let endReason = null;
  const runner = new ScenarioRunner(def, {
    log,
    onEvent: (e) => {
      if (e.type === 'scenario_end') endReason = e.reason;
    },
  });
  runner.start();
  const todo = Object.entries(plan).map(([t, acts]) => [Number(t), acts]).sort((a, b) => a[0] - b[0]);
  for (let t = 0; t <= 400 && !runner.ended; t = Math.round((t + 0.1) * 10) / 10) {
    log.t = t;
    runner.update(t);
    if (arriveAt === t) log.add('zone', { tool: 'ETCH-02', enter: true });
    while (todo.length && todo[0][0] <= t) {
      for (const a of todo.shift()[1]) {
        const ok = a.action === 'reroute' ? runner.reroute(a.lot, a.to) : true;
        runner.act({ ...a, ok });
        if (a.action === 'end_shift') runner.end('ended_by_candidate');
      }
    }
  }
  return { score: scoreSession(def, log.entries, log.positions), endReason, log };
}

const tests = {
  'perfect run scores 100 and ends after the lot lands'() {
    const { score, endReason, log } = simulate(
      {
        42: [{ action: 'inspect', tool: 'ETCH-02' }],
        46: [{ action: 'ack_alarm', tool: 'ETCH-02' }],
        50: [{ action: 'hold_tool', tool: 'ETCH-02' }],
        58: [{ action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01' }],
        66: [{ action: 'call_maintenance', tool: 'ETCH-02', problem: 'Chamber pressure', priority: 'Urgent' }],
        75: [{ action: 'notify_supervisor', text: 'Etch 2 on hold, lot moved to Etch 1, maintenance called.' }],
      },
      { arriveAt: 40 },
    );
    assert.equal(endReason, 'complete');
    assert.equal(score.overall, 100);
    assert.equal(score.metrics.reactionTime, 10);
    assert.ok(log.entries.some((e) => e.name === 'lot_arrived' && e.tool === 'ETCH-01'));
  },

  'unsafe shortcuts are penalised'() {
    const { score } = simulate({
      45: [{ action: 'inspect', tool: 'ETCH-02' }],
      47: [{ action: 'reset_resume', tool: 'ETCH-02' }],
      70: [{ action: 'emo', tool: 'ETCH-02' }],
      80: [{ action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-03' }],
    });
    const ids = score.violations.map((v) => v.id).sort();
    assert.deepEqual(ids, ['bypass', 'emo', 'pm-reroute']);
    assert.equal(score.skills.safety, 0);
    assert.equal(score.overall, 0);
  },

  'doing nothing lets the lot land on the faulted tool'() {
    const { score, endReason } = simulate({});
    assert.equal(endReason, 'time_limit');
    assert.ok(score.violations.some((v) => v.id === 'delivered'));
    assert.equal(score.overall, 0);
  },

  'acting before checking is an order issue; late reroute fails'() {
    const { score, endReason } = simulate({
      60: [{ action: 'hold_tool', tool: 'ETCH-02' }],
      90: [{ action: 'inspect', tool: 'ETCH-02' }],
      140: [{ action: 'reroute', lot: 'LOT-4471', from: 'ETCH-02', to: 'ETCH-01' }],
      150: [{ action: 'end_shift' }],
    });
    assert.equal(endReason, 'ended_by_candidate');
    assert.ok(score.orderIssues.some((o) => o.then === 'hold'));
    assert.equal(score.expectations.find((x) => x.id === 'reroute').done, false);
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
