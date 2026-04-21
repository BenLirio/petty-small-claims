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
  // Short-URL store for shareable cases. The app POSTs the encoded case
  // blob (same base64url we used to stuff in a #fragment) and gets back a
  // short id, then rewrites the URL to /?c=<id>. Reason: iOS Messages
  // can't reliably auto-linkify a URL with a 1500+ char hash fragment, so
  // shared links used to lose their state. A short URL linkifies cleanly
  // and iMessage can pull OG tags for a rich preview card.
  const CASE_STORE = 'https://rrun6q1lfk.execute-api.us-east-1.amazonaws.com';
  const CASE_SLUG = 'petty-small-claims';

  async function saveCaseToStore(fragString) {
    try {
      const res = await fetch(CASE_STORE + '/case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: CASE_SLUG, data: fragString })
      });
      if (!res.ok) return null;
      const j = await res.json();
      if (!j || typeof j.id !== 'string') return null;
      return { id: j.id, token: typeof j.token === 'string' ? j.token : null };
    } catch (_) { return null; }
  }

  async function patchCaseInStore(id, token, fragString) {
    if (!id || !token) return false;
    try {
      const res = await fetch(CASE_STORE + '/case/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, data: fragString })
      });
      return res.ok;
    } catch (_) { return false; }
  }

  async function loadCaseFromStore(id) {
    try {
      const res = await fetch(CASE_STORE + '/case/' + encodeURIComponent(id));
      if (!res.ok) return null;
      const j = await res.json();
      return j && typeof j.data === 'string' ? j.data : null;
    } catch (_) { return null; }
  }

  function shortUrlFor(id, token) {
    const base = location.origin + location.pathname + '?c=' + id;
    return token ? (base + '&k=' + token) : base;
  }

  function currentShortUrlParams() {
    const params = new URLSearchParams(location.search);
    return { id: params.get('c') || '', token: params.get('k') || '' };
  }
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
  const suggestStatus = $('#suggest-status');
  const aggSummary = $('#agg-summary');
  const itemSummary = $('#item-summary');

  // Multi-select arrays of chip keys (order = click order)
  let selectedAggs = [];
  let selectedItems = [];
  let suggestInflight = false;
  let lastSuggestHash = 0;
  // Options-ready gate: the FILE button stays disabled until the clerk has
  // finished drafting + typing the chip options, even though aggravators and
  // damages are themselves optional — we want the user to see the choices
  // before committing.
  let optionsReady = false;
  let optionsReadyTimer = null;

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
    const label = selectedAggs.length === 1 ? '1 factor' : (selectedAggs.length + ' factors');
    aggSummary.textContent = label + ' on record.';
  }

  function updateItemSummary() {
    if (!itemSummary) return;
    if (!selectedItems.length) {
      itemSummary.textContent = '';
      return;
    }
    const label = selectedItems.length === 1 ? '1 line item' : (selectedItems.length + ' line items');
    itemSummary.textContent = label + ' selected.';
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

  // Judgment prompt — see knowledge-base/pages/concepts/{humor-mechanics,
  // viral-patterns,shareability-design}.md for the rules driving this design:
  // benign-violation (formal court register applied to a petty matter),
  // arousal targets (amusement + anger), humblebrag-enabled output, stance
  // legibility (mock-bureaucratic), input-INTERPRETATION not input-restatement,
  // and the earned-flourish rule that makes at least one finding quotable
  // standalone. The shape is: three findings with distinct roles (ESTABLISH /
  // AGGRAVATE / SEAL), 12-26 words each, exactly one formal flourish in
  // SEAL (or sometimes AGGRAVATE) — never in ESTABLISH.
  const SYSTEM_PROMPT = `ROLE: Presiding clerk of the Circuit Court of Honest Grievances — a fictitious 1950s small-claims court hearing only trivial domestic matters. Write like a real mid-century clerk: clipped, formal, no warmth. The joke is applying this exact register to petty grievances. Writing is straight; absurdity is in the APPLICATION.

Output one JSON object. No preamble, no trailing prose.

WHY: A plaintiff reads this on their phone and decides whether to screenshot + share. Target emotions: amusement (mock-bureaucratic voice on a tiny matter) + anger (petty-injustice framing, defendant quietly dunked on). Calm/wistful/evenhanded = wrong — this court is never balanced. The share is a humblebrag ("the court ruled in my favor over SHAMPOO"); the judgment must enable it.

═══ THE FINDINGS ARE THE PAYOFF ═══
The three findings are what gets screenshotted. The other fields are stage dressing — write them plain.

CRAFT:
  Exactly 3 findings, 12–26 words each. Stop the instant the line lands. Do not pad.

  Sanctioned openings (pick from these, do not invent new ones):
    "The court finds ..." / "It is stipulated that ..." / "The record reflects that ..." /
    "The defendant offers no defense to ..." / "The plaintiff is not required to ..." /
    "This court takes notice of ..." / "In the matter of ..." / "No evidence has been produced that ..."

  Every finding must reference a CONCRETE detail from the grievance (specific object, time, number, action, phrase). Abstraction is failure ("the incident", "this behavior" — banned).

  Do NOT simply restate the grievance in fancy type. INTERPRET it — characterize the defendant's conduct, weigh the plaintiff's bearing. If the input is "keeps eating my leftovers", the finding characterizes ("has failed to respect the plaintiff's labeled vessels"), it does not echo. A reader who can spot "keyword + formal template" lost the magic.

  Each finding has a different JOB:
    1. ESTABLISH — state the offense as uncontested fact. Treat disputed facts as settled in the plaintiff's favor. Matter-of-fact.
    2. AGGRAVATE — fold ONE aggravator into procedural weight. Never list them all.
    3. SEAL — the closer. Either (a) dignify the plaintiff (principled / patient / reasonable beyond what was owed), or (b) indict the defendant's comportment (silence, absence, pattern). Final, not wistful.

═══ THE EARNED FLOURISH ═══
Exactly ONE of the three findings must carry a small formal figurative phrase that lifts a plain fact into civic register. It is the line the plaintiff quotes. Rules:
  - One per judgment. Three reads as overwritten.
  - Attached to a detail actually in the grievance — formalize a real thing, don't invent one.
  - Lives in SEAL (most natural) or sometimes AGGRAVATE. NEVER in ESTABLISH — first finding stays plain.
  - If you cannot land it cleanly, leave it out. A missing flourish beats a labored one.

  Calibration bank (do NOT copy — write new ones fitting THIS grievance):
    "the vessel" / "the nocturnal hour" / "the sabbath of personal hours" / "that natural refuge of small liars" / "a campaign of brass recurrence" / "a courtesy the record does not show was returned" / "an hour fit for burglars and poor judgment" / "relitigate through the vents"

═══ TONE ═══
Toward defendant: civil, cold, faintly contemptuous. Never hot. The court has seen this defendant in many shapes before.
Toward plaintiff: unearned gravity. Treat their trivial grievance as exactly what this court was built for. Deadpan flattery is welcome.
Toward grievance: the clerk NEVER acknowledges its triviality. A stolen granola bar gets the language of a felony. That unbroken straight-face IS the joke.

FORBIDDEN:
  - Generic platitudes ("plaintiff has been wronged", "justice must be served").
  - Modern idioms / sentiment words ("not cool", "heartbreaking", "shocking", "toxic", "a whole mood").
  - Exclamation marks, emojis, pop-culture references.
  - TV-drama clerk voice ("I've heard enough", "order in the court"). This clerk is bored, not theatrical.
  - Listing aggravators verbatim. Fold one in organically.
  - Fabricated facts contradicting the grievance.
  - A flourish in ESTABLISH.

═══ OTHER FIELDS (don't fuss, but do VARY) ═══
case_number:       "26-04-NNNN", 4 digits. Pick new digits each call — do not default to a handful you've seen; pick what feels organic for THIS grievance.
county:            whimsical fictional, riff on a word from THIS grievance. No real places.
verdict_archetype: exactly one allowed value; MATCH it to grievance shape — do NOT default to the same one each call. Use the list below to pick: denied-to-face → With Pettiness; repeat pattern → With Prejudice; defendant self-owns → Default Judgment: Cringe; mostly vibes → On Vibes Alone; hard-to-prove but obvious → In Spirit Only; plaintiff also petty → Begrudgingly; defendant somehow worse than claim → Counter-Suit Advised; silliness → Stricken From The Record.
base_damages:      0.25 < x < 2.99, ODD CENTS (1.73 / 2.19 / 0.87). Never .00 / .25 / .50 / .75.

═══ EXAMPLES ═══

EX1 — leftovers (flourish "the vessel", SEAL)
IN: P=Jordan P. Reeves  D=my roommate Dan  G="ate my clearly labeled pad thai at 2am, denied it the next morning"  Aggs=labeled, denied (×1.38)
OUT:
{"case_number":"26-04-3162","county":"Circuit Court of Muttontown County",
"findings":[
 "The court finds it uncontested that a labeled pad thai was consumed by the defendant Dan at or about 2:00 a.m.",
 "The defendant's morning denial, delivered in the continued presence of the empty container, is taken as aggravation and not defense.",
 "The plaintiff Reeves labeled the vessel — a courtesy the record does not show was returned."],
"verdict_archetype":"Ruled In Your Favor, With Pettiness","base_damages":2.17}

EX2 — late Slack (flourish "the sabbath of personal hours", SEAL; different verdict)
IN: P=Morgan Ito  D=my coworker Priya  G="sent a critical slack at 11:47pm Saturday, ruined my sleep"  Aggs=weekend, no urgency (×1.30)
OUT:
{"case_number":"26-04-0755","county":"Circuit Court of Loameland County",
"findings":[
 "The record reflects that a critical Slack communication was dispatched at 11:47 p.m. on a Saturday evening.",
 "No evidence has been produced that the timing was required by any workflow; the court treats it as chosen, not imposed.",
 "The plaintiff Ito observed the sabbath of personal hours — a practice this court commends and seldom sees reciprocated."],
"verdict_archetype":"Granted, Begrudgingly","base_damages":1.89}

═══ NEGATIVE EXAMPLE — never produce this ═══
{"findings":["Plaintiff has been wronged in a heartbreaking manner.","This is not cool behavior from the defendant — order in this court!","Justice demands the highest damages possible."]}
Why it fails: generic, TV-drama, exclamation mark, no concrete detail, sentiment words, no flourish.

═══ ALLOWED verdict_archetype VALUES ═══
${VERDICTS.map((v) => '  - ' + v).join('\n')}

Return ONLY the JSON object.`;

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
      'Produce the judgment JSON. Every finding must reference a concrete detail from the grievance and INTERPRET it (characterize the defendant, weigh the plaintiff), not just restate it. Include exactly ONE earned flourish across the three findings, placed in SEAL (or AGGRAVATE), never in ESTABLISH. Pick a verdict_archetype that actually matches this grievance shape — do not default. Do NOT add damage line items; only assess base_damages (0.25..2.99, odd cents).'
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
    const baseLabel = ctx.aggs.length
      ? 'base damages (including aggravating factors)'
      : 'base damages';
    const baseLine = {
      label: baseLabel,
      amount: baseAwarded
    };
    const lines = [baseLine, ...itemLines];
    let total = round2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
    if (total >= AWARD_CAP) total = ceiling; // paranoia pass for fp rounding

    const countyUpper = payload.county.toUpperCase();

    const aggSectionHtml = ctx.aggs.length ? `
      <div class="section-hd">Aggravating Factors On Record</div>
      <div class="agg-line">${escapeHtml(ctx.aggName)}.</div>
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
          ${lines.map((l, i) => `
            <tr>
              <td>${escapeHtml(l.label)}</td>
              <td class="amt"><span class="reveal-amt" style="animation-delay:${(i * 0.18).toFixed(2)}s">${fmt$(l.amount)}</span></td>
            </tr>`).join('')}
          <tr class="total">
            <td>AWARDED TOTAL</td>
            <td class="amt"><span class="reveal-amt" style="animation-delay:${(lines.length * 0.18 + 0.25).toFixed(2)}s">${fmt$(total)}</span></td>
          </tr>
        </tbody>
      </table>
      <div class="foot-math">${itemLines.length ? itemLines.length + ' line item' + (itemLines.length === 1 ? '' : 's') + ' on record · amounts assessed by the clerk' : 'amounts assessed by the clerk'}</div>

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
    // Bundle the LLM-computed judgment payload into the blob so any device
    // that hydrates this case from the case-store can render the judgment
    // INSTANTLY — no LLM call, no loading screen. Previously, cross-device
    // opens (recipient reading a shared link, sender reopening on a second
    // device) had to re-run callLLM because the per-device cache was empty.
    if (extra && extra.payload) {
      const pl = extra.payload;
      blob.pl = {
        cn: pl.case_number,
        co: pl.county,
        f:  Array.isArray(pl.findings) ? pl.findings.slice(0, 3) : [],
        v:  pl.verdict_archetype,
        bd: pl.base_damages
      };
    }
    return b64urlEncode(JSON.stringify(blob));
  }

  function payloadFromPl(pl) {
    if (!pl || typeof pl !== 'object') return null;
    return {
      case_number: pl.cn,
      county: pl.co,
      findings: Array.isArray(pl.f) ? pl.f.slice(0, 3) : [],
      verdict_archetype: pl.v,
      base_damages: Number(pl.bd) || 0
    };
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
      note.innerHTML = 'Tap <strong>SERVE THE DEFENDANT</strong> above and send the notice to the person who owes you. When they tender payment, the court record updates — reopen this link anytime and you\'ll see the <strong>PAID</strong> stamp.';
      paidSection.appendChild(note);
      return;
    }

    // ---- Recipient flow ----
    //
    // Two-step button with a confirm tap. First tap ("TENDER PAYMENT") swaps
    // the control into a confirm row. Second tap ("CONFIRM — REMIT PAYMENT")
    // actually commits the paid flag — it PATCHes the existing case-store
    // row if we have {id, token} in the URL (the happy path; recipient
    // got a proper ?c=X&k=Y link), so the plaintiff sees PAID automatically
    // next time they reopen the original link, with no receipt-URL
    // ping-pong. If PATCH is unavailable (legacy hash-only link, or the
    // short-URL service failed), we fall back to the old receipt-URL flow.
    const wrap = document.createElement('div');
    wrap.className = 'paid-receiver';
    const served = document.createElement('div');
    served.className = 'served-banner';
    served.innerHTML = '<strong>You have been served.</strong> The plaintiff has filed a claim against you for an amount assessed by the clerk. When you\'re ready, tender payment below and the court will update the record.';
    wrap.appendChild(served);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mark-paid-btn';
    btn.textContent = 'TENDER PAYMENT';
    wrap.appendChild(btn);

    const hint = document.createElement('p');
    hint.className = 'paid-hint';
    hint.textContent = 'Defendants only. Stamps the claim PAID on the court record.';
    wrap.appendChild(hint);

    const receiptBox = document.createElement('div');
    receiptBox.className = 'receipt-box hidden';
    wrap.appendChild(receiptBox);

    // First tap: swap the single button for a confirm/cancel pair so a
    // misclick can be undone before the stamp lands.
    btn.addEventListener('click', () => {
      btn.style.display = 'none';
      hint.style.display = 'none';

      const confirmRow = document.createElement('div');
      confirmRow.className = 'confirm-remit-row';
      const question = document.createElement('div');
      question.className = 'confirm-remit-q';
      question.textContent = 'Remit payment in full and stamp this claim PAID?';
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'mark-paid-btn confirm-remit-yes';
      confirmBtn.textContent = 'CONFIRM — REMIT PAYMENT';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'confirm-remit-no';
      cancelBtn.textContent = 'cancel';
      confirmRow.appendChild(question);
      confirmRow.appendChild(confirmBtn);
      confirmRow.appendChild(cancelBtn);
      wrap.insertBefore(confirmRow, receiptBox);

      cancelBtn.addEventListener('click', () => {
        confirmRow.remove();
        btn.style.display = '';
        hint.style.display = '';
      });

      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        cancelBtn.disabled = true;
        confirmBtn.textContent = 'STAMPING…';
        await commitPayment(ctx, payload, wrap, confirmRow, receiptBox);
      });
    });

    paidSection.appendChild(wrap);
  }

  async function commitPayment(ctx, payload, wrap, confirmRow, receiptBox) {
    const sig = paidSignature(ctx);
    const nowStamp = todayStamp();
    const frag = encodeCaseToFragment(ctx, {
      paid: 1, paidSig: sig, paidAt: nowStamp, payload
    });

    // Preferred path: PATCH the existing row in place so the sender's
    // original share URL starts returning the paid blob — no second URL
    // needs to travel back.
    const { id, token } = currentShortUrlParams();
    let patched = false;
    if (id && token) patched = await patchCaseInStore(id, token, frag);

    renderPaidStamp(nowStamp);
    confirmRow.remove();

    if (patched) {
      // Happy path: recipient is done. The plaintiff sees PAID whenever they
      // reopen the link they already sent. No receipt URL to ship back.
      const done = document.createElement('div');
      done.className = 'paid-done-note';
      done.innerHTML = '<strong>Done.</strong> The court record has been updated. The plaintiff will see this claim marked <strong>PAID</strong> the next time they open the link they sent you.';
      wrap.appendChild(done);
      return;
    }

    // Fallback: couldn't PATCH (no token in URL, or the store rejected).
    // Create a new short-URL row and surface the receipt-URL ping-pong flow.
    let receiptUrl;
    const saved = await saveCaseToStore(frag);
    if (saved && saved.id) {
      receiptUrl = shortUrlFor(saved.id, saved.token);
      history.replaceState(null, '', '?c=' + saved.id + (saved.token ? '&k=' + saved.token : ''));
    } else {
      receiptUrl = location.origin + location.pathname + '#' + frag;
      history.replaceState(null, '', '#' + frag);
    }

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
  }

  function renderAndShow(ctx, payload, opts) {
    const doc = document.getElementById('judgment-doc');
    doc.innerHTML = renderJudgment(ctx, payload);
    const state = opts || {};
    const isSender = senderHasCase(ctx);
    // Label the recipient's view so they know this case is addressed to them;
    // equivalently, sender sees "you filed this" so there's no ambiguity when
    // the same link is opened on both phones. Sits above the case header.
    const roleTag = document.createElement('div');
    roleTag.className = 'role-tag';
    roleTag.textContent = isSender
      ? '— on file: you filed this claim'
      : '— served to you: ' + (ctx.defendant || 'defendant');
    doc.insertBefore(roleTag, doc.firstChild);

    const sigValid = state.paid && state.paidSig === paidSignature(ctx);
    if (sigValid) {
      renderPaidStamp(state.paidAt || '');
    } else if (isSender && readPaidLocally(ctx)) {
      renderPaidStamp(readPaidLocally(ctx));
    }
    // Share / reset row visibility:
    //   - Recipients never see it — it's the plaintiff's collection toolbar.
    //   - Senders always see the row (so they can still "file another case"),
    //     but the SERVE THE DEFENDANT button + its preamble hide once the
    //     claim is paid. There's nothing left to serve, and leaving the
    //     button up while a big PAID stamp sits above it reads as contradictory.
    const effectivelyPaid = sigValid || (isSender && !!readPaidLocally(ctx));
    if (shareSection) shareSection.style.display = isSender ? '' : 'none';
    const serveBtn = document.getElementById('serve-btn');
    const preamble = shareSection ? shareSection.querySelector('.share-preamble') : null;
    const serveVisible = isSender && !effectivelyPaid;
    if (serveBtn) serveBtn.style.display = serveVisible ? '' : 'none';
    if (preamble) preamble.style.display = serveVisible ? '' : 'none';

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

  // Stagger between chips so they appear like a clerk is writing them out,
  // one after the next, rather than landing simultaneously.
  const CHIP_STAGGER_MS = 220;
  const CHIP_CHAR_MS = 24;
  const CHIP_GAP_AFTER_MS = 140;

  // Build the inner DOM of a chip: a hand-drawn checkbox with an SVG
  // checkmark path (revealed by stroke-dashoffset on check) + the text span
  // that the clerk types into character-by-character.
  function buildChipInterior(btn) {
    const box = document.createElement('span');
    box.className = 'chip-box';
    box.setAttribute('aria-hidden', 'true');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('class', 'chip-check');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M4 11 L9 15 L16 5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('pathLength', '1');
    svg.appendChild(path);
    box.appendChild(svg);
    btn.appendChild(box);
    const txt = document.createElement('span');
    txt.className = 'chip-text';
    btn.appendChild(txt);
    // Give each chip a tiny deterministic tilt (±0.45deg) so the list looks
    // hand-drawn rather than mechanically aligned. Derived from the label so
    // it's stable across re-renders of the same chip.
    const hash = hashStr(btn.dataset.key || Math.random().toString());
    const tilt = (((hash % 91) - 45) / 100).toFixed(2);
    btn.style.setProperty('--chip-tilt', tilt + 'deg');
    return txt;
  }

  // Type `fullText` into `textSpan` character-by-character. Honors
  // prefers-reduced-motion by jumping to the full string immediately.
  function typewriteChipText(btn, textSpan, fullText, startDelayMs) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      textSpan.textContent = fullText;
      return startDelayMs;
    }
    textSpan.textContent = '';
    btn.classList.add('chip-typing');
    setTimeout(() => {
      let i = 1;
      const step = () => {
        textSpan.textContent = fullText.slice(0, i);
        i++;
        if (i <= fullText.length) {
          setTimeout(step, CHIP_CHAR_MS + Math.random() * 18);
        } else {
          btn.classList.remove('chip-typing');
        }
      };
      step();
    }, startDelayMs);
    return startDelayMs + fullText.length * (CHIP_CHAR_MS + 9) + CHIP_GAP_AFTER_MS;
  }

  function makeChip(i, key, label, dataAttrs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'checkbox');
    btn.setAttribute('aria-checked', 'false');
    btn.dataset.key = key;
    Object.keys(dataAttrs || {}).forEach((k) => { btn.dataset[k] = String(dataAttrs[k]); });
    btn.style.setProperty('--chip-delay', (i * CHIP_STAGGER_MS) + 'ms');
    const txt = buildChipInterior(btn);
    const end = typewriteChipText(btn, txt, label, i * CHIP_STAGGER_MS);
    return { btn: btn, endMs: end };
  }

  // Render a list of chips into a container. Single unified path for all chip
  // rendering — animated (LLM- or default-sourced) and non-animated (hydrated
  // from a shared link) — so there's only one place to fix a chip bug.
  //
  //   specs   : [{ key, label, dataset: {mult|amount}, checked? }]
  //   animate : true → typewriter reveal via makeChip; false → plain chip
  //   baseOffset : used by animated renders to continue the stagger across
  //                the agg→item section so they read as one sheet
  function renderChipList(container, specs, opts) {
    if (!container) return 0;
    opts = opts || {};
    const animate = opts.animate !== false;
    const baseOffset = opts.baseOffset || 0;
    container.innerHTML = '';
    let lastEnd = 0;
    specs.forEach((s, i) => {
      let btn;
      if (animate) {
        const r = makeChip(baseOffset + i, s.key, s.label, s.dataset || {});
        btn = r.btn;
        lastEnd = Math.max(lastEnd, r.endMs);
      } else {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.setAttribute('role', 'checkbox');
        btn.dataset.key = s.key;
        Object.keys(s.dataset || {}).forEach((k) => { btn.dataset[k] = String(s.dataset[k]); });
        btn.textContent = s.label;
      }
      btn.setAttribute('aria-checked', s.checked ? 'true' : 'false');
      container.appendChild(btn);
    });
    return lastEnd;
  }

  function chipSpecFromAgg(key, label, mult, checked) {
    return { key, label, dataset: { mult }, checked: !!checked };
  }
  function chipSpecFromItem(key, label, amount, checked) {
    return { key, label, dataset: { amount }, checked: !!checked };
  }
  function itemsChipOffset() {
    return aggChipsEl ? aggChipsEl.querySelectorAll('.chip').length : 0;
  }

  function renderAggChips(aggSet) {
    const newCurrent = {};
    const specs = aggSet.map((a, i) => {
      const key = keyFromLabel('agg', a.label, i);
      newCurrent[key] = { label: a.label, mult: a.mult };
      return chipSpecFromAgg(key, a.label, a.mult, false);
    });
    const lastEnd = renderChipList(aggChipsEl, specs);
    CURRENT_AGG = newCurrent;
    selectedAggs = [];
    updateAggSummary();
    return lastEnd;
  }

  function renderItemChips(itemSet) {
    if (!itemChipsEl) return 0;
    const newCurrent = {};
    const specs = itemSet.map((a, i) => {
      const key = keyFromLabel('item', a.label, i);
      newCurrent[key] = { label: a.label, amount: a.amount };
      return chipSpecFromItem(key, a.label, a.amount, false);
    });
    const lastEnd = renderChipList(itemChipsEl, specs, { baseOffset: itemsChipOffset() });
    CURRENT_ITEM = newCurrent;
    selectedItems = [];
    updateItemSummary();
    return lastEnd;
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
    markOptionsNotReady();
    startDraftingIndicator();

    try {
      const out = await callSuggestLLM(plaintiff, defendant, grievance);
      stopDraftingIndicator();
      clearFallbackNotice();
      const aggEnd = renderAggChips(out.aggravators);
      const itemEnd = renderItemChips(out.items);
      lastSuggestHash = h;
      setSuggestStatus('the clerk’s options — pick any that apply');
      markOptionsReadyAfter(Math.max(aggEnd, itemEnd) + 160);
    } catch (err) {
      stopDraftingIndicator();
      console.warn('[petty] suggest failed:', err && err.message);
      setSuggestStatus('');
      // A persistent notice above the chip list (rather than the transient
      // status line) so the user still understands the chips are generic
      // even after the status line rotates back to "pick any that apply".
      showFallbackNotice();
      CURRENT_AGG = Object.assign({}, AGG);
      CURRENT_ITEM = Object.assign({}, ITEM);
      const aggEnd = renderDefaultAggChips();
      const itemEnd = renderDefaultItemChips();
      markOptionsReadyAfter(Math.max(aggEnd, itemEnd) + 160);
    } finally {
      suggestInflight = false;
    }
  }

  function showFallbackNotice() {
    const host = document.getElementById('suggest-status');
    if (!host) return;
    let n = document.getElementById('suggest-fallback');
    if (!n) {
      n = document.createElement('div');
      n.id = 'suggest-fallback';
      n.className = 'suggest-fallback';
      n.setAttribute('role', 'status');
      host.parentNode.insertBefore(n, host);
    }
    n.textContent = 'clerk unreachable — these are the court’s default options, not tailored to your grievance';
  }
  function clearFallbackNotice() {
    const n = document.getElementById('suggest-fallback');
    if (n && n.parentNode) n.parentNode.removeChild(n);
  }

  function setSuggestStatus(msg) {
    if (suggestStatus) suggestStatus.textContent = msg || '';
  }

  // Animated loading indicator for the status line while the clerk drafts.
  // Cycles through dots so the user sees that something is happening and
  // doesn't rush to click File before the options appear.
  let draftingTimer = null;
  const DRAFTING_FRAMES = [
    'the clerk is drafting your options',
    'the clerk is drafting your options.',
    'the clerk is drafting your options..',
    'the clerk is drafting your options...'
  ];
  function startDraftingIndicator() {
    stopDraftingIndicator();
    let i = 0;
    setSuggestStatus(DRAFTING_FRAMES[0]);
    draftingTimer = setInterval(() => {
      i = (i + 1) % DRAFTING_FRAMES.length;
      setSuggestStatus(DRAFTING_FRAMES[i]);
    }, 320);
  }
  function stopDraftingIndicator() {
    if (draftingTimer) { clearInterval(draftingTimer); draftingTimer = null; }
  }

  // FILE button gating: disabled while the clerk is drafting and while
  // chips are still typing in. Re-enabled after the last chip finishes its
  // typewriter animation. Aggravators & items remain optional — this is
  // purely a "let the user see the choices first" guard.
  function getFileBtn() { return document.getElementById('file-btn'); }
  function setFileBtnWaiting(waiting) {
    const fb = getFileBtn();
    if (!fb) return;
    fb.disabled = !!waiting;
    fb.classList.toggle('file-btn-waiting', !!waiting);
    fb.textContent = waiting ? 'AWAITING THE CLERK…' : 'FILE THE CASE';
  }
  function markOptionsNotReady() {
    optionsReady = false;
    if (optionsReadyTimer) { clearTimeout(optionsReadyTimer); optionsReadyTimer = null; }
    setFileBtnWaiting(true);
  }
  function markOptionsReadyAfter(ms) {
    if (optionsReadyTimer) clearTimeout(optionsReadyTimer);
    optionsReadyTimer = setTimeout(() => {
      optionsReady = true;
      optionsReadyTimer = null;
      setFileBtnWaiting(false);
    }, Math.max(0, ms | 0));
  }

  if (grievanceEl) {
    grievanceEl.addEventListener('blur', () => { runSuggest(false); });
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
      // Disable FILE immediately on step 2 entry; it re-enables once the
      // clerk returns and the chips finish typing.
      if (!optionsReady) setFileBtnWaiting(true);
      goToStep(2);
      // Chips area stays empty (with "drafting…" status) until the clerk returns;
      // HTML no longer ships default chips, so step 2 reveals a clean slate.
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
    // Defense-in-depth: even though FILE is disabled while options are
    // drafting, block any stray submit (Enter key, etc.) until the clerk's
    // chips have finished typing.
    if (!optionsReady) return setErr('Hold on — the clerk is still writing your options.');

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

    const frag = encodeCaseToFragment(ctx, { payload });
    const saved = await saveCaseToStore(frag);
    if (saved && saved.id) {
      // Token goes in the URL so whoever holds the link (sender OR recipient)
      // can PATCH the same row to flip paid state, instead of having to POST
      // a second row and ship a receipt URL back.
      const qs = '?c=' + saved.id + (saved.token ? '&k=' + saved.token : '');
      history.replaceState(null, '', location.pathname + qs);
    } else {
      // Fallback: if the store is unreachable, keep the old hash-fragment
      // behavior so at least the link still hydrates (just poorly on iOS).
      history.replaceState(null, '', '#' + frag);
    }

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
    aggChipsEl.innerHTML = '';
    if (itemChipsEl) itemChipsEl.innerHTML = '';
    lastSuggestHash = 0;
    setSuggestStatus('');
    stopDraftingIndicator();
    clearFallbackNotice();
    clearDeadLinkBanner();
    markOptionsNotReady();
    updateAggSummary();
    updateItemSummary();
    errEl.textContent = '';
    if (shareSection) shareSection.style.display = 'none';
    if (paidSection) paidSection.style.display = 'none';
    goToStep(1);
    refreshContinueState();
    show(intake);
  });

  function renderDefaultAggChips() {
    const specs = Object.keys(AGG).map((key) =>
      chipSpecFromAgg(key, AGG[key].label, AGG[key].mult, false));
    return renderChipList(aggChipsEl, specs);
  }

  function renderDefaultItemChips() {
    const specs = Object.keys(ITEM).map((key) =>
      chipSpecFromItem(key, ITEM[key].label, ITEM[key].amount, false));
    return renderChipList(itemChipsEl, specs, { baseOffset: itemsChipOffset() });
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

  // Share payload intentionally minimal: one sentence + the short URL in the
  // `url` field. When Messages/iMessage receives this, it linkifies the URL
  // cleanly and pulls the page's OG tags for a rich preview card, which
  // doesn't work when the body is a long pasted demand letter with a 1500+
  // char hash fragment buried inside it.
  window.serveDefendant = function () {
    const c = currentCaseText();
    const url = location.href;
    const oneLiner = c.defendantName + ', you have been served.';

    if (navigator.share) {
      navigator.share({ title: 'You have been served', text: oneLiner, url: url }).catch(() => {});
      return;
    }

    const toCopy = oneLiner + ' ' + url;
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
        .catch(() => { window.prompt('Copy this and send it to the defendant:', toCopy); });
    } else {
      window.prompt('Copy this and send it to the defendant:', toCopy);
    }
  };

  // Back-compat: some older hash fragments or cached scripts may still call
  // window.share(). Route it to the new serve flow.
  window.share = function () { window.serveDefendant(); };

  // ---------- Boot: hydrate from #fragment if present ----------

  (async function boot() {
    // Step 2 chip rows start empty; the clerk fills them after the grievance
    // is written. Defaults only render as a fallback when the suggest call fails.
    // FILE starts in its "awaiting the clerk" state — even though the user
    // can't see it yet from step 1, this guarantees the correct initial copy
    // the moment they land on step 2.
    setFileBtnWaiting(true);

    if (shareSection) shareSection.style.display = 'none';
    if (paidSection) paidSection.style.display = 'none';

    // Hydration priority: new short-URL `?c=<id>` first; fall through to
    // legacy `#<frag>` so any already-shared links keep working.
    const params = new URLSearchParams(location.search);
    const shortId = params.get('c');
    let frag = '';
    if (shortId) {
      // Keep the intake UI hidden briefly while we fetch; on failure we fall
      // back to the intake form like any other fresh-load.
      frag = (await loadCaseFromStore(shortId)) || '';
    }
    if (!frag) {
      frag = (location.hash || '').replace(/^#/, '');
    }
    const decoded = decodeFragment(frag);

    const normalized = normalizeDecodedToV4(decoded);
    if (normalized) {
      await hydrateAndShow(normalized);
      return;
    }
    // If a short-URL id was in the URL but we couldn't load it (expired/wrong),
    // show the intake with a banner so the user understands. Clear the bad
    // `?c=` param from the location bar so a reload starts fresh.
    if (shortId && !frag) {
      showDeadLinkBanner();
      try { history.replaceState(null, '', location.pathname); } catch (_) {}
    }
    show(intake);
  })();

  function showDeadLinkBanner() {
    const intakeEl = document.getElementById('intake');
    if (!intakeEl) return;
    if (intakeEl.querySelector('.dead-link-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'dead-link-banner';
    banner.setAttribute('role', 'status');
    banner.textContent = 'That case link has expired or was mistyped — the clerk has no record of it. File a fresh case below.';
    intakeEl.insertBefore(banner, intakeEl.firstChild);
  }
  function clearDeadLinkBanner() {
    const intakeEl = document.getElementById('intake');
    const b = intakeEl && intakeEl.querySelector('.dead-link-banner');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  }

  // ---------- Hydration: one shared path for all fragment versions ----------
  //
  // Any decoded fragment is first normalized into a v4-shaped blob, then fed
  // through the same hydrate routine. Earlier versions carried their judgment
  // payload inline (v1/v2) or embedded `micro_damages` in the cached payload
  // (v3); we surface those quirks as small flags on the normalized record,
  // and the hydrator handles them in a single place instead of three parallel
  // if-blocks.

  function normalizeDecodedToV4(decoded) {
    if (!decoded) return null;
    const o = decoded.blob;

    if (decoded.version === 4) {
      return { blob: o, inlinePayload: null, absorbMicroDamages: 'none' };
    }

    if (decoded.version === 3) {
      return {
        blob: {
          v: 4, p: o.p, d: o.d, g: o.g,
          a: Array.isArray(o.a) ? o.a.slice() : [],
          i: [],
          c: o.c || null,
          ci: null,
          paid: o.paid, ps: o.ps, pt: o.pt
        },
        inlinePayload: null,
        absorbMicroDamages: 'from-cache'
      };
    }

    if (decoded.version === 1 || decoded.version === 2) {
      const def = (o.v === 2 && o.ag) ? o.ag : (AGG[o.a] || { label: o.a, mult: 1.2 });
      const custom = {};
      custom[o.a] = { label: def.label, mult: def.mult };
      return {
        blob: {
          v: 4, p: o.p, d: o.d, g: o.g,
          a: [o.a],
          i: [],
          c: custom,
          ci: null,
          paid: o.paid, ps: o.ps, pt: o.pt
        },
        inlinePayload: o.ai || null,
        absorbMicroDamages: Array.isArray(o.ai && o.ai.micro_damages) ? 'from-inline' : 'none'
      };
    }

    return null;
  }

  function absorbLegacyItems(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const tmp = {};
    const keys = [];
    list.slice(0, 3).forEach((m, i) => {
      const k = keyFromLabel('item', m.label || ('item' + i), i);
      tmp[k] = { label: String(m.label || 'petty matter'), amount: Math.max(0, Number(m.amount) || 0) };
      keys.push(k);
    });
    return { tmp, keys };
  }

  async function hydrateAndShow(norm) {
    const o = norm.blob;

    // 1. Reconstruct chip dictionaries from the blob's custom sets, falling
    //    back to the built-in defaults when the blob didn't carry customs.
    if (o.c && typeof o.c === 'object') {
      CURRENT_AGG = {};
      Object.keys(o.c).forEach((k) => {
        const a = o.c[k];
        CURRENT_AGG[k] = { label: String(a.label || k), mult: Number(a.mult) || 1.2 };
      });
    } else {
      CURRENT_AGG = Object.assign({}, AGG);
    }
    if (o.ci && typeof o.ci === 'object') {
      CURRENT_ITEM = {};
      Object.keys(o.ci).forEach((k) => {
        const a = o.ci[k];
        CURRENT_ITEM[k] = { label: String(a.label || k), amount: Number(a.amount) || 1.00 };
      });
    } else {
      CURRENT_ITEM = Object.assign({}, ITEM);
    }

    // 2. Form fields + selections + initial chip render.
    $('#plaintiff').value = o.p;
    $('#defendant').value = o.d;
    $('#grievance').value = o.g;
    selectedAggs = Array.isArray(o.a) ? o.a.slice() : [];
    selectedItems = Array.isArray(o.i) ? o.i.slice() : [];
    renderHydratedAggChips(selectedAggs);
    updateAggSummary();

    let ctx = buildContext({
      plaintiff: o.p, defendant: o.d, grievance: o.g,
      aggs: selectedAggs, items: selectedItems
    });

    // 3. Payload resolution.
    //    (a) Newer v4 blobs bundle the LLM-computed payload inline as `pl`
    //        so cross-device hydration is instant — no cache miss, no LLM
    //        call, no loading screen. This is the happy path.
    //    (b) Older blobs without `pl` fall through to cache → LLM → fallback.
    //    (c) v1/v2 carries an inline payload; v3 had micro_damages embedded
    //        in the cached payload. We also collect any legacy micro_damages
    //        here; they'll be migrated into items below.
    let payload = null;
    let legacyMicroDamages = null;

    if (o.pl) {
      payload = payloadFromPl(o.pl);
      // Warm the local cache so later reopens from a hash fragment (no `pl`)
      // still hit. inputHash ignores items, so the migration step below
      // doesn't invalidate the key.
      if (payload) writeCache(ctx, payload);
    } else if (norm.inlinePayload) {
      const ai = norm.inlinePayload;
      if (norm.absorbMicroDamages === 'from-inline') legacyMicroDamages = ai.micro_damages;
      payload = {
        case_number: ai.case_number || caseNumberFromHash(inputHash(ctx)),
        county: ai.county || pickCounty(inputHash(ctx)),
        findings: Array.isArray(ai.findings) ? ai.findings.slice(0, 3) : fallbackPayload(ctx).findings,
        verdict_archetype: ai.verdict_archetype || VERDICTS[inputHash(ctx) % VERDICTS.length],
        base_damages: fallbackBaseDamages(o.g)
      };
    } else if (norm.absorbMicroDamages === 'from-cache') {
      // v3: read cache manually so we don't lose micro_damages (readCache
      // strips them). inputHash ignores items, so migration below doesn't
      // change the cache key.
      let cached = null;
      try {
        const raw = localStorage.getItem('psc:' + inputHash(ctx));
        if (raw) cached = JSON.parse(raw);
      } catch (e) {}
      if (cached) {
        payload = Object.assign({}, cached);
        if (Array.isArray(cached.micro_damages)) legacyMicroDamages = cached.micro_damages;
      }
    } else {
      payload = readCache(ctx);
    }

    if (!payload) {
      startLoading();
      try { payload = await callLLM(ctx); }
      catch (err) { payload = fallbackPayload(ctx); }
      stopLoading();
    }

    // 4. Legacy micro_damages → items migration.
    const absorbed = absorbLegacyItems(legacyMicroDamages);
    if (absorbed) {
      CURRENT_ITEM = absorbed.tmp;
      selectedItems = absorbed.keys;
      ctx = buildContext({
        plaintiff: o.p, defendant: o.d, grievance: o.g,
        aggs: selectedAggs, items: selectedItems
      });
    }

    renderHydratedItemChips(selectedItems);
    updateItemSummary();

    if (payload && payload.micro_damages) delete payload.micro_damages;
    if (payload) writeCache(ctx, payload);

    const paidState = { paid: !!o.paid, paidSig: o.ps || '', paidAt: o.pt || '' };
    renderAndShow(ctx, payload, paidState);
  }

  function renderHydratedAggChips(selectedKeys) {
    const checked = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
    const specs = Object.keys(CURRENT_AGG).map((key) =>
      chipSpecFromAgg(key, CURRENT_AGG[key].label, CURRENT_AGG[key].mult, checked.has(key)));
    renderChipList(aggChipsEl, specs, { animate: false });
  }

  function renderHydratedItemChips(selectedKeys) {
    const checked = new Set(Array.isArray(selectedKeys) ? selectedKeys : []);
    const specs = Object.keys(CURRENT_ITEM).map((key) =>
      chipSpecFromItem(key, CURRENT_ITEM[key].label, CURRENT_ITEM[key].amount, checked.has(key)));
    renderChipList(itemChipsEl, specs, { animate: false });
  }

})();
