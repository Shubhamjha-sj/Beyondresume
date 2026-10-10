// End-of-exercise report: overall score, skill breakdown, checklist, issues and timeline.
import { SKILLS, SKILL_LABELS } from './scoring.js';
import { escapeHtml, formatClock } from './hud.js';

const END_REASONS = {
  complete: 'All steps completed',
  time_limit: 'Time limit reached',
  ended_by_candidate: 'Shift ended by the candidate',
};

function actionText(e) {
  // [what they tried, what they did]
  const text = {
    inspect: [`check the ${e.tool} control screen`, `Checked the ${e.tool} control screen`],
    ack_alarm: [`acknowledge the alarm on ${e.tool}`, `Acknowledged the alarm on ${e.tool}`],
    hold_tool: [`put ${e.tool} on hold`, `Put ${e.tool} on hold`],
    reset_resume: [`reset the alarm on ${e.tool}`, `Reset the alarm and resumed ${e.tool}`],
    emo: [`press EMO on ${e.tool}`, `Pressed EMO (emergency off) on ${e.tool}`],
    reroute: [`reroute ${e.lot} to ${e.to}`, `Rerouted ${e.lot} from ${e.from} to ${e.to}`],
    call_maintenance: [
      `call maintenance for ${e.tool}`,
      `Called maintenance for ${e.tool} (${e.problem}, ${String(e.priority || '').toLowerCase()})`,
    ],
    notify_supervisor: ['message the supervisor', `Messaged the supervisor: “${e.text}”`],
    end_shift: ['end the shift', 'Ended the shift'],
  }[e.action];
  if (!text) return e.action;
  return e.ok === false ? `Tried to ${text[0]} (not possible)` : text[1];
}

export function describe(e) {
  if (e.type === 'action') return actionText(e);
  if (e.type === 'event') {
    switch (e.name) {
      case 'scenario_start':
        return 'Shift started';
      case 'alarm':
        return `Alarm on ${e.tool}: ${e.code} ${e.message}`;
      case 'lot':
        return `${e.lot} scheduled to ${e.to}`;
      case 'lot_approach':
        return `Overhead vehicle bringing ${e.lot} in to ${e.to}`;
      case 'lot_arrived':
        return `${e.lot} delivered to ${e.tool}`;
      case 'say':
        return `${e.speaker}: “${e.text}”`;
      case 'scenario_end':
        return END_REASONS[e.reason] || 'Exercise ended';
      default:
        return e.name;
    }
  }
  if (e.type === 'zone') return `${e.enter ? 'Arrived at' : 'Left'} ${e.tool}`;
  return '';
}

export function showResults(el, { score, def, log, candidate, reason, onDownload, onRestart }) {
  const s = score;
  const sec = (v) => (v == null ? '—' : `${Math.round(v)} s`);
  const checklist = s.expectations
    .map((x) => {
      const status = x.done ? (x.onTime ? 'ok' : 'late') : 'miss';
      const detail = x.done ? `+${Math.round(x.delay)} s after the alarm${x.onTime ? '' : ` (target ${x.within} s)`}` : 'Not done';
      return `<li class="${status}"><span class="mark"></span><div><b>${escapeHtml(x.label)}</b><small>${detail}</small></div></li>`;
    })
    .join('');
  const issues = [...s.violations.map((v) => ({ label: v.label, points: v.points, count: v.count })), ...s.orderIssues]
    .map((i) => `<li><span>${escapeHtml(i.label)}${i.count > 1 ? ` ×${i.count}` : ''}</span><b>−${i.points}</b></li>`)
    .join('');
  const skills = SKILLS.map(
    (k) => `<div class="skill"><span>${SKILL_LABELS[k]}</span><div class="bar"><i style="width:${s.skills[k]}%"></i></div><b>${s.skills[k]}</b></div>`,
  ).join('');
  const timeline = log.entries
    .filter((e) => e.type === 'action' || (e.type === 'event' && e.name !== 'lot_approach') || (e.type === 'zone' && e.enter && e.tool === def.focusTool))
    .map((e) => `<li class="${e.type}"><time>${formatClock(e.t)}</time><span>${escapeHtml(describe(e))}</span></li>`)
    .join('');

  el.innerHTML = `
    <div class="results">
      <header>
        <div>
          <p class="eyebrow">Assessment complete · ${escapeHtml(END_REASONS[reason] || '')}</p>
          <h1>${escapeHtml(candidate)}</h1>
          <p class="muted">${escapeHtml(def.title)} · ${escapeHtml(def.role)} · ${new Date().toLocaleString()}</p>
        </div>
        <div class="score"><b>${s.overall}</b><span>/ 100</span><em>${escapeHtml(s.rating)}</em></div>
      </header>

      <div class="results-grid">
        <section>
          <h3>Skills</h3>
          ${skills}
          <div class="metrics">
            <div><b>${sec(s.metrics.reactionTime)}</b><span>to reach or check ${escapeHtml(def.focusTool)}</span></div>
            <div><b>${sec(s.metrics.timeToSafe)}</b><span>to make it safe (hold + reroute)</span></div>
            <div><b>${s.metrics.distance} m</b><span>walked</span></div>
            <div><b>${s.metrics.terminalChecks}</b><span>terminal checks</span></div>
          </div>
        </section>
        <section>
          <h3>Expected actions</h3>
          <ul class="checklist">${checklist}</ul>
          <h3>Issues</h3>
          ${issues ? `<ul class="issues">${issues}</ul>` : '<p class="muted">No safety or judgment issues.</p>'}
        </section>
        <section class="timeline-section">
          <h3>Timeline</h3>
          <ol class="timeline">${timeline}</ol>
        </section>
      </div>

      <footer>
        <button class="ghost" data-act="download">Download full log (JSON)</button>
        <button data-act="restart">Run again</button>
      </footer>
    </div>`;
  el.classList.remove('is-hidden');
  el.querySelector('[data-act="download"]').addEventListener('click', onDownload);
  el.querySelector('[data-act="restart"]').addEventListener('click', onRestart);
}
