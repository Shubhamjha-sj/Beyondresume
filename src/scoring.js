// Scoring: compares the session log against the scenario's expectations.
// Pure functions (no DOM / three.js) so they can be unit-tested in Node.

export const SKILLS = ['response', 'procedure', 'judgment', 'safety', 'communication'];
export const SKILL_LABELS = {
  response: 'Response time',
  procedure: 'Procedure',
  judgment: 'Judgment',
  safety: 'Safety',
  communication: 'Communication',
};

// Does a log entry satisfy a match spec like { action: 'reroute', lot: 'LOT-4471', to: 'ETCH-01' }?
// Keys ending in "Not" mean "must differ", e.g. { toolNot: 'ETCH-02' }.
export function matches(entry, match) {
  if (match.action) {
    if (entry.type !== 'action' || entry.action !== match.action || entry.ok === false) return false;
  } else if (match.event) {
    if (entry.type !== 'event' || entry.name !== match.event) return false;
  } else {
    return false;
  }
  for (const [key, value] of Object.entries(match)) {
    if (key === 'action' || key === 'event') continue;
    if (key.endsWith('Not')) {
      if (entry[key.slice(0, -3)] === value) return false;
    } else if (entry[key] !== value) {
      return false;
    }
  }
  return true;
}

export function eventTimes(entries) {
  const times = {};
  for (const e of entries) {
    if (e.type === 'event' && e.id && !(e.id in times)) times[e.id] = e.t;
  }
  return times;
}

// Status of every expected action: done?, how long after its trigger, on time?
export function evaluateExpectations(def, entries) {
  const times = eventTimes(entries);
  return def.expect.map((x) => {
    const t0 = x.after ? times[x.after] : 0;
    if (t0 === undefined) return { ...x, done: false, credit: 0, notTriggered: true };
    const hit = entries.find((e) => e.t >= t0 && matches(e, x.match));
    if (!hit) return { ...x, done: false, credit: 0 };
    const delay = Math.round((hit.t - t0) * 10) / 10;
    const onTime = x.within == null || delay <= x.within;
    return { ...x, done: true, at: hit.t, delay, onTime, credit: onTime ? 1 : 0.5 };
  });
}

export function scoreSession(def, entries, positions = []) {
  const times = eventTimes(entries);
  const expectations = evaluateExpectations(def, entries);
  const byId = Object.fromEntries(expectations.map((x) => [x.id, x]));

  // Forbidden actions / outcomes
  const violations = [];
  for (const f of def.forbid || []) {
    const hits = entries.filter((e) => matches(e, f.match));
    if (!hits.length) continue;
    const count = f.repeat ? hits.length : 1;
    violations.push({ ...f, count, at: hits[0].t, points: f.penalty * count });
  }

  // Doing things in the wrong order (or acting without ever checking first)
  const orderIssues = [];
  for (const o of def.order || []) {
    const first = byId[o.first];
    const then = byId[o.then];
    if (then?.done && (!first?.done || then.at < first.at)) orderIssues.push({ ...o, points: o.penalty || 0 });
  }

  // Overall score out of 100
  const totalWeight = expectations.reduce((s, x) => s + x.weight, 0) || 1;
  const earned = expectations.reduce((s, x) => s + x.weight * x.credit, 0);
  const penalty = violations.reduce((s, v) => s + v.points, 0) + orderIssues.reduce((s, o) => s + o.points, 0);
  const overall = clamp(Math.round((earned / totalWeight) * 100 - penalty), 0, 100);

  // Metrics
  const alarmT = times.alarm;
  let reactionTime = null;
  if (alarmT !== undefined) {
    const arrived = entries.find((e) => e.type === 'zone' && e.enter && e.tool === def.focusTool && e.t >= alarmT);
    const candidates = [arrived?.t, byId.inspect?.done ? byId.inspect.at : undefined].filter((v) => v !== undefined);
    if (candidates.length) reactionTime = round1(Math.min(...candidates) - alarmT);
  }
  const safeParts = [byId.hold, byId.reroute].filter(Boolean);
  const timeToSafe = safeParts.length && safeParts.every((x) => x.done) ? Math.max(...safeParts.map((x) => x.delay)) : null;
  const distance = round1(pathLength(positions));
  const terminalChecks = entries.filter((e) => e.type === 'ui' && e.name === 'dashboard_open').length;
  const actionsTaken = entries.filter((e) => e.type === 'action' && e.action !== 'inspect').length;

  // Skill breakdown (0-100 each)
  const skills = {};
  for (const skill of SKILLS) {
    const xs = expectations.filter((x) => x.skill === skill);
    let value = xs.length ? xs.reduce((s, x) => s + x.weight * x.credit, 0) / xs.reduce((s, x) => s + x.weight, 0) : 1;
    if (skill === 'response') {
      const speed = reactionTime == null ? 0 : clamp(1 - (reactionTime - 20) / 70, 0, 1);
      value = 0.5 * value + 0.5 * speed;
    }
    const lost = violations.filter((v) => v.skill === skill).reduce((s, v) => s + v.points, 0) +
      orderIssues.filter((o) => o.skill === skill).reduce((s, o) => s + o.points, 0);
    skills[skill] = clamp(Math.round(value * 100 - lost * 2), 0, 100);
  }

  const rating = overall >= 85 ? 'Ready for the floor' : overall >= 65 ? 'Ready with coaching' : 'Needs more training';

  return {
    overall,
    rating,
    skills,
    expectations,
    violations,
    orderIssues,
    metrics: { reactionTime, timeToSafe, distance, terminalChecks, actionsTaken },
  };
}

export function pathLength(positions) {
  let d = 0;
  for (let i = 1; i < positions.length; i++) {
    const [, x0, z0] = positions[i - 1];
    const [, x1, z1] = positions[i];
    const step = Math.hypot(x1 - x0, z1 - z0);
    if (step < 5) d += step; // ignore teleports (respawn / noclip)
  }
  return d;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
