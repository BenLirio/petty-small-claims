// Petty Small Claims — client logic
//
// Flow (user-driven, no hidden charges):
//   1. User enters plaintiff / defendant / grievance.
//   2. Clerk (LLM) drafts tailored aggravator chips AND tailored itemized-damage chips.
//      User picks any that apply from BOTH lists. Nothing is tacked on at the end.
//   3. On file, LLM produces findings / verdict / base damages ONLY.
//      Total = base damages × aggravator multiplier + sum(selected itemized damages).
//   4. Local deterministic fallback kicks in on any LLM error.
//   5. Serializes only case inputs + selected chip keys to the URL fragment.
//   6. Paid-receipt flow unchanged.
//
// Design rule: everything on the judgment must be something the user input or
// explicitly selected. The clerk never invents surprise line items.

(function () {
  'use strict';

  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'petty-small-claims';

  // Default aggravator multipliers (fallback + seed for AI-generated set)
  const AGG = {
    labeled:   { label: 'it was labeled',  mult: 1.20 },
    denied:    { label: 'they denied it',  mult: 1.35 },
    third:     { label: 'third offense',   mult: 1.50 },
    pandemic:  { label: 'mid-pandemic',    mult: 1.15 },
    birthday:  { label: 'on my birthday',  mult: 1.75 }
  };

  // Default itemized-damage chips (fallback + seed for AI-generated set).
  // User picks which apply — these are NOT auto-added to the judgment.
  const ITEM = {
    tupperware:  { label: 'Tupperware depreciation',   amount: 4.50 },
    emotional:   { label: 'emotional distress',        amount: 12.00 },
    spite:       { label: 'interest on spite',         amount: 3.14 },
    procedural:  { label: 'procedural inconvenience',  amount: 8.88 },
    principle:   { label: 'principle of the thing',    amount: 1.99 },
    eyeroll:     { label: 'eye-roll servicing',        amount: 6.25 },
    groupchat:   { label: 'groupchat reputational harm', amount: 14.40 },
    sigh:        { label: 'deep-sigh processing',      amount: 0.99 }
  };

  // Current live sets — may be replaced by AI-generated alternates tailored to grievance.
  let CURRENT_AGG = Object.assign({}, AGG);
  let CURRENT_ITEM = Object.assign({}, ITEM);

  const MAX_COMBINED_MULT = 2.50;

  // 8 verdict archetypes (ALL flattering to the plaintiff)
  const VERDICTS = [
    'Ruled In Your Favor, With Pettiness',
    'Counter-Suit Advised',
    'Case Dismissed On Vibes Alone',
    'Default Judgment: Cringe',
    'Awarded With Prejudice',
    'Stricken From The Record',
    'Ruled In Spirit Only',
    'Granted, Begrudgingly'
  ];

  // 12 findings templates for the local fallback — each echoes the defendant / grievance / aggravator verbatim.
  const FINDINGS_TEMPLATES = [
    (c) => `The court finds it uncontested that ${c.defendant} did, in fact, ${c.grievance.toLowerCase()}.`,
    (c) => `Witness testimony corroborates the plaintiff's claim that ${c.defendant} committed the act described: "${c.grievance}".`,
    (c) => `The aggravating factors on record (${c.aggName}) weigh against ${c.defendant}.`,
    (c) => `No plausible defense was offered by ${c.defendant} for the incident: "${c.grievance}".`,
    (c) => `The plaintiff, ${c.plaintiff}, has appeared in good faith; ${c.defendant} has not.`,
    (c) => `The grievance — "${c.grievance}" — constitutes a pattern this court finds persuasive.`,
    (c) => `${c.defendant}'s conduct, given ${c.aggName}, constitutes aggravated nuisance under local custom.`,
    (c) => `The court takes judicial notice that "${c.grievance}" is, on its face, rude.`,
    (c) => `Damages assessed by the clerk are found to be reasonable under the circumstances.`,
    (c) => `The plaintiff demonstrated admirable restraint in not escalating "${c.grievance}" further.`,
    (c) => `${c.defendant}'s silence on the matter of "${c.grievance}" is itself instructive.`,
    (c) => `The court acknowledges the plaintiff's emotional investment in the specific detail: "${c.grievance}".`
  ];

  const SILLY_COUNTIES = [
    'West Haversack', 'Muttontown', 'Brine Hollow', 'Pickle Ridge', 'Upper Niblick',
    'Old Slanderfield', 'Grievance Gulch', 'North Rumor', 'Beefshire', 'Lower Pettiford',
    'Kvetch Harbor', 'Grudgemont', 'Crumbington', 'Leftover Mesa', 'Sidewalk Crossing'
  ];

  // ---------- DOM ----------

  const $ = (sel) => document.querySelector(sel);

  const intake   = $('#intake');
  const loading  = $('#loading');
  const judgment = $('#judgment');
  const form     = $('#case-form');
  const errEl    = $('#form-error');
  const loaderText = $('#loader-text');
  const aggChipsEl  = $('#aggravator-chips');
  const itemChipsEl = $('#item-chips');
  const grievanceEl = $('#grievance');
  const suggestBtn  = $('#suggest-btn');
  const suggestStatus = $('#suggest-status');
  const aggSummary = $('#agg-summary');
  const itemSummary = $('#item-summary');

  // Multi-select arrays of chip keys (order = click order)
  let selectedAggs = [];
  let selectedItems = [];
  let suggestInflight = false;
  let lastSuggestHash = 0;

  // ---------- Chips ----------

  aggChipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.key;
    const idx = selectedAggs.indexOf(key);
    if (idx >= 0) {
      selectedAggs.splice(idx, 1);
      chip.setAttribute('aria-checked', 'false');
    } else {
      selectedAggs.push(key);
      chip.setAttribute('aria-checked', 'true');
    }
    updateAggSummary();
  });

  if (itemChipsEl) {
    itemChipsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const key = chip.dataset.key;
      const idx = selectedItems.indexOf(key);
      if (idx >= 0) {
        selectedItems.splice(idx, 1);
        chip.setAttribute('aria-checked', 'false');
      } else {
        selectedItems.push(key);
        chip.setAttribute('aria-checked', 'true');
      }
      updateItemSummary();
    });
  }

  function updateAggSummary() {
    if (!aggSummary) return;
    if (!selectedAggs.length) {
      aggSummary.textContent = '';
      return;
    }
    const mult = combinedMultiplier(selectedAggs);
    const label = selectedAggs.length === 1 ? '1 factor' : (selectedAggs.length + ' factors');
    const capNote = mult >= MAX_COMBINED_MULT - 0.001 ? ' (capped)' : '';
    aggSummary.textContent = label + ' on record — combined multiplier ×' + mult.toFixed(2) + capNote;
  }

  function updateItemSummary() {
    if (!itemSummary) return;
    if (!selectedItems.length) {
      itemSummary.textContent = '';
      return;
    }
    const sum = selectedItems.reduce((s, k) => {
      const def = CURRENT_ITEM[k] || ITEM[k];
      return s + (def ? Number(def.amount) || 0 : 0);
    }, 0);
    const label = selectedItems.length === 1 ? '1 line item' : (selectedItems.length + ' line items');
    itemSummary.textContent = label + ' selected — subtotal ' + fmt$(sum);
  }

  // ---------- Hash / RNG ----------

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // Mulberry32 PRNG for seeded sequences
  function prng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Multiplier math ----------

  // Combine multipliers with diminishing returns:
  // total = 1 + sum( (m_i - 1) * decay^i ), decay=0.6, then hard-capped at 2.50.
  // Stable across selection order because we sort bonuses desc before applying decay.
  function combinedMultiplier(keys) {
    if (!keys.length) return 1;
    const bonuses = keys.map((k) => {
      const def = CURRENT_AGG[k] || AGG[k];
      if (!def) return 0;
      return Math.max(0, def.mult - 1);
    }).sort((a, b) => b - a);
    let mult = 1;
    const decay = 0.6;
    for (let i = 0; i < bonuses.length; i++) {
      mult += bonuses[i] * Math.pow(decay, i);
    }
    return Math.min(MAX_COMBINED_MULT, round2(mult));
  }

  function combinedAggName(keys) {
    const names = keys.map((k) => {
      const def = CURRENT_AGG[k] || AGG[k];
      return def ? def.label : k;
    });
    if (names.length === 0) return '(none)';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names.join(' and ');
    return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
  }

  function selectedItemLines(keys) {
    return keys.map((k) => {
      const def = CURRENT_ITEM[k] || ITEM[k];
      if (!def) return null;
      return { label: def.label, amount: round2(Number(def.amount) || 0) };
    }).filter(Boolean);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmt$(n) {
    if (!isFinite(n)) n = 0;
    return '$' + round2(n).toFixed(2);
  }

  // Deterministic fallback base damages (< $10), seeded by grievance text.
  function fallbackBaseDamages(grievance) {
    const rand = prng(hashStr((grievance || 'nothing') + '|base') || 1);
    const v = 1.25 + rand() * 8.5;
    return round2(v);
  }

  // ---------- Case number / county ----------

  function caseNumberFromHash(h) {
    const four = String(h % 10000).padStart(4, '0');
    return '26-04-' + four;
  }

  function pickCounty(h) {
    return 'Circuit Court of ' + SILLY_COUNTIES[h % SILLY_COUNTIES.length] + ' County';
  }

  // ---------- Input hash for cache / seed ----------
  // NOTE: hash does NOT include selected items — items affect only the rendered
  // total, not the LLM-generated findings / verdict / base. Same base & findings
  // can be reused even if user toggles itemized line-items.

  function inputHash(c) {
    return hashStr([
      (c.plaintiff || '').trim().toLowerCase(),
      (c.defendant || '').trim().toLowerCase(),
      (c.grievance || '').trim().toLowerCase(),
      (Array.isArray(c.aggs) ? c.aggs.slice().sort().join(',') : '')
    ].join('|'));
  }

  // ---------- Fallback (local, deterministic) ----------

  function fallbackPayload(ctx) {
    const h = inputHash(ctx);
    const rand = prng(h || 1);

    const findings = [];
    const used = new Set();
    while (findings.length < 3) {
      const i = Math.floor(rand() * FINDINGS_TEMPLATES.length);
      if (used.has(i)) continue;
      used.add(i);
      findings.push(FINDINGS_TEMPLATES[i](ctx));
    }

    const verdict = VERDICTS[h % VERDICTS.length];

    return {
      case_number: caseNumberFromHash(h),
      county: pickCounty(h),
      findings,
      verdict_archetype: verdict,
      base_damages: fallbackBaseDamages(ctx.grievance)
    };
  }

  // ---------- LLM call: main judgment ----------

  const SYSTEM_PROMPT = [
    'You are a dead-pan 1950s court clerk with a faint contempt for everyone.',
    'You fill in the flavor text AND assess base damages for a mock small-claims court judgment.',
    'You do NOT speak to the user. You do NOT ask follow-up questions.',
    'You do NOT say "here is" or "sure!" — you return JSON only.',
    'Every finding must quote or directly reference the plaintiff\'s stated grievance text verbatim (or a short verbatim slice of it).',
    'Findings are formal, clipped, faintly contemptuous. No exclamation marks. No modern slang.',
    'Base damages must be STRICTLY LESS than $10.00 and greater than $0.25 — small, petty, specific. The client applies the aggravator multiplier.',
    'Do NOT invent additional damage line items. The plaintiff picks their own itemized damages from separate chips. You only assess the base.',
    'Return strict JSON matching this schema:',
    '{',
    '  "case_number": string,           // format "26-04-XXXX" (4 digits)',
    '  "county": string,                // e.g. "Circuit Court of West Haversack County"',
    '  "findings": [string, string, string],  // exactly 3',
    '  "verdict_archetype": string,     // MUST be one of the 8 allowed archetypes',
    '  "base_damages": number           // STRICTLY less than 10.00, greater than 0.25',
    '}',
    'Allowed verdict_archetype values (pick exactly one):',
    VERDICTS.map((v) => '  - ' + v).join('\n')
  ].join('\n');

  async function callLLM(ctx) {
    const userPrompt = [
      'Plaintiff: ' + ctx.plaintiff,
      'Defendant: ' + ctx.defendant,
      'Grievance: "' + ctx.grievance + '"',
      'Aggravating factors on record: ' + ctx.aggName + ' (combined multiplier ×' + ctx.aggMult.toFixed(2) + ')',
      '',
      'Fill in the judgment flavor AND assess base damages (under $10) as strict JSON. Do NOT add extra damage line items.'
    ].join('\n');

    const body = {
      slug: SLUG,
      model: 'gpt-5.4',
      temperature: 0.4,
      max_tokens: 500,
      response_format: 'json_object',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    };

    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    if (!data || typeof data.content !== 'string') throw new Error('bad_shape');

    let parsed;
    try { parsed = JSON.parse(data.content); }
    catch (e) { throw new Error('bad_json'); }

    if (!parsed || typeof parsed !== 'object') throw new Error('bad_obj');
    if (!Array.isArray(parsed.findings) || parsed.findings.length < 3) throw new Error('bad_findings');
    if (typeof parsed.case_number !== 'string') throw new Error('bad_case');
    if (typeof parsed.county !== 'string') throw new Error('bad_county');
    if (typeof parsed.verdict_archetype !== 'string') throw new Error('bad_verdict');

    parsed.findings = parsed.findings.slice(0, 3).map((s) => String(s));

    if (VERDICTS.indexOf(parsed.verdict_archetype) < 0) {
      parsed.verdict_archetype = VERDICTS[inputHash(ctx) % VERDICTS.length];
    }

    if (!/^26-04-\d{4}$/.test(parsed.case_number)) {
      parsed.case_number = caseNumberFromHash(inputHash(ctx));
    }

    let base = Number(parsed.base_damages);
    if (!isFinite(base) || base <= 0) base = fallbackBaseDamages(ctx.grievance);
    if (base >= 10) base = 9.99;
    if (base < 0.25) base = 0.25;
    parsed.base_damages = round2(base);

    // Strip any micro_damages the model may still have volunteered — we do
    // not surface them. Line items are user-picked only.
    delete parsed.micro_damages;

    return parsed;
  }

  // ---------- Orchestrator ----------

  function cacheKey(ctx) { return 'psc:' + inputHash(ctx); }

  function readCache(ctx) {
    try {
      const raw = localStorage.getItem(cacheKey(ctx));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.micro_damages)) delete parsed.micro_damages;
      return parsed;
    } catch (e) { return null; }
  }

  function writeCache(ctx, payload) {
    try {
      const toSave = Object.assign({}, payload);
      delete toSave.micro_damages;
      localStorage.setItem(cacheKey(ctx), JSON.stringify(toSave));
    } catch (e) { /* ignore quota */ }
  }

  function buildContext({ plaintiff, defendant, grievance, aggs, items }) {
    const mult = combinedMultiplier(aggs);
    const name = combinedAggName(aggs);
    return {
      plaintiff: plaintiff.trim(),
      defendant: defendant.trim(),
      grievance: grievance.trim(),
      aggs: aggs.slice(),
      items: Array.isArray(items) ? items.slice() : [],
      aggName: name,
      aggMult: mult
    };
  }

  async function fileCase(ctx) {
    const cached = readCache(ctx);
    if (cached) return cached;

    try {
      const payload = await callLLM(ctx);
      writeCache(ctx, payload);
      return payload;
    } catch (err) {
      console.warn('[petty] LLM failed, using local fallback:', err && err.message);
      const payload = fallbackPayload(ctx);
      writeCache(ctx, payload);
      return payload;
    }
  }

  // ---------- Rendering ----------

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderJudgment(ctx, payload) {
    const base = Number(payload.base_damages) || 0;
    const baseAwarded = round2(base * ctx.aggMult);
    const aggPart = ctx.aggs.length
      ? `assessed base damages × ${ctx.aggMult.toFixed(2)} (${ctx.aggName})`
      : `assessed base damages (no aggravators on record)`;
    const baseLine = {
      label: `base damages — ${aggPart}`,
      amount: baseAwarded
    };

    // Only user-selected itemized damages — no surprise additions.
    const itemLines = selectedItemLines(ctx.items || []);
    const lines = [baseLine, ...itemLines];
    const total = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

    const countyUpper = payload.county.toUpperCase();

    const aggSectionHtml = ctx.aggs.length ? `
      <div class="section-hd">Aggravating Factors On Record</div>
      <div class="agg-line">${escapeHtml(ctx.aggName)} <span class="mult">(combined multiplier: ×${ctx.aggMult.toFixed(2)})</span></div>
    ` : `
      <div class="section-hd">Aggravating Factors On Record</div>
      <div class="agg-line"><em>none selected by the plaintiff.</em></div>
    `;

    const html = `
      <div class="doc-banner">
        <div class="doc-banner-1">IN THE ${escapeHtml(countyUpper)} SMALL CLAIMS COURT</div>
        <div class="doc-banner-2">Judgment &amp; Order of the Clerk</div>
      </div>

      <div class="docket-row">
        <div>
          Docket No. ${escapeHtml(payload.case_number)}<br>
          Filed: ${escapeHtml(todayStamp())}
        </div>
        <div class="case-stamp" aria-label="Case number stamp">CASE ${escapeHtml(payload.case_number)}</div>
      </div>

      <div class="parties">
        ${escapeHtml(ctx.plaintiff)}
        <span class="v">— v. —</span>
        ${escapeHtml(ctx.defendant)}
      </div>

      <div class="section-hd">Statement of Grievance</div>
      <div class="grievance-quote">"${escapeHtml(ctx.grievance)}"</div>

      ${aggSectionHtml}

      <div class="section-hd">Official Findings</div>
      <ul class="findings">
        ${payload.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
      </ul>

      <div class="section-hd">Awarded Damages</div>
      <table class="damages-table">
        <tbody>
          ${lines.map((l) => `
            <tr>
              <td>${escapeHtml(l.label)}</td>
              <td class="amt">${fmt$(l.amount)}</td>
            </tr>`).join('')}
          <tr class="total">
            <td>AWARDED TOTAL</td>
            <td class="amt">${fmt$(total)}</td>
          </tr>
        </tbody>
      </table>
      <div class="foot-math">Base = clerk-assessed ${fmt$(base)} × ${ctx.aggMult.toFixed(2)} = ${fmt$(baseAwarded)}${itemLines.length ? ' · ' + itemLines.length + ' line item' + (itemLines.length === 1 ? '' : 's') + ' selected by the plaintiff' : ' · no itemized damages selected'}</div>

      <div class="verdict-block">
        <div class="verdict-label">Verdict of the Court</div>
        <div class="verdict-name">${escapeHtml(payload.verdict_archetype)}</div>
      </div>

      <div class="signature-row">
        <div class="sig-line">/s/ Clerk of the Court — ${escapeHtml(payload.county)}</div>
        <div class="clerk-seal" aria-hidden="true">
          <svg viewBox="0 0 100 100" width="100" height="100">
            <defs>
              <path id="rim-${payload.case_number}" d="M50,50 m-40,0 a40,40 0 1,1 80,0 a40,40 0 1,1 -80,0"></path>
            </defs>
            <circle cx="50" cy="50" r="46" fill="none" stroke="#181714" stroke-width="1.5"></circle>
            <circle cx="50" cy="50" r="38" fill="none" stroke="#181714" stroke-width="0.75"></circle>
            <text font-family="IBM Plex Mono, monospace" font-size="7" letter-spacing="2" fill="#181714">
              <textPath href="#rim-${payload.case_number}" startOffset="0">CIRCUIT COURT OF HONEST GRIEVANCES ★ SEAL ★ </textPath>
            </text>
            <text x="50" y="56" text-anchor="middle" font-family="Playfair Display, serif" font-weight="900" font-size="18" fill="#b1271b">S.C.</text>
          </svg>
        </div>
      </div>
    `;
    return html;
  }

  function todayStamp() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${String(d.getFullYear()).slice(2)}`;
  }

  // ---------- Fragment (share URL) encoding ----------
  //
  // v4 fragment: inputs + selected chip keys + custom chip sets. The receiver's
  // client re-runs the LLM (or hits local cache) to regenerate findings /
  // verdict / base damages, and reconstructs the judgment's line items from the
  // selected keys + embedded custom sets.
  //
  // {
  //   v: 4,
  //   p: plaintiff, d: defendant, g: grievance,
  //   a: [aggKey, ...],                            // selected aggravator keys
  //   i: [itemKey, ...],                           // selected itemized-damage keys
  //   c: { key: {label, mult}, ... } | null,       // custom aggravator set (if LLM drafted)
  //   ci: { key: {label, amount}, ... } | null,    // custom item set (if LLM drafted)
  //   paid: 1?, ps: sig?, pt: date?                // optional paid-receipt fields
  // }
  //
  // v3 fragments are still decoded; their embedded micro_damages are treated as
  // the sender's itemized selections so the receiver sees the same line items.

  function b64urlEncode(str) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
    s += '='.repeat(pad);
    try { return decodeURIComponent(escape(atob(s))); } catch (e) { return null; }
  }

  function isDefaultAggSet() {
    const keys = Object.keys(CURRENT_AGG);
    if (keys.length !== Object.keys(AGG).length) return false;
    for (const k of keys) {
      const a = CURRENT_AGG[k], b = AGG[k];
      if (!b) return false;
      if (a.label !== b.label || Math.abs(a.mult - b.mult) > 0.001) return false;
    }
    return true;
  }

  function isDefaultItemSet() {
    const keys = Object.keys(CURRENT_ITEM);
    if (keys.length !== Object.keys(ITEM).length) return false;
    for (const k of keys) {
      const a = CURRENT_ITEM[k], b = ITEM[k];
      if (!b) return false;
      if (a.label !== b.label || Math.abs((Number(a.amount) || 0) - (Number(b.amount) || 0)) > 0.001) return false;
    }
    return true;
  }

  function encodeCaseToFragment(ctx, extra) {
    const blob = {
      v: 4,
      p: ctx.plaintiff,
      d: ctx.defendant,
      g: ctx.grievance,
      a: ctx.aggs.slice(),
      i: (ctx.items || []).slice()
    };
    if (!isDefaultAggSet()) {
      const needed = {};
      ctx.aggs.forEach((k) => {
        if (CURRENT_AGG[k]) needed[k] = { label: CURRENT_AGG[k].label, mult: CURRENT_AGG[k].mult };
      });
      if (Object.keys(needed).length) blob.c = needed;
    }
    if (!isDefaultItemSet()) {
      const needed = {};
      (ctx.items || []).forEach((k) => {
        if (CURRENT_ITEM[k]) needed[k] = { label: CURRENT_ITEM[k].label, amount: CURRENT_ITEM[k].amount };
      });
      if (Object.keys(needed).length) blob.ci = needed;
    }
    if (extra && extra.paid) {
      blob.paid = 1;
      blob.ps = extra.paidSig || '';
      if (extra.paidAt) blob.pt = extra.paidAt;
    }
    return b64urlEncode(JSON.stringify(blob));
  }

  // Decode v1..v4 for back-compat.
  function decodeFragment(frag) {
    if (!frag || frag.length < 4) return null;
    const raw = b64urlDecode(frag);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o) return null;

      if (o.v === 4) {
        if (!o.p || !o.d || !o.g || !Array.isArray(o.a)) return null;
        return { version: 4, blob: o };
      }
      if (o.v === 3) {
        if (!o.p || !o.d || !o.g || !Array.isArray(o.a)) return null;
        return { version: 3, blob: o };
      }
      if (o.v === 1 || o.v === 2) {
        if (!o.p || !o.d || !o.g || !o.a || !o.ai) return null;
        if (o.v === 1 && !AGG[o.a]) return null;
        if (o.v === 2 && (!o.ag || !o.ag.label || typeof o.ag.mult !== 'number')) return null;
        return { version: o.v, blob: o };
      }
      return null;
    } catch (e) { return null; }
  }

  // Deterministic payment signature derived from case identity.
  function paidSignature(ctx) {
    const basis = [
      'paid',
      ctx.plaintiff.toLowerCase(),
      ctx.defendant.toLowerCase(),
      ctx.grievance.toLowerCase(),
      ctx.aggName.toLowerCase(),
      ctx.aggMult.toFixed(2),
      (ctx.items || []).slice().sort().join(',')
    ].join('|');
    const h = hashStr(basis);
    const h2 = hashStr(basis + '|salt-3f7c');
    return (h.toString(36) + '-' + h2.toString(36)).slice(0, 24);
  }

  // ---------- Screen switching ----------

  function show(which) {
    for (const el of [intake, loading, judgment]) el.classList.add('hidden');
    which.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  const shareSection = document.getElementById('share');
  const paidSection  = document.getElementById('paid-actions');

  function senderHasCase(ctx) {
    try { return !!localStorage.getItem('psc-sender:' + inputHash(ctx)); }
    catch (e) { return false; }
  }
  function markSenderOwned(ctx) {
    try { localStorage.setItem('psc-sender:' + inputHash(ctx), '1'); } catch (e) { /* ignore */ }
  }

  function markPaidLocally(ctx, paidAt) {
    try { localStorage.setItem('psc-paid:' + inputHash(ctx), paidAt || '1'); }
    catch (e) { /* ignore */ }
  }
  function readPaidLocally(ctx) {
    try { return localStorage.getItem('psc-paid:' + inputHash(ctx)); }
    catch (e) { return null; }
  }

  function renderPaidStamp(paidAt) {
    const doc = document.getElementById('judgment-doc');
    if (!doc) return;
    if (doc.querySelector('.paid-stamp')) return;
    const stamp = document.createElement('div');
    stamp.className = 'paid-stamp';
    stamp.setAttribute('aria-label', 'Paid stamp');
    const stampInner = document.createElement('div');
    stampInner.className = 'paid-stamp-inner';
    stampInner.textContent = 'PAID';
    const sub = document.createElement('div');
    sub.className = 'paid-stamp-sub';
    sub.textContent = paidAt && paidAt !== '1' ? ('marked paid ' + paidAt) : 'marked paid by receiver';
    stamp.appendChild(stampInner);
    stamp.appendChild(sub);
    doc.appendChild(stamp);
  }

  function renderPaidActions(ctx, payload, opts) {
    if (!paidSection) return;
    paidSection.innerHTML = '';
    paidSection.style.display = '';

    const state = opts || {};
    const isSender = senderHasCase(ctx);
    const isPaidInUrl = !!state.paid;
    const sigValid = isPaidInUrl && state.paidSig === paidSignature(ctx);
    const locallyPaid = readPaidLocally(ctx);

    if (isSender && isPaidInUrl && sigValid) {
      markPaidLocally(ctx, state.paidAt || todayStamp());
    }

    const effectivelyPaid = (isPaidInUrl && sigValid) || !!locallyPaid;

    if (effectivelyPaid) {
      const strip = document.createElement('div');
      strip.className = 'paid-strip paid-strip-ok';
      const when = (isPaidInUrl && sigValid && state.paidAt) ? state.paidAt : (locallyPaid && locallyPaid !== '1' ? locallyPaid : '');
      strip.innerHTML = '<strong>Receipt verified.</strong> This claim is marked paid' + (when ? ' (' + escapeHtml(when) + ')' : '') + '. The signature matches the case.';
      paidSection.appendChild(strip);
      return;
    }
    if (isPaidInUrl && !sigValid) {
      const strip = document.createElement('div');
      strip.className = 'paid-strip paid-strip-bad';
      strip.innerHTML = '<strong>Paid flag present but signature does not match.</strong> Treat as unverified.';
      paidSection.appendChild(strip);
      return;
    }

    if (isSender) {
      const note = document.createElement('div');
      note.className = 'paid-note';
      note.innerHTML = 'Share this URL with the defendant. When they mark the claim paid, they\'ll hand you a short receipt URL — opening that URL once will stamp <strong>PAID</strong> on your case permanently on this device.';
      paidSection.appendChild(note);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'paid-receiver';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mark-paid-btn';
    btn.textContent = 'MARK THIS CLAIM AS PAID';
    wrap.appendChild(btn);
    const hint = document.createElement('p');
    hint.className = 'paid-hint';
    hint.textContent = 'Defendants only. Marking paid generates a short receipt URL you send back to the plaintiff as proof.';
    wrap.appendChild(hint);

    const receiptBox = document.createElement('div');
    receiptBox.className = 'receipt-box hidden';
    wrap.appendChild(receiptBox);

    btn.addEventListener('click', () => {
      const sig = paidSignature(ctx);
      const nowStamp = todayStamp();
      const frag = encodeCaseToFragment(ctx, { paid: 1, paidSig: sig, paidAt: nowStamp });
      const receiptUrl = location.origin + location.pathname + '#' + frag;
      history.replaceState(null, '', '#' + frag);
      renderPaidStamp(nowStamp);

      receiptBox.classList.remove('hidden');
      receiptBox.innerHTML = '';
      const lab = document.createElement('div');
      lab.className = 'receipt-label';
      lab.textContent = 'Receipt URL — send this back to the plaintiff:';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.readOnly = true;
      inp.value = receiptUrl;
      inp.className = 'receipt-url';
      const row = document.createElement('div');
      row.className = 'receipt-row';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'receipt-copy';
      copyBtn.textContent = 'COPY RECEIPT URL';
      copyBtn.addEventListener('click', () => {
        try {
          inp.select();
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(receiptUrl)
              .then(() => { copyBtn.textContent = 'COPIED'; })
              .catch(() => { copyBtn.textContent = 'SELECT + COPY'; });
          } else {
            document.execCommand && document.execCommand('copy');
            copyBtn.textContent = 'COPIED';
          }
        } catch (e) { /* ignore */ }
      });
      const shareBtn2 = document.createElement('button');
      shareBtn2.type = 'button';
      shareBtn2.className = 'receipt-share';
      shareBtn2.textContent = 'SHARE';
      shareBtn2.addEventListener('click', () => {
        if (navigator.share) {
          navigator.share({ title: 'Receipt of payment', url: receiptUrl }).catch(() => {});
        } else {
          copyBtn.click();
        }
      });
      row.appendChild(copyBtn);
      row.appendChild(shareBtn2);
      receiptBox.appendChild(lab);
      receiptBox.appendChild(inp);
      receiptBox.appendChild(row);

      btn.style.display = 'none';
      hint.style.display = 'none';
    });

    paidSection.appendChild(wrap);
  }

  function renderAndShow(ctx, payload, opts) {
    const doc = document.getElementById('judgment-doc');
    doc.innerHTML = renderJudgment(ctx, payload);
    const state = opts || {};
    const isSender = senderHasCase(ctx);
    const sigValid = state.paid && state.paidSig === paidSignature(ctx);
    if (sigValid) {
      renderPaidStamp(state.paidAt || '');
    } else if (isSender && readPaidLocally(ctx)) {
      renderPaidStamp(readPaidLocally(ctx));
    }
    if (shareSection) shareSection.style.display = '';
    renderPaidActions(ctx, payload, state);
    show(judgment);
  }

  // ---------- Loading typewriter ----------

  const LOADING_LINES = [
    'docketing your case…',
    'stamping the seal…',
    'consulting the clerk…',
    'reviewing precedent…',
    'drafting the findings…',
    'assessing the base damages…'
  ];
  let loadTimer = null;

  function startLoading() {
    show(loading);
    let i = 0;
    loaderText.textContent = LOADING_LINES[0];
    loadTimer = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      loaderText.textContent = LOADING_LINES[i];
    }, 900);
  }

  function stopLoading() {
    if (loadTimer) { clearInterval(loadTimer); loadTimer = null; }
  }

  // ---------- AI suggestions for aggravators + itemized damages ----------
  //
  // Single LLM call returns BOTH chip sets so the user gets a cohesive, tailored
  // palette to pick from on the intake form.

  const SUGGEST_SYSTEM_PROMPT = [
    'You are a world-class comedy writer impersonating a dead-pan 1950s court clerk.',
    'You help a plaintiff shape a mock small-claims filing by drafting TWO chip palettes:',
    '  (A) Aggravating-factor chips — conditions that multiply the base damages.',
    '  (B) Itemized-damage chips — specific absurd line-items the plaintiff can choose to include.',
    'The plaintiff selects WHICH of each they want on record. You do not add anything automatically.',
    'You do NOT speak to the user. You do NOT ask follow-up questions. Return strict JSON only.',
    '',
    'HARD requirements for aggravator chips:',
    '  - 6 chips. 2 to 6 words each. No trailing period. No quotes.',
    '  - Register: "it was labeled" / "on my birthday" / "third offense" / "in front of guests" / "after I warned them".',
    '  - Each chip SPECIFICALLY tailored to THIS grievance — reference a concrete detail, witness, timing, or pattern it implies.',
    '  - Funny, petty, specific. Avoid cliché (no "adds insult to injury", no "salt in the wound").',
    '  - Multiplier 1.10 to 1.85, two decimals. Petty small things ~1.10-1.25; genuinely aggravating ~1.50-1.85.',
    '',
    'HARD requirements for itemized-damage chips:',
    '  - 6 chips. Each is a short comedic line-item label (2 to 5 words) plus a dollar amount.',
    '  - Each tailored to THIS grievance — reference the specific situation, object, or injury.',
    '  - Label examples: "Tupperware depreciation", "groupchat reputational harm", "eye-roll servicing", "sidewalk glare tax".',
    '  - Amount 0.50 to 25.00, two decimals, petty and specific (odd cents encouraged).',
    '  - No trailing period. No quotes in labels.',
    '',
    'Return strict JSON:',
    '{',
    '  "aggravators": [ {"label": string, "mult": number}, ... exactly 6 ],',
    '  "items":       [ {"label": string, "amount": number}, ... exactly 6 ]',
    '}',
    'No commentary. No preface. JSON only.'
  ].join('\n');

  async function callSuggestLLM(plaintiff, defendant, grievance) {
    const userPrompt = [
      'Plaintiff: ' + (plaintiff || '(unspecified)'),
      'Defendant: ' + (defendant || '(unspecified)'),
      'Grievance: "' + grievance + '"',
      '',
      'Return six tailored aggravator chips AND six tailored itemized-damage chips as JSON.'
    ].join('\n');

    const body = {
      slug: SLUG,
      model: 'gpt-5.4',
      temperature: 0.55,
      max_tokens: 700,
      response_format: 'json_object',
      messages: [
        { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt }
      ]
    };

    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    if (!data || typeof data.content !== 'string') throw new Error('bad_shape');

    let parsed;
    try { parsed = JSON.parse(data.content); } catch (e) { throw new Error('bad_json'); }
    if (!parsed || typeof parsed !== 'object') throw new Error('bad_obj');
    if (!Array.isArray(parsed.aggravators) || parsed.aggravators.length < 3) throw new Error('bad_aggs');
    if (!Array.isArray(parsed.items) || parsed.items.length < 3) throw new Error('bad_items');

    const aggs = parsed.aggravators.slice(0, 6).map((a, i) => {
      const label = String(a.label || ('factor ' + (i + 1))).replace(/["'\.]+$/g, '').slice(0, 48);
      let mult = Number(a.mult);
      if (!isFinite(mult)) mult = 1.2;
      mult = Math.max(1.05, Math.min(1.95, mult));
      mult = Math.round(mult * 100) / 100;
      return { label: label, mult: mult };
    });
    const aggFillers = Object.values(AGG);
    while (aggs.length < 6) aggs.push(aggFillers[aggs.length % aggFillers.length]);

    const items = parsed.items.slice(0, 6).map((a, i) => {
      const label = String(a.label || ('line item ' + (i + 1))).replace(/["'\.]+$/g, '').slice(0, 56);
      let amount = Number(a.amount);
      if (!isFinite(amount)) amount = 2.50;
      amount = Math.max(0.25, Math.min(25.00, amount));
      amount = Math.round(amount * 100) / 100;
      return { label: label, amount: amount };
    });
    const itemFillers = Object.values(ITEM);
    while (items.length < 6) items.push(itemFillers[items.length % itemFillers.length]);

    return { aggravators: aggs, items: items };
  }

  function keyFromLabel(prefix, label, idx) {
    const k = String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    return (k || (prefix + idx)) + '-' + idx;
  }

  function renderAggChips(aggSet) {
    aggChipsEl.innerHTML = '';
    const newCurrent = {};
    aggSet.forEach((a, i) => {
      const key = keyFromLabel('agg', a.label, i);
      newCurrent[key] = { label: a.label, mult: a.mult };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.key = key;
      btn.dataset.mult = String(a.mult);
      btn.textContent = a.label + '  ×' + a.mult.toFixed(2);
      aggChipsEl.appendChild(btn);
    });
    CURRENT_AGG = newCurrent;
    selectedAggs = [];
    updateAggSummary();
  }

  function renderItemChips(itemSet) {
    if (!itemChipsEl) return;
    itemChipsEl.innerHTML = '';
    const newCurrent = {};
    itemSet.forEach((a, i) => {
      const key = keyFromLabel('item', a.label, i);
      newCurrent[key] = { label: a.label, amount: a.amount };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.key = key;
      btn.dataset.amount = String(a.amount);
      btn.textContent = a.label + '  ' + fmt$(a.amount);
      itemChipsEl.appendChild(btn);
    });
    CURRENT_ITEM = newCurrent;
    selectedItems = [];
    updateItemSummary();
  }

  async function runSuggest(manual) {
    const grievance = (grievanceEl.value || '').trim();
    if (!grievance || grievance.length < 6) {
      if (manual) setSuggestStatus('type a grievance first (6+ chars)');
      return;
    }
    const plaintiff = ($('#plaintiff').value || '').trim();
    const defendant = ($('#defendant').value || '').trim();
    const h = hashStr((plaintiff + '|' + defendant + '|' + grievance).toLowerCase());
    if (h === lastSuggestHash && !manual) return;
    if (suggestInflight) return;
    suggestInflight = true;
    setSuggestStatus('clerk is drafting options…');
    if (suggestBtn) suggestBtn.disabled = true;

    try {
      const out = await callSuggestLLM(plaintiff, defendant, grievance);
      renderAggChips(out.aggravators);
      renderItemChips(out.items);
      lastSuggestHash = h;
      setSuggestStatus('aggravators and line-items tailored — pick any that apply');
    } catch (err) {
      console.warn('[petty] suggest failed:', err && err.message);
      setSuggestStatus('couldn’t reach the clerk — using default options');
    } finally {
      suggestInflight = false;
      if (suggestBtn) suggestBtn.disabled = false;
    }
  }

  function setSuggestStatus(msg) {
    if (suggestStatus) suggestStatus.textContent = msg || '';
  }

  if (grievanceEl) {
    grievanceEl.addEventListener('blur', () => { runSuggest(false); });
  }
  if (suggestBtn) {
    suggestBtn.addEventListener('click', (e) => { e.preventDefault(); runSuggest(true); });
  }

  // ---------- Form submit ----------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';

    const plaintiff  = $('#plaintiff').value.trim();
    const defendant  = $('#defendant').value.trim();
    const grievance  = $('#grievance').value.trim();

    if (!plaintiff)  return setErr('The clerk needs a plaintiff name, please.');
    if (!defendant)  return setErr('A case needs a defendant — any name will do.');
    if (!grievance)  return setErr('State your grievance, however small.');
    // Aggravators & items are BOTH optional — the judgment always has at least
    // the base damages line, so the user can file a minimal case if they want.
    // But we nudge toward at least one selection so the result isn't bare.
    if (!selectedAggs.length && !selectedItems.length) {
      return setErr('Pick at least one aggravator OR itemized damage to put on record.');
    }

    const ctx = buildContext({
      plaintiff, defendant, grievance,
      aggs: selectedAggs,
      items: selectedItems
    });

    startLoading();
    const t0 = performance.now();
    let payload;
    try {
      payload = await fileCase(ctx);
    } catch (err) {
      payload = fallbackPayload(ctx);
    }
    const elapsed = performance.now() - t0;
    if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed));
    stopLoading();

    const frag = encodeCaseToFragment(ctx);
    history.replaceState(null, '', '#' + frag);

    markSenderOwned(ctx);

    renderAndShow(ctx, payload, {});
  });

  function setErr(msg) {
    errEl.textContent = msg;
  }

  // ---------- Reset ----------

  document.getElementById('reset-btn').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname + location.search);
    form.reset();
    selectedAggs = [];
    selectedItems = [];
    CURRENT_AGG = Object.assign({}, AGG);
    CURRENT_ITEM = Object.assign({}, ITEM);
    renderDefaultAggChips();
    renderDefaultItemChips();
    lastSuggestHash = 0;
    setSuggestStatus('');
    updateAggSummary();
    updateItemSummary();
    errEl.textContent = '';
    if (shareSection) shareSection.style.display = 'none';
    if (paidSection) paidSection.style.display = 'none';
    show(intake);
  });

  function renderDefaultAggChips() {
    aggChipsEl.innerHTML = '';
    Object.keys(AGG).forEach((key) => {
      const a = AGG[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.key = key;
      btn.dataset.mult = String(a.mult);
      btn.textContent = a.label;
      aggChipsEl.appendChild(btn);
    });
  }

  function renderDefaultItemChips() {
    if (!itemChipsEl) return;
    itemChipsEl.innerHTML = '';
    Object.keys(ITEM).forEach((key) => {
      const a = ITEM[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', 'false');
      btn.dataset.key = key;
      btn.dataset.amount = String(a.amount);
      btn.textContent = a.label + '  ' + fmt$(a.amount);
      itemChipsEl.appendChild(btn);
    });
  }

  // ---------- Share (exposed to onclick) ----------

  window.share = function () {
    const title = document.title;
    const url = location.href;
    if (navigator.share) {
      navigator.share({ title, url }).catch(() => {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => alert('Link copied! Paste it anywhere — your judgment loads instantly.'))
        .catch(() => alert(url));
    } else {
      alert(url);
    }
  };

  // ---------- Boot: hydrate from #fragment if present ----------

  (async function boot() {
    // Draw default item chips (HTML has default aggravator chips inline).
    renderDefaultItemChips();

    if (shareSection) shareSection.style.display = 'none';
    if (paidSection) paidSection.style.display = 'none';

    const frag = (location.hash || '').replace(/^#/, '');
    const decoded = decodeFragment(frag);

    if (decoded && decoded.version === 4) {
      const o = decoded.blob;

      // Reconstruct custom aggravator set
      if (o.c && typeof o.c === 'object') {
        CURRENT_AGG = {};
        Object.keys(o.c).forEach((k) => {
          const a = o.c[k];
          CURRENT_AGG[k] = { label: String(a.label || k), mult: Number(a.mult) || 1.2 };
        });
      } else {
        CURRENT_AGG = Object.assign({}, AGG);
      }

      // Reconstruct custom item set
      if (o.ci && typeof o.ci === 'object') {
        CURRENT_ITEM = {};
        Object.keys(o.ci).forEach((k) => {
          const a = o.ci[k];
          CURRENT_ITEM[k] = { label: String(a.label || k), amount: Number(a.amount) || 1.00 };
        });
      } else {
        CURRENT_ITEM = Object.assign({}, ITEM);
      }

      $('#plaintiff').value = o.p;
      $('#defendant').value = o.d;
      $('#grievance').value = o.g;

      renderHydratedAggChips(o.a || []);
      renderHydratedItemChips(o.i || []);

      selectedAggs = Array.isArray(o.a) ? o.a.slice() : [];
      selectedItems = Array.isArray(o.i) ? o.i.slice() : [];
      updateAggSummary();
      updateItemSummary();

      const ctx = buildContext({
        plaintiff: o.p, defendant: o.d, grievance: o.g,
        aggs: selectedAggs, items: selectedItems
      });

      let payload = readCache(ctx);
      if (!payload) {
        startLoading();
        try {
          payload = await callLLM(ctx);
          writeCache(ctx, payload);
        } catch (err) {
          payload = fallbackPayload(ctx);
          writeCache(ctx, payload);
        }
        stopLoading();
      }

      const paidState = {
        paid: !!o.paid,
        paidSig: o.ps || '',
        paidAt: o.pt || ''
      };
      renderAndShow(ctx, payload, paidState);
      return;
    }

    if (decoded && decoded.version === 3) {
      // v3 had micro_damages baked into the cached payload. Treat them as the
      // sender's chosen itemized line items so receivers see the same doc.
      const o = decoded.blob;

      if (o.c && typeof o.c === 'object') {
        CURRENT_AGG = {};
        Object.keys(o.c).forEach((k) => {
          const a = o.c[k];
          CURRENT_AGG[k] = { label: String(a.label || k), mult: Number(a.mult) || 1.2 };
        });
      } else {
        CURRENT_AGG = Object.assign({}, AGG);
      }
      CURRENT_ITEM = Object.assign({}, ITEM);

      $('#plaintiff').value = o.p;
      $('#defendant').value = o.d;
      $('#grievance').value = o.g;
      renderHydratedAggChips(o.a || []);

      selectedAggs = Array.isArray(o.a) ? o.a.slice() : [];
      updateAggSummary();

      const ctx = buildContext({
        plaintiff: o.p, defendant: o.d, grievance: o.g,
        aggs: selectedAggs, items: []
      });

      // Pull cached v3 payload if present — it has micro_damages.
      let cached = null;
      try {
        const raw = localStorage.getItem('psc:' + inputHash(ctx));
        if (raw) cached = JSON.parse(raw);
      } catch (e) { cached = null; }

      let payload;
      if (cached) {
        payload = Object.assign({}, cached);
      } else {
        startLoading();
        try { payload = await callLLM(ctx); }
        catch (err) { payload = fallbackPayload(ctx); }
        stopLoading();
      }

      // Absorb any old micro_damages from the cache as itemized line-items so
      // the receiver still sees a populated judgment.
      if (Array.isArray(cached && cached.micro_damages) && cached.micro_damages.length) {
        const tmp = {};
        const keys = [];
        cached.micro_damages.slice(0, 3).forEach((m, i) => {
          const k = keyFromLabel('item', m.label || ('item' + i), i);
          tmp[k] = { label: String(m.label || 'petty matter'), amount: Math.max(0, Number(m.amount) || 0) };
          keys.push(k);
        });
        CURRENT_ITEM = tmp;
        selectedItems = keys;
        ctx.items = keys.slice();
        updateItemSummary();
      }

      delete payload.micro_damages;
      writeCache(ctx, payload);

      const paidState = {
        paid: !!o.paid,
        paidSig: o.ps || '',
        paidAt: o.pt || ''
      };
      renderAndShow(ctx, payload, paidState);
      return;
    }

    // Legacy v1/v2: pre-existing behavior.
    if (decoded && (decoded.version === 1 || decoded.version === 2)) {
      const o = decoded.blob;
      $('#plaintiff').value = o.p;
      $('#defendant').value = o.d;
      $('#grievance').value = o.g;

      const def = (o.v === 2 && o.ag) ? o.ag : (AGG[o.a] || { label: o.a, mult: 1.2 });
      CURRENT_AGG = {};
      CURRENT_AGG[o.a] = { label: def.label, mult: def.mult };
      CURRENT_ITEM = Object.assign({}, ITEM);

      aggChipsEl.innerHTML = '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      btn.setAttribute('aria-checked', 'true');
      btn.dataset.key = o.a;
      btn.dataset.mult = String(def.mult);
      btn.textContent = def.label + '  ×' + Number(def.mult).toFixed(2);
      aggChipsEl.appendChild(btn);
      selectedAggs = [o.a];
      updateAggSummary();

      const ctx = buildContext({
        plaintiff: o.p, defendant: o.d, grievance: o.g,
        aggs: [o.a], items: []
      });

      const ai = o.ai || {};
      // Absorb legacy inline micro_damages as itemized line items.
      if (Array.isArray(ai.micro_damages) && ai.micro_damages.length) {
        const tmp = {};
        const keys = [];
        ai.micro_damages.slice(0, 3).forEach((m, i) => {
          const k = keyFromLabel('item', m.label || ('item' + i), i);
          tmp[k] = { label: String(m.label || 'petty matter'), amount: Math.max(0, Number(m.amount) || 0) };
          keys.push(k);
        });
        CURRENT_ITEM = tmp;
        selectedItems = keys;
        ctx.items = keys.slice();
        updateItemSummary();
      }

      const payload = {
        case_number: ai.case_number || caseNumberFromHash(inputHash(ctx)),
        county: ai.county || pickCounty(inputHash(ctx)),
        findings: Array.isArray(ai.findings) ? ai.findings.slice(0, 3) : fallbackPayload(ctx).findings,
        verdict_archetype: ai.verdict_archetype || VERDICTS[inputHash(ctx) % VERDICTS.length],
        base_damages: fallbackBaseDamages(o.g)
      };
      writeCache(ctx, payload);

      const paidState = {
        paid: !!o.paid,
        paidSig: o.ps || '',
        paidAt: o.pt || ''
      };
      renderAndShow(ctx, payload, paidState);
      return;
    }

    show(intake);
  })();

  function renderHydratedAggChips(selectedKeys) {
    aggChipsEl.innerHTML = '';
    Object.keys(CURRENT_AGG).forEach((key) => {
      const a = CURRENT_AGG[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      const isChecked = Array.isArray(selectedKeys) && selectedKeys.indexOf(key) >= 0;
      btn.setAttribute('aria-checked', isChecked ? 'true' : 'false');
      btn.dataset.key = key;
      btn.dataset.mult = String(a.mult);
      btn.textContent = a.label + '  ×' + Number(a.mult).toFixed(2);
      aggChipsEl.appendChild(btn);
    });
  }

  function renderHydratedItemChips(selectedKeys) {
    if (!itemChipsEl) return;
    itemChipsEl.innerHTML = '';
    Object.keys(CURRENT_ITEM).forEach((key) => {
      const a = CURRENT_ITEM[key];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.setAttribute('role', 'checkbox');
      const isChecked = Array.isArray(selectedKeys) && selectedKeys.indexOf(key) >= 0;
      btn.setAttribute('aria-checked', isChecked ? 'true' : 'false');
      btn.dataset.key = key;
      btn.dataset.amount = String(a.amount);
      btn.textContent = a.label + '  ' + fmt$(a.amount);
      itemChipsEl.appendChild(btn);
    });
  }

})();
