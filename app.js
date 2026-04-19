// Petty Small Claims — client logic
// - Collects 4 text inputs + 1 aggravator chip
// - Computes base damages deterministically in JS
// - Calls AI proxy for flavor (findings / county / case# / archetype / micro_damages)
// - Falls back to deterministic local generator on any error
// - Renders an official judgment document
// - Serializes the full case to the URL fragment for sharing
// - Caches results by input hash in localStorage

(function () {
  'use strict';

  const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
  const SLUG = 'petty-small-claims';

  // Aggravator multipliers
  const AGG = {
    labeled:   { label: 'it was labeled',  mult: 1.20 },
    denied:    { label: 'they denied it',  mult: 1.35 },
    third:     { label: 'third offense',   mult: 1.50 },
    pandemic:  { label: 'mid-pandemic',    mult: 1.15 },
    birthday:  { label: 'on my birthday',  mult: 1.75 }
  };

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

  // 24 absurd micro-damage line items for the local fallback + dedupe reference
  const MICRO_POOL = [
    { label: 'Tupperware depreciation',        amount: 4.50 },
    { label: 'emotional distress',             amount: 12.00 },
    { label: 'interest on spite',              amount: 3.14 },
    { label: 'procedural inconvenience',       amount: 8.88 },
    { label: 'principle of the thing',         amount: 1.99 },
    { label: 'time-of-life tax',               amount: 22.17 },
    { label: 'footnote royalty',               amount: 0.76 },
    { label: 'eye-roll servicing',             amount: 6.25 },
    { label: 'groupchat reputational harm',    amount: 14.40 },
    { label: 'door-slamming vibrations',       amount: 5.55 },
    { label: 'fridge-space occupancy',         amount: 9.11 },
    { label: 'passive-aggressive postage',     amount: 2.47 },
    { label: 'notebook smudge fee',            amount: 1.25 },
    { label: 'sigh-per-minute overage',        amount: 3.77 },
    { label: 'conversational fumbling',        amount: 7.62 },
    { label: 'missed-apology interest',        amount: 11.30 },
    { label: 'grudge storage lease',           amount: 18.00 },
    { label: 'therapist referral inconvenience', amount: 25.00 },
    { label: 'sidewalk glare tax',             amount: 4.04 },
    { label: 'eyebrow-raising fee',            amount: 2.22 },
    { label: 'deep-sigh processing',           amount: 0.99 },
    { label: 'mental receipts filing',         amount: 5.00 },
    { label: 'unsolicited opinion surcharge',  amount: 13.13 },
    { label: 'vibes violation',                amount: 7.07 }
  ];

  // 12 findings templates for the fallback — each echoes the defendant / grievance / aggravator verbatim.
  const FINDINGS_TEMPLATES = [
    (c) => `The court finds it uncontested that ${c.defendant} did, in fact, ${c.grievance.toLowerCase()}.`,
    (c) => `Witness testimony corroborates the plaintiff's claim that ${c.defendant} committed the act described: "${c.grievance}".`,
    (c) => `The aggravating factor "${c.aggName}" weighs against ${c.defendant} in the record.`,
    (c) => `No plausible defense was offered by ${c.defendant} for the incident: "${c.grievance}".`,
    (c) => `The plaintiff, ${c.plaintiff}, has appeared in good faith; ${c.defendant} has not.`,
    (c) => `The grievance — "${c.grievance}" — constitutes a pattern this court finds persuasive.`,
    (c) => `${c.defendant}'s conduct, given "${c.aggName}", constitutes aggravated nuisance under local custom.`,
    (c) => `The court takes judicial notice that "${c.grievance}" is, on its face, rude.`,
    (c) => `Damages claimed by ${c.plaintiff} (${c.rawDamages}) are found to be reasonable under the circumstances.`,
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
  const chipsEl  = $('#aggravator-chips');

  let selectedAgg = null;

  // ---------- Chips ----------

  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const all = chipsEl.querySelectorAll('.chip');
    all.forEach((c) => {
      const isThis = c === chip;
      c.setAttribute('aria-checked', isThis ? 'true' : 'false');
    });
    selectedAgg = chip.dataset.key;
  });

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

  // ---------- Damage math ----------

  // Extract first number from free-text damages field, default 25
  function parseClaimNumber(str) {
    if (!str) return 25;
    // Look for $XX.XX or XX.XX or XX,XXX etc.
    const m = String(str).match(/\$?\s*([0-9][0-9,]*\.?[0-9]{0,2})/);
    if (!m) return 25;
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n) || n <= 0) return 25;
    return n;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function fmt$(n) {
    if (!isFinite(n)) n = 0;
    return '$' + round2(n).toFixed(2);
  }

  // Pick 3 unique micro-damages from MICRO_POOL deterministically from the grievance hash
  function pickMicros(grievance) {
    const rand = prng(hashStr(grievance || 'nothing') || 1);
    const pool = MICRO_POOL.slice();
    const picks = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const idx = Math.floor(rand() * pool.length);
      picks.push(pool.splice(idx, 1)[0]);
    }
    return picks;
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

  function inputHash(c) {
    return hashStr([
      (c.plaintiff || '').trim().toLowerCase(),
      (c.defendant || '').trim().toLowerCase(),
      (c.grievance || '').trim().toLowerCase(),
      (c.rawDamages || '').trim().toLowerCase(),
      c.agg
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
    const micros = pickMicros(ctx.grievance || ctx.defendant || 'nothing').map((m) => ({
      label: m.label,
      amount: m.amount
    }));

    return {
      case_number: caseNumberFromHash(h),
      county: pickCounty(h),
      findings,
      verdict_archetype: verdict,
      micro_damages: micros
    };
  }

  // ---------- LLM call ----------

  const SYSTEM_PROMPT = [
    'You are a dead-pan 1950s court clerk with a faint contempt for everyone.',
    'You fill in the flavor text for a mock small-claims court judgment.',
    'You do NOT speak to the user. You do NOT ask follow-up questions.',
    'You do NOT say "here is" or "sure!" — you return JSON only.',
    'Every finding must quote or directly reference the plaintiff\'s stated grievance text verbatim (or a short verbatim slice of it).',
    'Findings are formal, clipped, faintly contemptuous. No exclamation marks. No modern slang.',
    'Return strict JSON matching this schema:',
    '{',
    '  "case_number": string,           // format "26-04-XXXX" (4 digits)',
    '  "county": string,                // e.g. "Circuit Court of West Haversack County"',
    '  "findings": [string, string, string],  // exactly 3',
    '  "verdict_archetype": string,     // MUST be one of the 8 allowed archetypes',
    '  "micro_damages": [ {"label": string, "amount": number}, ... ]  // exactly 3',
    '}',
    'Allowed verdict_archetype values (pick exactly one):',
    VERDICTS.map((v) => '  - ' + v).join('\n'),
    'micro_damages labels are absurd petty categories like "Tupperware depreciation" or "interest on spite". Amounts are small ($0.50 to $25.00).',
    'Do NOT compute a total. Do NOT compute base damages. Client handles math.'
  ].join('\n');

  async function callLLM(ctx) {
    const userPrompt = [
      'Plaintiff: ' + ctx.plaintiff,
      'Defendant: ' + ctx.defendant,
      'Grievance: "' + ctx.grievance + '"',
      'Damages claimed (raw): ' + ctx.rawDamages,
      'Aggravating factor: ' + ctx.aggName + ' (multiplier ×' + ctx.aggMult.toFixed(2) + ')',
      '',
      'Fill in the judgment flavor as strict JSON.'
    ].join('\n');

    const body = {
      slug: SLUG,
      model: 'gpt-5.4-mini',
      temperature: 0.3,
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

    // Validate shape
    if (!parsed || typeof parsed !== 'object') throw new Error('bad_obj');
    if (!Array.isArray(parsed.findings) || parsed.findings.length < 3) throw new Error('bad_findings');
    if (!Array.isArray(parsed.micro_damages) || parsed.micro_damages.length < 3) throw new Error('bad_micros');
    if (typeof parsed.case_number !== 'string') throw new Error('bad_case');
    if (typeof parsed.county !== 'string') throw new Error('bad_county');
    if (typeof parsed.verdict_archetype !== 'string') throw new Error('bad_verdict');

    // Normalize: strictly 3 findings, 3 micro_damages
    parsed.findings = parsed.findings.slice(0, 3).map((s) => String(s));
    parsed.micro_damages = parsed.micro_damages.slice(0, 3).map((m) => ({
      label: String(m.label || 'petty matter'),
      amount: Math.max(0, Number(m.amount) || 0)
    }));

    // Clamp verdict to allowed list (pick closest by hash if it somehow went rogue)
    if (VERDICTS.indexOf(parsed.verdict_archetype) < 0) {
      parsed.verdict_archetype = VERDICTS[inputHash(ctx) % VERDICTS.length];
    }

    // Repair / enforce case number format
    if (!/^26-04-\d{4}$/.test(parsed.case_number)) {
      parsed.case_number = caseNumberFromHash(inputHash(ctx));
    }

    return parsed;
  }

  // ---------- Orchestrator ----------

  function cacheKey(ctx) { return 'psc:' + inputHash(ctx); }

  function readCache(ctx) {
    try {
      const raw = localStorage.getItem(cacheKey(ctx));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function writeCache(ctx, payload) {
    try {
      localStorage.setItem(cacheKey(ctx), JSON.stringify(payload));
    } catch (e) { /* ignore quota */ }
  }

  function buildContext({ plaintiff, defendant, grievance, rawDamages, agg }) {
    const aggDef = AGG[agg];
    const claim = parseClaimNumber(rawDamages);
    const base  = round2(claim * aggDef.mult);
    return {
      plaintiff: plaintiff.trim(),
      defendant: defendant.trim(),
      grievance: grievance.trim(),
      rawDamages: rawDamages.trim(),
      agg,
      aggName: aggDef.label,
      aggMult: aggDef.mult,
      baseClaim: claim,
      baseAwarded: base
    };
  }

  async function fileCase(ctx) {
    // Check cache first
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
    const baseLabel = `claim ×${ctx.aggMult.toFixed(2)} (${ctx.aggName})`;
    const baseLine = {
      label: `base damages — ${baseLabel}`,
      amount: ctx.baseAwarded
    };
    const micros = payload.micro_damages.slice(0, 3);
    const lines = [baseLine, ...micros];
    const total = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

    const countyUpper = payload.county.toUpperCase();

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

      <div class="section-hd">Aggravating Factor On Record</div>
      <div class="agg-line">${escapeHtml(ctx.aggName)} <span class="mult">(multiplier: ×${ctx.aggMult.toFixed(2)})</span></div>

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
      <div class="foot-math">Base = claimed ${fmt$(ctx.baseClaim)} × ${ctx.aggMult.toFixed(2)} = ${fmt$(ctx.baseAwarded)} (aggravator: ${escapeHtml(ctx.aggName)})</div>

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

  function encodeCaseToFragment(ctx, payload) {
    const blob = {
      v: 1,
      p: ctx.plaintiff,
      d: ctx.defendant,
      g: ctx.grievance,
      r: ctx.rawDamages,
      a: ctx.agg,
      ai: payload
    };
    return b64urlEncode(JSON.stringify(blob));
  }

  function decodeFragment(frag) {
    if (!frag || frag.length < 4) return null;
    const raw = b64urlDecode(frag);
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o || o.v !== 1) return null;
      if (!o.p || !o.d || !o.g || !o.a || !AGG[o.a] || !o.ai) return null;
      return o;
    } catch (e) { return null; }
  }

  // ---------- Screen switching ----------

  function show(which) {
    for (const el of [intake, loading, judgment]) el.classList.add('hidden');
    which.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  // Share button visible via #share (already in DOM). Unhide when judgment renders.
  const shareSection = document.getElementById('share');

  function renderAndShow(ctx, payload) {
    const doc = document.getElementById('judgment-doc');
    doc.innerHTML = renderJudgment(ctx, payload);
    if (shareSection) shareSection.style.display = '';
    show(judgment);
  }

  // ---------- Loading typewriter ----------

  const LOADING_LINES = [
    'docketing your case…',
    'stamping the seal…',
    'consulting the clerk…',
    'reviewing precedent…',
    'drafting the findings…'
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

  // ---------- Form submit ----------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';

    const plaintiff  = $('#plaintiff').value.trim();
    const defendant  = $('#defendant').value.trim();
    const grievance  = $('#grievance').value.trim();
    const rawDamages = $('#damages').value.trim() || '$25';

    if (!plaintiff)  return setErr('The clerk needs a plaintiff name, please.');
    if (!defendant)  return setErr('A case needs a defendant — any name will do.');
    if (!grievance)  return setErr('State your grievance, however small.');
    if (!selectedAgg) return setErr('Please select an aggravating factor chip.');

    const ctx = buildContext({ plaintiff, defendant, grievance, rawDamages, agg: selectedAgg });

    startLoading();
    const t0 = performance.now();
    let payload;
    try {
      payload = await fileCase(ctx);
    } catch (err) {
      payload = fallbackPayload(ctx);
    }
    // Keep loading visible at least 900ms for the drama
    const elapsed = performance.now() - t0;
    if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed));
    stopLoading();

    const frag = encodeCaseToFragment(ctx, payload);
    history.replaceState(null, '', '#' + frag);

    renderAndShow(ctx, payload);
  });

  function setErr(msg) {
    errEl.textContent = msg;
  }

  // ---------- Reset ----------

  document.getElementById('reset-btn').addEventListener('click', () => {
    history.replaceState(null, '', location.pathname + location.search);
    // Clear form
    form.reset();
    selectedAgg = null;
    chipsEl.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', 'false'));
    errEl.textContent = '';
    if (shareSection) shareSection.style.display = 'none';
    show(intake);
  });

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

  (function boot() {
    if (shareSection) shareSection.style.display = 'none';

    const frag = (location.hash || '').replace(/^#/, '');
    const parsed = decodeFragment(frag);
    if (parsed) {
      // Pre-fill form (for "File another case" affordance)
      $('#plaintiff').value  = parsed.p;
      $('#defendant').value  = parsed.d;
      $('#grievance').value  = parsed.g;
      $('#damages').value    = parsed.r || '';
      selectedAgg = parsed.a;
      chipsEl.querySelectorAll('.chip').forEach((c) => {
        c.setAttribute('aria-checked', c.dataset.key === selectedAgg ? 'true' : 'false');
      });

      const ctx = buildContext({
        plaintiff: parsed.p,
        defendant: parsed.d,
        grievance: parsed.g,
        rawDamages: parsed.r || '$25',
        agg: parsed.a
      });

      // Cache by input hash (so reopening = no burn)
      writeCache(ctx, parsed.ai);

      renderAndShow(ctx, parsed.ai);
      return;
    }
    show(intake);
  })();

})();
