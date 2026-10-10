// Badge and share helpers (no browser needed): `node tests/badge.test.mjs`
import assert from 'node:assert/strict';
import { toCredentialRecord, COMPETENCIES_ETCH, BADGE_ETCH } from '../prototype/lib/assessment.js';
import { SAMPLE_CANDIDATES } from '../prototype/lib/samples.js';
import { badgeModel, badgeUrl, shareLinks, shareText, shareHead, competencyGroups, emblemSVG, OG_IMAGE_PATH } from '../prototype/lib/badge.js';

const ORIGIN = 'https://industryproof.up.railway.app';
const cred = async (key, id) => ({ id, record: await toCredentialRecord(SAMPLE_CANDIDATES[key]), signature: 'x', key: 'k' });
const jordan = await cred('jordan', 'cred_0123456789ab');
const riley = await cred('riley', 'cred_ba9876543210');
const params = (url) => Object.fromEntries(new URL(url).searchParams);

const tests = {
  'only a pass with signed competencies earns a badge'() {
    const j = badgeModel(jordan, ORIGIN);
    assert.equal(j.eligible, true);
    assert.equal(j.reason, null);
    assert.equal(j.name, BADGE_ETCH.name);
    assert.equal(j.candidate, 'Jordan Lee');
    assert.equal(j.issuedOn, 'Oct 9, 2026');
    assert.equal(j.url, `${ORIGIN}/badge/cred_0123456789ab`);
    assert.equal(badgeModel(riley, ORIGIN).reason, 'not_passed');
    const autoFail = structuredClone(jordan);
    autoFail.record.auto_fail = true;
    assert.equal(badgeModel(autoFail).reason, 'auto_fail');
    // Signed before rubric etch-v2: still a credential, but no competency levels to show
    const v1 = structuredClone(jordan);
    delete v1.record.competencies;
    v1.record.rubric_version = 'etch-v1';
    assert.equal(badgeModel(v1).reason, 'no_competencies');
    const other = structuredClone(jordan);
    other.record.scenario_id = 'robot-cell';
    assert.equal(badgeModel(other).reason, 'no_badge');
    assert.equal(badgeModel(null).eligible, false);
    assert.equal(badgeModel(jordan).url, null); // no origin, no link
  },

  'groups: Technical and Behavioural with mean levels; missing levels are "Not assessed"'() {
    const [tech, beh] = badgeModel(jordan).groups;
    assert.equal(tech.label, 'Technical');
    assert.equal(tech.items.length, 5);
    assert.equal(tech.avg, 4.8);
    assert.equal(beh.label, 'Behavioural');
    assert.equal(beh.items.length, 6);
    assert.equal(beh.avg, 4.2);
    assert.deepEqual(tech.items.find((x) => x.id === 'fab_tools'), { id: 'fab_tools', label: 'Working with semiconductor fab tools', level: 5, levelName: 'Exemplary' });
    const g = competencyGroups({ composure: null, procedure: 9 });
    assert.ok(g.every((x) => x.avg === null));
    assert.equal(g[1].items[0].levelName, 'Not assessed');
    assert.equal(g[0].items[0].level, null);
    assert.equal(g.flatMap((x) => x.items).length, COMPETENCIES_ETCH.length);
  },

  'share links: LinkedIn add-to-profile, LinkedIn post, X and Facebook'() {
    const m = badgeModel(jordan, ORIGIN);
    const s = shareLinks(m);
    assert.ok(s.linkedinProfile.startsWith('https://www.linkedin.com/profile/add?'));
    assert.deepEqual(params(s.linkedinProfile), {
      startTask: 'CERTIFICATION_NAME',
      name: 'Etch Tool Fault Response',
      organizationName: 'IndustryProof',
      issueYear: '2026',
      issueMonth: '10',
      certUrl: `${ORIGIN}/badge/cred_0123456789ab`,
      certId: 'cred_0123456789ab',
    });
    assert.deepEqual(params(s.linkedinPost), { url: m.url });
    assert.deepEqual(params(s.facebook), { u: m.url });
    assert.deepEqual(params(s.x), { text: s.text, url: m.url });
    assert.ok(s.x.startsWith('https://x.com/intent/tweet?'));
    // X counts any link as 23 characters
    assert.ok(s.text.length + 1 + 23 <= 280, `${s.text.length} chars`);
    assert.match(s.text, /^I earned the Etch Tool Fault Response badge from IndustryProof/);
    assert.match(s.text, /Top skills: \w/);
    assert.equal(shareText(m), s.text);
    // Nothing to share for a fail or without a link
    assert.equal(shareLinks(badgeModel(riley, ORIGIN)), null);
    assert.equal(shareLinks(badgeModel(jordan)), null);
  },

  'social preview: personal tags for a badge, generic noindex tags otherwise'() {
    const j = shareHead(jordan, ORIGIN + '/');
    assert.equal(j.title, 'Jordan Lee · Etch Tool Fault Response');
    assert.match(j.tags, /<meta property="og:title" content="Jordan Lee · Etch Tool Fault Response">/);
    assert.match(j.tags, new RegExp(`<meta property="og:url" content="${ORIGIN}/badge/cred_0123456789ab">`));
    assert.match(j.tags, new RegExp(`<meta property="og:image" content="${ORIGIN}${OG_IMAGE_PATH}">`));
    assert.match(j.tags, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(j.tags, /Verified by IndustryProof on Oct 9, 2026\. .*5\/5/);
    assert.doesNotMatch(j.tags, /noindex/);
    for (const head of [shareHead(riley, ORIGIN), shareHead(null, ORIGIN)]) {
      assert.equal(head.title, 'Verify an IndustryProof credential');
      assert.match(head.tags, /<meta name="robots" content="noindex">/);
      assert.doesNotMatch(head.tags, /Riley|fail/i);
    }
    assert.match(shareHead(null, ORIGIN).tags, new RegExp(`<link rel="canonical" href="${ORIGIN}/">`));
  },

  'social preview escapes HTML in the record'() {
    const evil = structuredClone(jordan);
    evil.record.candidate = '"><script>alert(1)</script>';
    const { title, tags } = shareHead(evil, ORIGIN);
    assert.doesNotMatch(tags, /<script>/);
    assert.match(tags, /&quot;&gt;&lt;script&gt;/);
    assert.equal(title, '"><script>alert(1)</script> · Etch Tool Fault Response'); // the server escapes the title
  },

  'badge url and emblem'() {
    assert.equal(badgeUrl('https://x.test/', 'cred_0123456789ab'), 'https://x.test/badge/cred_0123456789ab');
    const a = emblemSVG();
    const b = emblemSVG(48);
    assert.match(a, /^<svg class="emblem" width="96"/);
    assert.notEqual(a.match(/id="([^"]+)"/)[1], b.match(/id="([^"]+)"/)[1]);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${e.message.split('\n').join('\n  ')}`);
  }
}
process.exit(failed ? 1 : 0);
