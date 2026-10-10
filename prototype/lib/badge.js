// Skills badge for a signed credential (docs/INTEGRATION.md, "Badge"): who can share it, what it
// shows, the share links and the social-preview tags served at /badge/<id>.
// Pure functions with no DOM at import, so server.mjs and Node tests use the same code.
// badgePng() draws the downloadable image and runs only in the browser.
import { COMPETENCIES_ETCH, COMPETENCY_GROUPS, LEVELS, BADGE_ETCH, SCENARIO_ETCH } from './assessment.js';

export const ISSUER = 'IndustryProof';
export const OG_IMAGE_PATH = '/prototype/badge-og.png'; // generic 1200×630 preview (crawlers can't use SVG)
const BADGES = { [SCENARIO_ETCH.id]: BADGE_ETCH };
const ID_RE = /^cred_[0-9a-f]{12}$/;

export const badgeUrl = (origin, id) => `${String(origin || '').replace(/\/+$/, '')}/badge/${id}`;

// Levels ({ id: 1-5 | null }) grouped Technical / Behavioural, with each group's mean level.
export function competencyGroups(levels = {}) {
  return COMPETENCY_GROUPS.map((g) => {
    const items = COMPETENCIES_ETCH.filter((c) => c.group === g.id).map((c) => {
      const level = toLevel(levels?.[c.id]);
      return { id: c.id, label: c.label, level, levelName: level ? LEVELS[level] : 'Not assessed' };
    });
    const rated = items.filter((x) => x.level);
    const avg = rated.length ? Math.round((rated.reduce((s, x) => s + x.level, 0) / rated.length) * 10) / 10 : null;
    return { id: g.id, label: g.label, avg, items };
  });
}

// What a credential's badge shows. Only a pass with no auto-fail and signed competency levels
// earns a shareable badge; anything else gets a reason instead (the credential still verifies).
export function badgeModel(cred, origin = '') {
  const r = cred && typeof cred.record === 'object' && cred.record ? cred.record : {};
  const levels = r.competencies && typeof r.competencies === 'object' && !Array.isArray(r.competencies) ? r.competencies : null;
  const badge = BADGES[r.scenario_id] || null;
  const reason = r.status !== 'pass' ? 'not_passed'
    : r.auto_fail ? 'auto_fail'
    : !levels ? 'no_competencies' // signed before rubric etch-v2
    : !badge ? 'no_badge'
    : null;
  const groups = competencyGroups(levels || {});
  const top = groups.flatMap((g) => g.items).filter((x) => x.level).sort((a, b) => b.level - a.level).slice(0, 3);
  const id = cred && ID_RE.test(cred.id) ? cred.id : null;
  return {
    eligible: !reason,
    reason,
    name: badge?.name || BADGE_ETCH.name,
    description: badge?.description || '',
    criteria: badge?.criteria || '',
    candidate: String(r.candidate || ''),
    role: String(r.role || ''),
    assessment: String(r.assessment || ''),
    company: String(r.company || ''),
    issuer: String(r.issuer || ISSUER),
    rubric: String(r.rubric_version || ''),
    issuedAt: r.assessed_at || null,
    issuedOn: fmtDay(r.assessed_at),
    credId: id,
    url: id && origin ? badgeUrl(origin, id) : null,
    groups,
    top,
  };
}

// Post text: the badge and its strongest skills. Stays well under X's 280 characters with the link.
export function shareText(m) {
  const top = m.top.slice(0, 2).map((x) => `${x.label} ${x.level}/5`).join(', ');
  return `I earned the ${m.name} badge from ${m.issuer}, scored in a 3D fab simulation.${top ? ` Top skills: ${top}.` : ''} Check it here:`;
}

// Share targets. LinkedIn "Add to profile" puts it under Licenses & certifications.
export function shareLinks(m) {
  if (!m?.eligible || !m.url) return null;
  const d = new Date(m.issuedAt);
  const dated = !Number.isNaN(d.getTime());
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
  const text = shareText(m);
  return {
    linkedinProfile: 'https://www.linkedin.com/profile/add?' + q({
      startTask: 'CERTIFICATION_NAME',
      name: m.name,
      organizationName: m.issuer,
      issueYear: dated ? String(d.getUTCFullYear()) : null,
      issueMonth: dated ? String(d.getUTCMonth() + 1) : null,
      certUrl: m.url,
      certId: m.credId,
    }),
    linkedinPost: 'https://www.linkedin.com/sharing/share-offsite/?' + q({ url: m.url }),
    x: 'https://x.com/intent/tweet?' + q({ text, url: m.url }),
    facebook: 'https://www.facebook.com/sharer/sharer.php?' + q({ u: m.url }),
    text,
  };
}

// Social-preview tags for /badge/<id>. A shareable badge names the candidate and their top skills;
// anything else (fail, unknown id) gets generic tags and noindex, so link previews never expose a failed result.
export function shareHead(cred, origin) {
  const base = String(origin || '').replace(/\/+$/, '');
  const m = cred ? badgeModel(cred, base) : null;
  const url = m?.credId ? badgeUrl(base, m.credId) : `${base}/`;
  let title = `Verify an ${ISSUER} credential`;
  let description = `Check that an ${ISSUER} assessment result is real and unchanged since it was issued.`;
  if (m?.eligible) {
    title = `${m.candidate} · ${m.name}`;
    description = `Verified by ${m.issuer} on ${m.issuedOn}. ` +
      (m.top.length ? m.top.map((x) => `${x.label} ${x.level}/5`).join(' · ') + '. ' : '') +
      'Scored in a 3D fab simulation. Open the link to check the signature.';
  }
  const meta = (attr, key, value) => `<meta ${attr}="${key}" content="${esc(value)}">`;
  const tags = [
    meta('name', 'description', description),
    m?.eligible ? '' : meta('name', 'robots', 'noindex'),
    `<link rel="canonical" href="${esc(url)}">`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', ISSUER),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', base + OG_IMAGE_PATH),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', `${ISSUER} verified skills badge`),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', title),
    meta('name', 'twitter:description', description),
    meta('name', 'twitter:image', base + OG_IMAGE_PATH),
  ].filter(Boolean).join('\n');
  return { title, tags };
}

// The hexagon emblem as inline SVG (same shape as the brand mark), for the badge card.
// Each call gets its own gradient id: a shared id inside a hidden screen would leave the others unfilled.
let emblems = 0;
export function emblemSVG(size = 96) {
  const id = `emb-g${++emblems}`;
  return `<svg class="emblem" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="Verified badge">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E4F35C"/><stop offset="1" stop-color="#93E27F"/></linearGradient></defs>` +
    `<path d="${hexPath(32, 32, 30)}" fill="url(#${id})"/>` +
    `<path d="${hexPath(32, 32, 24.5)}" fill="#11160A"/>` +
    '<path d="M22.5 32.5l6.5 6.5 12.5-13" fill="none" stroke="#E4F35C" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

// ---------- downloadable image (browser only) ----------

const FONTS = { display: '"Unbounded", "Arial Black", sans-serif', body: '"Manrope", "Helvetica Neue", Arial, sans-serif', mono: '"JetBrains Mono", Menlo, monospace' };
const C = { bg: '#0B0D10', panel: '#16191D', line: '#2A2F36', ink: '#F1F3F4', muted: '#9AA2AA', limeA: '#E4F35C', limeB: '#93E27F', limeInk: '#11160A', off: '#2A2F36' };

// 1200×630 PNG (drawn at 2×) of the badge, for posting as an image. Resolves to a Blob.
export async function badgePng(m, { scale = 2 } = {}) {
  if (globalThis.document?.fonts?.load) {
    await Promise.all([`500 40px ${FONTS.display}`, `600 24px ${FONTS.body}`, `400 15px ${FONTS.body}`, `400 14px ${FONTS.mono}`]
      .map((f) => document.fonts.load(f).catch(() => null)));
  }
  const W = 1200;
  const H = 630;
  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);

  // Ground and emblem panel
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(210, 300, 20, 210, 300, 330);
  glow.addColorStop(0, 'rgba(147,226,127,0.22)');
  glow.addColorStop(1, 'rgba(147,226,127,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 440, H);
  const lime = g.createLinearGradient(80, 150, 340, 450);
  lime.addColorStop(0, C.limeA);
  lime.addColorStop(1, C.limeB);
  hex(g, 210, 280, 150);
  g.fillStyle = lime;
  g.fill();
  hex(g, 210, 280, 122);
  g.fillStyle = C.limeInk;
  g.fill();
  g.strokeStyle = C.limeA;
  g.lineWidth = 16;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(160, 262);
  g.lineTo(196, 298);
  g.lineTo(262, 230);
  g.stroke();
  g.textAlign = 'center';
  g.fillStyle = C.limeA;
  g.font = `600 17px ${FONTS.body}`;
  spaced(g, 'VERIFIED', 210, 350, 4);
  g.fillStyle = C.ink;
  g.font = `300 26px ${FONTS.body}`;
  const w1 = g.measureText('Industry').width;
  g.font = `600 26px ${FONTS.body}`;
  const w2 = g.measureText('Proof').width;
  g.textAlign = 'left';
  g.font = `300 26px ${FONTS.body}`;
  g.fillText('Industry', 210 - (w1 + w2) / 2, 510);
  g.font = `600 26px ${FONTS.body}`;
  g.fillStyle = '#C9EE62';
  g.fillText('Proof', 210 - (w1 + w2) / 2 + w1, 510);

  // Heading
  const X = 460;
  g.fillStyle = C.muted;
  g.font = `600 14px ${FONTS.body}`;
  spaced(g, 'VERIFIED SKILLS BADGE', X, 72, 2);
  g.fillStyle = C.ink;
  g.font = `500 36px ${FONTS.display}`;
  g.fillText(fit(g, m.name, 700), X, 120);
  g.font = `600 22px ${FONTS.body}`;
  g.fillText(fit(g, [m.candidate, m.role].filter(Boolean).join(' · '), 700), X, 160);
  g.fillStyle = C.muted;
  g.font = `400 15px ${FONTS.body}`;
  g.fillText(fit(g, [`Issued ${m.issuedOn}`, m.company && `${m.company} assessment`, m.rubric && `rubric ${m.rubric}`].filter(Boolean).join(' · '), 700), X, 188);

  // Competencies: two columns with 5-pip meters
  const cols = [X, X + 360];
  m.groups.forEach((grp, i) => {
    const x = cols[i] ?? X;
    let y = 236;
    g.fillStyle = C.muted;
    g.font = `600 13px ${FONTS.body}`;
    spaced(g, `${grp.label.toUpperCase()}${grp.avg != null ? ` · ${grp.avg.toFixed(1)}` : ''}`, x, y, 1.5);
    y += 30;
    for (const it of grp.items) {
      g.fillStyle = C.ink;
      g.font = `500 15px ${FONTS.body}`;
      g.fillText(fit(g, it.label, 330), x, y);
      for (let p = 0; p < 5; p++) {
        g.fillStyle = it.level && p < it.level ? C.limeB : C.off;
        round(g, x + p * 34, y + 9, 29, 7, 3.5);
      }
      g.fillStyle = it.level ? C.ink : C.muted;
      g.font = `400 13px ${FONTS.mono}`;
      g.fillText(it.level ? `${it.level}/5` : '—', x + 176, y + 16);
      y += 46;
    }
  });

  // Footer: where to verify
  g.fillStyle = C.line;
  g.fillRect(X, 560, 700, 1);
  g.fillStyle = C.muted;
  g.font = `400 14px ${FONTS.mono}`;
  g.fillText(fit(g, m.url ? `Verify: ${m.url.replace(/^https?:\/\//, '')}` : `Credential ${m.credId || ''}`, 700), X, 592);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not draw the badge'))), 'image/png'));
}

// ---------- helpers ----------

function hexPath(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ') + ' Z';
}

function hex(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    g[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  g.closePath();
}

function round(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.fill();
}

// Letter-spaced text (canvas letterSpacing isn't available everywhere).
function spaced(g, text, x, y, spacing) {
  const align = g.textAlign;
  const width = [...text].reduce((s, ch) => s + g.measureText(ch).width + spacing, -spacing);
  let cx = align === 'center' ? x - width / 2 : x;
  g.textAlign = 'left';
  for (const ch of text) {
    g.fillText(ch, cx, y);
    cx += g.measureText(ch).width + spacing;
  }
  g.textAlign = align;
}

function fit(g, text, max) {
  let s = String(text || '');
  if (g.measureText(s).width <= max) return s;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

function fmtDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const toLevel = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
