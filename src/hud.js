// In-world HUD: interaction prompt, shift clock, terminal hint with alarm badge, subtitles, toasts.

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class Hud {
  constructor({ prompt, clock, badge, subtitles, toast }) {
    Object.assign(this, { promptEl: prompt, clockEl: clock, badgeEl: badge, subEl: subtitles, toastEl: toast });
    this.lastClock = -1;
    this.lastBadge = -1;
    this.subTimer = 0;
    this.toastTimer = 0;
  }

  setPrompt(text) {
    if (!text) {
      this.promptEl.classList.add('is-hidden');
      return;
    }
    this.promptEl.innerHTML = `<kbd>E</kbd> ${text}`;
    this.promptEl.classList.remove('is-hidden');
  }

  setClock(seconds) {
    const s = Math.floor(seconds);
    if (s === this.lastClock) return;
    this.lastClock = s;
    this.clockEl.textContent = `Bay 3 · Shift ${formatClock(s)}`;
  }

  setAlarmCount(n) {
    if (n === this.lastBadge) return;
    this.lastBadge = n;
    this.badgeEl.textContent = n === 1 ? '1 alarm' : `${n} alarms`;
    this.badgeEl.classList.toggle('is-hidden', n === 0);
  }

  showSubtitle(speaker, text) {
    clearTimeout(this.subTimer);
    this.subEl.innerHTML = `<b>${escapeHtml(speaker)}:</b> ${escapeHtml(text)}`;
    this.subEl.classList.remove('is-hidden');
  }

  hideSubtitleSoon(ms = 1600) {
    clearTimeout(this.subTimer);
    this.subTimer = setTimeout(() => this.subEl.classList.add('is-hidden'), ms);
  }

  // A line spoken somewhere else (embed mode: Sam on the call). Stays up about as long as it takes to read.
  showSubtitleFor(speaker, text, ms = Math.min(12000, 2500 + String(text).length * 60)) {
    this.showSubtitle(speaker, text);
    this.hideSubtitleSoon(ms);
  }

  toast(message, ms = 2200) {
    this.toastEl.textContent = message;
    this.toastEl.classList.remove('is-hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastEl.classList.add('is-hidden'), ms);
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
