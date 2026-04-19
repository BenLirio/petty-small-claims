// Petty Small Claims — client logic
//
// Flow (user-driven, no hidden charges):
//   1. User enters plaintiff / defendant / grievance.
//   2. Clerk (LLM) drafts tailored aggravator chips AND tailored itemized-damage chips.
//      User picks any that apply from BOTH lists. Nothing is tacked on at the end.
//   3. User may ALSO add one custom "other" line item (label + amount).
//   4. On file, LLM produces findings / verdict / base damages ONLY.
//      Total = base damages × aggravator multiplier + sum(selected itemized damages),
//      guaranteed to land strictly under $20 — the pettiness is the point.
//   5. Local deterministic fallback kicks in on any LLM error.
//   6. Serializes only case inputs + selected chip keys (+ custom chip defs) to the URL fragment.
//   7. Paid-receipt flow unchanged.
//
// Design rule: everything on the judgment must be something the user input or
// explicitly selected. The clerk never invents surprise line items. And the
// total is ALWAYS under $20 — if math would push it over, line items are
// scaled down proportionally before rendering.

(function () {
  'use strict';

  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'petty-small-claims';

  // Hard ceiling — final awarded total is always STRICTLY LESS THAN this.
  const AWARD_CAP = 20.00;

  // Default aggravator multipliers (fallback + seed for AI-generated set).
  // Kept small: combined cap is 1.99 so base × mult never breaks the $20 rule.
  const AGG = {
    labeled:   { label: 'it was labeled',  mult: 1.15 },
    denied:    { label: 'they denied it',  mult: 1.25 },
    third:     { label: 'third offense',   mult: 1.35 },
    birthday:  { label: 'on my birthday',  mult: 1.45 }
  };

  // Default itemized-damage chips (fallback + seed for AI-generated set).
  // User picks which apply — these are NOT auto-added to the judgment.
  // Amounts are petty on purpose: sub-$5 each.
  const ITEM = {
    tupperware:  { label: 'Tupperware depreciation',     amount: 1.25 },
    emotional:   { label: 'minor emotional distress',    amount: 2.49 },
    spite:       { label: 'interest on spite',           amount: 0.77 },
    eyeroll:     { label: 'eye-roll servicing',          amount: 1.50 },
    principle:   { label: 'principle of the thing',      amount: 1.99 }
  };

  // Current live sets — may be replaced by AI-generated alternates tailored to grievance.
  let CURRENT_AGG = Object.assign({}, AGG);
  let CURRENT_ITEM = Object.assign({}, ITEM);

  const MAX_COMBINED_MULT = 1.99;
  const CUSTOM_ITEM_KEY = 'custom-other';
  const MAX_CUSTOM_ITEM_AMT = 4.99;

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

  // Deterministic fallback base damages (strictly < $3.00, > $0.10),
  // seeded by grievance text. Keeps the base tiny so the final total —
  // base × mult + itemized — always lands comfortably under $20.
  function fallbackBaseDamages(grievance) {
    const rand = prng(hashStr((grievance || 'nothing') + '|base') || 1);
    const v = 0.25 + rand() * 2.5; // 0.25 .. 2.75
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
    'ROLE: You are a dead-pan 1950s small-claims court clerk with faint contempt for all parties. You return JSON. You do NOT talk to the user, do NOT say "sure" or "here is", do NOT add commentary.',
    '',
    'CONTEXT: This is a satirical mock-court whose awarded total is ALWAYS strictly less than $20. Grievances are petty by design (labeled leftovers, unreturned pens, loud chewing, bad roommate behavior, missed texts, etc). The humor comes from treating a dumb domestic crime with full courtroom gravity.',
    '',
    'OUTPUT FIELDS:',
    '  case_number   — string format "26-04-XXXX" (4 digits).',
    '  county        — whimsical fictional county, e.g. "Circuit Court of West Haversack County". Pick something that fits the grievance\'s vibe; avoid real place names.',
    '  findings      — EXACTLY 3 formal findings, clipped and contemptuous. Each finding MUST reference something concrete from the plaintiff\'s grievance (an object, action, place, pattern) OR the listed aggravators — never a generic platitude. Each finding should feel like something a real (if snide) clerk would write. Max ~32 words each.',
    '  verdict_archetype — MUST be exactly one of the allowed values below, chosen to flatter the plaintiff (this court always sides with plaintiffs).',
    '  base_damages  — a number strictly less than 3.00 and greater than 0.25, with ODD CENTS (e.g. 1.73, 2.19, 0.87). This is the clerk-assessed base only; the client applies the aggravator multiplier and adds user-chosen line items separately.',
    '',
    'HARD RULES:',
    '  - Do NOT invent additional damage line items. The plaintiff picks their own itemized damages separately. You ONLY assess the base number.',
    '  - Do NOT propose settlements, suggest mediation, or be evenhanded — the whole bit is that the court is absurdly pro-plaintiff.',
    '  - Do NOT use modern slang, exclamation marks, emojis, or pop-culture references. Register is 1950s civil-procedure with minor sarcasm.',
    '  - Every finding must feel hand-fitted to THIS grievance. Quote or paraphrase a concrete detail from it. If the grievance mentions "my Stanley cup", the finding should mention the Stanley cup (or at least "the vessel"). Generic findings like "the plaintiff has been wronged" are forbidden.',
    '  - No fabricated facts that contradict the grievance. Stay within what the plaintiff wrote.',
    '',
    'EXAMPLE INPUT →',
    '  Plaintiff: Jordan P. Reeves',
    '  Defendant: my roommate Dan',
    '  Grievance: "ate my clearly labeled pad thai at 2am, denied it the next morning"',
    '  Aggravators on record: it was labeled, they denied it (×1.38 combined)',
    '',
    'EXAMPLE OUTPUT →',
    '{',
    '  "case_number": "26-04-2917",',
    '  "county": "Circuit Court of Muttontown County",',
    '  "findings": [',
    '    "The court finds it uncontested that a labeled pad thai was consumed by the defendant Dan at or about 2:00 a.m., in defiance of the handwritten label.",',
    '    "The defendant\'s morning denial — in the continued presence of the empty container — is taken by this court as an aggravating circumstance, not a defense.",',
    '    "The plaintiff Reeves appeared in good faith; the defendant has offered no plausible alternative eater."',
    '  ],',
    '  "verdict_archetype": "Ruled In Your Favor, With Pettiness",',
    '  "base_damages": 2.17',
    '}',
    '',
    'Allowed verdict_archetype values (pick exactly one):',
    VERDICTS.map((v) => '  - ' + v).join('\n'),
    '',
    'Return ONLY the JSON object. No preface. No trailing prose.'
  ].join('\n');

  async function callLLM(ctx) {
    const itemsContext = (ctx.items && ctx.items.length)
      ? ('Plaintiff-selected line items (context only — you do NOT assess these): ' +
         selectedItemLines(ctx.items).map((l) => l.label + ' ' + fmt$(l.amount)).join('; '))
      : 'Plaintiff-selected line items: (none)';

    const userPrompt = [
      'Plaintiff: ' + ctx.plaintiff,
      'Defendant: ' + ctx.defendant,
      'Grievance: "' + ctx.grievance + '"',
      'Aggravating factors on record: ' + ctx.aggName + ' (combined multiplier ×' + ctx.aggMult.toFixed(2) + ')',
      itemsContext,
      '',
      'Produce the judgment JSON. Every finding must name a concrete detail from the grievance above (or an aggravator). Do NOT add damage line items — only assess base_damages (0.25..2.99, odd cents).'
    ].join('\n');

    const body = {
      slug: SLUG,
      model: 'gpt-5.4',
      temperature: 0.55,
      max_tokens: 700,
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
    if (base >= 3) base = 2.99;
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
    let baseAwarded = round2(base * ctx.aggMult);
    const aggPart = ctx.aggs.length
      ? `assessed base damages × ${ctx.aggMult.toFixed(2)} (${ctx.aggName})`
      : `assessed base damages (no aggravators on record)`;

    // Only user-selected itemized damages — no surprise additions.
    let itemLines = selectedItemLines(ctx.items || []);

    // HARD cap: total must be strictly less than $20. If base × mult + items
    // threatens that, scale ONLY the itemized line items down proportionally
    // so the clerk's assessed base survives intact. If even the bare base is
    // over the ceiling (shouldn't happen given our clamps), trim the base too.
    const ceiling = round2(AWARD_CAP - 0.01); // 19.99
    if (baseAwarded > ceiling) baseAwarded = ceiling;
    let rawItemSum = itemLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const roomForItems = round2(ceiling - baseAwarded);
    if (rawItemSum > roomForItems && rawItemSum > 0) {
      const scale = roomForItems / rawItemSum;
      itemLines = itemLines.map((l) => ({
        label: l.label,
        amount: round2((Number(l.amount) || 0) * scale)
      }));
    }
    const baseLine = {
      label: `base damages — ${aggPart}`,
      amount: baseAwarded
    };
    const lines = [baseLine, ...itemLines];
    let total = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
    if (total >= AWARD_CAP) total = ceiling; // paranoia pass for fp rounding

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
      note.innerHTML = 'Tap <strong>SERVE THE DEFENDANT</strong> above and send the notice to the person who owes you. When they mark it paid, they\'ll hand you back a short receipt URL — opening that URL once stamps <strong>PAID</strong> on your case permanently on this device.';
      paidSection.appendChild(note);
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'paid-receiver';
    const served = document.createElement('div');
    served.className = 'served-banner';
    served.innerHTML = '<strong>You have been served.</strong> The plaintiff has asked you to settle this claim. When you\'re ready, mark it paid below and return the receipt URL to them as proof.';
    wrap.appendChild(served);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mark-paid-btn';
    btn.textContent = 'MARK THIS CLAIM AS PAID';
    wrap.appendChild(btn);
    const hint = document.createElement('p');
    hint.className = 'paid-hint';
    hint.textContent = 'Defendants only. Marking paid generates a short receipt URL you send back to the plaintiff as proof of payment.';
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
    'ROLE: World-class comedy writer ghost-writing as a dead-pan 1950s small-claims court clerk.',
    'This court only hears PATHETICALLY SMALL grievances — the final awarded total is always strictly less than $20. Dial everything down to the smallest possible scale: missing pens, loud chewing, labeled leftovers, missed texts, socks left in the dryer.',
    '',
    'TASK: Given one specific grievance, draft TWO small chip palettes the plaintiff can pick from:',
    '  (A) Aggravating-factor chips — conditions that slightly multiply the base damages.',
    '  (B) Itemized-damage chips — sub-$5 line items the plaintiff may choose to include.',
    '',
    'TONE: Dry, formal, specific, faintly contemptuous. No exclamation marks, no pop-culture references, no modern slang, no clichés ("last straw", "salt in the wound", "adds insult to injury" are BANNED).',
    '',
    'HARD requirements for AGGRAVATOR chips:',
    '  - Exactly 4. 2–6 words each. No trailing period. No quotes in labels.',
    '  - Each SPECIFICALLY tailored to THIS grievance — reference a concrete detail, timing, witness, repetition pattern, or object that appears in the grievance. Generic chips ("it was rude") are rejected.',
    '  - Register examples: "it was labeled", "on my birthday", "third offense this month", "in front of houseguests", "after I warned them", "during finals week".',
    '  - Multiplier 1.05..1.45, two decimals. Small slights ~1.05–1.15. Genuinely aggravating ~1.30–1.45. NEVER above 1.45. Spread the multipliers across that range — do not cluster them.',
    '',
    'HARD requirements for ITEMIZED-DAMAGE chips:',
    '  - Exactly 4. Each a short comedic label (2–5 words) plus a dollar amount.',
    '  - Label must name a specific object or harm from THIS grievance (not generic "emotional damage"). Odd, specific, civil-procedural register.',
    '  - Label examples: "Tupperware depreciation", "groupchat reputational harm", "pen-return freight", "overheard-apology tax", "laundromat quarter reimbursement".',
    '  - Amount 0.25..3.99, two decimals, odd cents encouraged. Spread amounts across the range. NEVER above 3.99.',
    '',
    'EXAMPLE INPUT → Grievance: "my roommate keeps using my shampoo and then gaslights me about it"',
    'EXAMPLE OUTPUT →',
    '{',
    '  "aggravators": [',
    '    {"label": "bottle was labeled", "mult": 1.15},',
    '    {"label": "denied to my face", "mult": 1.35},',
    '    {"label": "third time this month", "mult": 1.40},',
    '    {"label": "used the last of it", "mult": 1.45}',
    '  ],',
    '  "items": [',
    '    {"label": "shampoo depreciation", "amount": 2.37},',
    '    {"label": "gaslight hazard pay", "amount": 3.19},',
    '    {"label": "bathroom reentry fee", "amount": 0.83},',
    '    {"label": "replacement label printing", "amount": 1.05}',
    '  ]',
    '}',
    '',
    'Return strict JSON (no commentary, no preface):',
    '{',
    '  "aggravators": [ {"label": string, "mult": number}, ... exactly 4 ],',
    '  "items":       [ {"label": string, "amount": number}, ... exactly 4 ]',
    '}'
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
      temperature: 0.7,
      max_tokens: 800,
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

    const aggs = parsed.aggravators.slice(0, 4).map((a, i) => {
      const label = String(a.label || ('factor ' + (i + 1))).replace(/["'\.]+$/g, '').slice(0, 48);
      let mult = Number(a.mult);
      if (!isFinite(mult)) mult = 1.15;
      mult = Math.max(1.05, Math.min(1.45, mult));
      mult = Math.round(mult * 100) / 100;
      return { label: label, mult: mult };
    });
    const aggFillers = Object.values(AGG);
    while (aggs.length < 4) aggs.push(aggFillers[aggs.length % aggFillers.length]);

    const items = parsed.items.slice(0, 4).map((a, i) => {
      const label = String(a.label || ('line item ' + (i + 1))).replace(/["'\.]+$/g, '').slice(0, 56);
      let amount = Number(a.amount);
      if (!isFinite(amount)) amount = 1.50;
      amount = Math.max(0.25, Math.min(3.99, amount));
      amount = Math.round(amount * 100) / 100;
      return { label: label, amount: amount };
    });
    const itemFillers = Object.values(ITEM);
    while (items.length < 4) items.push(itemFillers[items.length % itemFillers.length]);

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
    // Preserve any user-added custom line item across re-suggests.
    const preservedCustom = CURRENT_ITEM[CUSTOM_ITEM_KEY] || null;
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
    if (preservedCustom) {
      CURRENT_ITEM[CUSTOM_ITEM_KEY] = preservedCustom;
      renderCustomChipIfPresent();
    }
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

  // ---------- Custom "other" line-item editor ----------
  //
  // User can add ONE custom sub-$5 line item. Uses a reserved key
  // (CUSTOM_ITEM_KEY) in CURRENT_ITEM so existing encode / render / share
  // flows pick it up with no schema change. Adding again replaces the prior
  // custom item.

  const customToggle = document.getElementById('custom-item-toggle');
  const customEditor = document.getElementById('custom-item-editor');
  const customLabelEl = document.getElementById('custom-item-label');
  const customAmtEl = document.getElementById('custom-item-amount');
  const customAddBtn = document.getElementById('custom-item-add');

  function openCustomEditor() {
    if (!customEditor) return;
    customEditor.classList.remove('hidden');
    if (customToggle) customToggle.setAttribute('aria-expanded', 'true');
    if (customLabelEl) customLabelEl.focus();
  }
  function closeCustomEditor() {
    if (!customEditor) return;
    customEditor.classList.add('hidden');
    if (customToggle) customToggle.setAttribute('aria-expanded', 'false');
  }

  function renderCustomChipIfPresent() {
    if (!itemChipsEl) return;
    if (!CURRENT_ITEM[CUSTOM_ITEM_KEY]) return;
    // If a chip with that key already exists, replace its text; otherwise append.
    let existing = itemChipsEl.querySelector('.chip[data-key="' + CUSTOM_ITEM_KEY + '"]');
    const def = CURRENT_ITEM[CUSTOM_ITEM_KEY];
    if (!existing) {
      existing = document.createElement('button');
      existing.type = 'button';
      existing.className = 'chip';
      existing.setAttribute('role', 'checkbox');
      existing.setAttribute('aria-checked', 'false');
      existing.dataset.key = CUSTOM_ITEM_KEY;
      itemChipsEl.appendChild(existing);
    }
    existing.dataset.amount = String(def.amount);
    existing.textContent = def.label + '  ' + fmt$(def.amount);
    // Auto-select the just-added custom chip.
    existing.setAttribute('aria-checked', 'true');
    if (selectedItems.indexOf(CUSTOM_ITEM_KEY) < 0) selectedItems.push(CUSTOM_ITEM_KEY);
    updateItemSummary();
  }

  if (customToggle) {
    customToggle.setAttribute('aria-expanded', 'false');
    customToggle.addEventListener('click', (e) => {
      e.preventDefault();
      if (customEditor && customEditor.classList.contains('hidden')) openCustomEditor();
      else closeCustomEditor();
    });
  }

  function handleCustomAdd() {
    if (!customLabelEl || !customAmtEl) return;
    const label = (customLabelEl.value || '').trim().replace(/["'\.]+$/g, '').slice(0, 42);
    let amt = Number(customAmtEl.value);
    if (!label || label.length < 2) {
      customLabelEl.focus();
      return;
    }
    if (!isFinite(amt) || amt <= 0) {
      customAmtEl.focus();
      return;
    }
    amt = Math.max(0.25, Math.min(MAX_CUSTOM_ITEM_AMT, amt));
    amt = Math.round(amt * 100) / 100;

    CURRENT_ITEM[CUSTOM_ITEM_KEY] = { label: label, amount: amt };
    renderCustomChipIfPresent();
    closeCustomEditor();
    // Leave values in the fields so the user can tweak + re-add if they want.
  }

  if (customAddBtn) {
    customAddBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleCustomAdd();
    });
  }
  if (customAmtEl) {
    customAmtEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleCustomAdd(); }
    });
  }
  if (customLabelEl) {
    customLabelEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleCustomAdd(); }
    });
  }

  // ---------- Progressive disclosure (step 1 → step 2) ----------

  const step1El = document.getElementById('step-1');
  const step2El = document.getElementById('step-2');
  const continueBtn = document.getElementById('continue-btn');
  const backBtn = document.getElementById('back-btn');
  const plaintiffEl = $('#plaintiff');
  const defendantEl = $('#defendant');

  function step1Ready() {
    return (plaintiffEl.value.trim().length >= 2) &&
           (defendantEl.value.trim().length >= 1) &&
           (grievanceEl.value.trim().length >= 6);
  }

  function refreshContinueState() {
    if (!continueBtn) return;
    continueBtn.disabled = !step1Ready();
  }

  function goToStep(n) {
    if (!step1El || !step2El) return;
    if (n === 2) {
      step1El.classList.remove('step-active');
      step1El.classList.add('step-hidden');
      step1El.setAttribute('aria-hidden', 'true');
      step2El.classList.remove('step-hidden');
      step2El.classList.add('step-active');
      step2El.setAttribute('aria-hidden', 'false');
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    } else {
      step2El.classList.remove('step-active');
      step2El.classList.add('step-hidden');
      step2El.setAttribute('aria-hidden', 'true');
      step1El.classList.remove('step-hidden');
      step1El.classList.add('step-active');
      step1El.setAttribute('aria-hidden', 'false');
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
    }
  }

  [plaintiffEl, defendantEl, grievanceEl].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', refreshContinueState);
    el.addEventListener('change', refreshContinueState);
  });
  refreshContinueState();

  if (continueBtn) {
    continueBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!step1Ready()) return;
      goToStep(2);
      // Kick off tailored-chip suggest in the background once user lands on step 2.
      runSuggest(false);
    });
  }
  if (backBtn) {
    backBtn.addEventListener('click', (e) => {
      e.preventDefault();
      goToStep(1);
    });
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
    // Aggravators & items are BOTH optional. The user can file a minimal case
    // with just the base damages if they want — that's fine.

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
    if (customLabelEl) customLabelEl.value = '';
    if (customAmtEl) customAmtEl.value = '';
    closeCustomEditor();
    if (shareSection) shareSection.style.display = 'none';
    if (paidSection) paidSection.style.display = 'none';
    goToStep(1);
    refreshContinueState();
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

  // ---------- Serve the defendant (collection-letter style share) ----------
  //
  // Instead of a generic "share this judgment" meant for friends, the share
  // payload is framed as an official notice FROM the plaintiff TO the defendant,
  // demanding payment of the awarded total. The plaintiff forwards this text
  // directly to the person who owes them (text message, DM, email).
  //
  // We read the current context + total off the DOM so this stays in sync with
  // whatever was rendered (including any itemized scaling for the $20 cap).

  function currentCaseText() {
    const doc = document.getElementById('judgment-doc');
    const totalEl = doc && doc.querySelector('.damages-table tr.total td.amt');
    const caseEl = doc && doc.querySelector('.case-stamp');
    const plaintiffName = ($('#plaintiff').value || '').trim() || 'the plaintiff';
    const defendantName = ($('#defendant').value || '').trim() || 'you';
    const grievanceText = ($('#grievance').value || '').trim() || 'the matter on record';
    const total = totalEl ? totalEl.textContent.trim() : '$0.00';
    const docket = caseEl ? caseEl.textContent.trim().replace(/^CASE\s+/i, '') : '';
    return { plaintiffName, defendantName, grievanceText, total, docket };
  }

  function buildDemandLetter() {
    const c = currentCaseText();
    const url = location.href;
    const lines = [
      c.defendantName + ',',
      '',
      'You have been served.',
      '',
      'In the matter of "' + c.grievanceText + '", the Circuit Court of Honest Grievances has ruled in favor of ' + c.plaintiffName + '.',
      'Awarded total: ' + c.total + (c.docket ? ' (docket ' + c.docket + ')' : '') + '.',
      '',
      'Remit payment at your earliest convenience. Mark the claim paid at the link below and return the receipt URL to ' + c.plaintiffName + ' as proof.',
      '',
      url
    ];
    return lines.join('\n');
  }

  function buildDemandTitle() {
    const c = currentCaseText();
    return 'You have been served — ' + c.plaintiffName + ' v. ' + c.defendantName;
  }

  window.serveDefendant = function () {
    const title = buildDemandTitle();
    const text = buildDemandLetter();
    const url = location.href;

    if (navigator.share) {
      navigator.share({ title: title, text: text, url: url }).catch(() => {});
      return;
    }

    const toCopy = text; // text already contains the URL
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(toCopy)
        .then(() => {
          const btn = document.getElementById('serve-btn');
          if (btn) {
            const prev = btn.textContent;
            btn.textContent = 'COPIED — NOW PASTE TO DEFENDANT';
            setTimeout(() => { btn.textContent = prev; }, 2400);
          } else {
            alert('Demand copied — paste it to the defendant.');
          }
        })
        .catch(() => { window.prompt('Copy this demand and send it to the defendant:', toCopy); });
    } else {
      window.prompt('Copy this demand and send it to the defendant:', toCopy);
    }
  };

  // Back-compat: some older hash fragments or cached scripts may still call
  // window.share(). Route it to the new serve flow.
  window.share = function () { window.serveDefendant(); };

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
