// Two modal screens:
//  - ToolPanel: the tool's own control screen (opened with E at the tool)
//  - Dashboard: the bay operator terminal (Tab) with tool status, lots, maintenance and messaging
// Both report what the candidate does through onAction(action) -> { ok, message }.
import { STATE_INFO } from './tools.js';
import { escapeHtml, formatClock } from './hud.js';

const fmt = (r) => (r.digits === undefined ? String(r.current) : r.current.toFixed(r.digits));
const chip = (info) => `<span class="chip" style="--c:${info.color}">${info.label}</span>`;
const canHold = (state) => ['running', 'idle', 'alarm'].includes(state);

export class ToolPanel {
  constructor(el, { onAction, onClose }) {
    this.el = el;
    this.onAction = onAction;
    this.onClose = onClose;
    this.tool = null;
    this.message = null;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || !this.tool || btn.disabled) return;
      if (btn.dataset.act === 'close') return this.onClose();
      this.message = this.onAction({ action: btn.dataset.act, tool: this.tool.id, source: 'tool_panel' });
      const scroll = this.el.querySelector('.hmi')?.scrollTop ?? 0;
      this.render();
      this.el.querySelector('.hmi').scrollTop = scroll; // stay at the buttons (the message lands just above them)
    });
  }

  get isOpen() {
    return !!this.tool;
  }

  open(tool) {
    this.tool = tool;
    this.message = null;
    this.render();
    this.el.classList.remove('is-hidden');
  }

  close() {
    this.tool = null;
    this.el.classList.add('is-hidden');
  }

  refresh() {
    const body = this.tool && this.el.querySelector('.hmi-readings tbody');
    if (body) body.innerHTML = this.readingRows();
  }

  readingRows() {
    return this.tool.readings
      .map((r) => {
        const bad = r.limit != null && r.current > r.limit;
        const limit = r.limit != null ? `<span class="lim">limit ${r.limit}</span>` : '';
        return `<tr class="${bad ? 'bad' : ''}"><td>${r.label}</td><td class="v">${fmt(r)}</td><td class="u">${r.unit} ${limit}</td></tr>`;
      })
      .join('');
  }

  lotLine() {
    const t = this.tool;
    const parts = [];
    if (t.state === 'emo') parts.push('No power.');
    else if (t.state === 'pm') parts.push('No lot loaded.');
    else if (t.state === 'idle' || !t.lot) parts.push('Idle, waiting for lots.');
    else parts.push(`${t.state === 'hold' ? 'Holding' : 'Processing'} ${t.lot} · wafer ${t.wafer} of 25`);
    if (t.queue.length) parts.push(`At load port: ${t.queue.join(', ')}`);
    return parts.join('<br>');
  }

  render() {
    const t = this.tool;
    if (!t) return;
    const a = t.alarm;
    const alarmBox = a
      ? `<div class="hmi-alarm ${a.acked ? 'acked' : ''}"><b>${escapeHtml(a.code)}</b> ${escapeHtml(a.message)}
           <small>Raised at shift time ${formatClock(a.t)} · ${a.acked ? 'acknowledged' : 'not acknowledged'}</small></div>`
      : '';
    const note =
      t.state === 'pm'
        ? `<div class="hmi-note">${escapeHtml(t.note || 'Down for maintenance')}. Tool is locked out, do not operate.</div>`
        : t.state === 'emo'
          ? `<div class="hmi-note danger">Emergency off. All power to the tool is cut.</div>`
          : '';
    const msg = this.message
      ? `<p class="hmi-msg ${this.message.ok ? '' : 'err'}">${escapeHtml(this.message.message)}</p>`
      : '';
    this.el.innerHTML = `
      <div class="hmi">
        <header>
          <div><div class="hmi-id">${t.id}</div><div class="hmi-sub">${escapeHtml(t.def.process)}</div></div>
          ${chip(t.stateInfo)}
        </header>
        ${alarmBox}${note}
        <table class="hmi-readings"><tbody>${this.readingRows()}</tbody></table>
        <div class="hmi-lot">${this.lotLine()}</div>
        ${msg}
        <div class="hmi-actions">
          <button data-act="ack_alarm" ${a && !a.acked ? '' : 'disabled'}>Acknowledge alarm</button>
          <button data-act="hold_tool" ${canHold(t.state) ? '' : 'disabled'}>Put tool on hold</button>
          <button data-act="reset_resume" ${a ? '' : 'disabled'}>Reset alarm &amp; resume</button>
        </div>
        <button class="emo" data-act="emo" ${t.state === 'emo' ? 'disabled' : ''}>EMO · Emergency off</button>
        <footer><span>Live readings</span><button class="ghost" data-act="close">Close <kbd>E</kbd></button></footer>
      </div>`;
  }
}

const PROBLEMS = ['Chamber pressure', 'Wafer handling / robot', 'RF power', 'Gas delivery', 'Software / communication', 'Other'];

export class Dashboard {
  constructor(el, { tools, runner, plan, onAction, onClose, getTime, getPlayer }) {
    Object.assign(this, { el, tools, runner, plan, onAction, onClose, getTime, getPlayer });
    this.isOpen = false;
    this.sig = {};
    this.render();
    this.q = (sel) => el.querySelector(sel);

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      const act = btn.dataset.act;
      if (act === 'close') return this.onClose();
      if (act === 'hold_tool') return this.feedback(this.onAction({ action: 'hold_tool', tool: btn.dataset.tool, source: 'dashboard' }));
      if (act === 'reroute') {
        const lot = this.runner.lots.get(btn.dataset.lot);
        const select = el.querySelector(`select[data-lot-select="${btn.dataset.lot}"]`);
        if (!lot || !select?.value) return;
        return this.feedback(this.onAction({ action: 'reroute', lot: lot.id, from: lot.to, to: select.value, source: 'dashboard' }));
      }
      if (act === 'end_shift') {
        if (window.confirm('End the shift now? You will be scored on what you have done so far.')) {
          this.onAction({ action: 'end_shift', source: 'dashboard' });
        }
      }
    });

    this.q('.dash-maint').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (!f.get('tool')) return this.feedback({ ok: false, message: 'Pick the tool that needs maintenance.' });
      const result = this.onAction({
        action: 'call_maintenance',
        tool: f.get('tool'),
        problem: f.get('problem'),
        priority: f.get('priority'),
        note: String(f.get('note') || '').trim(),
        source: 'dashboard',
      });
      this.feedback(result);
      if (result.ok) e.target.reset();
    });

    this.q('.dash-msg').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = String(new FormData(e.target).get('text') || '').trim();
      if (!text) return this.feedback({ ok: false, message: 'Type a message first.' });
      const result = this.onAction({ action: 'notify_supervisor', text, source: 'dashboard' });
      this.feedback(result);
      if (result.ok) e.target.reset();
    });
  }

  render() {
    const toolOptions = this.tools.list().map((t) => `<option value="${t.id}">${t.id}</option>`).join('');
    this.el.innerHTML = `
      <div class="dash">
        <header>
          <div><b>Bay 3 · Operator terminal</b> <span class="dash-clock"></span></div>
          <button class="ghost" data-act="close">Close <kbd>Tab</kbd></button>
        </header>
        <div class="dash-body">
          <div class="dash-col">
            <section><h3>Active alarms</h3><div class="dash-alarms"></div></section>
            <section>
              <h3>Tools</h3>
              <table class="dash-tools">
                <thead><tr><th>Tool</th><th>Process</th><th>State</th><th>Lot / note</th><th></th></tr></thead>
                <tbody></tbody>
              </table>
            </section>
            <section><h3>Incoming lots</h3><div class="dash-lots"></div></section>
          </div>
          <div class="dash-col dash-side">
            <section>
              <h3>Floor map</h3>
              <div class="dash-map"><img src="./assets/floorplan.png" alt="Bay 3 floor plan" /><div class="dash-markers"></div><div class="dash-you"></div></div>
            </section>
            <section>
              <h3>Call maintenance</h3>
              <form class="dash-maint">
                <label>Tool <select name="tool"><option value="">Select a tool…</option>${toolOptions}</select></label>
                <label>Problem <select name="problem">${PROBLEMS.map((p) => `<option>${p}</option>`).join('')}</select></label>
                <label>Priority <select name="priority"><option>Normal</option><option>Urgent</option></select></label>
                <label>Note <input name="note" type="text" maxlength="160" placeholder="Optional" /></label>
                <button type="submit">Send ticket</button>
              </form>
            </section>
            <section>
              <h3>Message supervisor</h3>
              <form class="dash-msg">
                <textarea name="text" rows="3" maxlength="400" placeholder="What's happening and what you've done…"></textarea>
                <button type="submit">Send</button>
              </form>
            </section>
          </div>
        </div>
        <footer><span class="dash-feedback"></span><button class="danger-ghost" data-act="end_shift">End shift</button></footer>
      </div>`;
  }

  open() {
    this.isOpen = true;
    this.sig = {};
    this.el.classList.remove('is-hidden');
    this.q('.dash-feedback').textContent = '';
    this.refresh();
  }

  close() {
    this.isOpen = false;
    this.el.classList.add('is-hidden');
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
  }

  feedback(result) {
    const el = this.q('.dash-feedback');
    el.textContent = result?.message || '';
    el.classList.toggle('err', result && !result.ok);
    this.refresh();
    return result;
  }

  // Rebuild a section only when its content actually changed (keeps form inputs and selects stable).
  update(key, sig, build) {
    if (this.sig[key] === sig) return;
    this.sig[key] = sig;
    build();
  }

  refresh() {
    if (!this.isOpen) return;
    const now = this.getTime();
    const tools = this.tools.list();
    this.q('.dash-clock').textContent = `· Shift ${formatClock(now)}`;

    const toolSig = tools.map((t) => `${t.id}:${t.state}:${t.alarm ? t.alarm.code + t.alarm.acked : ''}:${t.queue.length}`).join('|');

    this.update('alarms', toolSig, () => {
      const alarms = tools.filter((t) => t.alarm);
      this.q('.dash-alarms').innerHTML = alarms.length
        ? alarms
            .map(
              (t) => `<div class="dash-alarm ${t.alarm.acked ? 'acked' : ''}">
                <b>${t.id}</b> ${escapeHtml(t.alarm.code)} · ${escapeHtml(t.alarm.message)}
                <small>Since ${formatClock(t.alarm.t)} · ${t.alarm.acked ? 'acknowledged' : 'not acknowledged (acknowledge at the tool)'}</small>
              </div>`,
            )
            .join('')
        : '<p class="muted">No active alarms.</p>';
    });

    this.update('tools', toolSig, () => {
      this.q('.dash-tools tbody').innerHTML = tools
        .map((t) => {
          const lotNote = t.state === 'pm' ? escapeHtml(t.note) : [t.lot, ...t.queue].filter(Boolean).join(', ') || '—';
          return `<tr class="${t.alarm && !t.alarm.acked ? 'alarm-row' : ''}">
            <td><b>${t.id}</b></td><td>${escapeHtml(t.def.process)}</td><td>${chip(t.stateInfo)}</td><td>${lotNote}</td>
            <td><button class="small" data-act="hold_tool" data-tool="${t.id}" ${canHold(t.state) ? '' : 'disabled'}>Hold</button></td>
          </tr>`;
        })
        .join('');
    });

    this.refreshLots(now, tools);
    this.refreshMap(toolSig, tools);
  }

  refreshLots(now, tools) {
    const lots = [...this.runner.lots.values()].sort((a, b) => a.eta - b.eta);
    const states = tools.map((t) => t.state).join(',');
    const sig = lots.map((l) => `${l.id}:${l.to}:${l.approaching}:${l.arrived}`).join('|') + states;
    this.update('lots', sig, () => {
      this.q('.dash-lots').innerHTML = lots.length
        ? lots.map((lot) => this.lotCard(lot)).join('')
        : '<p class="muted">No lots scheduled into this bay yet.</p>';
    });
    for (const el of this.el.querySelectorAll('[data-lot-eta]')) {
      const lot = this.runner.lots.get(el.dataset.lotEta);
      if (lot) el.textContent = `ETA ${formatClock(lot.eta - now)}`;
    }
  }

  lotCard(lot) {
    if (lot.arrived) {
      return `<div class="lot done"><b>${lot.id}</b> · delivered to ${lot.to}</div>`;
    }
    const dest = this.tools.get(lot.to);
    const alternatives = this.tools
      .list()
      .filter((t) => t.type === dest?.type && t.id !== lot.to)
      .map((t) => `<option value="${t.id}">${t.id} · ${t.stateInfo.label}</option>`)
      .join('');
    const control = lot.approaching
      ? `<div class="lot-lock">Vehicle is on its way in. It can't be rerouted now.</div>`
      : `<div class="lot-reroute"><span>Reroute to</span><select data-lot-select="${lot.id}">${alternatives}</select>
           <button class="small" data-act="reroute" data-lot="${lot.id}">Reroute</button></div>`;
    return `<div class="lot">
      <div class="lot-head"><b>${lot.id}</b> · ${lot.wafers} wafers · ${escapeHtml(lot.product || '')}</div>
      <div class="lot-route">Next step: <b>${lot.to}</b> ${dest ? chip(dest.stateInfo) : ''} · <span data-lot-eta="${lot.id}"></span></div>
      ${control}
    </div>`;
  }

  refreshMap(toolSig, tools) {
    if (!this.plan) return;
    const { x0, z0, x1, z1 } = this.plan;
    const pct = (x, z) => [((x - x0) / (x1 - x0)) * 100, ((z - z0) / (z1 - z0)) * 100];
    this.update('map', toolSig, () => {
      this.q('.dash-markers').innerHTML = tools
        .map((t) => {
          const [u, v] = pct(t.center.x, t.center.z);
          const cls = t.alarm && !t.alarm.acked ? 'pulse' : '';
          return `<div class="marker ${cls}" style="left:${u}%;top:${v}%;--c:${t.stateInfo.color}"><i></i><span>${t.id}</span></div>`;
        })
        .join('');
    });
    const p = this.getPlayer();
    const [u, v] = pct(p.x, p.z);
    const you = this.q('.dash-you');
    you.style.left = `${u}%`;
    you.style.top = `${v}%`;
  }
}

export { STATE_INFO };
