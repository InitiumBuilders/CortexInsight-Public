/* ============================================================================
   CortexInsight v2 — the command-center layer.
   Loaded AFTER renderer.js, so the view functions declared here intentionally
   supersede their v1 namesakes (later declaration wins). Everything new lives
   in this file so the original renderer stays readable and diffable.
   ============================================================================ */
'use strict';

/* ---------------------------------------------------------------- fleet state */
// One clock for the whole app: his local time, 12-hour, never military.
// "Aug 18 · 4:44 PM" — the year only when it differs from this one.
function fmtDT2(ts) {
  const d = new Date(ts); if (isNaN(d)) return String(ts || '');
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} · ${t}`;
}

async function refreshFleet() {
  const r = await C.fleet();
  if (!r || r.error) return;
  FLEET_LIVE = r.fleet || [];
  QUALITY_LIVE = r.quality || [];
  MODELS_LIVE = r.known || [];
  BRIDGE = r.bridge || {};
  return r;
}
let BRIDGE = {};

/* ------------------------------------------------------- control plane (stop) */
function wireControlBar() {
  const stop = $('#tbStop'), duo = $('#tbDuo');
  if (stop) stop.onclick = () => toggleStop();
  if (duo) duo.onclick = () => switchView('duo');
  refreshControl();
}
async function refreshControl() {
  const c = await C.control();
  if (!c || c.error) return;
  CONTROL = c;
  const btn = $('#tbStop');
  if (btn) {
    btn.classList.toggle('on', !!c.stopped);
    btn.innerHTML = c.stopped ? '▶ Resume' : '■ Stop';
    btn.title = c.stopped ? c.scope : 'Stop everything CortexInsight drives';
  }
  const d = $('#tbDuo');
  if (d) {
    d.classList.toggle('on', !!(c.duo && c.duo.active));
    d.title = c.duo && c.duo.active ? `Duo-Drive running · ${aname(c.duo.agent)}` : 'Duo-Drive (off)';
  }
  document.body.classList.toggle('fleet-stopped', !!c.stopped);
  // The banner states the ACTUAL reach of the current stop, not a slogan.
  let bn = $('#stopBanner');
  if (c.stopped) {
    if (!bn) { bn = document.createElement('div'); bn.id = 'stopBanner'; bn.className = 'stop-banner'; $('#content').prepend(bn); }
    bn.className = 'stop-banner' + (c.hardEffective ? ' hard' : c.hard ? ' warn' : '');
    bn.innerHTML = `<b>${c.hardEffective ? '■ HARD STOPPED' : c.hard ? '⚠ HARD STOP NOT IN FORCE' : '■ STOPPED (this app only)'}</b> <span>${esc(c.scope)}</span>`;
  } else if (bn) { bn.remove(); }
  return c;
}
async function toggleStop() {
  const stopping = !CONTROL.stopped;
  let hard = false;
  if (stopping) {
    const ext = CONTROL.external ? `\n· ${CONTROL.external.name} runs in her own gateway on her own OpenRouter key — nothing here can stop her.` : '';
    if (!confirm('Stop the fleet?\n\n'
      + 'SOFT STOP halts everything CortexInsight drives: Command sends, Duo-Drive, workflows,\n'
      + 'subagent spawns, triggers, delegation and the auto-loops.\n\n'
      + 'It does NOT stop a message you send Davara on Telegram.'
      + ext + '\n\n'
      + 'OK = continue.   Cancel = leave it running.')) return;

    hard = confirm('Also HARD-stop at the runner? (recommended if you want ZERO token spend)\n\n'
      + 'This makes the fleet runner itself refuse every relay turn — so Telegram and\n'
      + 'Hermes stop spending too. It is the only setting that truly guarantees no\n'
      + 'subscription tokens are used.\n\n'
      + (CONTROL.bridgeInstalled
        ? 'Your fleet bridge is installed, so this will take effect immediately.'
        : '⚠ YOUR FLEET BRIDGE IS NOT INSTALLED — hard stop CANNOT take effect without it.\nInstall it on the Model screen first, or a Telegram message will still run and still spend.')
      + '\n\nOK = hard stop.   Cancel = soft stop (this app only).');
  }
  const c = await C.control({ stopped: stopping, hard });
  CONTROL = c || CONTROL;
  await refreshControl();
  if (stopping && hard && c && !c.hardEffective) {
    toast('Stopped here — but hard stop is NOT in force without the bridge', 'bad');
  } else {
    toast(stopping ? (hard ? 'Fleet HARD-stopped ■ — no relay tokens can be spent' : 'Fleet stopped ■ (this app only)') : 'Fleet resumed ▶', stopping ? 'warn' : 'good');
  }
  loadView(CUR.view);
}

/* ================================================================= MODEL VIEW
   The model select screen August asked for: the catalogue (with Opus 5 and the
   rest of the Claude 5 family) AND per-agent model + quality assignment.       */
function qualityBar(agentId, cur) {
  return QUALITY_LIVE.map((q) =>
    `<button class="qbtn ${q.id === cur ? 'on' : ''}" data-qa="${agentId}" data-q="${q.id}" title="${esc(q.note)}">${esc(q.label)}</button>`).join('');
}
async function loadModels() {
  const r = await C.models();
  if (!r || r.error) return;
  FLEET_LIVE = r.fleet || FLEET_LIVE; QUALITY_LIVE = r.quality || QUALITY_LIVE;
  MODELS_LIVE = r.known || MODELS_LIVE; BRIDGE = r.bridge || BRIDGE;
  const relay = relayFleet();
  const gens = [...new Set(MODELS_LIVE.map((m) => m.gen || 'Other'))];

  const bridgeCard = BRIDGE.outdated
    ? `<div class="bridge warn glass-deep">
         <div class="br-ic">↑</div>
         <div><div class="br-t">Your bridge is one version behind</div>
           <div class="br-d">Per-agent model and quality work. What is missing is <b>the brief</b>: every agent turn — including every Telegram message — currently starts blind, with no idea of your Motus, your goal, your open board, or what the fleet has already learned. Updating prepends that orientation to each turn (~2KB, capped). Same guarantees: additive, backed up, syntax-verified, auto-rolled-back.</div></div>
         <button class="prime-btn" id="bridgeOn">Update bridge</button>
       </div>`
    : BRIDGE.installed
    ? `<div class="bridge ok glass-deep">
         <div class="br-ic">✓</div>
         <div><div class="br-t">Per-agent control is live${BRIDGE.carriesBrief ? ' · the fleet is oriented' : ''}</div>
           <div class="br-d">The runner reads your choices fresh on every turn — a change here takes effect on the next message, with no restart of anything.${BRIDGE.carriesBrief ? ' Every turn also carries your Motus, goal, open board and the fleet\'s strongest learnings, so no agent starts blind.' : ''}</div></div>
         <button class="ghost-btn" id="bridgeOff">Remove bridge</button>
       </div>`
    : `<div class="bridge warn glass-deep">
         <div class="br-ic">◈</div>
         <div><div class="br-t">Per-agent control needs the fleet bridge</div>
           <div class="br-d">Right now the fleet runner has <b>one global pin</b> for every agent, so per-agent choices below are saved but not yet obeyed. The bridge adds one guarded, additive block to <code>cortex-run.sh</code> that reads your choices per turn. It is backed up, syntax-verified after writing, auto-rolled-back on any error, and removable in one click.</div></div>
         <button class="prime-btn" id="bridgeOn">Install fleet bridge</button>
       </div>`;

  setHTML($('#modelBody'), `
    <div class="view-head"><h2>Model &amp; Quality</h2>
      <p class="view-desc">Give every agent its own brain and its own depth. Defaults to <b>Opus 5</b> across the fleet.</p></div>
    ${bridgeCard}
    <div class="panel glass">
      <div class="panel-head"><h3>Per-agent assignment</h3><span class="panel-sub">model · quality · turn budget · pause</span></div>
      <div class="fleet-rows">
        ${relay.map((f) => `
          <div class="frow tone-${TONE[f.id] || 'slate'} ${f.paused ? 'is-paused' : ''}">
            <div class="fr-id"><span class="fr-orb"></span>
              <div><div class="fr-name">${esc(f.name)}</div><div class="fr-role">${esc(f.role || '')}</div></div>
            </div>
            <div class="fr-model">
              <label class="fr-lbl">Model</label>
              <select class="sel" data-model-for="${f.id}">
                ${MODELS_LIVE.map((m) => `<option value="${esc(m.id)}" ${m.id === f.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
              </select>
              ${f.altModels ? `<div class="fr-alt">${f.altModels.map((m) => `<button class="mini ${m === f.model ? 'on' : ''}" data-model-for="${f.id}" data-quick="${esc(m)}">${esc(mlabel(m))}</button>`).join('')}</div>` : ''}
            </div>
            <div class="fr-q">
              <label class="fr-lbl">Quality</label>
              <div class="qrow">${qualityBar(f.id, f.effort)}</div>
            </div>
            <div class="fr-turns">
              <label class="fr-lbl">Turns</label>
              <input class="num" type="number" min="1" max="400" value="${f.turns}" data-turns-for="${f.id}" />
            </div>
            <div class="fr-act">
              <button class="mini ${f.paused ? 'danger on' : ''}" data-pause-for="${f.id}" data-paused="${f.paused ? 1 : 0}">${f.paused ? '▶ Resume' : '⏸ Pause'}</button>
            </div>
          </div>`).join('')}
        ${FLEET_LIVE.filter((f) => f.lane !== 'relay').map((f) => `
          <div class="frow ext tone-${TONE[f.id] || 'slate'}">
            <div class="fr-id"><span class="fr-orb"></span>
              <div><div class="fr-name">${esc(f.name)}</div><div class="fr-role">${esc(f.role || '')}</div></div>
            </div>
            <div class="fr-extnote">Configured in her own Hermes gateway on <b>OpenRouter</b> — currently <code>${esc(f.model || '—')}</code>. She is observed in Live, Board and Output, never driven from here.</div>
          </div>`).join('')}
      </div>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Model catalogue</h3><span class="panel-sub">only ids this CLI actually accepts — nothing speculative</span></div>
      ${gens.map((g) => `
        <div class="mgen"><div class="mgen-t">${esc(g)}</div>
          ${MODELS_LIVE.filter((m) => (m.gen || 'Other') === g).map((m) => `
            <div class="mrow ${m.flagship ? 'flag' : ''}">
              <div class="mr-l"><div class="mr-name">${esc(m.label)}${m.id === r.defaultModel ? ' <span class="mr-def">fleet default</span>' : ''}</div>
                <div class="mr-id mono">${esc(m.id)}</div></div>
              <div class="mr-note">${esc(m.note || '')}</div>
              <div class="mr-users">${relay.filter((f) => f.model === m.id).map((f) => `<span class="chip-tiny tone-${TONE[f.id] || 'slate'}">${esc(f.name)}</span>`).join('') || '<span class="mr-none">— unused</span>'}</div>
            </div>`).join('')}
        </div>`).join('')}
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Global runner pin</h3><span class="panel-sub">the fallback for anything not covered per-agent</span></div>
      <div class="gpin"><span class="gp-cur mono">${esc(r.current.model)}</span>
        <span class="gp-src">pinned in ${esc(r.current.source || 'runner')}</span>
        <span class="gp-note">Per-agent choices above override this whenever the bridge is installed.</span></div>
    </div>`);

  // --- wiring -------------------------------------------------------------
  const apply = async (agent, patch, label) => {
    const res = await C.setAgentConfig({ agent, ...patch });
    if (!res || !res.ok) { toast('Could not apply: ' + ((res && res.error) || '?'), 'bad'); return; }
    toast(`${aname(agent)} → ${label}${res.effective ? '' : ' (saved — bridge not installed)'}`, res.effective ? 'good' : 'warn');
    await refreshFleet(); loadModels(); loadChatBar();
  };
  $$('#modelBody [data-model-for]').forEach((el) => {
    if (el.tagName === 'SELECT') el.onchange = () => apply(el.dataset.modelFor, { model: el.value }, mlabel(el.value));
    else if (el.dataset.quick) el.onclick = () => apply(el.dataset.modelFor, { model: el.dataset.quick }, mlabel(el.dataset.quick));
  });
  $$('#modelBody [data-qa]').forEach((b) => b.onclick = () => apply(b.dataset.qa, { effort: b.dataset.q }, QLABEL[b.dataset.q] || b.dataset.q));
  $$('#modelBody [data-turns-for]').forEach((i) => i.onchange = () => apply(i.dataset.turnsFor, { turns: i.value }, i.value + ' turns'));
  $$('#modelBody [data-pause-for]').forEach((b) => b.onclick = async () => {
    const paused = b.dataset.paused !== '1';
    const res = await C.pauseAgent({ agent: b.dataset.pauseFor, paused });
    if (res && res.ok) { toast(`${aname(b.dataset.pauseFor)} ${paused ? 'paused ⏸' : 'resumed ▶'}`, paused ? 'warn' : 'good'); await refreshFleet(); loadModels(); loadChatBar(); }
  });
  const on = $('#bridgeOn'), off = $('#bridgeOff');
  if (on) on.onclick = async () => {
    if (!confirm('Install the fleet bridge?\n\nThis adds ONE guarded block to cortex-run.sh:\n\n· purely additive — no existing line is rewritten\n· a timestamped backup is written first\n· the result is checked with `bash -n` and rolled back automatically if anything is off\n· if the config file is ever missing or corrupt, the runner falls back to today\'s behaviour exactly\n· removable in one click\n\nProceed?')) return;
    on.disabled = true; on.textContent = 'Installing…';
    const res = await C.bridge('install');
    if (res && res.ok) toast(res.already ? 'Bridge already installed' : `Bridge installed ✓ (backup ${res.backup || 'written'})`, 'good');
    else toast('Bridge not installed: ' + ((res && res.error) || '?'), 'bad');
    await refreshFleet(); loadModels();
  };
  if (off) off.onclick = async () => {
    if (!confirm('Remove the fleet bridge?\n\ncortex-run.sh returns to a single global model pin for every agent. Your per-agent choices stay saved here and will apply again if you reinstall.')) return;
    const res = await C.bridge('uninstall');
    toast(res && res.ok ? 'Bridge removed' : 'Could not remove: ' + ((res && res.error) || '?'), res && res.ok ? 'good' : 'bad');
    await refreshFleet(); loadModels();
  };
}

/* ================================================================= THE BOARD
   A real task manager: August's work, assignable to any agent, dispatchable in
   one click — merged with what the fleet actually completed.                   */
const BOARD = { work: null };
const BOARD_COLS = [
  { id: 'inbox', label: 'Inbox', hint: 'captured, not started' },
  { id: 'active', label: 'Active', hint: 'in motion' },
  { id: 'waiting', label: 'Waiting', hint: 'blocked or with an agent' },
  { id: 'done', label: 'Done', hint: 'finished' },
];
/* ── THE BOARD, REBUILT ──────────────────────────────────────────────────────
   The old card carried eight controls — two selects, two buttons, three chips
   and an expandable note — across four columns at once. Same failure as the
   live page: everything shouting at one volume, so nothing reads as important.

   Now the card shows what you need to SCAN (priority, title, who has it, and
   whether the pool is working on it) and hides what you need to ACT (assign,
   move, run, dispatch, delete) behind one press. And it finally surfaces the
   thing that changed underneath it: a task can now be worked by the compute
   commons, so the card shows that state where the work actually is. */
async function loadBoard() {
  const b = await C.board();
  if (!b || b.error) return viewFail('tasks', b || null);
  const tasks = b.tasks || [];
  const prio = ['', 'high', 'normal', 'low'];

  /* ⚠ MEASURED (the v3.40 instrument): tasks was the slowest LOCAL view at
     ~1s median — and the board itself is a millisecond read from the vault.
     The whole wait was C.work(), an HTTPS round-trip to the pool ledger,
     awaited BEFORE the first paint. Same disease as the stream view, same
     cure: paint from what is here, refresh from the network afterwards, and
     only repaint if the answer actually changed — the signature check means
     a quiet pool costs one string compare, not a rebuild. */
  const workByTask = {};
  (((BOARD.work || {}).byTask) || []).forEach((t) => { workByTask[t.task] = t; });
  if (C.work && !loadBoard._inflight) {
    loadBoard._inflight = true;
    C.work().then((k) => {
      loadBoard._inflight = false;
      if (!(k && k.ok && k.work)) return;
      const sig = JSON.stringify(k.work.byTask || []);
      if (sig === BOARD.workSig) return;          // nothing moved — no repaint
      BOARD.workSig = sig;
      BOARD.work = k.work;
      if (CUR.view === 'tasks') loadBoard();      // he is still here — patch in
    }).catch(() => { loadBoard._inflight = false; });
  }

  const card = (t) => {
    const pool = workByTask[t.title];
    const isAuto = (b.autoWork || {}).current === t.id;
    const ageD = Math.floor((Date.now() - (Date.parse(t.updated || t.created) || Date.now())) / 864e5);
    return `
    <div class="tcard p${t.priority} ${t.agent ? 'tone-' + (TONE[t.agent] || 'slate') : ''} ${t.owner === 'fleet' ? 'fleet-owned' : ''} ${isAuto ? 'auto-live' : ''} ${ageD >= 14 && t.status !== 'done' ? 'stale' : ''}" data-task="${t.id}">
      <div class="tc-top">
        <span class="tc-pri" title="${prio[t.priority] || 'normal'} priority"></span>
        <div class="tc-title">${esc(t.title)}</div>
        <button class="tc-more" data-tmore="${t.id}" aria-label="task actions" title="actions">⋯</button>
      </div>
      <div class="tc-meta">
        <button class="tc-owner ${t.owner === 'fleet' ? 'fleet' : ''}" data-towner="${t.id}"
          title="${t.owner === 'fleet' ? 'the fleet works this on its own — click to take it back' : 'yours — click to hand it to the fleet queue'}">${t.owner === 'fleet' ? '⇄ fleet' : '◈ mine'}</button>
        ${isAuto ? '<span class="tc-auto-live">● working now</span>' : ''}
        ${ageD >= 3 && t.status !== 'done' ? '<span class="tc-age" title="days since anyone touched it">⏱ ' + ageD + 'd</span>' : ''}
        ${t.agent ? `<span class="tc-agent">${esc(aname(t.agent))}</span>` : '<span class="tc-agent none">unassigned</span>'}
        ${t.project ? (t.projectUrl
          ? `<a class="proj-chip" href="${escAttr(t.projectUrl)}" target="_blank" rel="noopener" title="${escAttr(t.projectUrl)}">◈ ${esc(t.project)} ↗</a>`
          : `<span class="proj-chip still">◈ ${esc(t.project)}</span>`) : ''}
        ${t.jobs && t.jobs.length ? `<span class="tc-jobs" title="agent dispatches">↻ ${t.jobs.length}</span>` : ''}
        ${pool ? `<span class="tc-pool${pool.inFlight ? ' live' : ''}" title="${pool.units} verified · ${pool.inFlight} still out · ${pool.contributors} machine(s)">⚙ ${pool.inFlight ? `${pool.inFlight} out` : `${pool.units} verified`}${pool.units && pool.inFlight ? ` · ${pool.units} done` : ''} · ${pool.contributors} machine${pool.contributors === 1 ? '' : 's'}</span>` : ''}
      </div>
      ${t.body ? `<div class="tc-body">${esc(String(t.body))}</div>` : ''}

      <div class="tc-acts" data-acts="${t.id}" hidden>
        <select class="sel-mini" data-tagent="${t.id}">
          <option value="">— assign —</option>
          ${relayFleet().map((f) => `<option value="${f.id}" ${t.agent === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
        </select>
        <select class="sel-mini" data-tstatus="${t.id}">
          ${BOARD_COLS.map((c) => `<option value="${c.id}" ${t.status === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
        <button class="mini go" data-tdispatch="${t.id}" title="Hand this to its agent now">▷ Run</button>
        <button class="mini pool" data-tpool="${t.id}" title="Send this to the compute commons as verified work units">⚙ To the pool</button>
        <button class="mini" data-tdel="${t.id}" title="Delete">✕</button>
      </div>

      ${t.jobs && t.jobs.length ? `<div class="tc-last expandable" data-body="${escAttr(t.jobs[0].note || '')}" data-rtitle="${escAttr(t.title)}" data-rsub="last dispatch · ${esc(t.jobs[0].ts)}">
        <span class="tc-lbl">${t.jobs[0].ok ? '✓' : '⚠'} ${esc(aname(t.jobs[0].agent))} · ${ago(t.jobs[0].ts)} ago</span><span class="tc-note">${esc(t.jobs[0].note || '')}</span>
        <button class="mini read" data-read="1">⤢ read full</button></div>` : ''}
    </div>`;
  };

  const completedRows = Object.entries(b.completed || {}).filter(([, v]) => v.length).map(([ag, rows]) => `
    <div class="cmp-agent">
      <div class="cmp-head tone-${TONE[ag] || 'slate'}"><span class="cmp-orb"></span>${esc(aname(ag))}
        <span class="cmp-n">${rows.length} finished</span></div>
      ${capList('cmp-' + ag, rows, (x) => `
        <div class="cmp-row ${x.ok ? '' : 'bad'} expandable" data-body="${escAttr(x.focus || '')}" data-rtitle="${escAttr(aname(ag) + ' · ' + x.ts)}" data-rsub="${x.ok ? 'completed' : 'faulted'} · ${Math.round(x.latency)}s">
          <span class="cmp-when mono">${esc(fmtDT2(x.ts))}</span>
          <span class="cmp-focus">${esc(x.focus || '—')}</span>
          <span class="cmp-meta mono">${x.latency ? Math.round(x.latency) + 's' : ''} ${x.tokens ? '· ' + compact(x.tokens) : ''}</span>
        </div>`)}
    </div>`).join('');

  const w = BOARD.work || {};
  const wq = w.queue || {};
  // parked cards leave the columns; the WIP limit is his, default five
  const wip = Math.max(1, parseInt(b.wipLimit, 10) || 5);
  const parked = tasks.filter((t) => (t.tags || []).includes('parked') && t.status !== 'done');
  const live = tasks.filter((t) => !parked.includes(t));
  const active = live.filter((t) => t.status === 'active').length;
  const open = live.filter((t) => t.status !== 'done').length;
  const highOpen = live.filter((t) => t.status !== 'done' && String(t.priority) === '1').length;

  setHTML($('#boardBody'), `
    <div class="view-head"><h2>Board</h2>
      <p class="view-desc">Your work, the fleet's, and the commons' — on one screen. A task can go to an agent, or out to the pool as verified work units.</p></div>

    ${(() => {
      // ⚠ auto-work read ON and did nothing, forever, in silence — because
      // none of his 49 tasks were handed to the fleet. A governed engine that
      // declines to act must say which gate it stopped at, and how to open it.
      const w = b.autoWhy;
      if (!w || !w.idle) return '';
      const aw = (b.autoWork || {});
      if (!aw.on) return '';
      return '<div class="aw-why"><span class="awk">⚑ AUTO-WORK IS ON BUT IDLE</span>'
        + '<span class="awt">' + esc(w.why) + '</span>'
        + (w.fix ? '<span class="awf">→ ' + esc(w.fix) + '</span>' : '') + '</div>';
    })()}
    <!-- ═══ THE READINGS — same grammar as Live, Workflows and Output ═══
         The fifth is the one that does not flatter us: a task nobody has
         touched in a fortnight is not "open", it is stuck, and a board that
         cannot say so slowly becomes a list you stop reading. -->
    <div class="st-strip n5">
      <div class="st-si ${open ? '' : 'go'}"><b>${open}</b><i>open right now</i></div>
      <div class="st-si ${active > wip ? 'zero' : active ? 'live' : ''}"><b>${active}<span class="st-of">/${wip}</span></b><i>${active > wip ? 'in motion, over your WIP limit of ' + wip : active ? 'in motion · WIP limit ' + wip : 'nothing in motion'}</i></div>
      <div class="st-si ${highOpen ? 'zero' : ''}"><b>${highOpen}</b><i>high priority, still open</i></div>
      <div class="st-si ${(wq.open || 0) + (wq.verifying || 0) ? 'go' : ''}"><b>${(wq.open || 0) + (wq.verifying || 0)}</b><i>units out to the pool</i></div>
      ${(() => {
        const cut = Date.now() - 14 * 864e5;
        const stale = live.filter((t) => t.status !== 'done' && (Date.parse(t.updated || t.created) || 0) < cut).length;
        return '<div class="st-si ' + (stale ? 'zero' : '') + '"><b>' + stale + '</b><i>' +
          (stale ? 'untouched 14+ days — stuck, not open' : 'nothing has gone stale') + '</i></div>';
      })()}
    </div>
    ${(() => {
      // THE FLOW LINE — the board's own close rate, from the rhythm reading
      const f = b.flow;
      if (!f) return '';
      const clears = f.clearDays == null ? 'nothing has closed in 28 days, so there is no pace to clear at' : 'at this pace the board clears in about ' + f.clearDays + ' days';
      const lever = f.clearDays != null && f.clearDays > 30 ? ' · <b>closing is the lever</b>' : '';
      return '<div class="bd-flow">' + clears + ' · ' + f.done7 + ' closed this week · median lead ' + (f.leadMedDays ? f.leadMedDays + ' d' : '—') + lever + '</div>';
    })()}
    ${(() => {
      const s = b.sweep;
      if (!s || !s.count) return '';
      return '<div class="bd-sweep"><span>' + s.count + ' task' + (s.count === 1 ? '' : 's') + ' untouched for ' + s.days + '+ days. Parking folds them under the board at low priority; nothing is deleted.</span>'
        + '<button class="mini" id="bdSweep">park ' + s.count + '</button></div>';
    })()}
    ${(() => {
      // THE CLOSE — the hand on the lever the reading named. Three decisions,
      // chosen from what the ledger already knows, one press each.
      const cl = b.close || [];
      if (!cl.length) return '';
      const kindWord = { claimed: 'claimed done', waiting: 'waiting too long', stuck: 'in motion too long', oldest: 'oldest high priority' };
      return '<div class="bd-close"><div class="bd-close-h"><b>The close</b><span>' + cl.length + ' decision' + (cl.length === 1 ? '' : 's') + ' worth making today · closing is the lever</span></div>'
        + cl.map((c) => '<div class="bd-cl"><div><div class="bcl-t">' + esc(c.title) + '</div><span class="bcl-w">' + esc(kindWord[c.kind] || c.kind) + ' · ' + esc(c.why) + '</span></div>'
          + '<div class="bcl-a"><button class="mini go" data-closeact="done" data-close="' + c.id + '">✓ done</button><button class="mini" data-closeact="park" data-close="' + c.id + '">park</button><button class="mini" data-closeact="keep" data-close="' + c.id + '">keep</button></div></div>').join('')
        + '</div>';
    })()}
    ${(() => {
      const nx = b.nexts || [];
      if (!nx.length) return '';
      return '<details class="bd-nexts" open><summary>From the loops · ' + nx.length + ' proposed next move' + (nx.length === 1 ? '' : 's') + '</summary>'
        + nx.map((n) => '<div class="bd-next"><div class="bn-t">' + esc(n.text) + '</div><div class="bn-m"><span class="mono">' + esc(n.loop) + ' · ' + esc(aname(n.agent)) + ' · ' + ago(n.ts) + ' ago</span>'
          + '<button class="mini go" data-nextact="add" data-next="' + n.id + '">+ board</button><button class="mini" data-nextact="dismiss" data-next="' + n.id + '">✕</button></div></div>').join('')
        + '</details>';
    })()}

    <!-- ═══ AUTO-WORK — the board runs its own fleet-owned queue ═══ -->
    <div class="bd-auto glass ${(b.autoWork || {}).on ? 'armed' : ''}">
      <div class="bd-auto-core">
        <button class="bd-auto-toggle ${(b.autoWork || {}).on ? 'on' : ''}" id="awToggle">
          <span class="bd-auto-orb"></span>${(b.autoWork || {}).on ? 'AUTO-WORK ON' : 'AUTO-WORK OFF'}
        </button>
        <div class="bd-auto-meta">
          ${(b.autoWork || {}).on
            ? ((b.autoWork || {}).current
              ? `<b>working a task right now</b> — one at a time, ${b.autoWork.ran}/${b.autoWork.perDay} today`
              : (b.autoWork || {}).next
                ? `next up: <b>${esc(b.autoWork.next)}</b> · ${b.autoWork.ran}/${b.autoWork.perDay} today`
                : `queue clear — mark a task <b>⇄ fleet</b> and it gets picked up · ${b.autoWork.ran}/${b.autoWork.perDay} today`)
            : 'When on, the fleet works through every task you mark <b>⇄ fleet</b> — one at a time, capped per day, honouring the stop button and the budget governor.'}
        </div>
        ${(b.autoWork || {}).on && (b.autoWork || {}).next && !(b.autoWork || {}).current ? '<button class="mini go" id="awRunNow">▷ next now</button>' : ''}
      </div>
      ${((b.autoWork || {}).log || []).length ? `<div class="bd-auto-log">${b.autoWork.log.slice(0, 3).map((l) => `<div class="bd-auto-l ${l.ok ? '' : 'bad'}">${l.ok ? '✓' : '⚠'} <span>${esc(l.title)}</span><span class="mono">${esc(fmtDT2(l.ts))}</span></div>`).join('')}</div>` : ''}
    </div>

    <!-- capture is one press away, not a permanently open form taking the top
         of the screen. The board is for looking at; capture is for doing. -->
    <details class="bd-capture" id="bdCapture">
      <summary>✚ Capture a task</summary>
      <div class="newtask">
        <input id="ntTitle" placeholder="What needs to happen?   (@davara  !high  #tag  due:fri  fleet:)" spellcheck="true" />
        <textarea id="ntBody" rows="2" placeholder="Detail, acceptance criteria, links… (optional)" spellcheck="true"></textarea>
        <div class="nt-row">
          <select id="ntOwner" class="sel" title="who works it"><option value="mine" selected>◈ mine — I work it</option><option value="fleet">⇄ fleet — they auto-work it</option></select>
          <select id="ntAgent" class="sel"><option value="">— unassigned —</option>${relayFleet().map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
          <select id="ntPrio" class="sel"><option value="1">high</option><option value="2" selected>normal</option><option value="3">low</option></select>
          <button class="prime-btn" id="ntAdd">+ Add to board</button>
          <label class="nt-wip" title="how many tasks may be in motion at once">WIP limit <input type="number" id="ntWip" min="1" max="20" value="${wip}" /></label>
        </div>
      </div>
    </details>

    <div class="board">
      ${BOARD_COLS.map((c) => {
        const items = live.filter((t) => t.status === c.id);
        const overWip = c.id === 'active' && items.length > wip;
        return `<div class="bcol${c.id === 'done' ? ' quiet' : ''}${overWip ? ' over-wip' : ''}">
          <div class="bcol-head"><span class="bc-t">${c.label}</span><span class="bc-n">${items.length}${c.id === 'active' ? '<span class="bc-wip">/' + wip + '</span>' : ''}</span><span class="bc-h">${overWip ? 'over the WIP limit: finish one before starting another' : c.hint}</span></div>
          <div class="bcol-body">${items.map(card).join('') || `<div class="bcol-empty">nothing here</div>`}</div>
        </div>`;
      }).join('')}
    </div>

    ${parked.length ? `<details class="bd-parked">
      <summary>Parked · ${parked.length} · cold for three weeks or more, kept at low priority</summary>
      ${parked.map((t) => `<div class="bd-park"><span class="bp-t">${esc(t.title)}</span><span class="mono">${esc(t.status)} · parked ${ago(t.parkedAt || t.updated)} ago</span>
        <button class="mini" data-tunpark="${t.id}">↩ back on the board</button><button class="mini" data-tdel="${t.id}">✕</button></div>`).join('')}
    </details>` : ''}

    <details class="bd-fleet">
      <summary>What the fleet actually finished — every completed job, per agent</summary>
      ${completedRows || '<div class="empty">No completed jobs on record yet.</div>'}
    </details>`);

  // auto-work controls
  const awT = $('#awToggle');
  if (awT) awT.onclick = async () => {
    const on = !awT.classList.contains('on');
    if (on && !$('#ntAgent')) { /* board is always loaded here */ }
    const r = await C.autoWork({ on });
    toast(r && r.ok ? (on ? 'Auto-work armed — the fleet owns its queue now' : 'Auto-work stood down') : 'could not switch', r && r.ok ? 'good' : 'bad');
    loadBoard();
  };
  const awR = $('#awRunNow');
  if (awR) awR.onclick = async () => { awR.disabled = true; await C.autoWork({ runNow: true }); toast('Picking up the next fleet task…', 'good'); setTimeout(loadBoard, 800); };
  // owner toggle on every card — one click moves a task between his lane and theirs
  $$('#boardBody [data-towner]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.towner;
    const toFleet = !btn.classList.contains('fleet');
    const r = await C.taskUpdate(id, { owner: toFleet ? 'fleet' : 'mine' });
    if (r && r.ok && toFleet && !r.task.agent) toast('Fleet-owned — assign an agent so auto-work can pick it up', 'warn');
    else toast(r && r.ok ? (toFleet ? 'Handed to the fleet queue' : 'Taken back — yours again') : 'could not change owner', r && r.ok ? 'good' : 'bad');
    loadBoard();
  });

  const add = $('#ntAdd');
  if (add) add.onclick = async () => {
    const title = $('#ntTitle').value.trim();
    if (!title) { toast('Give the task a title', 'bad'); return; }
    const owner = $('#ntOwner') ? $('#ntOwner').value : 'mine';
    if (owner === 'fleet' && !$('#ntAgent').value) { toast('A fleet task needs an agent — pick who works it', 'warn'); return; }
    const res = await C.taskCreate({ title, body: $('#ntBody').value, agent: $('#ntAgent').value, priority: $('#ntPrio').value, owner });
    if (res && res.ok) { $('#ntTitle').value = ''; $('#ntBody').value = ''; toast(owner === 'fleet' ? 'On the fleet queue ⇄' : 'Added to board ✓', 'good'); loadBoard(); }
    else toast('Could not add: ' + ((res && res.error) || '?'), 'bad');
  };
  // ── v3.54 · flow controls: WIP limit, the sweep, the loops' tray, parked cards ──
  const wipIn = $('#ntWip');
  if (wipIn) wipIn.onchange = async () => {
    const v = Math.max(1, Math.min(20, parseInt(wipIn.value, 10) || 5));
    await C.saveSettings({ wipLimit: v });
    toast('WIP limit is ' + v + ' now', 'good'); loadBoard();
  };
  const sw = $('#bdSweep');
  if (sw) sw.onclick = async () => {
    const s = b.sweep || {};
    if (!confirm('Park ' + s.count + ' task(s) untouched for ' + s.days + '+ days?\n\nThey fold under the board at low priority and come back with one click. Nothing is deleted, and nothing in motion or at high priority is touched.')) return;
    const r = await C.taskSweep({ apply: true });
    toast(r && r.ok ? 'Parked ' + r.count : 'could not sweep', r && r.ok ? 'good' : 'bad'); loadBoard();
  };
  $$('#boardBody [data-closeact]').forEach((btn) => btn.onclick = async () => {
    const r = await C.closeAct(btn.dataset.close, btn.dataset.closeact);
    if (r && r.ok) toast(btn.dataset.closeact === 'done' ? 'Closed' : btn.dataset.closeact === 'park' ? 'Parked' : 'Kept, for now', 'good');
    else toast((r && r.error) || 'could not act', 'bad');
    loadBoard();
  });
  $$('#boardBody [data-nextact]').forEach((btn) => btn.onclick = async () => {
    const r = await C.duoNextAct(btn.dataset.next, btn.dataset.nextact);
    if (r && r.ok) toast(btn.dataset.nextact === 'add' ? 'On the board' : 'Dismissed', 'good');
    else toast((r && r.error) || 'could not act', 'bad');
    loadBoard();
  });
  $$('#boardBody [data-tunpark]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.tunpark;
    const t = tasks.find((x) => x.id === id);
    await C.taskUpdate(id, { tags: (t && t.tags ? t.tags : []).filter((x) => x !== 'parked'), priority: 2 });
    toast('Back on the board', 'good'); loadBoard();
  });
  $$('#boardBody [data-tagent]').forEach((s) => s.onchange = async () => { await C.taskUpdate(s.dataset.tagent, { agent: s.value }); loadBoard(); });
  $$('#boardBody [data-tstatus]').forEach((s) => s.onchange = async () => { await C.taskUpdate(s.dataset.tstatus, { status: s.value }); loadBoard(); });
  $$('#boardBody [data-tdel]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('Delete this task from the board?')) return;
    await C.taskDelete(btn.dataset.tdel); toast('Deleted', 'good'); loadBoard();
  });
  $$('#boardBody [data-tdispatch]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.tdispatch;
    btn.disabled = true; btn.textContent = '… running';
    const res = await C.taskDispatch(id);
    btn.disabled = false; btn.textContent = '▷ Run';
    if (res && res.ok) toast('Agent picked it up ✓', 'good');
    else toast('Dispatch failed: ' + ((res && res.error) || '?'), 'bad');
    loadBoard();
  });

  // ── actions live behind one press, so the card stays scannable ──
  $$('#boardBody [data-tmore]').forEach((btn) => btn.onclick = () => {
    const acts = document.querySelector(`[data-acts="${btn.dataset.tmore}"]`);
    if (!acts) return;
    const showing = !acts.hidden;
    // only one card's actions open at a time — otherwise the board becomes the
    // same wall of controls this rebuild removed
    $$('#boardBody [data-acts]').forEach((a) => { a.hidden = true; });
    $$('#boardBody [data-tmore]').forEach((b2) => b2.classList.remove('on'));
    if (showing) return;
    acts.hidden = false;
    btn.classList.add('on');
  });

  // ── send a task to the compute commons ──
  $$('#boardBody [data-tpool]').forEach((btn) => btn.onclick = async () => {
    const id = btn.dataset.tpool;
    const card2 = document.querySelector(`[data-task="${id}"]`);
    const title = (card2 && card2.querySelector('.tc-title')?.textContent) || '';
    const body = (card2 && card2.querySelector('.tc-body')?.textContent) || '';
    if (!confirm(`Send "${title}" to the compute commons?\n\nIt becomes public work units computed by strangers' machines and served to anyone who asks.\n\n⚠ PUBLIC WORK ONLY — the secret-shape gate refuses key-like content, but the rule is yours to keep.`)) return;
    btn.disabled = true; btn.textContent = '… sending';
    const r = await C.workEnqueue({ task: title, text: body || title, kind: 'embed' });
    btn.disabled = false; btn.textContent = '⚙ To the pool';
    if (r && r.ok) {
      const res = r.res || {};
      toast(`${res.enqueued} unit(s) out · ${res.canaries} canary${r.held ? ` · ${r.held} held by the gate` : ''}`, 'good');
      loadBoard();
    } else {
      // the refusal IS the feature — say exactly why
      toast((r && r.error) || (r && r.res && r.res.error) || 'the pool refused it', 'bad');
    }
  });
}
// keep the old name working for any legacy call site
async function loadTasks() { return loadBoard(); }

/* ============================================================== SUBAGENTS VIEW
   The fan-out layer made visible: who spawned what, what it is doing, what it
   produced — read straight from the transcripts, plus a spawner.               */
async function loadSubagents() {
  const r = await C.subagents(CUR.subAgent);
  if (!r || r.error) return viewFail('subagents', r || null);
  const items = r.items || [];
  const stateCls = { running: 'run', done: 'ok', failed: 'bad', ended: 'end' };
  const stateLbl = { running: 'running now', done: 'complete', failed: 'failed', ended: 'ended with the turn' };

  setHTML($('#subBody'), `
    <div class="view-head"><h2>Subagents</h2>
      <p class="view-desc">Davara and Davaris can fan out into parallel subagents. This is what they spawned, what each one worked on, and what it handed back.</p></div>
    <div class="panel glass">
      <div class="panel-head"><h3>Fan out a fleet</h3><span class="panel-sub">one goal → several subagents, working in parallel</span></div>
      <div class="spawner">
        <textarea id="spGoal" rows="2" placeholder="The goal to fan out on — e.g. “Audit the relay path for every single point of failure and rank fixes by leverage.”" spellcheck="true"></textarea>
        <div class="sp-row">
          <select id="spAgent" class="sel">${relayFleet().filter((f) => f.coder).map((f) => `<option value="${f.id}" ${f.id === 'davara' ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
          <select id="spCount" class="sel">${[2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n} subagents</option>`).join('')}</select>
          <input id="spLenses" class="txt" placeholder="lenses, comma-separated (correctness, security, performance…)" />
          <button class="prime-btn" id="spGo">✦ Spawn fleet</button>
        </div>
        <div class="sp-note">The parent agent spawns these with its own Task tool and synthesizes the results. Each subagent gets a self-contained prompt and a distinct lens so they are not redundant.</div>
      </div>
    </div>
    <div class="sub-tabs">
      <button class="chip ${CUR.subAgent === 'all' ? 'on' : ''}" data-sa="all">All parents</button>
      ${(r.byParent || []).filter((p) => p.total).map((p) => `<button class="chip ${CUR.subAgent === p.agent ? 'on' : ''}" data-sa="${p.agent}">${esc(p.name)} · ${p.total}${p.running ? ` <span class="live-dot"></span>` : ''}</button>`).join('')}
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Observed subagents</h3>
        <span class="panel-sub">${items.length} on record${r.running ? ` · ${r.running} running now` : ''}</span></div>
      ${items.length ? capList('subs', items, (s) => `
        <div class="sacard ${stateCls[s.status] || ''} expandable" data-body="${escAttr((s.prompt ? 'GIVEN:\n' + s.prompt + '\n\n' : '') + (s.output ? 'RETURNED:\n' + s.output : ''))}" data-rtitle="${escAttr(s.title)}" data-rsub="${esc(aname(s.parent))} → ${esc(s.kind)} · ${stateLbl[s.status] || s.status}">
          <div class="sa-top">
            <span class="sa-state">${s.status === 'running' ? '<span class="live-dot"></span> ' : ''}${stateLbl[s.status] || s.status}</span>
            <span class="sa-parent tone-${TONE[s.parent] || 'slate'}">${esc(aname(s.parent))}</span>
            <span class="sa-kind mono">${esc(s.kind)}</span>
            <span class="sa-meta mono">${s.durationMs ? fmtDur(s.durationMs) : s.status === 'running' ? 'in flight' : '—'}${s.outChars ? ` · ${compact(s.outChars)} chars` : ''}</span>
          </div>
          <div class="sa-title">${esc(s.title)}</div>
          ${s.prompt ? `<div class="sa-prompt"><span class="sa-lbl">Given</span>${esc(s.prompt)}</div>` : ''}
          ${s.output ? `<div class="sa-out"><span class="sa-lbl">Returned</span>${esc(s.output)}
            <button class="mini read" data-read="1">⤢ read full</button></div>` : ''}
        </div>`) : `<div class="empty">No subagents on record yet. Fan out a fleet above and they will appear here as they spawn — including what each one is working on while it runs.</div>`}
    </div>
    ${(r.persisted || []).length ? `<div class="panel glass">
      <div class="panel-head"><h3>Fan-out history</h3><span class="panel-sub">the syntheses your spawns produced</span></div>
      ${capList('subhist', r.persisted, (h) => `
        <div class="sahist expandable" data-body="${escAttr(h.synthesis || '')}" data-rtitle="${escAttr(h.goal)}" data-rsub="${esc(aname(h.parent))} · ${h.count} subagents · ${esc(h.ts)}">
          <div class="sh-top"><span class="sh-parent tone-${TONE[h.parent] || 'slate'}">${esc(aname(h.parent))}</span>
            <span class="sh-n">${h.count} subagents</span><span class="sh-when mono">${ago(h.ts)} ago</span>
            <span class="sh-st ${h.ok ? 'ok' : 'bad'}">${h.ok ? '✓' : '⚠'}</span></div>
          <div class="sh-goal">${esc(h.goal)}</div>
          <div class="sh-syn">${esc(h.synthesis || '')}
            <button class="mini read" data-read="1">⤢ read full</button></div>
        </div>`)}
    </div>` : ''}`);

  $$('#subBody [data-sa]').forEach((b) => b.onclick = () => { CUR.subAgent = b.dataset.sa; loadSubagents(); });
  const go = $('#spGo');
  if (go) go.onclick = async () => {
    const goal = $('#spGoal').value.trim();
    if (!goal) { toast('Give the fleet a goal', 'bad'); return; }
    const lenses = $('#spLenses').value.split(',').map((s) => s.trim()).filter(Boolean);
    go.disabled = true; go.textContent = '… fanning out';
    const res = await C.spawnSubagents({ agent: $('#spAgent').value, goal, count: $('#spCount').value, lenses });
    go.disabled = false; go.textContent = '✦ Spawn fleet';
    if (res && res.ok) { toast('Fleet ran ✓ — synthesis below', 'good'); $('#spGoal').value = ''; }
    else toast('Fan-out failed: ' + ((res && res.error) || '?'), 'bad');
    loadSubagents();
  };
}

/* ========================================================= WORKFLOWS / MOTUS
   Progressions between agents: staged handoffs where each stage builds on the
   previous one's output, with parallel fan-out inside a stage.                 */
/* ── THE WORKFLOW STRIP ────────────────────────────────────────────────────
   Workflows was the last major surface still answering "what is going on here?"
   with a scroll. These five readings answer it before he reads anything: how
   much structure exists, how much of it runs itself, whether something is
   moving right now, and — the one that does not flatter us — whether the last
   run actually finished. A run that BLOCKED is the most useful thing on this
   screen, so it is never softened into "3 runs". */
function wfStrip(r) {
  const ws = r.workflows || [];
  const runs = r.runs || [];
  const running = (r.running || []).length;
  const armed = ws.filter((w) => w.trigger && w.trigger.on && w.trigger.armed).length;
  const totalRuns = ws.reduce((n, w) => n + (w.runs || 0), 0);
  const last = runs.find((x) => x.status !== 'running');
  const bad = last && ['failed', 'blocked', 'stopped'].includes(last.status);
  const cell = (cls, big, sub) => '<div class="st-si ' + cls + '"><b>' + big + '</b><i>' + sub + '</i></div>';
  return '<div class="st-strip n5">'
    + cell(ws.length ? 'go' : 'zero', ws.length, ws.length ? 'progressions encoded' : 'no structure encoded yet')
    + cell(armed ? 'go' : '', armed, armed ? 'armed — these run themselves' : 'none run without you')
    + cell(running ? 'live' : '', running, running ? 'running right now' : 'nothing in flight')
    + cell(bad ? 'zero' : '', last ? esc(last.status) : '—',
        last ? 'last run' + (last.blockedAt ? ' · blocked at ' + esc(last.blockedAt) : '') + ' · ' + fmtDT2(last.started) : 'never run')
    + cell('', totalRuns, 'runs all time')
    + '</div>';
}
/* ── THE LIVE RUN TICKER ───────────────────────────────────────────────────
   The same instrument the Motus Max stage got: while a progression is moving,
   say WHICH STAGE it is on and who is holding it, without making him open the
   run history and read. A stage rail, the live one pulsing. */
function wfTicker(r) {
  const live = (r.runs || []).filter((x) => x.status === 'running');
  if (!live.length) return '';
  return live.map((run) => {
    const steps = run.steps || [];
    const cur = steps.filter((x) => x.status === 'running').slice(-1)[0] || steps.slice(-1)[0];
    const who = cur && (cur.results || []).map((x) => aname(x.agent)).filter(Boolean);
    const done = steps.filter((x) => x.status === 'done' || x.status === 'ok').length;
    return '<div class="wf-ticker">'
      + '<div class="wtk-head"><span class="live-dot"></span><b>' + esc(run.name) + '</b>'
      + '<span class="wtk-when mono">started ' + fmtDT2(run.started) + ' · ' + ago(run.started) + ' ago</span></div>'
      + '<div class="wtk-rail">' + steps.map((x) => '<span class="wtk-seg ' + esc(x.status) + '" title="' + escAttr(x.stage) + '"></span>').join('') + '</div>'
      + '<div class="wtk-now">' + (cur
        ? '<b>' + esc(cur.stage) + '</b>' + (who && who.length ? ' — ' + esc(who.join(', ')) : '') + ' <i>stage ' + (done + 1) + ' of ' + steps.length + '</i>'
        : '<i>starting…</i>') + '</div>'
      + '</div>';
  }).join('');
}
async function loadWorkflows() {
  const r = await C.workflows();
  if (!r || r.error) return viewFail('workflows', r || null);
  const relay = r.fleet || relayFleet();
  const editing = CUR.wfEdit;

  const stageEditor = (s, i) => `
    <div class="wfs" data-si="${i}">
      <div class="wfs-n">${i + 1}</div>
      <input class="txt wfs-name" placeholder="Stage name" value="${escAttr(s.name || '')}" />
      <div class="wfs-agents">${relay.map((f) => `<button class="mini ${(s.agents || []).includes(f.id) ? 'on tone-' + (TONE[f.id] || 'slate') : ''}" data-wfa="${i}:${f.id}">${esc(f.name)}</button>`).join('')}
        <button class="mini gate ${s.gate ? 'on' : ''}" data-wfgate="${i}" title="A gate stage can BLOCK the run: its agents answer VERDICT: PASS or BLOCK, and a block stops the progression and puts the reason on your board.">⛨ gate</button></div>
      <textarea class="wfs-inst" rows="2" placeholder="What this stage must do…" spellcheck="true">${esc(s.instruction || '')}</textarea>
      <button class="mini danger" data-wfdel-stage="${i}">✕</button>
    </div>`;

  setHTML($('#wfBody'), `
    <div class="view-head"><h2>Workflows <span class="h2-sub">MotusModels</span></h2>
      <p class="view-desc">Compose progressions between agents. Each stage receives the previous stage's output, so work <b>compounds</b> down the chain instead of restarting. Put several agents in one stage and they run in parallel.</p></div>

    ${wfStrip(r)}
    ${wfTicker(r)}

    ${editing ? `
    <div class="panel glass wf-editor">
      <div class="panel-head"><h3>${editing.id && r.workflows.some((w) => w.id === editing.id) ? 'Edit' : 'New'} workflow</h3>
        <button class="mini" id="wfCancel">✕ cancel</button></div>
      <input class="txt big" id="wfName" placeholder="Workflow name" value="${escAttr(editing.name || '')}" />
      <textarea class="txt" id="wfIntent" rows="2" placeholder="What is this progression FOR? (given to every stage as context)" spellcheck="true">${esc(editing.intent || '')}</textarea>
      <div class="wfs-list">${(editing.stages || []).map(stageEditor).join('')}</div>
      <div class="wf-trigger">
        <div class="wt-h">⚡ Run itself when…<span class="wt-sub">leave off to run only when you press Run</span></div>
        <div class="wt-row">
          <select id="wfTrigOn" class="sel">
            <option value="" ${!(editing.trigger && editing.trigger.on) ? 'selected' : ''}>— manual only —</option>
            <option value="fault" ${editing.trigger && editing.trigger.on === 'fault' ? 'selected' : ''}>an agent faults</option>
            <option value="task" ${editing.trigger && editing.trigger.on === 'task' ? 'selected' : ''}>a task lands on the board</option>
            <option value="duo" ${editing.trigger && editing.trigger.on === 'duo' ? 'selected' : ''}>Duo-Drive finishes a pass</option>
          </select>
          <input id="wfTrigMatch" class="txt" placeholder="only if it mentions… (optional)" value="${escAttr((editing.trigger && editing.trigger.match) || '')}" />
          <select id="wfTrigCool" class="sel">
            ${[15, 30, 60, 120, 360, 720].map((n) => `<option value="${n}" ${(editing.trigger && editing.trigger.cooldownMin) === n ? 'selected' : (!(editing.trigger && editing.trigger.cooldownMin) && n === 60 ? 'selected' : '')}>at most every ${n < 60 ? n + 'm' : (n / 60) + 'h'}</option>`).join('')}
          </select>
          <button class="mini ${editing.trigger && editing.trigger.armed ? 'on' : ''}" id="wfTrigArm">${editing.trigger && editing.trigger.armed ? '● armed' : '○ disarmed'}</button>
        </div>
      </div>
      <div class="wf-ed-act">
        <button class="ghost-btn" id="wfAddStage">+ Add stage</button>
        <button class="prime-btn" id="wfSave">Save workflow</button>
      </div>
    </div>` : `
    <div class="wf-top">
      <button class="prime-btn" id="wfNew">+ New workflow</button>
      <span class="wf-seedlbl">or start from a proven progression:</span>
      ${(r.seeds || []).map((s, i) => `<button class="ghost-btn" data-wfseed="${i}">${esc(s.name)}</button>`).join('')}
    </div>`}

    <div class="panel glass">
      <div class="panel-head"><h3>Your workflows</h3><span class="panel-sub">${(r.workflows || []).length} defined</span></div>
      ${(r.workflows || []).length ? (r.workflows || []).map((w) => `
        <div class="wfcard ${(r.running || []).includes(w.id) ? 'running' : ''}">
          <div class="wf-h">
            <div><div class="wf-name">${esc(w.name)}</div>${w.intent ? `<div class="wf-intent">${esc(w.intent)}</div>` : ''}</div>
            <div class="wf-act">
              ${(r.running || []).includes(w.id) ? `<span class="wf-live"><span class="live-dot"></span> running</span>` : `<button class="mini go" data-wfrun="${w.id}">▷ Run</button>`}
              <button class="mini" data-wfedit="${w.id}">✎</button>
              <button class="mini danger" data-wfdel="${w.id}">✕</button>
            </div>
          </div>
          <div class="wf-chain">${(w.stages || []).map((s, i) => `
            <div class="wf-stage">
              <div class="ws-n">${i + 1}</div>
              <div class="ws-name">${esc(s.name)}</div>
              <div class="ws-agents">${(s.agents || []).map((a) => `<span class="chip-tiny tone-${TONE[a] || 'slate'}">${esc(aname(a))}</span>`).join('')}</div>
              ${(s.agents || []).length > 1 ? '<div class="ws-par">parallel</div>' : ''}
            </div>${i < (w.stages || []).length - 1 ? '<div class="wf-arrow">→</div>' : ''}`).join('')}
          </div>
          <div class="wf-foot">${w.runs || 0} run${(w.runs || 0) === 1 ? '' : 's'}
            ${w.trigger && w.trigger.on && w.trigger.armed
              ? `<span class="wf-trig on">⚡ auto: on ${esc({ fault: 'a fault', task: 'a new task', duo: 'a Duo pass' }[w.trigger.on] || w.trigger.on)}${w.trigger.match ? ` mentioning “${esc(w.trigger.match)}”` : ''} · max every ${w.trigger.cooldownMin}m</span>`
              : w.trigger && w.trigger.on ? `<span class="wf-trig">⚡ auto-run configured but disarmed</span>` : ''}</div>
        </div>`).join('') : '<div class="empty">No workflows yet. Start from a seed above — they are real, runnable progressions.</div>'}
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Run history</h3><span class="panel-sub">stage by stage, with each agent's output</span></div>
      ${(r.runs || []).length ? capList('wfruns', r.runs, (run) => `
        <div class="wfrun ${run.status}">
          <div class="wr-h"><span class="wr-st ${run.status}">${run.status === 'running' ? '<span class="live-dot"></span> running' : run.status}</span>
            <span class="wr-name">${esc(run.name)}${run.blockedAt ? ` <span class="wr-blocked">⛨ at ${esc(run.blockedAt)}</span>` : ''}</span>
            ${['failed', 'blocked', 'stopped'].includes(run.status) ? `<button class="mini go" data-wfresume="${run.id}">▷ Resume</button>` : ''}
            <span class="wr-when mono">${ago(run.started)} ago${run.durationMs ? ` · ${fmtDur(run.durationMs)}` : ''}</span></div>
          ${(run.steps || []).map((s) => `
            <div class="wr-step">
              <div class="wrs-h"><span class="wrs-st ${s.status}">${s.status}</span><span class="wrs-name">${esc(s.stage)}</span></div>
              ${(s.results || []).map((x) => `
                <div class="wrs-out expandable" data-body="${escAttr(x.text || x.error || '')}" data-rtitle="${escAttr(s.stage + ' · ' + aname(x.agent))}" data-rsub="${x.ok ? 'ok' : 'failed'} · ${Math.round(x.latency || 0)}s">
                  <span class="wrs-agent tone-${TONE[x.agent] || 'slate'}">${esc(aname(x.agent))}</span>
                  <span class="wrs-text">${esc(x.text || x.error || '')}</span>
                  ${x.confidence != null ? `<span class="wrs-conf" title="${escAttr(x.basis || '')}">confidence ${x.confidence}/10</span>` : ''}
                  <button class="mini read" data-read="1">⤢</button>
                </div>`).join('')}
            </div>`).join('')}
        </div>`) : '<div class="empty">No runs yet.</div>'}
    </div>`);

  // --- wiring -------------------------------------------------------------
  const nw = $('#wfNew');
  if (nw) nw.onclick = () => { CUR.wfEdit = { name: '', intent: '', stages: [{ name: 'Stage 1', agents: ['davara'], instruction: '' }] }; loadWorkflows(); };
  $$('#wfBody [data-wfseed]').forEach((b) => b.onclick = () => {
    const s = (r.seeds || [])[+b.dataset.wfseed]; if (!s) return;
    CUR.wfEdit = JSON.parse(JSON.stringify(s)); loadWorkflows();
  });
  const cancel = $('#wfCancel'); if (cancel) cancel.onclick = () => { CUR.wfEdit = null; loadWorkflows(); };
  const readEditor = () => {
    if (!CUR.wfEdit) return null;
    const stages = $$('#wfBody .wfs').map((el) => ({
      name: $('.wfs-name', el).value,
      instruction: $('.wfs-inst', el).value,
      agents: CUR.wfEdit.stages[+el.dataset.si] ? CUR.wfEdit.stages[+el.dataset.si].agents : [],
      gate: CUR.wfEdit.stages[+el.dataset.si] ? !!CUR.wfEdit.stages[+el.dataset.si].gate : false,
    }));
    const on = $('#wfTrigOn') ? $('#wfTrigOn').value : '';
    return {
      id: CUR.wfEdit.id, name: $('#wfName').value, intent: $('#wfIntent').value, stages,
      trigger: {
        on,
        match: $('#wfTrigMatch') ? $('#wfTrigMatch').value : '',
        cooldownMin: $('#wfTrigCool') ? +$('#wfTrigCool').value : 60,
        armed: on ? !!(CUR.wfEdit.trigger && CUR.wfEdit.trigger.armed) : false,
        lastFired: (CUR.wfEdit.trigger && CUR.wfEdit.trigger.lastFired) || 0,
      },
    };
  };
  const addStage = $('#wfAddStage');
  if (addStage) addStage.onclick = () => {
    const cur = readEditor() || CUR.wfEdit;
    cur.stages.push({ name: `Stage ${cur.stages.length + 1}`, agents: ['davaris'], instruction: '' });
    CUR.wfEdit = cur; loadWorkflows();
  };
  $$('#wfBody [data-wfa]').forEach((b) => b.onclick = () => {
    const [i, id] = b.dataset.wfa.split(':');
    const cur = readEditor() || CUR.wfEdit;
    const st = cur.stages[+i]; if (!st) return;
    st.agents = st.agents || [];
    st.agents = st.agents.includes(id) ? st.agents.filter((x) => x !== id) : [...st.agents, id];
    CUR.wfEdit = cur; loadWorkflows();
  });
  $$('#wfBody [data-wfdel-stage]').forEach((b) => b.onclick = () => {
    const cur = readEditor() || CUR.wfEdit;
    cur.stages.splice(+b.dataset.wfdelStage, 1);
    CUR.wfEdit = cur; loadWorkflows();
  });
  const arm = $('#wfTrigArm');
  if (arm) arm.onclick = () => {
    const cur = readEditor() || CUR.wfEdit;
    if (!cur.trigger.on) { toast('Pick an event first', 'bad'); return; }
    cur.trigger.armed = !(CUR.wfEdit.trigger && CUR.wfEdit.trigger.armed);
    CUR.wfEdit = cur; loadWorkflows();
  };
  $$('#wfBody [data-wfgate]').forEach((b) => b.onclick = () => {
    const cur = readEditor() || CUR.wfEdit;
    const st = cur.stages[+b.dataset.wfgate]; if (st) st.gate = !st.gate;
    CUR.wfEdit = cur; loadWorkflows();
  });
  const save = $('#wfSave');
  if (save) save.onclick = async () => {
    const def = readEditor(); if (!def) return;
    if (!def.name.trim()) { toast('Name the workflow', 'bad'); return; }
    const res = await C.workflowSave(def);
    if (res && res.ok) { toast('Workflow saved ✓', 'good'); CUR.wfEdit = null; loadWorkflows(); }
    else toast('Could not save: ' + ((res && res.error) || '?'), 'bad');
  };
  $$('#wfBody [data-wfedit]').forEach((b) => b.onclick = () => {
    const w = (r.workflows || []).find((x) => x.id === b.dataset.wfedit);
    if (w) { CUR.wfEdit = JSON.parse(JSON.stringify(w)); loadWorkflows(); }
  });
  $$('#wfBody [data-wfdel]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this workflow? Run history is kept.')) return;
    await C.workflowDelete(b.dataset.wfdel); toast('Deleted', 'good'); loadWorkflows();
  });
  $$('#wfBody [data-wfrun]').forEach((b) => b.onclick = async () => {
    const seed = prompt('Anything to seed the first stage with? (optional — leave blank to run as defined)') || '';
    // price before paying: a rough input-token estimate + where the 5h window sits
    const est = await C.workflowEstimate(b.dataset.wfrun, seed);
    if (est && est.ok) {
      const budget = est.budget && est.budget.governed
        ? `\nYour 5-hour window: ${Math.round(est.budget.pct * 100)}% of the cap you set.` : '';
      if (!confirm(`Run this workflow?\n\nEstimated prompt cost: ~${compact(est.estTokens)} input tokens (output comes on top).${budget}`)) return;
    }
    b.disabled = true; b.textContent = '… running';
    toast('Workflow started — stages will stream in below', 'good');
    const res = await C.workflowRun(b.dataset.wfrun, seed);
    if (!res || !res.ok) toast('Workflow ended: ' + ((res && res.error) || (res && res.run && res.run.status) || '?'), 'warn');
    else toast('Workflow complete ✓', 'good');
    loadWorkflows();
  });
  $$('#wfBody [data-wfresume]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = '… resuming';
    const res = await C.workflowResume(b.dataset.wfresume);
    toast(res && res.ok ? 'Resumed and finished ✓' : 'Resume: ' + ((res && res.error) || (res && res.run && res.run.status) || '?'), res && res.ok ? 'good' : 'warn');
    loadWorkflows();
  });
}

/* ============================================================ DASH-OPS — VOICE
   Talk to the fleet and hear it answer. Two modes, exactly like DAV-OPS:
     · CALL — continuous. It listens, you speak, it answers aloud, it listens again.
     · PUSH-TO-TALK — hold the key (or the button), speak, release to send.
   Speech-to-text is the browser's own recogniser, so August's voice never leaves
   this machine through us. Only the agent's TEXT reply goes to ElevenLabs, and
   that call is made in the main process so the API key never enters this context. */
const VOICE = { mode: 'idle', rec: null, listening: false, busy: false, audio: null,
  turns: [], partial: '', wantLoop: false, held: false,
  met: [], quick: true, chain: null,
  stream: null, ac: null, meterRAF: 0 };

// v3.3: listening is MediaRecorder + server-side transcription. The Web Speech
// API is present in Electron but its backing service is Chrome-only — it failed
// instantly with `not-allowed`, which is why nothing was ever heard and why call
// mode flickered (an instant error re-triggering the restart handler).
function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof MediaRecorder !== 'undefined');
}
function pickMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
  }
  return '';
}
// One shared mic stream — re-acquiring per utterance is slow and re-prompts.
async function micStream() {
  if (VOICE.stream && VOICE.stream.active) return VOICE.stream;
  VOICE.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return VOICE.stream;
}
function releaseMic() {
  if (VOICE.stream) { try { VOICE.stream.getTracks().forEach((t) => t.stop()); } catch {} VOICE.stream = null; }
  if (VOICE.ac) { try { VOICE.ac.close(); } catch {} VOICE.ac = null; }
}
function voiceStopAudio() {
  VOICE.chain = null;                                    // the tail never plays
  if (VOICE.audio) { try { VOICE.audio.pause(); } catch {} VOICE.audio = null; }
}
function voicePush(role, text, meta) {
  VOICE.turns.unshift({ role, text, meta: meta || '', ts: Date.now() });
  VOICE.turns = VOICE.turns.slice(0, 60);
  renderVoiceLog();
}
// Confirm-tier actions she proposed but is not allowed to run on her own.
function renderVoicePending() {
  const host = $('#vcPending'); if (!host) return;
  const list = VOICE.pending || [];
  host.innerHTML = list.length ? `
    <div class="vc-pend">
      <div class="vp-h">⚑ Waiting on your tap<span>she proposed these; they change configuration, so they do not auto-run</span></div>
      ${list.map((p, i) => `
        <div class="vp-row">
          <div class="vp-what"><b>${esc(p.verb)}</b> — ${esc(p.help || '')}<div class="vp-raw mono">${esc(p.raw)}</div></div>
          <button class="prime-btn" data-vp-ok="${i}">Approve</button>
          <button class="mini" data-vp-no="${i}">Dismiss</button>
        </div>`).join('')}
    </div>` : '';
  $$('#vcPending [data-vp-ok]').forEach((b) => b.onclick = async () => {
    const a = (VOICE.pending || [])[+b.dataset.vpOk]; if (!a) return;
    b.disabled = true; b.textContent = '…';
    const r = await C.approveAction(a);
    voicePush('sys', (r && r.ok ? '✓ ' : '⚠ ') + ((r && r.said) || 'failed'));
    VOICE.pending = (VOICE.pending || []).filter((_, i) => i !== +b.dataset.vpOk);
    renderVoicePending();
    if (r && r.ok && r.view) setTimeout(() => switchView(r.view), 700);
  });
  $$('#vcPending [data-vp-no]').forEach((b) => b.onclick = () => {
    VOICE.pending = (VOICE.pending || []).filter((_, i) => i !== +b.dataset.vpNo);
    renderVoicePending();
  });
}
function renderVoiceLog() {
  const el = $('#vcLog'); if (!el) return;
  el.innerHTML = VOICE.turns.map((t) => `
    <div class="vt ${t.role}">
      <div class="vt-who">${t.role === 'me' ? 'You' : t.role === 'sys' ? '' : esc(t.meta || 'Agent')}</div>
      <div class="vt-text">${esc(t.text)}</div>
    </div>`).join('') || '<div class="vc-empty">Nothing said yet. Hold the button and speak, or start a call.</div>';
}
function setVoiceState(s, label) {
  VOICE.mode = s;
  const orb = $('#vcOrb'), st = $('#vcState');
  if (orb) orb.className = 'vc-orb ' + s;
  if (st) st.textContent = label;
}

// Record one utterance. `autoStop` (call mode) ends it after a beat of silence;
// push-to-talk ends it when the key comes up.
async function startListening({ autoStop = false, onDone } = {}) {
  if (VOICE.listening || VOICE.busy) return;
  // BARGE-IN. Pressing talk while she is speaking used to record OVER her
  // voice — the mic heard her too, and he had to wait her out to be heard
  // cleanly. Interrupting is a normal part of conversation; the instant his
  // intent to speak exists, her audio stops.
  voiceStopAudio();
  if (!voiceSupported()) { toast('No microphone support in this build', 'bad'); return; }
  let stream;
  try { stream = await micStream(); }
  catch (e) {
    setVoiceState('idle', 'microphone blocked');
    voicePush('sys', 'Microphone access was refused: ' + (e && e.name ? e.name : 'unknown') + '. Allow it in Windows → Privacy → Microphone.');
    VOICE.wantLoop = false;
    return;
  }
  const mime = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
  catch { toast('Could not start the recorder', 'bad'); return; }

  const chunks = [];
  VOICE.rec = rec; VOICE.listening = true; VOICE.partial = '';
  setVoiceState('listening', autoStop ? 'listening…' : 'listening — release to send');
  const p = $('#vcPartial'); if (p) p.textContent = '';

  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    VOICE.listening = false;
    stopMeter();
    const blob = new Blob(chunks, { type: mime || 'audio/webm' });
    if (blob.size < 1600) {           // basically silence — don't pay to transcribe it
      setVoiceState(VOICE.wantLoop ? 'listening' : 'idle', VOICE.wantLoop ? 'listening…' : 'ready');
      if (VOICE.wantLoop) startListening({ autoStop: true, onDone });
      return;
    }
    setVoiceState('thinking', 'transcribing…');
    const tStt = performance.now();
    const b64 = await blobToB64(blob);
    const r = await C.transcribe(b64, blob.type);
    VOICE.sttMs = performance.now() - tStt;   // read (and cleared) by voiceSend
    if (!r || !r.ok) {
      setVoiceState('idle', 'ready');
      voicePush('sys', 'Could not transcribe: ' + ((r && r.error) || 'unknown'));
      VOICE.wantLoop = false;         // never spin on a failing transcriber
      return;
    }
    if (onDone) onDone(r.text);
  };
  try { rec.start(); } catch { VOICE.listening = false; return; }
  if (autoStop) startMeter(stream, () => { if (VOICE.listening) stopListening(); });
}
function blobToB64(blob) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onloadend = () => res(String(fr.result).split(',')[1] || '');
    fr.readAsDataURL(blob);
  });
}
// Live level meter → drives the orb AND ends an utterance after ~1.1s of quiet.
function startMeter(stream, onSilence) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    VOICE.ac = new AC();
    const src = VOICE.ac.createMediaStreamSource(stream);
    const an = VOICE.ac.createAnalyser();
    an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    let spoke = false, quietSince = 0;
    const tick = () => {
      if (!VOICE.listening || !VOICE.ac) return;
      an.getByteFrequencyData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
      const level = sum / buf.length;
      const orb = $('#vcOrb');
      if (orb) orb.style.setProperty('--lvl', Math.min(1, level / 42).toFixed(2));
      const now = performance.now();
      if (level > 11) { spoke = true; quietSince = 0; }
      else if (spoke) { if (!quietSince) quietSince = now; else if (now - quietSince > 1100) { onSilence(); return; } }
      VOICE.meterRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch {}
}
function stopMeter() {
  if (VOICE.meterRAF) cancelAnimationFrame(VOICE.meterRAF);
  VOICE.meterRAF = 0;
  if (VOICE.ac) { try { VOICE.ac.close(); } catch {} VOICE.ac = null; }
  const orb = $('#vcOrb'); if (orb) orb.style.removeProperty('--lvl');
}
function stopListening() {
  if (VOICE.rec && VOICE.rec.state === 'recording') { try { VOICE.rec.stop(); } catch {} }
  VOICE.listening = false;
}

/* The thinking clock: "thinking…" with no number teaches him to distrust the
   app; "thinking… 7s" teaches him to trust the number. One interval, always
   cleared, never stacked. */
function vcClock(on) {
  clearInterval(VOICE.clock); VOICE.clock = 0;
  if (!on) return;
  const t0 = performance.now();
  VOICE.clock = setInterval(() => {
    const st = $('#vcState');
    if (st && VOICE.mode === 'thinking') st.textContent = 'thinking… ' + Math.round((performance.now() - t0) / 1000) + 's';
  }, 1000);
}
async function voiceSend(text) {
  if (!text || VOICE.busy) return;
  VOICE.busy = true;
  voiceStopAudio();
  voicePush('me', text);
  setVoiceState('thinking', 'thinking…');
  renderVcStrip();          // the LIVE cell lights when the turn starts, not after
  vcClock(true);
  const agent = ($('#vcAgent') && $('#vcAgent').value) || 'davara';
  /* ⚠ THE DELAY HE FELT, FOUND: the reply's ENTIRE mp3 was synthesized inside
     the voiceTurn handler before anything at all came back — so the text he
     could have been reading sat behind the render of the voice that reads it.
     speak:false returns the words the moment they exist; the voice is fetched
     immediately after and lands while he is already reading. Nothing is lost —
     the same audio plays either way — only the waiting is removed. */
  const t0 = performance.now();
  const sttMs = VOICE.sttMs || 0; VOICE.sttMs = 0;
  /* QUICK MODE (on by default): most of "thought 8s" is her COMPOSING an
     essay nobody asked to hear. Spoken conversation wants a breath, not a
     briefing — and a shorter answer is faster twice: faster to think, faster
     to speak. The instruction travels with the turn, never shown in his
     bubble; switching it off restores full-depth replies. */
  const asked = VOICE.quick !== false
    ? text + '\n\n(Answer OUT LOUD in at most three short sentences. If more is genuinely needed, give the headline and offer to go deeper.)'
    : text;
  const r = await C.voiceTurn({ text: asked, agent, speak: false });
  const thinkMs = performance.now() - t0;
  vcClock(false);
  VOICE.busy = false;
  if (!r || !r.ok) {
    setVoiceState('idle', 'ready');
    voicePush('sys', (r && r.error) || 'that turn did not come back');
    if (r && r.blocked) { toast('The fleet is stopped — resume it to talk', 'warn'); VOICE.wantLoop = false; }
    if (VOICE.wantLoop) startListening({ autoStop: true, onDone: voiceSend });
    return;
  }
  /* the latency meter — the whole pipeline, phase by phase, on every turn.
     "Slow" stops being a feeling and becomes an address. */
  const lat = (ms) => (ms / 1000).toFixed(1) + 's';
  voicePush('them', r.text, aname(r.agent) + ' · ' + (sttMs ? 'heard ' + lat(sttMs) + ' · ' : '') + 'thought ' + lat(thinkMs));
  // She can drive the app: show what she changed, and follow her to that screen.
  if (r.actions && r.actions.length) {
    for (const a of r.actions) voicePush('sys', (a.ok ? '✓ ' : '⚠ ') + a.said);
    if (CUR.view === 'voice') { refreshControl(); }
  }
  if (r.pending && r.pending.length) {
    VOICE.pending = r.pending;
    renderVoicePending();
  }
  if (r.goView && r.goView !== 'voice') {
    // a beat, so he hears the sentence before the screen moves under him
    setTimeout(() => { if (CUR.view === 'voice') { toast('opening ' + r.goView, 'good'); switchView(r.goView); } }, 1400);
  }
  /* ── THE PIPELINE ──────────────────────────────────────────────────────────
     TTS time scales with text length, so a long reply used to mean a long
     silence before the FIRST word. Split at the first sentence boundary past
     a breath's worth of text, request both halves IN PARALLEL, and play the
     head the instant it lands — the tail renders while she is already talking.
     Voice-start latency becomes the cost of one sentence, not one essay. */
  setVoiceState('speaking', 'rendering her voice…');
  const tv = performance.now();
  const [head, tail] = splitSpeech(r.text);
  const pHead = C.speak(head).catch(() => null);
  const pTail = tail ? C.speak(tail).catch(() => null) : null;
  const sp = await pHead;
  if (sp && sp.ok && sp.audio) {
    const first = VOICE.turns.find((x) => x.role === 'them');
    if (first) { first.meta += ' · voice ' + lat(performance.now() - tv); renderVoiceLog(); }
    VOICE.met.push({ think: thinkMs, stt: sttMs, voice: performance.now() - tv });
    if (VOICE.met.length > 24) VOICE.met.shift();
    renderVcStrip();
    setVoiceState('speaking', 'speaking…');
    playChain([Promise.resolve(sp), pTail].filter(Boolean));
  } else {
    if (sp && sp.error) toast('Spoken reply unavailable: ' + sp.error, 'warn');
    VOICE.met.push({ think: thinkMs, stt: sttMs, voice: 0 });
    renderVcStrip();
    setVoiceState('idle', 'ready');
    if (VOICE.wantLoop) startListening({ autoStop: true, onDone: voiceSend });
  }
}
/* the seam: past ~150 chars, break at the first sentence end — never mid-word */
function splitSpeech(text) {
  const t = String(text || '').trim();
  if (t.length < 220) return [t, ''];
  const m = /[.!?]["')\]]?\s/g;
  let cut = -1, mm;
  while ((mm = m.exec(t))) { if (mm.index > 120) { cut = mm.index + 1; break; } }
  if (cut < 0 || cut > 400) return [t, ''];
  return [t.slice(0, cut).trim(), t.slice(cut).trim()];
}
/* play rendered segments back to back; a barge-in clears the whole chain */
function playChain(promises) {
  VOICE.chain = promises;
  const step = async (i) => {
    if (VOICE.chain !== promises) return;               // barged in — stop cold
    if (i >= promises.length) {
      VOICE.audio = null;
      if (VOICE.wantLoop) { setVoiceState('listening', 'listening…'); startListening({ autoStop: true, onDone: voiceSend }); }
      else setVoiceState('idle', 'ready');
      return;
    }
    const seg = await promises[i];
    if (VOICE.chain !== promises) return;
    if (!(seg && seg.ok && seg.audio)) return step(i + 1);
    const a = new Audio('data:audio/mpeg;base64,' + seg.audio);
    VOICE.audio = a;
    a.onended = () => step(i + 1);
    a.onerror = () => step(i + 1);
    a.play().catch(() => step(i + 1));
  };
  step(0);
}

/* the deck is delegated so it survives every repaint of the view */
/* the page's own reading: not "is it slow" but WHERE it is slow, from the
   meter's own history — median of what he actually experienced. */
function renderVcStrip() {
  const host = $('#vcStrip');
  if (!host) return;
  const met = VOICE.met || [];
  const med = (k) => {
    const a = met.map((x) => x[k]).filter((v) => v > 0).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  };
  const sec = (ms) => ms ? (ms / 1000).toFixed(1) + 's' : '—';
  const cell = (cls, big, sub) => '<div class="st-si ' + (cls || '') + '"><b>' + big + '</b><i>' + sub + '</i></div>';
  const mth = med('think');
  setHTML(host, '<div class="st-strip n5">'
    + cell(VOICE.busy ? 'live' : '', VOICE.busy ? 'LIVE' : 'READY', VOICE.busy ? 'a turn is in flight' : 'the line is open')
    + cell('', sec(med('stt')), 'median: heard in')
    + cell(mth > 12000 ? 'zero' : '', sec(mth), 'median: thought for')
    + cell('', sec(med('voice')), 'median: first word in')
    + cell(met.length ? 'go' : '', met.length, 'turn(s) this session')
    + '</div>');
}
const OPS_DECK = {
  brief: 'Give me the twenty-second brief: what actually moved in the last few hours, what is stuck, and the single next move. Speak plainly, no preamble.',
  blocked: 'What is blocked or waiting on me right now? Name each one in a single line, most important first. If nothing is blocked, say exactly that.',
  next: 'One move, highest leverage, doable in the next thirty minutes. Name it, say why it is the lever, then stop.',
  dark: 'Check the broadcast: are we off air, and is the public endpoint actually empty? Give me the verdict first, then one line of evidence.',
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('.ops-deck [data-od]');
  if (!b || VOICE.busy) return;
  voiceSend(OPS_DECK[b.dataset.od]);
});
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'vcQuick') VOICE.quick = e.target.checked;
});
/* the global key: press anywhere in Windows → the app fronts and listens;
   press again or just stop talking → the turn sends. */
if (C.onPTT) C.onPTT(() => {
  if (CUR.view !== 'voice') switchView('voice');
  if (VOICE.listening) { stopListening(); return; }
  if (!VOICE.busy) startListening({ autoStop: true, onDone: voiceSend });
});
async function loadVoice() {
  const v = await C.voice();
  if (!v || v.error) return viewFail('voice', v || null);
  const supported = voiceSupported();
  setHTML($('#voiceBody'), `
    <div class="view-head"><h2>DASH-OPS</h2>
      <p class="view-desc">Talk to the fleet and hear it answer. Your voice is transcribed on this machine and never sent anywhere by this app — only the agent's written reply goes out to be spoken.</p></div>

    ${v.keySet ? `<div class="bridge ok glass-deep">
      <div class="br-ic">🔊</div>
      <div><div class="br-t">Voice is connected</div>
        <div class="br-d">Using the ElevenLabs key already on this machine${v.keySource ? ` (<code>~/${esc(v.keySource)}</code>)` : ''} — the same one MotusMoves and DAV-OPS use. It was read from disk, sealed with Windows DPAPI, and is <b>bound to this PC and this Windows account</b>: copied anywhere else, the vault is inert. It is never shown on screen, never sent to the interface, and never written to a log.</div></div>
    </div>`
    : v.machineKeyAvailable ? `<div class="bridge warn glass-deep">
      <div class="br-ic">🔑</div>
      <div><div class="br-t">A voice key is already on this machine</div>
        <div class="br-d">Found the ElevenLabs key your other builds use. Adopt it and CortexInsight will seal it to this device — you never have to paste or create a new one.</div></div>
      <button class="prime-btn" id="vcAdopt">Use this machine's key</button>
    </div>`
    : `<div class="bridge warn glass-deep">
      <div class="br-ic">🔊</div>
      <div><div class="br-t">Connect a voice</div>
        <div class="br-d">Paste an ElevenLabs API key to give the fleet a voice. It is encrypted at rest with Windows DPAPI, decrypted only inside the app's main process, and never handed back to the interface or written to a log. You can still talk without it — you just read the replies instead of hearing them.</div></div>
    </div>`}

    <!-- ═══ READY-STATE — four things that decide whether talking will work,
         answered before he presses anything. A mic that fails on the first
         press is the worst possible moment to learn any of this. ═══ -->
    <div class="vc-ready">
      <div class="vcr ${supported ? 'ok' : 'no'}"><b>${supported ? '✓' : '✕'}</b><i>${supported ? 'recorder ready' : 'no recorder'}</i></div>
      <div class="vcr ${v.keySet ? 'ok' : 'warn'}"><b>${v.keySet ? '✓' : '—'}</b><i>${v.keySet ? 'voice connected' : 'no voice key'}</i></div>
      <div class="vcr ${v.control && v.control.stopped ? 'no' : 'ok'}"><b>${v.control && v.control.stopped ? '■' : '✓'}</b><i>${v.control && v.control.stopped ? 'fleet stopped' : 'fleet live'}</i></div>
      <div class="vcr"><b>${esc(((v.fleet || []).find((f) => f.id === v.agent) || {}).name || '—')}</b><i>on the line</i></div>
    </div>

    <!-- ═══ THE OPS DECK — the four asks he actually makes, one press each.
         Not shortcuts: these are the founder's standing questions, phrased
         once, well, and answered out loud through the exact same gated path
         as his own voice. ═══ -->
    <div id="vcStrip"></div>
    <div class="ops-deck">
      <button class="od" data-od="brief"><b>⚡ Brief me</b><span>what moved · what is stuck · what is next</span></button>
      <button class="od" data-od="blocked"><b>⛔ What's blocked</b><span>everything waiting on you, one line each</span></button>
      <button class="od" data-od="next"><b>◈ Next move</b><span>one move, highest leverage, doable now</span></button>
      <button class="od" data-od="dark"><b>🛡 Am I dark?</b><span>the broadcast verdict, spoken</span></button>
    </div>

    <label class="om-check vc-quick"><input type="checkbox" id="vcQuick" ${VOICE.quick !== false ? 'checked' : ''} />
      <span><b>Quick mode</b> — she answers in a breath (three sentences), and offers to go deeper. Off = full-depth replies, slower to think and to speak.</span></label>

    <div class="vc glass-deep">
      <div class="vc-orb ${VOICE.mode}" id="vcOrb"><span></span><i></i></div>
      <div class="vc-mid">
        <div class="vc-state" id="vcState">${v.control && v.control.stopped ? 'the fleet is stopped' : supported ? 'ready' : 'no speech recogniser in this build'}</div>
        <div class="vc-partial" id="vcPartial"></div>
        <div class="vc-modes">
          <button class="vc-ptt ${supported ? '' : 'off'}" id="vcPtt">🎙 Hold to talk<span>or hold <b>V</b></span></button>
          <button class="vc-call ${supported ? '' : 'off'}" id="vcCall">📞 Start call<span>continuous</span></button>
        </div>
      </div>
      <div class="vc-side">
        <label class="fr-lbl">Speaking with</label>
        <select id="vcAgent" class="sel">${(v.fleet || []).map((f) => `<option value="${f.id}" ${v.agent === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
        <label class="fr-lbl" style="margin-top:10px">Type instead</label>
        <div class="vc-typerow"><input class="txt" id="vcType" placeholder="say it in text…" /><button class="mini go" id="vcSend">▷</button></div>
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Conversation</h3><span class="panel-sub">this session</span>
        <button class="mini" id="vcClear">✕ clear</button></div>
      <div id="vcPending"></div>
      <div class="vc-log" id="vcLog"></div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Voice</h3><span class="panel-sub">${v.keySet ? 'key saved · encrypted at rest' : 'no key yet'}</span></div>
      <div class="vc-cfg">
        <div class="vc-krow">
          <input class="txt" id="vcKey" type="password" placeholder="${v.keySet ? '•••••••••• (saved — paste a new key to replace)' : 'ElevenLabs API key'}" autocomplete="off" spellcheck="false" />
          <button class="prime-btn" id="vcKeySave">Save key</button>
          ${v.keySet ? '<button class="mini danger" id="vcKeyClear">Remove</button>' : ''}
        </div>
        <div class="vc-vrow">
          <div><label class="fr-lbl">Voice</label>
            <select id="vcVoice" class="sel"><option value="${esc(v.voiceId)}">${esc(v.voiceName || 'current')}</option></select></div>
          <div><label class="fr-lbl">Stability ${Math.round(v.stability * 100)}%</label>
            <input type="range" id="vcStab" min="0" max="100" value="${Math.round(v.stability * 100)}" /></div>
          <div><label class="fr-lbl">Similarity ${Math.round(v.similarity * 100)}%</label>
            <input type="range" id="vcSim" min="0" max="100" value="${Math.round(v.similarity * 100)}" /></div>
        </div>
        <div class="lp-act">
          <button class="ghost-btn" id="vcLoad">↻ Load my voices</button>
          <button class="ghost-btn" id="vcTest">▶ Hear it</button>
          <button class="mini ${v.speakDuo ? 'on' : ''}" id="vcDuo">${v.speakDuo ? '● speaks Duo-Drive passes' : '○ silent on Duo-Drive passes'}</button>
        </div>
        <div class="uhonest"><b>Where the key lives:</b> encrypted with Windows DPAPI in this app's private vault, decrypted only in the main process for the moment of a call, and never returned to this screen — the same handling as your canary email password. Remove it any time and voice simply turns off.</div>
      </div>
    </div>`);

  renderVoiceLog();
  renderVoicePending();
  renderVcStrip();   // the strip must exist BEFORE the first turn, showing "—"

  const ptt = $('#vcPtt'), call = $('#vcCall');
  const beginPtt = () => {
    if (!supported || VOICE.busy || VOICE.held) return;
    VOICE.held = true; VOICE.wantLoop = false; voiceStopAudio();
    if (ptt) ptt.classList.add('live');
    // transcription happens on release; onDone fires with the real text
    startListening({ autoStop: false, onDone: (t) => voiceSend(t) });
  };
  const endPtt = () => {
    if (!VOICE.held) return;
    VOICE.held = false; if (ptt) ptt.classList.remove('live');
    stopListening();     // → onstop → transcribe → onDone → voiceSend
  };
  if (ptt) {
    ptt.onmousedown = beginPtt; ptt.onmouseup = endPtt; ptt.onmouseleave = () => { if (VOICE.held) endPtt(); };
    ptt.ontouchstart = (e) => { e.preventDefault(); beginPtt(); };
    ptt.ontouchend = (e) => { e.preventDefault(); endPtt(); };
  }
  if (call) call.onclick = () => {
    if (VOICE.wantLoop) {
      VOICE.wantLoop = false; stopListening(); voiceStopAudio(); releaseMic();
      setVoiceState('idle', 'ready'); call.classList.remove('live'); call.innerHTML = '📞 Start call<span>continuous</span>';
      voicePush('sys', 'Call ended.');
    } else {
      if (!supported) return;
      VOICE.wantLoop = true; call.classList.add('live'); call.innerHTML = '■ End call<span>listening</span>';
      voicePush('sys', 'Call started — just talk. Pause when you are done and she will answer.');
      startListening({ autoStop: true, onDone: voiceSend });
    }
  };
  const send = $('#vcSend'), typed = $('#vcType');
  const doTyped = () => { const t = typed.value.trim(); if (!t) return; typed.value = ''; voiceSend(t); };
  if (send) send.onclick = doTyped;
  if (typed) typed.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doTyped(); } };
  const clr = $('#vcClear'); if (clr) clr.onclick = () => { VOICE.turns = []; renderVoiceLog(); };

  const adopt = $('#vcAdopt');
  if (adopt) adopt.onclick = async () => {
    adopt.disabled = true; adopt.textContent = '… sealing';
    const r = await C.voiceSave({ adoptMachineKey: true });
    toast(r && r.ok ? 'Key adopted and sealed to this device ✓' : 'Could not adopt: ' + ((r && r.error) || '?'), r && r.ok ? 'good' : 'bad');
    loadVoice();
  };
  const ks = $('#vcKeySave');
  if (ks) ks.onclick = async () => {
    const k = $('#vcKey').value.trim();
    if (!k) { toast('Paste a key first', 'bad'); return; }
    const r = await C.voiceSave({ key: k });
    $('#vcKey').value = '';
    toast(r && r.ok ? 'Key saved and encrypted ✓' : 'Could not save: ' + ((r && r.error) || '?'), r && r.ok ? 'good' : 'bad');
    loadVoice();
  };
  const kc = $('#vcKeyClear');
  if (kc) kc.onclick = async () => { if (!confirm('Remove the ElevenLabs key? Voice output turns off; everything else keeps working.')) return; await C.voiceSave({ clearKey: true }); toast('Key removed', 'good'); loadVoice(); };
  const load = $('#vcLoad');
  if (load) load.onclick = async () => {
    load.disabled = true; load.textContent = '… loading';
    const r = await C.voiceList();
    load.disabled = false; load.textContent = '↻ Load my voices';
    if (!r || !r.ok) { toast('Could not load voices: ' + ((r && r.error) || '?'), 'bad'); return; }
    const sel = $('#vcVoice');
    sel.innerHTML = r.voices.map((x) => `<option value="${escAttr(x.id)}" ${x.id === v.voiceId ? 'selected' : ''}>${esc(x.name)}${x.category ? ` · ${esc(x.category)}` : ''}</option>`).join('');
    sel.onchange = async () => {
      const opt = sel.options[sel.selectedIndex];
      await C.voiceSave({ voiceId: sel.value, voiceName: opt.textContent.split(' · ')[0] });
      toast('Voice set ✓', 'good');
    };
    toast(`${r.voices.length} voices loaded`, 'good');
  };
  const test = $('#vcTest');
  if (test) test.onclick = async () => {
    test.disabled = true;
    const r = await C.speak('Systems nominal. I am here, and I am listening.', $('#vcVoice') ? $('#vcVoice').value : null);
    test.disabled = false;
    if (r && r.ok) { voiceStopAudio(); const a = new Audio('data:audio/mpeg;base64,' + r.audio); VOICE.audio = a; a.play().catch(() => {}); }
    else toast('No sound: ' + ((r && r.error) || '?'), 'bad');
  };
  const stab = $('#vcStab'), sim = $('#vcSim');
  if (stab) stab.onchange = () => C.voiceSave({ stability: stab.value / 100 });
  if (sim) sim.onchange = () => C.voiceSave({ similarity: sim.value / 100 });
  const vd = $('#vcDuo');
  if (vd) vd.onclick = async () => { await C.voiceSave({ speakDuo: !v.speakDuo }); loadVoice(); };
  const va = $('#vcAgent'); if (va) va.onchange = () => C.voiceSave({ agent: va.value });
}

// Hold V anywhere to talk — the physical gesture of DASH-OPS.
document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat || CUR.view !== 'voice') return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
  const b = $('#vcPtt'); if (b) b.dispatchEvent(new MouseEvent('mousedown'));
});
document.addEventListener('keyup', (e) => {
  if (e.code !== 'KeyV' || CUR.view !== 'voice') return;
  const b = $('#vcPtt'); if (b) b.dispatchEvent(new MouseEvent('mouseup'));
});

/* ============================================== DUO-DRIVE v3 — LEVERAGE LOOPS
   She no longer just "does a pass". She runs LOOPS: bounded, repeatable, high-
   confidence moves scoped to real projects — some written by August, some she
   proposes for herself. Nothing she authors ever runs until he approves it.   */
const DUO_TABS = [['loops', 'Loops'], ['work', 'Work log'], ['projects', 'Projects'], ['ethos', 'Design ethos'], ['passes', 'Pass log']];
CUR.duoTab = CUR.duoTab || 'loops';
CUR.loopEdit = null;
CUR.projEdit = null;

function loopCard(l, projects) {
  const k = l.kindMeta || { glyph: '◆', label: l.kind };
  const scope = (l.projectIds || []).length
    ? (l.projectIds || []).map((id) => (projects.find((p) => p.id === id) || {}).name).filter(Boolean).join(', ')
    : 'all enabled projects';
  // the wait stretches while a loop keeps finding nothing (×1.5 per idle pass, ×4 at most)
  const stretch = l.stretch || 1;
  const due = l.approved && l.enabled
    ? Math.max(0, Math.round((l.cadenceMin * 60000 * stretch - (Date.now() - (l.lastRun || 0))) / 60000))
    : null;
  return `
    <div class="loop ${l.approved ? '' : 'pending'} ${l.enabled && l.approved ? 'on' : ''} k-${l.kind}">
      <div class="lp-top">
        <span class="lp-glyph">${k.glyph}</span>
        <div class="lp-id">
          <div class="lp-name">${esc(l.name)}</div>
          <div class="lp-kind">${esc(k.label)} · every ${l.cadenceMin < 60 ? l.cadenceMin + 'm' : (l.cadenceMin / 60) + 'h'} · confidence floor ${l.confidenceMin}/10</div>
        </div>
        ${l.origin === 'duo' ? `<span class="lp-authored">✎ she wrote this</span>` : ''}
        ${l.approved ? `<span class="lp-stat mono">${l.runs || 0} run${(l.runs || 0) === 1 ? '' : 's'}${l.skipped ? ` · ${l.skipped} skipped` : ''}</span>` : ''}
        ${l.approved && l.yield && (l.runs || 0) ? `<span class="lp-yield" title="shipped passes over all passes: the only honest score for a loop">yield <b>${l.yield.shipped}</b>/${l.runs}</span>` : ''}
        ${l.avgQuality != null ? `<span class="lp-q ${l.avgQuality < 6 ? 'low' : ''}" title="mean report quality, 0 to 10: a confidence with its basis, a dated falsifier, a walked turn, a concrete DID, verified files, a next">Q ${l.avgQuality.toFixed(1)}</span>` : ''}
        ${(l.skipStreak || 0) >= 3 ? `<span class="lp-stall" title="found nothing ${l.skipStreak} passes in a row; its wait is stretched ×${(l.stretch || 1).toFixed(1)}">stalling ×${l.skipStreak}</span>` : ''}
        ${l.lowQuality ? `<span class="lp-stall" title="its reports keep scoring under 5 over five or more passes, so it waits twice as long between passes">low quality · waiting ×2</span>` : ''}
      </div>
      <div class="lp-inst">${esc(l.instruction)}</div>
      ${l.rationale ? `<div class="lp-why"><b>Why:</b> ${esc(l.rationale)}</div>` : ''}
      <div class="lp-scope">◎ ${esc(scope)}${due !== null ? ` · next pass in ~${due}m` : ''}</div>
      <div class="lp-act">
        ${l.approved
          ? `<button class="mini ${l.enabled ? 'on' : ''}" data-loop-toggle="${l.id}">${l.enabled ? '● running' : '○ paused'}</button>
             <button class="mini go" data-loop-run="${l.id}">▷ Run now</button>
             <button class="mini" data-loop-edit="${l.id}">✎ Revise</button>
             <button class="mini danger" data-loop-del="${l.id}">✕ Delete</button>`
          : `<button class="prime-btn" data-loop-approve="${l.id}">✓ Approve &amp; arm</button>
             <button class="mini" data-loop-edit="${l.id}">✎ Revise first</button>
             <button class="mini danger" data-loop-del="${l.id}">✕ Reject</button>`}
      </div>
    </div>`;
}

async function loadDuo() {
  const [r, L, W] = await Promise.all([C.duo(), C.loops(), C.duoWork({ loopId: CUR.workLoop || 'all' })]);
  if (!r || r.error || !L || L.error) return viewFail('duo', r || L);
  const d = r.duo || {};
  const loops = L.loops || [], projects = L.projects || [];
  const pending = loops.filter((l) => !l.approved);
  const approved = loops.filter((l) => l.approved);

  const tabs = `<div class="duo-tabs">${DUO_TABS.map(([id, lab]) =>
    `<button class="chip ${CUR.duoTab === id ? 'on' : ''}" data-dtab="${id}">${lab}${id === 'loops' && pending.length ? ` <span class="tab-badge">${pending.length}</span>` : ''}</button>`).join('')}</div>`;

  let body = '';
  if (CUR.duoTab === 'loops') {
    body = `
      ${pending.length ? `<div class="panel glass approve-panel">
        <div class="panel-head"><h3>Waiting for your approval</h3><span class="panel-sub">she designed these — nothing runs until you arm it</span></div>
        ${pending.map((l) => loopCard(l, projects)).join('')}
      </div>` : ''}
      <div class="panel glass">
        <div class="panel-head"><h3>Leverage Loops</h3><span class="panel-sub">${approved.filter((l) => l.enabled).length} running of ${approved.length}</span>
          <button class="ghost-btn" id="loopNew">+ New loop</button>
          <button class="ghost-btn" id="loopInvent">✦ Ask her to design one</button></div>
        ${CUR.loopEdit ? loopEditor(L) : ''}
        ${approved.length ? approved.map((l) => loopCard(l, projects)).join('') : '<div class="empty">No loops yet.</div>'}
      </div>`;
  } else if (CUR.duoTab === 'work') {
    const items = W.items || [];
    body = `
      <div class="panel glass">
        <div class="panel-head"><h3>Completed work</h3><span class="panel-sub">everything she has actually done, newest first</span>
          <button class="clear-btn" data-clear="duoWork" data-clear-label="the Duo-Drive work ledger">✕ clear</button></div>
        <div class="up-stats">
          <div class="us"><span class="us-v mono">${W.shipped || 0}</span><span class="us-l">changes shipped</span></div>
          <div class="us"><span class="us-v mono">${W.reported || 0}</span><span class="us-l">findings reported</span></div>
          <div class="us"><span class="us-v mono">${W.files || 0}</span><span class="us-l">files touched</span></div>
        </div>
        <div class="work-filter">
          <button class="chip ${!CUR.workLoop || CUR.workLoop === 'all' ? 'on' : ''}" data-wloop="all">All loops</button>
          ${(W.byLoop || []).map((b) => `<button class="chip ${CUR.workLoop === b.id ? 'on' : ''}" data-wloop="${b.id}">${esc(b.name)} · ${b.n}</button>`).join('')}
        </div>
        ${items.length ? capList('duowork', items, (w) => `
          <div class="wk v-${w.verdict} expandable" data-body="${escAttr(w.body || '')}" data-rtitle="${escAttr(w.title)}" data-rsub="${esc(w.loopName || '')} · ${esc(w.ts)}">
            <div class="wk-top">
              <span class="wk-v">${w.verdict === 'shipped' ? '✓ shipped' : w.verdict === 'skipped' ? '– skipped' : '◎ reported'}</span>
              <span class="wk-loop">${esc(w.loopName || 'pass')}</span>
              ${Number.isFinite(w.quality) ? `<span class="wk-q ${w.quality < 6 ? 'low' : ''}" title="${escAttr((w.qualityWhy || []).length ? 'missing: ' + w.qualityWhy.join(' · ') : 'carries everything a report should')}">Q ${w.quality}</span>` : ''}
              ${w.filesVerified === false ? '<span class="wk-q low" title="the files this pass claimed could not be found on disk">files not found</span>' : ''}
              ${w.project ? (w.projectUrl
                ? `<a class="proj-chip" href="${escAttr(w.projectUrl)}" target="_blank" rel="noopener" title="${escAttr(w.projectUrl)}">◈ ${esc(w.project)} ↗</a>`
                : `<span class="proj-chip still">◈ ${esc(w.project)}</span>`) : ''}
              ${w.confidence ? `<span class="wk-conf mono">${w.confidence}/10</span>` : ''}
              <span class="wk-when mono" title="${esc(ago(w.ts))} ago">${esc(fmtDT2(w.ts))}</span>
            </div>
            <div class="wk-title">${esc(w.title)}</div>
            ${w.did ? `<div class="wk-did">${esc(w.did)}</div>` : ''}
            ${(w.files || []).length ? `<div class="wk-files">${w.files.map((f) => `<button class="wk-file mono" data-open-file="${esc(f)}" title="open this file">⤢ ${esc(f)}</button>`).join('')}</div>` : ''}
            ${w.next && !/^none$/i.test(w.next) ? `<div class="wk-next"><b>Next:</b> ${esc(w.next)}</div>` : ''}
            <div class="dl-act"><span class="dl-more">click to expand</span><button class="mini read" data-read="1">⤢ read full</button></div>
          </div>`) : '<div class="empty">Nothing yet. Once a loop runs, every move she makes lands here with what changed and how sure she was.</div>'}
      </div>`;
  } else if (CUR.duoTab === 'projects') {
    body = `
      <div class="panel glass">
        <div class="panel-head"><h3>Projects she may refine</h3><span class="panel-sub">she only ever touches what is listed and enabled here</span>
          <button class="ghost-btn" id="projNew">+ Add project</button></div>
        ${CUR.projEdit ? projectEditor() : ''}
        ${projects.length ? projects.map((p) => `
          <div class="proj ${p.enabled ? '' : 'off'}">
            <div class="pj-top">
              <span class="pj-dot"></span>
              <div class="pj-id"><div class="pj-name">${esc(p.name)}</div>
                ${p.url ? `<div class="pj-url mono">${esc(p.url)}</div>` : ''}</div>
              <span class="pj-stat mono">${p.passes || 0} pass${(p.passes || 0) === 1 ? '' : 'es'}${p.lastTouched ? ` · touched ${ago(p.lastTouched)} ago` : ''}</span>
            </div>
            ${p.localPath ? `<div class="pj-path mono">📁 ${esc(p.localPath)}</div>` : ''}
            ${p.repo ? `<div class="pj-path mono">⎇ ${esc(p.repo)}</div>` : ''}
            ${p.notes ? `<div class="pj-notes">${esc(p.notes)}</div>` : ''}
            <div class="lp-act">
              <button class="mini ${p.enabled ? 'on' : ''}" data-proj-toggle="${p.id}">${p.enabled ? '● included' : '○ excluded'}</button>
              <button class="mini" data-proj-edit="${p.id}">✎ Edit</button>
              <button class="mini danger" data-proj-del="${p.id}">✕ Remove</button>
            </div>
          </div>`).join('') : '<div class="empty">No projects yet. Add one — a name plus a local folder or a URL is enough for her to start refining it.</div>'}
      </div>`;
  } else if (CUR.duoTab === 'ethos') {
    body = `
      <div class="panel glass">
        <div class="panel-head"><h3>Design ethos</h3><span class="panel-sub">the taste she designs against — she refines this as she learns yours</span></div>
        <p class="view-desc" style="padding:0 4px 12px">Every <b>design</b> loop reads this before it touches anything. Teach her here once and it compounds across every project.</p>
        <textarea id="ethosBox" class="txt ethos" rows="18" spellcheck="true">${esc(L.ethos || '')}</textarea>
        <div class="lp-act"><button class="prime-btn" id="ethosSave">Save ethos</button></div>
      </div>`;
  } else {
    body = `
      <div class="panel glass">
        <div class="panel-head"><h3>Pass log</h3><span class="panel-sub">every pass, including the ones she chose to skip</span>
          <button class="clear-btn" data-clear="duo" data-clear-label="the Duo-Drive pass log">✕ clear</button></div>
        ${(d.log || []).length ? capList('duolog', d.log, (l) => `
          <div class="dlog ${l.ok ? '' : 'bad'} ${l.skipped ? 'skip' : ''} expandable" data-body="${escAttr(l.body || '')}" data-rtitle="${escAttr(l.title)}" data-rsub="${esc(aname(l.agent))} · ${esc(l.ts)} · ${esc(l.reason || '')}">
            <div class="dl-top"><span class="dl-agent tone-${TONE[l.agent] || 'slate'}">${esc(aname(l.agent))}</span>
              ${l.confidence ? `<span class="wk-conf mono">${l.confidence}/10</span>` : ''}
              <span class="dl-when mono">${ago(l.ts)} ago</span><span class="dl-why">${esc(l.reason || '')}</span></div>
            <div class="dl-title">${esc(l.title)}</div>
            <div class="dl-body">${esc(l.body || '')}</div>
            <div class="dl-act"><span class="dl-more">click to expand</span><button class="mini read" data-read="1">⤢ read full</button></div>
          </div>`) : '<div class="empty">No passes yet.</div>'}
      </div>`;
  }

  /* ═══ THE READINGS — is she actually driving, and is anything waiting on you?
     The third cell is the one that matters most: a loop she designed and cannot
     run is the whole partnership stalled on a click, and it used to be visible
     only as a small badge on a tab. The fifth refuses to flatter a quiet week —
     "running" with no pass in three days is not running. ═══ */
  const lastPass = ((W.items || [])[0] || {}).ts;
  const sinceP = sinceLabel(lastPass);
  const runningLoops = approved.filter((l) => l.enabled).length;
  setHTML($('#duoBody'), `
    <div class="view-head"><h2>Duo-Drive <span class="h2-sub">MotusAgent One</span></h2>
      <p class="view-desc">She works alongside you on <b>Leverage Loops</b> — small, repeatable, high-confidence moves on your real projects. She can design new loops for herself; none of them run until you approve them.</p></div>

    <div class="st-strip n5">
      ${siCell(d.active ? 'live' : 'zero', d.active ? 'DRIVING' : 'IDLE', d.active ? 'a loop is compounding right now' : 'progress stops when you stop')}
      ${siCell(runningLoops ? 'go' : 'zero', runningLoops, 'of ' + approved.length + ' loop(s) enabled')}
      ${siCell(pending.length ? 'zero' : '', pending.length, pending.length ? 'she designed these and cannot run them' : 'nothing waiting on your approval')}
      ${siCell((W.shipped || 0) ? 'go' : '', W.shipped || 0, 'change(s) shipped · ' + (W.files || 0) + ' file(s) touched')}
      ${siCell(!sinceP || (Date.now() - Date.parse(lastPass)) > 3 * 864e5 ? 'zero' : '', sinceP || '—',
        sinceP ? 'since her last pass' : 'she has never taken a pass')}
    </div>
    ${(() => {
      // her stated NEXT from the newest pass that has one — the plan the next
      // pass must answer to, standing on screen between passes
      const li = (W.items || []).find((x) => x.next);
      return li ? '<div class="duo-intent"><span class="di-k">◈ HER STANDING INTENTION</span>'
        + '<span class="di-t">' + esc(String(li.next).slice(0, 220)) + '</span>'
        + '<span class="di-m">from “' + esc(String(li.loopName || 'a pass').slice(0, 40)) + '” — the next pass honors it, or says why not</span></div>' : '';
    })()}
    <div class="creed">
      <span class="cr-flow"><b>Mantra</b> → <b>Mindset</b> → <b>Model</b> → <b>Motus</b></span>
      <span class="cr-test">every pass answers one question: <b>did something actually move?</b></span>
    </div>
    <div class="duo-hero glass-deep ${d.active ? 'on' : ''}">
      <div class="dh-orb ${d.active ? 'live' : ''}"><span></span></div>
      <div class="dh-mid">
        <div class="dh-state">${d.active ? `Running with ${esc(aname(d.agent))}` : 'Duo-Drive is off'}</div>
        <div class="dh-sub">${d.active
          ? `${approved.filter((l) => l.enabled).length} loop(s) armed · ${L.nextDue ? `next up: <b>${esc(L.nextDue.name)}</b>` : 'nothing due yet'} · ${d.runs || 0} pass${(d.runs || 0) === 1 ? '' : 'es'} so far${d.skipped ? ` · ${d.skipped} idle passes skipped` : ''}${(d.cadenceStretch || 1) > 1 ? ` · waiting ×${d.cadenceStretch.toFixed(1)} longer after ${d.skipStreak} idle pass${d.skipStreak === 1 ? '' : 'es'}` : ''}${d.nextsCount ? ` · <b>${d.nextsCount}</b> proposed next move${d.nextsCount === 1 ? '' : 's'} on the Board` : ''}`
          : 'It never acts while the fleet is stopped, never exceeds your token budget, and every move is logged with a confidence score.'}</div>
      </div>
      <div class="dh-act">
        <select id="duoAgent" class="sel">${(r.fleet || []).map((f) => `<option value="${f.id}" ${d.agent === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
        <button class="prime-btn ${d.active ? 'danger' : ''}" id="duoToggle">${d.active ? '■ Stop' : '▶ Start'}</button>
      </div>
    </div>
    <div class="panel glass duo-brief">
      <label class="fr-lbl">Standing brief <span class="fr-hint">held in mind on every pass</span></label>
      <textarea id="duoBrief" rows="2" spellcheck="true" placeholder="e.g. We are pre-launch on MotusMoves. Prefer polish over new surface. Never touch the relay or payments.">${esc(d.brief || '')}</textarea>
      <div class="lp-act"><button class="ghost-btn" id="duoSave">Save brief</button><button class="ghost-btn" id="duoNow">✦ Run a pass now</button></div>
    </div>
    ${tabs}
    ${body}`);

  wireDuo(r, L, projects);
}

function loopEditor(L) {
  const e = CUR.loopEdit || {};
  return `
    <div class="loop-editor">
      <div class="wt-h">${e.id ? '✎ Revise loop' : '+ New loop'}<span class="wt-sub">she will follow this instruction verbatim, every pass</span></div>
      <input class="txt big" id="lpName" placeholder="Loop name — e.g. Polish Pass" value="${escAttr(e.name || '')}" />
      <div class="lp-row">
        <select id="lpKind" class="sel">${(L.kinds || []).map((k) => `<option value="${k.id}" ${e.kind === k.id ? 'selected' : ''}>${k.glyph} ${k.label}</option>`).join('')}</select>
        <select id="lpCad" class="sel">${[15, 30, 60, 90, 120, 240, 480, 720].map((n) => `<option value="${n}" ${(e.cadenceMin || 60) === n ? 'selected' : ''}>every ${n < 60 ? n + 'm' : (n / 60) + 'h'}</option>`).join('')}</select>
        <select id="lpConf" class="sel">${[6, 7, 8, 9, 10].map((n) => `<option value="${n}" ${(e.confidenceMin || 8) === n ? 'selected' : ''}>confidence floor ${n}/10</option>`).join('')}</select>
      </div>
      <textarea id="lpInst" class="txt" rows="5" spellcheck="true" placeholder="What she does each pass. Be specific about the ONE thing she should do — and what she must never do.">${esc(e.instruction || '')}</textarea>
      <div class="lp-scopepick"><span class="fr-lbl">Scope to projects <span class="fr-hint">none selected = every enabled project</span></span>
        <div class="lp-chips">${(L.projects || []).map((p) => `<button class="mini ${(e.projectIds || []).includes(p.id) ? 'on' : ''}" data-lpproj="${p.id}">${esc(p.name)}</button>`).join('') || '<span class="fr-hint">no projects registered yet</span>'}</div>
      </div>
      <div class="lp-act"><button class="prime-btn" id="lpSave">Save loop</button><button class="mini" id="lpCancel">cancel</button></div>
    </div>`;
}
function projectEditor() {
  const e = CUR.projEdit || {};
  return `
    <div class="loop-editor">
      <div class="wt-h">${e.id ? '✎ Edit project' : '+ Add project'}<span class="wt-sub">she only touches what is listed here</span></div>
      <input class="txt big" id="pjName" placeholder="Project name — e.g. MotusMoves.US" value="${escAttr(e.name || '')}" />
      <div class="lp-row">
        <input class="txt" id="pjUrl" placeholder="Live URL (optional)" value="${escAttr(e.url || '')}" />
        <input class="txt" id="pjRepo" placeholder="GitHub repo (optional)" value="${escAttr(e.repo || '')}" />
      </div>
      <input class="txt" id="pjPath" placeholder="Local folder — e.g. \\\\wsl.localhost\\<distro>\\home\\<you>\\project" value="${escAttr(e.localPath || '')}" />
      <textarea id="pjNotes" class="txt" rows="2" spellcheck="true" placeholder="What matters here, and what she must never touch.">${esc(e.notes || '')}</textarea>
      <textarea id="pjEthos" class="txt" rows="2" spellcheck="true" placeholder="Taste specific to this project (optional) — she refines this over time.">${esc(e.ethos || '')}</textarea>
      <div class="lp-act"><button class="prime-btn" id="pjSave">Save project</button><button class="mini" id="pjCancel">cancel</button></div>
    </div>`;
}

function wireDuo(r, L, projects) {
  const d = r.duo || {};
  $$('#duoBody [data-dtab]').forEach((b) => b.onclick = () => { CUR.duoTab = b.dataset.dtab; CUR.loopEdit = null; CUR.projEdit = null; loadDuo(); });
  $$('#duoBody [data-wloop]').forEach((b) => b.onclick = () => { CUR.workLoop = b.dataset.wloop; loadDuo(); });
  // every file she touched in the work ledger opens with one click — an output
  // he cannot open is a claim, not a deliverable
  $$('#duoBody [data-open-file]').forEach((b) => b.onclick = async () => {
    const r = await C.openPath(b.dataset.openFile, false).catch(() => null);
    toast(r && r.ok !== false ? 'Opening ' + b.dataset.openFile.split(/[\\/]/).pop() : 'Could not open it', r && r.ok !== false ? 'good' : 'bad');
  });

  const t = $('#duoToggle');
  if (t) t.onclick = async () => {
    const next = !d.active;
    if (next && !confirm(`Start Duo-Drive with ${aname($('#duoAgent').value || d.agent)}?\n\nShe will run your armed loops on their cadences — small, high-confidence refinements only. Every move is logged with what changed and how sure she was. She obeys the Stop button and your token budget, and she will never make a drastic change on autopilot.`)) return;
    await C.duo({ active: next, agent: $('#duoAgent').value, brief: $('#duoBrief').value });
    toast(next ? 'Duo-Drive running ▶' : 'Duo-Drive stopped', next ? 'good' : 'warn');
    await refreshControl(); loadDuo();
  };
  const sv = $('#duoSave');
  if (sv) sv.onclick = async () => { await C.duo({ agent: $('#duoAgent').value, brief: $('#duoBrief').value }); toast('Saved ✓', 'good'); };
  const nowBtn = $('#duoNow');
  if (nowBtn) nowBtn.onclick = async () => {
    nowBtn.disabled = true; nowBtn.textContent = '… working';
    const res = await C.duoPass();
    nowBtn.disabled = false; nowBtn.textContent = '✦ Run a pass now';
    toast(res && res.ok ? (res.skipped ? 'She judged there was nothing worth doing' : 'Pass complete ✓') : 'Pass failed: ' + ((res && res.error) || '?'), res && res.ok ? 'good' : 'bad');
    loadDuo();
  };

  // --- loops ---
  const nl = $('#loopNew');
  if (nl) nl.onclick = () => { CUR.loopEdit = { kind: 'refine', cadenceMin: 60, confidenceMin: 8, projectIds: [] }; loadDuo(); };
  const inv = $('#loopInvent');
  if (inv) inv.onclick = async () => {
    inv.disabled = true; inv.textContent = '… she is thinking';
    const res = await C.loopInvent();
    inv.disabled = false; inv.textContent = '✦ Ask her to design one';
    if (res && res.ok) { toast(`She proposed “${res.loop.name}” — approve it to arm it`, 'good'); CUR.duoTab = 'loops'; }
    else toast('No loop this time: ' + ((res && res.error) || '?'), 'warn');
    loadDuo();
  };
  const readLoop = () => ({
    id: (CUR.loopEdit || {}).id,
    name: $('#lpName') ? $('#lpName').value : '',
    kind: $('#lpKind') ? $('#lpKind').value : 'refine',
    cadenceMin: $('#lpCad') ? +$('#lpCad').value : 60,
    confidenceMin: $('#lpConf') ? +$('#lpConf').value : 8,
    instruction: $('#lpInst') ? $('#lpInst').value : '',
    projectIds: (CUR.loopEdit || {}).projectIds || [],
    approved: true, origin: (CUR.loopEdit || {}).origin || 'operator',
    rationale: (CUR.loopEdit || {}).rationale || '',
    enabled: (CUR.loopEdit || {}).enabled !== false,
  });
  $$('#duoBody [data-lpproj]').forEach((b) => b.onclick = () => {
    const cur = readLoop(); const id = b.dataset.lpproj;
    cur.projectIds = cur.projectIds.includes(id) ? cur.projectIds.filter((x) => x !== id) : [...cur.projectIds, id];
    CUR.loopEdit = cur; loadDuo();
  });
  const lps = $('#lpSave');
  if (lps) lps.onclick = async () => {
    const def = readLoop();
    if (!def.name.trim()) { toast('Name the loop', 'bad'); return; }
    const res = await C.loopSave(def);
    if (res && res.ok) { toast('Loop saved ✓', 'good'); CUR.loopEdit = null; loadDuo(); }
    else toast('Could not save: ' + ((res && res.error) || '?'), 'bad');
  };
  const lpc = $('#lpCancel'); if (lpc) lpc.onclick = () => { CUR.loopEdit = null; loadDuo(); };
  $$('#duoBody [data-loop-edit]').forEach((b) => b.onclick = () => {
    CUR.loopEdit = JSON.parse(JSON.stringify((L.loops || []).find((x) => x.id === b.dataset.loopEdit) || {}));
    CUR.duoTab = 'loops'; loadDuo();
  });
  const act = async (id, action, msg) => { const res = await C.loopAct(id, action); if (res && res.ok) { toast(msg, 'good'); loadDuo(); } };
  $$('#duoBody [data-loop-approve]').forEach((b) => b.onclick = () => act(b.dataset.loopApprove, 'approve', 'Approved and armed ✓'));
  $$('#duoBody [data-loop-toggle]').forEach((b) => b.onclick = () => act(b.dataset.loopToggle, 'toggle', 'Updated'));
  $$('#duoBody [data-loop-del]').forEach((b) => b.onclick = () => {
    if (!confirm('Delete this loop? Work it already produced stays in the ledger.')) return;
    act(b.dataset.loopDel, 'delete', 'Deleted');
  });
  $$('#duoBody [data-loop-run]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = '… running';
    const res = await C.loopRun(b.dataset.loopRun);
    toast(res && res.ok ? (res.entry && res.entry.skipped ? 'She judged there was nothing worth doing' : 'Loop pass complete ✓') : 'Failed: ' + ((res && res.error) || '?'), res && res.ok ? 'good' : 'bad');
    loadDuo();
  });

  // --- projects ---
  const pn = $('#projNew');
  if (pn) pn.onclick = () => { CUR.projEdit = {}; loadDuo(); };
  const pjs = $('#pjSave');
  if (pjs) pjs.onclick = async () => {
    const def = { id: (CUR.projEdit || {}).id, name: $('#pjName').value, url: $('#pjUrl').value,
      repo: $('#pjRepo').value, localPath: $('#pjPath').value, notes: $('#pjNotes').value, ethos: $('#pjEthos').value };
    if (!def.name.trim()) { toast('Name the project', 'bad'); return; }
    const res = await C.projectSave(def);
    if (res && res.ok) { toast('Project saved ✓', 'good'); CUR.projEdit = null; loadDuo(); }
    else toast('Could not save: ' + ((res && res.error) || '?'), 'bad');
  };
  const pjc = $('#pjCancel'); if (pjc) pjc.onclick = () => { CUR.projEdit = null; loadDuo(); };
  $$('#duoBody [data-proj-edit]').forEach((b) => b.onclick = () => {
    CUR.projEdit = JSON.parse(JSON.stringify(projects.find((x) => x.id === b.dataset.projEdit) || {})); loadDuo();
  });
  $$('#duoBody [data-proj-toggle]').forEach((b) => b.onclick = async () => { await C.projectAct(b.dataset.projToggle, 'toggle'); loadDuo(); });
  $$('#duoBody [data-proj-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('Remove this project? She will stop touching it.')) return;
    await C.projectAct(b.dataset.projDel, 'delete'); toast('Removed', 'good'); loadDuo();
  });

  // --- ethos ---
  const es = $('#ethosSave');
  if (es) es.onclick = async () => { await C.saveEthos($('#ethosBox').value); toast('Ethos saved — every design loop reads this ✓', 'good'); };
}

async function _loadDuoLegacy() {
  const r = await C.duo();
  if (!r || r.error) return;
  const d = r.duo || {};
  setHTML($('#duoBody'), `
    <div class="view-head"><h2>Duo-Drive</h2>
      <p class="view-desc">Pick an agent to work <b>alongside</b> you. It runs on its own cadence, reads what actually changed since its last pass, and does the work you are not doing — then tells you the one next move.</p></div>
    <div class="duo-hero glass-deep ${d.active ? 'on' : ''}">
      <div class="dh-orb ${d.active ? 'live' : ''}"><span></span></div>
      <div class="dh-mid">
        <div class="dh-state">${d.active ? `Running with ${esc(aname(d.agent))}` : 'Duo-Drive is off'}</div>
        <div class="dh-sub">${d.active
          ? `Next pass ${d.lastRun ? 'about ' + Math.max(0, Math.round((d.cadenceMin * 60000 - (Date.now() - d.lastRun)) / 60000)) + 'm from now' : 'shortly'} · ${d.runs || 0} pass${(d.runs || 0) === 1 ? '' : 'es'} so far`
          : 'It will never act while the fleet is stopped, and every pass is logged here.'}</div>
      </div>
      <button class="prime-btn ${d.active ? 'danger' : ''}" id="duoToggle">${d.active ? '■ Stop Duo-Drive' : '▶ Start Duo-Drive'}</button>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>How it drives</h3><span class="panel-sub">its stance on every pass</span></div>
      <div class="duo-modes">
        ${(r.modes || []).map((m) => `
          <button class="dmode ${d.mode === m.id ? 'on' : ''} ${m.id === 'motivus' ? 'motivus' : ''}" data-dmode="${m.id}">
            <span class="dm-t">${m.id === 'motivus' ? '✶ Motus Motivus' : esc(cap(m.id))}</span><span class="dm-d">${esc(m.desc)}</span></button>`).join('')}
      </div>
      <p class="om-p" style="padding:0 4px 4px">Every stance but one is deliberately conservative — small, surgical, reversible. <b>Motus Motivus is the one that is allowed to be big:</b> it reads the whole map, names the loop and the Meadows rung, and takes the highest-leverage move it can actually reach. Same guardrails, higher aim.</p>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Partner &amp; cadence</h3></div>
      <div class="duo-cfg">
        <div class="dc-item"><label class="fr-lbl">Agent</label>
          <select id="duoAgent" class="sel">${(r.fleet || []).map((f) => `<option value="${f.id}" ${d.agent === f.id ? 'selected' : ''}>${esc(f.name)} · ${esc(mlabel(f.model))}</option>`).join('')}</select></div>
        <div class="dc-item"><label class="fr-lbl">Pass every</label>
          <select id="duoCad" class="sel">${[10, 15, 25, 40, 60, 120].map((n) => `<option value="${n}" ${d.cadenceMin === n ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></div>
        <div class="dc-item wide"><label class="fr-lbl">Standing brief <span class="fr-hint">what it should always keep in mind</span></label>
          <textarea id="duoBrief" rows="2" spellcheck="true" placeholder="e.g. We are building the CortexInsight command center. Prefer resilience over new surface. Never touch the relay without a backup.">${esc(d.brief || '')}</textarea></div>
        <div class="dc-act"><button class="ghost-btn" id="duoSave">Save</button><button class="ghost-btn" id="duoNow">✦ Run a pass now</button></div>
      </div>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Pass log</h3><span class="panel-sub">what it actually did, every time</span>
        <button class="clear-btn" data-clear="duo" data-clear-label="the Duo-Drive log">✕ clear</button></div>
      ${(d.log || []).length ? capList('duolog', d.log, (l) => `
        <div class="dlog ${l.ok ? '' : 'bad'} expandable" data-body="${escAttr(l.body || '')}" data-rtitle="${escAttr(l.title)}" data-rsub="${esc(aname(l.agent))} · ${esc(l.ts)} · ${l.reason}">
          <div class="dl-top"><span class="dl-agent tone-${TONE[l.agent] || 'slate'}">${esc(aname(l.agent))}</span>
            <span class="dl-when mono">${ago(l.ts)} ago</span><span class="dl-why">${esc(l.reason || '')}</span></div>
          <div class="dl-title">${esc(l.title)}</div>
          <div class="dl-body">${esc(l.body || '')}</div>
          <div class="dl-act"><span class="dl-more">click to expand</span><button class="mini read" data-read="1">⤢ read full</button></div>
        </div>`) : '<div class="empty">No passes yet. Start Duo-Drive, or run one pass now to see how it works.</div>'}
    </div>`);

  const t = $('#duoToggle');
  if (t) t.onclick = async () => {
    const next = !d.active;
    if (next && !confirm(`Start Duo-Drive with ${aname($('#duoAgent').value || d.agent)}?\n\nIt will run a pass every ${$('#duoCad').value || d.cadenceMin} minutes on its own, doing real work alongside you. Every pass is logged, it obeys the fleet Stop button, and you can turn it off at any time.`)) return;
    await C.duo({ active: next, agent: $('#duoAgent').value, cadenceMin: $('#duoCad').value, brief: $('#duoBrief').value });
    toast(next ? 'Duo-Drive running ▶' : 'Duo-Drive stopped', next ? 'good' : 'warn');
    await refreshControl(); loadDuo();
  };
  $$('#duoBody [data-dmode]').forEach((b) => b.onclick = async () => { await C.duo({ mode: b.dataset.dmode }); loadDuo(); });
  const sv = $('#duoSave');
  if (sv) sv.onclick = async () => {
    await C.duo({ agent: $('#duoAgent').value, cadenceMin: $('#duoCad').value, brief: $('#duoBrief').value });
    toast('Saved ✓', 'good'); loadDuo();
  };
  const nowBtn = $('#duoNow');
  if (nowBtn) nowBtn.onclick = async () => {
    nowBtn.disabled = true; nowBtn.textContent = '… working';
    const res = await C.duoPass();
    nowBtn.disabled = false; nowBtn.textContent = '✦ Run a pass now';
    toast(res && res.ok ? 'Pass complete ✓' : 'Pass failed: ' + ((res && res.error) || '?'), res && res.ok ? 'good' : 'bad');
    loadDuo();
  };
}

/* ============================================================== USAGE (REAL)
   Real metered tokens from the Claude Code transcripts — 5-hour and weekly
   windows, per model. Honest about what it can and cannot know.                */
function usageBar(label, used, capv, tone) {
  const pct = capv > 0 ? Math.min(100, (used / capv) * 100) : 0;
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'ok';
  return `<div class="ubar">
    <div class="ub-top"><span class="ub-l">${esc(label)}</span>
      <span class="ub-v mono">${compact(used)}${capv > 0 ? ` / ${compact(capv)}` : ''}</span></div>
    <div class="ub-track"><div class="ub-fill ${capv > 0 ? cls : 'none'} tone-${tone}" style="width:${capv > 0 ? pct : Math.min(100, used / 1000)}%"></div></div>
    ${capv > 0 ? `<div class="ub-pct ${cls}">${Math.round(pct)}% of your cap</div>` : `<div class="ub-pct none">no cap set — set one below to get warnings</div>`}
  </div>`;
}
async function loadUsage() {
  const u = await C.usageReal();
  if (!u || u.error) return viewFail('usage', u || null);
  const win = u[CUR.usageWin] || u.fiveH;
  const winLabel = { fiveH: 'last 5 hours', day: 'last 24 hours', week: 'last 7 days' }[CUR.usageWin] || 'window';
  const maxSpark = Math.max(1, ...u.spark.map((s) => s.out));

  setHTML($('#usageBody'), `
    <div class="view-head"><h2>Usage</h2>
      <p class="view-desc">Real metered tokens — read from the actual <code>usage</code> blocks in your Claude Code sessions, not estimated.</p></div>

    <div class="upanel glass-deep">
      <div class="up-head"><div class="up-t">Consumption windows</div>
        <div class="up-tabs">
          ${[['fiveH', '5 hours'], ['day', '24 hours'], ['week', '7 days']].map(([k, l]) =>
            `<button class="chip ${CUR.usageWin === k ? 'on' : ''}" data-uw="${k}">${l}</button>`).join('')}
        </div></div>
      <div class="up-bars">
        ${usageBar('Output tokens · 5-hour window', u.fiveH.out, u.budget.fiveHour, 'violet')}
        ${usageBar('Output tokens · weekly window', u.week.out, u.budget.weekly, 'cyan')}
      </div>
      <div class="up-stats">
        <div class="us"><span class="us-v mono">${compact(win.out)}</span><span class="us-l">output tok · ${winLabel}</span></div>
        <div class="us"><span class="us-v mono">${compact(win.in)}</span><span class="us-l">input tok</span></div>
        <div class="us"><span class="us-v mono">${compact(win.cacheRead)}</span><span class="us-l">cache reads (cheap)</span></div>
        <div class="us"><span class="us-v mono">${win.turns}</span><span class="us-l">assistant turns</span></div>
        <div class="us"><span class="us-v mono">${compact(u.burnPerHour)}</span><span class="us-l">output tok / hour</span></div>
        <div class="us"><span class="us-v mono">${compact(u.week.out)}</span><span class="us-l">output tok · week</span></div>
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>By model</h3><span class="panel-sub">${winLabel} · includes Fable 5 separately, as you asked</span></div>
      ${(win.byModel || []).length ? (win.byModel || []).map((m) => {
        const share = win.out ? (m.out / win.out) * 100 : 0;
        return `<div class="umrow">
          <div class="um-l"><div class="um-name">${esc(mlabel(m.model))}</div><div class="um-id mono">${esc(m.model)}</div></div>
          <div class="um-bar"><div class="um-fill" style="width:${share}%"></div></div>
          <div class="um-nums mono">${compact(m.out)} out · ${compact(m.in)} in · ${m.turns} turns</div>
          <div class="um-share mono">${Math.round(share)}%</div>
        </div>`;
      }).join('') : '<div class="empty">No metered turns in this window.</div>'}
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Last 24 hours</h3><span class="panel-sub">output tokens per hour</span></div>
      <div class="uspark">${u.spark.map((s) => `<div class="usp" style="height:${Math.max(2, (s.out / maxSpark) * 100)}%" title="${s.turns} turns · ${compact(s.out)} output tokens"></div>`).join('')}</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Your caps</h3><span class="panel-sub">soft limits, so you get a warning before you are surprised</span></div>
      <div class="ucaps">
        <div class="uc"><label class="fr-lbl">5-hour output cap</label><input id="capFive" class="num" type="number" min="0" step="10000" value="${u.budget.fiveHour}" /></div>
        <div class="uc"><label class="fr-lbl">Weekly output cap</label><input id="capWeek" class="num" type="number" min="0" step="100000" value="${u.budget.weekly}" /></div>
        <div class="uc"><button class="prime-btn" id="capSave">Save caps</button></div>
      </div>
      <div class="uhonest">
        <b>Straight answer about limits:</b> your Claude subscription's real 5-hour and weekly caps are not published anywhere on this machine — not by the CLI, not in a cache, not in a response header. I checked. So rather than show you an invented percentage, this screen meters your <b>real consumption</b> in exactly those windows and compares it to caps <i>you</i> set. Fable 5 is broken out separately above. ${esc(u.note)}
      </div>
    </div>`);

  $$('#usageBody [data-uw]').forEach((b) => b.onclick = () => { CUR.usageWin = b.dataset.uw; loadUsage(); });
  const cs = $('#capSave');
  if (cs) cs.onclick = async () => {
    const res = await C.setBudget({ fiveHour: $('#capFive').value, weekly: $('#capWeek').value });
    toast(res && res.ok ? 'Caps saved ✓' : 'Could not save', res && res.ok ? 'good' : 'bad');
    loadUsage();
  };
}

/* ============================================================ SYSTEMS LENS 2
   The systems-thinking instrument: the live system as stocks/flows/loops, the
   iceberg descent, and a leverage ladder wired to controls that really exist. */
const ICEBERG = [
  { k: 'Events', d: 'What just happened. Reacting here is the most expensive place to work.', power: 1 },
  { k: 'Patterns', d: 'What keeps happening. Here you can anticipate instead of react.', power: 3 },
  { k: 'Structure', d: 'What produces the pattern. Here you redesign and the pattern stops recurring.', power: 7 },
  { k: 'Mental models', d: 'The belief holding the structure in place. Change this and everything downstream moves.', power: 10 },
];
async function loadSystems() {
  // `learn.patterns` is what the app noticed happening MORE THAN ONCE. It
  // already rides in every agent brief and every Duo-Drive loop; this screen was
  // the last place still reading only the CURRENT gauges. A gauge tells you
  // where the system is. A repeat tells you where its structure is wrong — and
  // that is a strictly higher rung, so it belongs above everything else here.
  const [ov, u, r, sub, wf, learn, dyn] = await Promise.all([C.overview(), C.usageReal(), C.fleet(), C.subagents('all'), C.workflows(), C.learnings(), C.dynamics ? C.dynamics() : null]);
  if (!ov || ov.error) return viewFail('systems', ov || null);
  const agents = (r && r.fleet) || relayFleet();
  const running = (sub && sub.running) || 0;
  BRIDGE = (r && r.bridge) || BRIDGE;

  // Real stocks, measured — not decorative.
  const stocks = [
    { name: 'Attention', v: (ov.motus ? 1 : 0) + (ov.goal ? 1 : 0), unit: '/2 focuses set',
      note: ov.motus ? 'A Motus is named — the fleet has a prime mover.' : 'No Motus set: every agent is optimising against a weaker signal.', good: !!ov.motus },
    { name: 'Momentum', v: (u && u.fiveH && u.fiveH.turns) || 0, unit: 'turns / 5h',
      note: 'Flow rate through the relay right now.', good: ((u && u.fiveH && u.fiveH.turns) || 0) > 0 },
    { name: 'Compounded learning', v: (ov.learnCount != null ? ov.learnCount : '—'), unit: 'learnings banked',
      note: 'Every incident paid for once, not twice.', good: true },
    { name: 'Open loops', v: (ov.openNext != null ? ov.openNext : '—'), unit: 'next-steps open',
      note: 'Unclosed loops are a stock too — they drain attention while they sit.', good: true },
    { name: 'Parallelism', v: running, unit: 'subagents running',
      note: running ? 'The fleet is genuinely fanned out.' : 'Serial right now — one mind at a time.', good: running > 0 },
    { name: 'Fleet depth', v: agents.filter((a) => a.effort === 'max' || a.effort === 'xhigh').length, unit: `of ${agents.length} at high depth`,
      note: 'Depth is compute you chose to spend on thinking.', good: true },
  ];

  const LADDER = [
    { n: 2, rung: 'Paradigm', what: 'What we believe the system is FOR.', ctl: 'Goal + Motus', view: 'motus',
      state: ov.motus ? `“${String(ov.motus.text).slice(0, 70)}”` : 'not set' },
    { n: 3, rung: 'Goals', what: 'What the fleet is actually optimising.', ctl: 'The Board + standing brief', view: 'tasks', state: 'assignable per agent' },
    { n: 4, rung: 'Self-organisation', what: 'Power to add or change loops.', ctl: 'Workflows + subagent fan-out', view: 'workflows', state: 'compose your own progressions' },
    { n: 5, rung: 'Rules', what: 'Incentives, constraints, permissions.', ctl: 'Quality mode + turn budgets + pause', view: 'models',
      state: `${agents.filter((a) => a.paused).length} paused · depth set per agent` },
    { n: 6, rung: 'Information flows', what: 'Who sees what, and when.', ctl: 'Live · Subagents · Board · Usage', view: 'live', state: 'every agent, both lanes' },
    { n: 7, rung: 'Reinforcing loops', what: 'What compounds.', ctl: 'Duo-Drive + recursive learnings', view: 'duo',
      state: CONTROL.duo && CONTROL.duo.active ? 'Duo-Drive is compounding' : 'Duo-Drive off' },
    { n: 8, rung: 'Balancing loops', what: 'What resists change.', ctl: 'Sympath healing loop', view: 'sympath', state: 'diagnose → propose → verify' },
    { n: 9, rung: 'Delays', what: 'Where cause outruns effect.', ctl: 'Latency + hang detection', view: 'usage', state: `${Math.round((ov.avgLatency || 0))}s median turn` },
    { n: 10, rung: 'Stock-flow structure', what: 'The plumbing itself.', ctl: 'Model assignment per agent', view: 'models', state: 'per-agent brains' },
    { n: 12, rung: 'Parameters', what: 'Numbers. Mostly theatre.', ctl: 'Poll interval, caps', view: 'settings', state: 'tune last' },
  ];

  // ---- ACTIONABLE DIAGNOSIS -------------------------------------------------
  // Systems thinking is worthless as decoration. Each item below is a real
  // structural reading of the live system WITH the lever attached, highest
  // leverage first — Meadows' own ordering, not a to-do list.
  const burn = (u && u.burnPerHour) || 0;
  const deepAgents = agents.filter((a) => a.lane === 'relay' && (a.effort === 'max' || a.effort === 'xhigh'));
  const acts = [];
  if (!ov.motus) acts.push({ rung: 2, sev: 'high', t: 'No Motus is set — the fleet is optimising against a weaker signal',
    why: 'Rung 2 is the paradigm: what the system is FOR. Every agent weighs its moves against the Motus first. Without one, six agents each guess at your priority.',
    do: 'Name the prime mover', act: 'goto:motus' });
  if (!ov.goal) acts.push({ rung: 3, sev: 'medium', t: 'No long-term goal set',
    why: 'Rung 3 is the goal of the system. Reflections and next-steps are scored against it; with none, learning has nothing to compound toward.',
    do: 'Set the north star', act: 'goto:goal' });
  if (!BRIDGE.installed) acts.push({ rung: 5, sev: 'high', t: 'Per-agent rules are not in force yet',
    why: 'Rung 5 is rules — who is allowed what depth and which brain. Your per-agent choices are saved but the runner still applies one global pin, so the whole fleet behaves identically.',
    do: 'Install the fleet bridge', act: 'bridge' });
  if (!(CONTROL.duo && CONTROL.duo.active)) acts.push({ rung: 7, sev: 'medium', t: 'No reinforcing loop is running',
    why: 'Rung 7 is reinforcing-loop gain — the thing that compounds while you sleep. Right now progress stops exactly when you stop.',
    do: 'Start Duo-Drive', act: 'goto:duo' });
  if (!running) acts.push({ rung: 4, sev: 'medium', t: 'The fleet is serial, not parallel',
    why: 'Rung 4 is self-organisation: the power to add loops. Davara and Davaris can fan out into subagents but never do unless asked — so coverage is one mind wide.',
    do: 'Fan out a subagent fleet', act: 'goto:subagents' });
  if (!(wf && wf.workflows && wf.workflows.length)) acts.push({ rung: 4, sev: 'low', t: 'No progressions defined',
    why: 'Handoffs you repeat by hand are structure waiting to be encoded. A workflow makes the good sequence the default one.',
    do: 'Build one from a seed', act: 'goto:workflows' });
  if (burn > 0 && !(u.budget.fiveHour)) acts.push({ rung: 6, sev: 'medium', t: `Burning ~${compact(burn)} output tokens/hour with no cap set`,
    why: 'Rung 6 is information flow: you cannot steer what you cannot see. Depth costs tokens, and the 5-hour window is your real constraint — not turn count.',
    do: 'Set a soft cap', act: 'goto:usage' });
  if (deepAgents.length >= 4 && burn > 60000) acts.push({ rung: 5, sev: 'medium', t: `${deepAgents.length} agents are at max depth while burn is high`,
    why: 'Depth is compute. Running the whole fleet at ULTRACODE is the fastest way to hit your window — spend depth where thinking is hard, not everywhere.',
    do: 'Rebalance quality', act: 'goto:models' });
  if ((ov.openNext || 0) > 40) acts.push({ rung: 11, sev: 'low', t: `${ov.openNext} next-steps are open`,
    why: 'Unclosed loops are a stock that drains attention while it sits. Past a point the ledger stops being a plan and becomes noise.',
    do: 'Triage or clear the ledger', act: 'goto:nextsteps' });
  // One failure is an event; the same failure twice is a structure. Parsed into
  // claim + consequence so the panel states what keeps happening AND what it
  // means, rather than echoing a log line.
  const pats = ((learn && learn.patterns) || []).map((line) => {
    const t = String(line).replace(/^[-•]s*/, '').trim();
    // ⚠ LAST occurrence, not the first. A pattern quotes the task's own title,
    // and titles contain em-dashes — splitting on the first one cut a title in
    // half and left an orphan quote mark on screen. The consequence clause is
    // always the final segment, so that is the only reliable seam.
    const i = t.lastIndexOf(' — ');
    return i > 0 ? { what: t.slice(0, i), why: t.slice(i + 3) } : { what: t, why: '' };
  }).filter((p) => p.what);

  const sevRank = { high: 0, medium: 1, low: 2 };
  acts.sort((a, b) => (a.rung - b.rung) || (sevRank[a.sev] - sevRank[b.sev]));

  setHTML($('#sysBody'), `
    <div class="view-head"><h2>Systems Lens</h2>
      <p class="view-desc">This system seen as it actually behaves — stocks that accumulate, loops that move them, delays that fool you, and the leverage points that are real controls in this app.</p></div>
    ${dynBand(dyn)}

    <div class="panel glass">
      <div class="panel-head"><h3>Act here first</h3>
        <span class="panel-sub">${pats.length ? pats.length + ' structural repeat(s) · then the live gauges' : (acts.length ? 'read from the live system · highest leverage first' : 'nothing structural is asking for you')}</span></div>
      ${pats.length ? `<div class="pat-band">
        <div class="pb-h"><span class="pb-glyph">⟲</span><b>What keeps happening</b>
          <span class="pb-sub">seen more than once — the fleet reads these too, in every brief and every Duo pass</span></div>
        ${pats.map((p) => `<div class="pat-row">
          <div class="pr-t">${esc(p.what)}</div>
          ${p.why ? `<div class="pr-w">${esc(p.why)}</div>` : ''}
        </div>`).join('')}
        <div class="pb-f">A gauge says where the system <i>is</i>. A repeat says where its <b>structure</b> is wrong — attack the pattern, not the instance.</div>
      </div>` : ''}
      ${acts.length ? `<div class="acts">${acts.map((a) => `
        <div class="act s-${a.sev}">
          <div class="ac-rung mono" title="Meadows leverage rung">${a.rung}</div>
          <div class="ac-mid">
            <div class="ac-t">${esc(a.t)}</div>
            <div class="ac-why">${esc(a.why)}</div>
          </div>
          <button class="prime-btn ac-go" data-act="${a.act}">${esc(a.do)}</button>
        </div>`).join('')}</div>`
      : `<div class="allclear">Every structural lever this screen can see is already pulled: a Motus and goal are set, per-agent rules are in force, a reinforcing loop is running and the fleet can fan out. Nothing here is theatre — when something slips, it reappears at the top of this list.</div>`}
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Stocks — what is accumulating right now</h3><span class="panel-sub">measured, not decorative</span></div>
      <div class="stocks">
        ${stocks.map((s) => `
          <div class="stock ${s.good ? '' : 'thin'}">
            <div class="st-v mono">${s.v}</div>
            <div class="st-n">${esc(s.name)}</div>
            <div class="st-u">${esc(s.unit)}</div>
            <div class="st-note">${esc(s.note)}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>The iceberg — descend before you act</h3>
        <span class="panel-sub">most failures are structural problems answered at event level</span></div>
      <div class="iceberg">
        ${ICEBERG.map((i, ix) => `
          <div class="ice ice-${ix}">
            <div class="ic-l"><span class="ic-k">${esc(i.k)}</span><span class="ic-p mono">leverage ${i.power}/10</span></div>
            <div class="ic-d">${esc(i.d)}</div>
          </div>`).join('')}
      </div>
      <div class="ice-q">Ask, every time: <b>what structure makes this event inevitable?</b> Then go one layer deeper — to the belief that built the structure.</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Leverage ladder</h3>
        <span class="panel-sub">Meadows, strongest first — every rung is a control you can actually reach here</span></div>
      <div class="ladder">
        ${LADDER.map((l) => `
          <div class="rung r${l.n <= 4 ? 'hi' : l.n <= 8 ? 'mid' : 'lo'}" data-goview="${l.view}">
            <div class="rg-n mono">${l.n}</div>
            <div class="rg-mid">
              <div class="rg-name">${esc(l.rung)}</div>
              <div class="rg-what">${esc(l.what)}</div>
            </div>
            <div class="rg-ctl"><div class="rg-c">${esc(l.ctl)}</div><div class="rg-s">${esc(l.state)}</div></div>
            <div class="rg-go">→</div>
          </div>`).join('')}
      </div>
      <div class="ladder-note"><b>The counterintuitive part:</b> almost everyone pushes rung 12 (numbers). The real lever lives at 2–6 — change what the system is <i>for</i>, who <i>sees</i> what, and what is <i>rewarded</i>. The rungs above are ordered so the strongest is first, not last.</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Second order — “and then what?”</h3><span class="panel-sub">three iterations, on the choices live in this system</span></div>
      <div class="secondorder">
        ${[
          { a: 'Every agent moves to Opus 5 at high depth', b: 'turns get deeper and slower', c: 'token burn per turn rises', d: 'the 5-hour window becomes the real constraint — so set a cap and watch the burn rate, not the turn count' },
          { a: 'Duo-Drive runs continuously', b: 'work compounds without you', c: 'the log becomes the real record of progress', d: 'read the pass log before starting your own session, or you will duplicate your partner' },
          { a: 'Subagents fan out widely', b: 'coverage improves fast', c: 'synthesis becomes the bottleneck', d: 'the parent\'s synthesis quality now matters more than the number of subagents — depth on the parent beats width on the fleet' },
        ].map((s) => `
          <div class="so">
            <div class="so-a">${esc(s.a)}</div><div class="so-ar">→</div>
            <div class="so-b">${esc(s.b)}</div><div class="so-ar">→</div>
            <div class="so-c">${esc(s.c)}</div><div class="so-ar">→</div>
            <div class="so-d">${esc(s.d)}</div>
          </div>`).join('')}
      </div>
    </div>`);

  $$('#sysBody [data-goview]').forEach((el) => el.onclick = () => switchView(el.dataset.goview));
  // the levers actually pull
  $$('#sysBody [data-act]').forEach((b) => b.onclick = async () => {
    const a = b.dataset.act;
    if (a.startsWith('goto:')) { switchView(a.slice(5)); return; }
    if (a === 'bridge') {
      if (!confirm('Install the fleet bridge?\n\nOne guarded, additive block in cortex-run.sh so each agent uses its own model and depth. Backed up, syntax-verified, auto-rolled-back on error, removable in one click.')) return;
      b.disabled = true; b.textContent = 'Installing…';
      const res = await C.bridge('install');
      toast(res && res.ok ? 'Bridge installed ✓' : 'Failed: ' + ((res && res.error) || '?'), res && res.ok ? 'good' : 'bad');
      await refreshFleet(); loadSystems();
    }
  });
}

/* ============================================================ AMBIENT FIELD v2
   Supersedes the v1 startField(). The v1 loop ran an uncapped requestAnimationFrame
   over a devicePixelRatio-scaled full-screen canvas FOREVER — even while the window
   was hidden or unfocused — and every frame forced the compositor to re-blur every
   backdrop-filter panel stacked above it. That combination was the machine-wide
   slowdown August felt. This version keeps the same look and:
     · renders at DPR 1 (it is a soft ambient field; 2× bought nothing visible)
     · caps to ~20fps instead of ~60  → about a third of the frames
     · STOPS DEAD when the window is hidden, minimised or unfocused
     · uses squared distances (no Math.sqrt) and a bounded link pass
   Net effect: idle GPU/CPU cost drops to roughly nothing when you are not looking. */
function startField() {
  const cv = $('#field'); if (!cv) return;
  const ctx = cv.getContext('2d', { alpha: true });
  const FPS = 20, FRAME_MS = 1000 / FPS, LINK_D2 = 148 * 148;
  let W = 0, H = 0, nodes = [], pulses = [], t = 0, last = 0, raf = 0, running = false;

  let stars = [], comet = null;
  function resize() {
    W = cv.width = innerWidth; H = cv.height = innerHeight;   // DPR 1 on purpose
    cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    const want = Math.min(26, Math.round((innerWidth * innerHeight) / 78000));
    nodes = [];
    for (let i = 0; i < want; i++) nodes.push({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .10, vy: (Math.random() - .5) * .10,
      r: Math.random() * 1.5 + .8,
    });
    // INTERSTELLAR: a real starfield. Positions are fixed (no per-frame motion
    // cost); only alpha breathes, and the whole thing rides the existing 20fps
    // loop that already stops when the window loses focus. No new timers, no
    // blur layers — the perf law holds.
    const sn = Math.min(170, Math.round((innerWidth * innerHeight) / 11000));
    stars = [];
    for (let i = 0; i < sn; i++) stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() < .88 ? Math.random() * .9 + .35 : Math.random() * 1.5 + 1.1,
      a: Math.random() * .5 + .18,
      tw: Math.random() * .022 + .004,     // twinkle rate
      ph: Math.random() * 6.283,
      hue: Math.random() < .16 ? 1 : 0,    // a few carry colour
    });
  }
  resize();
  addEventListener('resize', () => { resize(); if (running) draw(0); });

  function spawnPulse() {
    if (!nodes.length || pulses.length > 5) return;
    const a = nodes[(Math.random() * nodes.length) | 0], b = nodes[(Math.random() * nodes.length) | 0];
    if (a !== b) pulses.push({ a, b, p: 0 });
  }

  function paint() {
    t++;
    ctx.clearRect(0, 0, W, H);
    const fault = (typeof PULSE !== 'undefined' && PULSE.faulting);
    const rgbNode = fault ? '255,93,120' : '124,77,255';
    const rgbLink = fault ? '255,120,140' : '84,230,255';
    const intensity = .28 + ((typeof PULSE !== 'undefined' && PULSE.intensity) || 0) * .72;

    // ---- deep field: stars first, so the cortex lattice sits in front of them
    for (const s of stars) {
      const a = s.a * (0.62 + 0.38 * Math.sin(s.ph + t * s.tw));
      ctx.fillStyle = s.hue ? `rgba(180,205,255,${a})` : `rgba(255,255,255,${a})`;
      ctx.fillRect(s.x, s.y, s.r, s.r);        // fillRect beats arc() at this size
    }
    // a rare comet — the one piece of drama, and it costs nothing when absent
    if (!comet && t % 520 === 0 && Math.random() < .8) {
      const fromLeft = Math.random() < .5;
      comet = { x: fromLeft ? -60 : W + 60, y: Math.random() * H * .55,
        vx: (fromLeft ? 1 : -1) * (5.5 + Math.random() * 3), vy: 1.1 + Math.random() * 1.5, life: 1 };
    }
    if (comet) {
      comet.x += comet.vx; comet.y += comet.vy; comet.life -= .006;
      const tail = 90;
      const g = ctx.createLinearGradient(comet.x, comet.y, comet.x - comet.vx * tail / 6, comet.y - comet.vy * tail / 6);
      g.addColorStop(0, `rgba(200,230,255,${.85 * comet.life})`);
      g.addColorStop(1, 'rgba(200,230,255,0)');
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(comet.x, comet.y);
      ctx.lineTo(comet.x - comet.vx * tail / 6, comet.y - comet.vy * tail / 6); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${comet.life})`;
      ctx.beginPath(); ctx.arc(comet.x, comet.y, 1.7, 0, 6.283); ctx.fill();
      if (comet.life <= 0 || comet.x < -140 || comet.x > W + 140 || comet.y > H + 60) comet = null;
    }

    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > W) n.vx *= -1;
      if (n.y < 0 || n.y > H) n.vy *= -1;
    }
    // links — squared distance, single pass, no sqrt and no shadowBlur
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 > LINK_D2) continue;
        ctx.strokeStyle = `rgba(${rgbLink},${(1 - d2 / LINK_D2) * .16 * intensity})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const n of nodes) {
      ctx.fillStyle = `rgba(${rgbNode},${.5 * intensity})`;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 6.283); ctx.fill();
    }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; p.p += .014;
      if (p.p >= 1) { pulses.splice(i, 1); continue; }
      const x = p.a.x + (p.b.x - p.a.x) * p.p, y = p.a.y + (p.b.y - p.a.y) * p.p;
      ctx.fillStyle = `rgba(${rgbLink},${(1 - Math.abs(.5 - p.p) * 2) * .7})`;
      ctx.beginPath(); ctx.arc(x, y, 1.9, 0, 6.283); ctx.fill();
    }
    if (t % 90 === 0) spawnPulse();
  }

  function draw(ts) {
    if (!running) return;
    raf = requestAnimationFrame(draw);
    if (ts && ts - last < FRAME_MS) return;          // fps gate
    last = ts || 0;
    paint();
  }
  function start() {
    if (running) return;
    if (document.body.classList.contains('reduce-motion')) { ctx.clearRect(0, 0, W, H); return; }
    running = true; last = 0; raf = requestAnimationFrame(draw);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }
  // The whole point: no frames at all unless the window is genuinely in front.
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  addEventListener('blur', stop);
  addEventListener('focus', start);
  window.__fieldStop = stop; window.__fieldStart = start;
  start();
}

/* ==================================================== MOTUS & GOAL (v2)
   v1 rendered both pages from one identical scaffold: a textarea and a button,
   with nothing alive once set. They are not the same thing. The MOTUS is a
   gravity well — everything visibly orbits it or drifts from it. The GOAL is
   fixed sky: it changes rarely, and the Motus moves underneath it.
   Every panel below is built from data the app ALREADY has — zero extra turns. */
const FOCUS_V2 = {
  motus: { icon: '◆', title: 'Motus', tag: 'Prime mover · now',
    sub: 'The single strongest thing you are moving on right now. Shorter-horizon than the goal — naming it points every agent at the same push.',
    ph: 'e.g. Get MotusMoves.US launch-ready and onboard the first Davara Operators', cmd: '/motus' },
  goal: { icon: '◎', title: 'Goal', tag: 'North star · long-term',
    sub: 'Your north star. Reflections, next-steps and every Davara recommendation are weighed against it. It should change rarely.',
    ph: 'e.g. Master and teach systems thinking through the Motus platform', cmd: '/goal' },
};
async function loadFocusV2(which) {
  const host = $(which === 'motus' ? '#motusBody' : '#goalBody'); if (!host) return;
  const meta = FOCUS_V2[which];
  const [f, board, ov] = await Promise.all([C.focus(), C.board(), C.overview()]);
  if (!f || f.error) return viewFail(which, f);
  const cur = which === 'motus' ? f.motus : f.goal;
  const other = which === 'motus' ? f.goal : f.motus;
  const tasks = (board && board.tasks) || [];
  const done = tasks.filter((t) => t.status === 'done');
  const open = tasks.filter((t) => t.status !== 'done');
  const heldDays = cur && cur.ts ? Math.max(0, Math.floor((Date.now() - Date.parse(cur.ts)) / 864e5)) : 0;

  // ALIGNMENT — deterministic word-overlap between the focus and real work.
  // Not an LLM judgement: a cheap, honest signal of whether the fleet moved on it.
  const STOP = new Set(['the','and','for','with','that','this','our','from','into','all','are','was','has','get','set','out','new','use','can','will','make','more','than','then','now','you','your','they','their']);
  const bag = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
  const focusBag = bag(cur && cur.text);
  const score = (s) => { const b = bag(s); if (!focusBag.size || !b.size) return 0; let n = 0; for (const w of b) if (focusBag.has(w)) n++; return n / Math.min(b.size, focusBag.size); };
  const scored = tasks.map((t) => ({ t, s: score(t.title + ' ' + (t.body || '')) })).sort((a, b) => b.s - a.s);
  const aligned = scored.filter((x) => x.s >= 0.18);
  const drifting = scored.filter((x) => x.s < 0.06 && x.t.status !== 'done');
  const pct = tasks.length ? Math.round((aligned.length / tasks.length) * 100) : 0;

  const setPanel = `
    <div class="focus-set glass">
      <div class="fs-lbl">${cur ? 'Change it' : `Name your ${meta.title.toLowerCase()}`}</div>
      <textarea class="focus-input" id="focusInput-${which}" rows="2" placeholder="${escAttr(meta.ph)}" spellcheck="true">${esc(cur ? cur.text : '')}</textarea>
      <div class="focus-actions">
        <button class="prime-btn" id="focusSet-${which}">${meta.icon} ${cur ? 'Update' : 'Set'} ${meta.title.toLowerCase()}</button>
        <span class="focus-hint">or type <code>${meta.cmd} …</code> in Command${which === 'goal' && cur ? ' · a goal should change rarely' : ''}</span>
      </div>
      <div class="focus-status" id="focusStatus-${which}"></div>
    </div>`;

  setHTML(host, `
    <div class="view-head"><h2>${meta.title}</h2><p class="view-desc">${esc(meta.sub)}</p></div>

    <div class="focus-hero glass-deep f-${which} ${cur ? 'set' : 'empty'}">
      <div class="fh-glyph">${meta.icon}</div>
      <div class="fh-mid">
        <div class="fh-tag">${esc(meta.tag)}</div>
        <div class="fh-text">${cur ? esc(cur.text) : `Nothing set yet — every agent is optimising against a weaker signal.`}</div>
        ${cur ? `<div class="fh-meta">held <b>${heldDays === 0 ? 'today' : heldDays + ' day' + (heldDays === 1 ? '' : 's')}</b> · carried by ${esc(aname((cur && cur.agent) || 'davara'))}</div>` : ''}
      </div>
      ${cur ? `<div class="fh-ring"><div class="fhr-v">${pct}%</div><div class="fhr-l">of the board<br>orbits this</div></div>` : ''}
    </div>

    ${which === 'motus' ? `
      <div class="panel glass">
        <div class="panel-head"><h3>Alignment current</h3><span class="panel-sub">did the fleet actually MOVE on it — measured against your real board</span></div>
        ${cur ? `
          <div class="align">
            <div class="al-col">
              <div class="al-h ok">◆ Moving on it <span>${aligned.length}</span></div>
              ${aligned.length ? aligned.slice(0, 6).map((x) => `
                <div class="al-row ${x.t.status === 'done' ? 'is-done' : ''}">
                  <span class="al-dot"></span>
                  <span class="al-t" title="${escAttr(x.t.title)}">${esc(x.t.title)}</span>
                  <span class="al-s mono">${x.t.status}</span>
                </div>`).join('') : '<div class="al-empty">Nothing on the board matches this yet. Either the board or the Motus is out of date.</div>'}
            </div>
            <div class="al-col">
              <div class="al-h drift">◇ Drifting <span>${drifting.length}</span></div>
              ${drifting.length ? drifting.slice(0, 6).map((x) => `
                <div class="al-row">
                  <span class="al-dot d"></span>
                  <span class="al-t" title="${escAttr(x.t.title)}">${esc(x.t.title)}</span>
                  <span class="al-s mono">${x.t.status}</span>
                </div>`).join('') : '<div class="al-empty">Nothing open is pulling away from the Motus. Clean line.</div>'}
            </div>
          </div>
          <div class="al-note">Measured by word-overlap between this Motus and your real tasks — a deterministic signal, not an opinion, and it costs nothing to compute. ${done.length} of ${tasks.length} board items are finished.</div>`
        : '<div class="empty">Set a Motus and this fills with what is actually moving on it.</div>'}
      </div>` : `
      <div class="panel glass">
        <div class="panel-head"><h3>Bearing</h3><span class="panel-sub">how today's push serves the star</span></div>
        <div class="bearing">
          <div class="bg-item"><div class="bg-k">◎ Goal</div><div class="bg-v">${cur ? esc(cur.text) : 'not set'}</div></div>
          <div class="bg-arrow">↑ serves</div>
          <div class="bg-item"><div class="bg-k">◆ Motus</div><div class="bg-v">${other ? esc(other.text) : 'not set'}</div></div>
        </div>
        ${cur && other ? `<div class="bg-read ${score(other.text) >= 0.12 ? 'ok' : 'warn'}">${score(other.text) >= 0.12
          ? 'Your prime mover reads as on-bearing for the star.'
          : 'Your prime mover and your star do not visibly share language. That can be right — a stepping stone often looks unlike the destination — but it is worth a glance.'}</div>` : ''}
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>Evidence</h3><span class="panel-sub">what the system has actually banked toward it</span></div>
        <div class="up-stats">
          <div class="us"><span class="us-v mono">${heldDays}</span><span class="us-l">days held</span></div>
          <div class="us"><span class="us-v mono">${done.length}</span><span class="us-l">board items finished</span></div>
          <div class="us"><span class="us-v mono">${(ov && ov.learnCount) || 0}</span><span class="us-l">learnings banked</span></div>
        </div>
      </div>`}

    ${setPanel}`);

  const btn = $(`#focusSet-${which}`), ta = $(`#focusInput-${which}`), st = $(`#focusStatus-${which}`);
  if (btn) btn.onclick = async () => {
    const text = (ta.value || '').trim();
    if (!text) { toast(`Write the ${meta.title.toLowerCase()} first`, 'bad'); return; }
    if (which === 'goal' && cur && !confirm('Change your north star?\n\nA goal is meant to change rarely — everything the fleet learns is weighed against it.\n\nProceed?')) return;
    btn.disabled = true; if (st) st.textContent = 'Sending to Davara…';
    try {
      await C.send({ agent: 'davara', kind: which, text });
      if (st) st.textContent = '✓ Set — the fleet is holding it.';
      toast(`${meta.title} set ${meta.icon}`, 'good');
      setTimeout(() => loadFocusV2(which), 600);
    } catch (e) { if (st) st.textContent = 'Could not set — try again.'; toast('Failed to set', 'bad'); btn.disabled = false; }
  };
}
function loadMotus() { return loadFocusV2('motus'); }
function loadGoal() { return loadFocusV2('goal'); }

/* ====================================================== LEVELS (v2)
   Arden's page. v1 listed her reflections as flat ledger rows — a write-only
   shrine. Two additions, both zero-token and built from data already on hand:
     · THREAD OF SIGHT — for each observation, what actually changed in the 24h
       after it. That is the difference between a guardian and a diary.
     · her parsed CONVICTION, surfaced, so the loud ones are visibly loud.
   The felt descent into the held layer is pure CSS (see styles-v2.css). */
async function loadLevelsV2() {
  const host = $('#ardenReflections'); if (!host) return;
  const [log, board] = await Promise.all([C.ardenLog(), C.board()]);
  if (!log || log.error) return;
  const items = (log.items || []);
  if (!items.length) return;   // let v1's empty state stand
  const tasks = (board && board.tasks) || [];

  // What moved in the 24 hours after she spoke? Local join, no tokens.
  const after = (ts) => {
    const t0 = Date.parse(ts) || 0; if (!t0) return [];
    return tasks.filter((t) => {
      const u = Date.parse(t.updated || t.created || '') || 0;
      return u > t0 && u < t0 + 864e5;
    }).slice(0, 3);
  };
  const html = capList('ardenV2', items, (it) => {
    const moved = after(it.ts);
    const conv = it.conviction;
    return `
      <div class="ardv expandable" data-body="${escAttr(it.body || '')}" data-rtitle="${escAttr(it.title)}" data-rsub="Arden · ${esc(it.ts)}${conv ? ` · conviction ${conv}/10` : ''}">
        <div class="ad-top">
          <span class="ad-sym">${esc(it.symbol || '◈')}</span>
          <span class="ad-title">${esc(it.title)}</span>
          ${conv ? `<span class="ad-conv ${conv >= 8 ? 'hot' : ''}">${conv}/10</span>` : ''}
          <span class="ad-when mono">${ago(it.ts)} ago</span>
        </div>
        <div class="ad-body">${esc(String(it.body || ''))}</div>
        <div class="dl-act"><span class="dl-more">click to expand</span><button class="mini read" data-read="1">⤢ read full</button></div>
        <div class="ad-thread">
          <span class="ad-tl">thread of sight</span>
          ${moved.length
            ? moved.map((t) => `<span class="ad-mv" title="${escAttr(t.title)}">→ ${esc(t.title)} <em>${esc(t.status)}</em></span>`).join('')
            : '<span class="ad-none">nothing moved in the 24h after this — either it was early, or it went unheard</span>'}
        </div>
      </div>`;
  });
  setHTML(host, html);
}
// Supersede v1's loadLevels, but REUSE its renderArden() — the held layer, the
// signals lexicon and the 5s-hold machinery all still live there and are still
// correct. We only await it, then enrich the reflections list on top. Awaiting
// (rather than a timer) means the enrichment can never race the base render.
async function loadLevels() {
  const t = $('#levelsTitle');
  if (t) t.textContent = (typeof LEVELS !== 'undefined' && LEVELS.unlocked) ? 'Levels · Arden' : 'Levels';
  if (typeof renderArden === 'function') await renderArden();
  await loadLevelsV2();
  paintLiveModes();
}

/* ------------------------------------------------------------ live model tags
   Any `[data-live-mode="<agentId>"]` badge shows that agent's CURRENT model and
   depth instead of a hard-coded string. The old "Opus 4.8 · ULTRACODE" badges on
   the Sympath and Arden heroes kept claiming a model those agents no longer run. */
function paintLiveModes() {
  $$('[data-live-mode]').forEach((el) => {
    const f = FLEET_LIVE.find((x) => x.id === el.dataset.liveMode);
    if (!f) return;
    el.textContent = `${mlabel(f.model)} · ${(QLABEL[f.effort] || f.effort || '').toUpperCase()}`;
  });
}
// Supersedes v1's switchView with the same behaviour plus a repaint of the live
// badges. Keeping the body identical (rather than wrapping) avoids any ambiguity
// about which one loadView/nav ends up calling.
function switchView(view) {
  if (CUR.view === 'live' && view !== 'live') { try { C.liveStop(); } catch {} LIVE.active = false; }
  // leaving DASH-OPS releases the microphone — never hold it open in the background
  if (CUR.view === 'voice' && view !== 'voice') {
    VOICE.wantLoop = false; stopListening(); voiceStopAudio(); releaseMic();
    setVoiceState('idle', 'ready');
  }
  if (CUR.view === 'levels' && view !== 'levels') LEVELS.unlocked = false;   // re-seal on leave
  // leaving Motus Max stops the countdown and any narration — it never keeps
  // a timer alive behind another screen. Arming itself is untouched: the fuse
  // is authoritative in main, so walking away does not silently extend it.
  if (CUR.view === 'omni' && view !== 'omni') { clearInterval(OMNI.tick); OMNI.tick = 0; omniStopAudio(); }
  CUR.view = view;
  // every view carries its own light — this is the SUPERSEDING switchView, so
  // the hue handoff must live here (the v1 copy below it is dead code)
  const _hue = (NAV.find((n) => n[0] === view) || [])[3];
  if (_hue != null) document.documentElement.style.setProperty('--view-hue', _hue);
  $$('#railNav .nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view));
  $('#content').scrollTop = 0;
  const r = loadView(view);
  Promise.resolve(r).then(paintLiveModes).catch(() => {});
  return r;
}

/* --------------------------------------------------- live progress listeners */
if (C.onWorkflowProgress) C.onWorkflowProgress(() => { if (CUR.view === 'workflows') loadWorkflows(); });
if (C.onDuoPass) C.onDuoPass(() => { refreshControl(); if (CUR.view === 'duo') loadDuo(); });
// She can announce a landed pass aloud — never while you are mid-sentence in a call.
if (C.onDuoSpeak) C.onDuoSpeak((d) => {
  if (!d || !d.audio || VOICE.listening || VOICE.busy || VOICE.wantLoop) return;
  try { const a = new Audio('data:audio/mpeg;base64,' + d.audio); a.volume = 0.9; a.play().catch(() => {}); } catch {}
});

/* ==================================================== ON AIR · SEMBLE LIVE
   The broadcast composer. Enter a DJ mode, tick exactly what the world may
   see, and go live to semble.cc/live + augustjames.live/livenow + /rightnow.
   The privacy law is visible in the UI itself: nothing is ticked by default,
   the preview shows precisely what leaves, and the drop counter names any
   item the secret-shape gate refused. */
const STREAM = { data: null, timer: 0, msgs: [], compute: null, pay: null, golem: null, plan: null, armed: null };

/* ── shared formatters: big numbers readable, small numbers honest ── */
const cnum = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const chrs = (s) => (s >= 3600 ? (s / 3600).toFixed(1) + 'h' : s >= 60 ? Math.round(s / 60) + 'm' : Math.round(s || 0) + 's');

/* ── the contribution history, drawn as inline SVG (no library, no CDN) ──
   Reads bucket.motusSeconds, which the API ACCUMULATES per beat. Deriving it
   from seconds×capability over-counted 3.4x; the operator's chart and the
   payout engine must agree or the chart is decoration. */
function histSvg(hist, w = 560, h = 46) {
  if (!hist || !hist.length) return '<div class="om-empty">no history yet — the first hour of contribution starts the record</div>';
  const max = Math.max(...hist.map((b) => b.motusSeconds || 0), 1);
  const bw = w / hist.length;
  const bars = hist.map((b, i) => {
    const bh = Math.max(1, ((b.motusSeconds || 0) / max) * h);
    return `<rect x="${(i * bw).toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${(bw * .74).toFixed(2)}"
      height="${bh.toFixed(2)}" rx="1.5" class="cb"><title>${fmtDT2(b.t)} — ${cnum(b.motusSeconds)} MOTUS-s · ${b.nodes} node(s)</title></rect>`;
  }).join('');
  return `<svg class="cmp-hist" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>
    <div class="cmp-ax"><span>${new Date(hist[0].t).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      <span>peak ${cnum(max)} MOTUS-s/h · ${hist.length}h of record</span>
      <span>now</span></div>`;
}

/* MOTUSCOMPUTE — what we actually have access to right now. Reports pledged
   capability, never delivered work, because no jobs are dispatched yet. A
   dashboard that implied a working grid would be the most expensive lie in the
   app: he would plan around it. */
/* ── R3 · THE MOVER LOOP, MEASURED ──────────────────────────────────────────
   The standing finding is that R1 (build) and R2 (canon) run hot while R3 —
   a mover who is not August — has never turned once. Every rail for it exists.
   This panel is the instrument that will notice the first turn, and the two
   controls that make joining one press away instead of a browser errand. */
function r3Panel(c) {
  const R = c.reading;
  if (!R) return '';
  const turned = R.foreign > 0;
  const head = turned
    ? '<b class="r3-yes">◉ THE MOVER LOOP HAS TURNED</b>'
    : R.canTell
      ? '<b class="r3-no">○ still only you</b>'
      : '<b class="r3-unk">◍ cannot tell from here</b>';
  const body = turned
    ? 'A machine that is not yours is in this pool right now: <span class="mono">' + esc(R.foreignIds.join(', ')) + '</span>. That is the riskiest untested assumption in the whole ecosystem, answered.'
    : R.canTell
      ? 'Every machine this ledger can account for is yours, or a test fixture. One stranger completing one run is worth more than any feature on this screen — every rail is built and nothing has flowed through them.'
      : esc(R.why) + '. Claim the ids you recognise below and the count becomes truthful.';
  return `
    <div class="r3-band ${turned ? 'on' : ''}">
      <div class="r3-h">${head}
        <span class="r3-sub">${R.listed} node record(s) · ${R.mine} yours · ${R.foreign} not yours${R.everForeign && !turned ? ' · one joined on ' + fmtDT2(R.firstForeignTs) : ''}</span></div>
      <div class="r3-b">${body}</div>
      ${(() => {
        // ★ THE COST, IN UNITS. Measured on the live queue: 450 units sitting in
        // `verifying` because agreement needs N independent machines and only one
        // is contributing. This is the difference between "we would like a
        // stranger" and "real work is blocked on exactly this" — and it is the
        // single most persuasive line in the app, so it is never invented: if
        // the work endpoint has not answered, this renders nothing at all.
        const w = STREAM.work;
        if (!w || !w.queue) return '';
        const waiting = w.queue.verifying || 0;
        const need = w.need || 0;
        const have = Math.max(...[(w.byTask || []).map((t) => t.contributors || 0), [0]].flat());
        if (!waiting || !need || have >= need) return '';
        const short = need - have;
        return `<div class="r3-cost">⧗ <b>${cnum(waiting)}</b> unit(s) of real work are stuck in <b>verifying</b> —
          agreement needs <b>${need}</b> independent machines and <b>${have}</b> is contributing.
          <span>${short} more machine${short === 1 ? '' : 's'} unblocks all of it.</span></div>`;
      })()}
      <div class="r3-acts">
        <button class="mini ${R.pledgedSelf ? '' : 'go'}" id="cmpPledge" title="Register THIS machine as a node with a stable anonymous id. It is marked as yours, so it can never inflate the stranger count it exists to measure.">⊕ ${R.pledgedSelf ? 're-pledge this machine' : 'pledge this machine'}</button>
        <input class="om-in r3-in" id="cmpClaim" placeholder="a node id you recognise as yours…" spellcheck="false" />
        <button class="mini" id="cmpClaimBtn">mark as mine</button>
        <span class="r3-id mono" title="this app's node id — random and meaningless on purpose, so a public ledger never carries your machine name">${esc(R.ownNodeId || '')}</span>
      </div>
    </div>`;
}
function computeCard() {
  const c = STREAM.compute;
  if (!c) return '';
  const p = c.pool || {};
  const o = c.own || {};
  const m = p.motus || {};
  const hrs = ((p.seconds || 0) / 3600).toFixed(1);
  return `
    <div class="card glass st-compute">
      <div class="card-h"><h3>MotusCompute</h3><span class="card-tag">${p.jobsRunning ? 'jobs running' : 'ledger only · no jobs dispatched yet'}</span></div>
      <div class="cmp-grid">
        <div class="cmp-stat"><span class="k">LIVE NODES</span><b>${p.live || 0}</b><i>pledged and awake</i></div>
        <div class="cmp-stat"><span class="k">POOL CAPABILITY</span><b>${p.liveCapability || 0}</b><i>tab-equivalents</i></div>
        <div class="cmp-stat"><span class="k">ALL TIME</span><b>${p.pledged || 0}</b><i>machines · ${hrs}h pledged</i></div>
        <div class="cmp-stat"><span class="k">PAYABLE</span><b>${(p.withDash || 0) + (p.withTrust || 0)}</b><i>${p.withDash || 0} $DASH · ${p.withTrust || 0} $TRUST</i></div>
      </div>
      <div class="cmp-own">
        <span class="k">THIS MACHINE</span>
        <b>${esc(o.cpuModel || 'unknown')}</b> — ${o.cores || '?'} cores · ${o.ramGB || '?'} GB RAM (${o.freeGB || '?'} GB free) · ${esc(o.platform || '')}
      </div>
      <div class="cmp-sec"><span class="k">CONTRIBUTED PER HOUR</span>${histSvg(p.history)}</div>

      <div class="cmp-cols">
        <div class="cmp-col">
          <span class="k">PER-DJ COMPUTE RECORD</span>
          ${(p.byDj || []).filter((d) => d.seconds > 0).length ? `<div class="cmp-djs">${(p.byDj || [])
            .filter((d) => d.seconds > 0).map((d) => `
            <div class="cmp-dj"><span class="dn">${esc(d.dj)}</span>
              <span class="dt">${chrs(d.seconds)}</span><span class="dn2">${d.nodes} node(s)</span>
              <span class="dbar"><i style="width:${Math.max(2, d.share)}%"></i></span>
              <span class="dp">${d.share}%</span></div>`).join('')}</div>`
            : '<div class="om-empty">no attributed compute yet</div>'}
        </div>
        <div class="cmp-col">
          <span class="k">BY MODE</span>
          ${(p.byMode || []).length ? `<div class="cmp-kv">${(p.byMode || []).map((m) => `
            <div><b>${esc(m.mode)}</b><span>${chrs(m.seconds)} · ${m.nodes} node(s)</span></div>`).join('')}</div>`
            : '<div class="om-empty">no mode data yet</div>'}
          <span class="k" style="margin-top:10px;display:block">BY TIER</span>
          <div class="cmp-kv">${(p.byTier || []).filter((t) => t.count).map((t) => `
            <div><b>${esc(t.tier)}</b><span>${t.count}× · cap ${t.capability} · ${chrs(t.seconds)}</span></div>`).join('')
            || '<div class="om-empty">nothing pledged</div>'}</div>
        </div>
      </div>

      <div class="cmp-accrual">
        <span class="k">ACCRUAL — what the pool is owed</span>
        <div class="cmp-acc">
          <div><b>${cnum(m.accrued || 0)}</b><span>MOTUS-s all time</span></div>
          <div><b>${cnum(m.open || 0)}</b><span>open, unsettled</span></div>
          <div><b>${(m.owedDash || 0).toFixed(6)}</b><span>$DASH owed</span></div>
          <div class="${m.settleable ? 'go' : ''}"><b>$${(m.owedUsd || 0).toFixed(2)}</b><span>${m.settleable ? 'clears the floor' : `below the $${m.settleFloorUsd} floor`}</span></div>
        </div>
      </div>

      ${r3Panel(c)}
      ${(p.recent || []).length ? `<div class="cmp-list">${p.recent.slice(-8).reverse().map((n) => `
        <div class="cmp-node"><span class="nid">${esc(n.id)}</span><span class="ntier">${esc(n.tier)}</span>
          <span class="nven">${esc(n.vendor || '')} ${esc(n.klass || '')}</span>
          <span class="ncap">${n.cap}×</span>
          <span class="nadr">${n.dash ? '$DASH ' + esc(n.dash) : ''}${n.trust ? ' · $TRUST ' + esc(n.trust) : ''}</span>
        </div>`).join('')}</div>` : (p.pledged
        // ⚠ "no one has pledged" sat directly under a strip reading 2. A count
        // and a roster from the same payload disagreeing on screen is how a
        // dashboard stops being believed. State the gap instead of picking one.
        ? `<div class="om-empty">the ledger counts <b>${p.pledged}</b> pledged machine(s) but returns no node records for them, so they cannot be listed or attributed here</div>`
        : '<div class="om-empty">no one has pledged a machine yet — the LEND YOUR GPU panel is live on the stream pages</div>')}
      <p class="om-p">${p.jobsRunning ? '' : '<b>Nothing is executing.</b> This is the ledger running ahead of the work — pledges, attribution and accrual are recorded so the accounting exists before the first job does. Distribution figures appear when rung 3 dispatches real jobs.'}</p>
      <div class="om-actions"><button class="mini" id="stCmpRefresh">⟳ refresh</button><button class="mini" id="stCmpClear">clear the pool ledger</button></div>
    </div>
    ${dispatchCard()}
    ${payoutCard()}
    ${golemCard()}`;
}

/* ── RUNG 5 · THE DISPATCH CONSOLE ───────────────────────────────────────────
   Where one of his tasks becomes work the pool actually does. The queue drains,
   receipts arrive, and every unit is checked by two machines that have never
   met. `jobsRunning` here is COMPUTED from the queue — the one number in this
   app that used to be hard-coded false and has now earned the right to be true. */
function dispatchCard() {
  const w = STREAM.work; if (!w) return '';
  const q = w.queue || {};
  // his real board, so dispatch starts from actual work rather than a text box
  const tasks = (STREAM.board || []).filter((t) => t.status !== 'done').slice(0, 14);
  return `
    <div class="card glass st-dispatch">
      <div class="card-h"><h3>Dispatch</h3><span class="card-tag">${w.jobsRunning ? 'jobs running' : 'queue idle'}</span></div>
      <div class="cmp-grid">
        <div class="cmp-stat ${w.jobsRunning ? 'go' : ''}"><span class="k">RUNNING</span><b>${w.jobsRunning ? 'YES' : 'IDLE'}</b><i>${(q.open || 0) + (q.verifying || 0)} unit(s) out</i></div>
        <div class="cmp-stat"><span class="k">VERIFIED</span><b>${w.completed || 0}</b><i>agreed by 2 machines</i></div>
        <div class="cmp-stat"><span class="k">DISPUTED</span><b>${q.disputed || 0}</b><i>nobody credited, re-issued</i></div>
        <div class="cmp-stat ${w.quarantined ? 'zero' : ''}"><span class="k">QUARANTINED</span><b>${w.quarantined || 0}</b><i>failed a known-answer probe</i></div>
      </div>

      <div class="disp-send">
        <span class="k">SEND A TASK TO THE POOL</span>
        <select class="in" id="stWorkTask">
          <option value="">— pick a task —</option>
          ${tasks.map((t) => `<option value="${esc(t.id)}" data-title="${escAttr(t.title || '')}">${esc(String(t.title || t.id).slice(0, 70))}</option>`).join('')}
        </select>
        <textarea class="in" id="stWorkText" rows="3" placeholder="Public text for the pool to index. Leave blank to use the task title.&#10;⚠ This is served publicly to anyone who asks — the secret-shape gate refuses keys, but public-work-only is the rule."></textarea>
        <div class="om-actions">
          <button class="mini go" id="stWorkSend">⚡ dispatch to the pool</button>
          <button class="mini" id="stWorkRefresh">⟳ refresh</button>
          <button class="mini" id="stWorkClear">clear the queue</button>
        </div>
      </div>

      ${(w.byTask || []).length ? `<div class="disp-tasks"><span class="k">WHAT THE POOL FINISHED</span>
        <div class="cmp-kv">${w.byTask.map((t) => `<div><b>${esc(t.task)}</b><span>${t.units} verified unit(s) · ${t.contributors} machine(s)</span></div>`).join('')}</div></div>` : ''}

      ${(w.recent || []).length ? `<div class="disp-recent"><span class="k">RECENTLY VERIFIED</span>
        ${w.recent.slice(0, 6).map((u) => `<div class="dr-row"><span class="drk">${esc(u.kind)}</span>
          <span class="drt">${esc(u.task)}</span><code class="drd">${esc(u.digest)}</code>
          <span class="drb">${(u.by || []).join(' + ')}</span></div>`).join('')}</div>` : ''}

      <p class="om-p">${esc(w.verification || '')}</p>
      <p class="om-p dim"><b>Public work only, by protocol.</b> Payloads are stored in a public blob and served to anyone who asks — so if it would be bad for it to be public, it cannot be a work unit. The gate refuses key-shaped content before it ever leaves this machine.</p>
    </div>`;
}

/* ── THE PAYOUT CONSOLE ──────────────────────────────────────────────────────
   plan → arm → (sign on his own node) → settle. The app never holds a key, so
   the dangerous step is deliberately NOT in the app: `arm` hands back a
   sendmany he executes himself. Anything that moves money asks twice. */
function payoutCard() {
  const j = STREAM.pay; if (!j) return '';
  const s = j.summary || {};
  const plan = STREAM.plan;
  return `
    <div class="card glass st-payout">
      <div class="card-h"><h3>Payouts</h3><span class="card-tag">${j.moneyMoved ? `${s.sent} batch(es) sent` : 'no money has moved'}</span></div>
      <div class="cmp-grid">
        <div class="cmp-stat"><span class="k">$DASH SENT</span><b>${(s.dashSent || 0).toFixed(6)}</b><i>${s.recipientsPaid || 0} recipient(s)</i></div>
        <div class="cmp-stat"><span class="k">OPEN</span><b>$${(s.openOwedUsd || 0).toFixed(2)}</b><i>${cnum(s.motusSecondsOpen || 0)} MOTUS-s</i></div>
        <div class="cmp-stat"><span class="k">BATCHES</span><b>${s.batches || 0}</b><i>${s.armed || 0} armed · ${s.failed || 0} failed</i></div>
        <div class="cmp-stat"><span class="k">$TRUST</span><b>${s.trustAttestations || 0}</b><i>receipts, never a reward</i></div>
      </div>
      <div class="pay-key">🔑 ${esc(j.custody || '')}</div>

      ${plan ? `<div class="pay-plan">
        <span class="k">PLAN — ${plan.recipients} recipient(s) · ${(plan.total || 0).toFixed(6)} DASH ($${(plan.totalUsd || 0).toFixed(2)})</span>
        ${(plan.paying || []).length ? `<div class="cmp-kv">${plan.paying.slice(0, 8).map((r) => `
          <div><b>${esc(r.short)}</b><span>${(r.amount).toFixed(6)} DASH · ${cnum(r.motusSeconds)} MOTUS-s · ${esc(r.topDj || '—')}</span></div>`).join('')}</div>` : ''}
        ${(plan.held || []).length ? `<div class="pay-held"><b>${plan.held.length} held</b> — ${esc(plan.heldReason || '')}</div>` : ''}
        ${plan.sendmany && Object.keys(plan.sendmany).length ? `
          <span class="k" style="margin-top:10px;display:block">SENDMANY — run this on YOUR node</span>
          <pre class="pay-cmd">dash-cli sendmany "" '${esc(JSON.stringify(plan.sendmany))}'</pre>` : ''}
      </div>` : ''}

      ${STREAM.armed ? `<div class="pay-armed">
        <b>ARMED · ${esc(STREAM.armed.batchId)}</b> — sign the sendmany above, then record the txid.
        <div class="pay-settle"><input class="in" id="stTxid" placeholder="txid from your node…" spellcheck="false">
          <button class="mini go" id="stSettle">record settled</button>
          <button class="mini" id="stFail">release batch</button></div>
      </div>` : ''}

      <div class="pay-log">${(j.log || []).slice(0, 6).map((p) => `
        <div class="pl-row st-${esc(p.status)}"><span class="pw">${new Date(p.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          <span class="pr ${esc(p.rail)}">${esc(p.rail)}</span><span class="pd">${esc(p.dj || 'all')}</span>
          <span class="pn">${p.recipients}→</span><span class="pa">${p.rail === 'dash' ? p.amount.toFixed(6) : '—'}</span>
          <span class="ps">${esc(p.status)}</span></div>`).join('')
        || '<div class="om-empty">no batches yet — nothing armed, nothing sent</div>'}</div>

      <div class="om-actions">
        <button class="mini" id="stPayPlan">▤ plan a batch (dry run)</button>
        <button class="mini ${plan && plan.recipients ? 'go' : 'off'}" id="stPayArm" ${plan && plan.recipients ? '' : 'disabled'}>⚡ arm ${plan ? plan.recipients : 0} payout(s)</button>
        <button class="mini" id="stPayRefresh">⟳ refresh</button>
      </div>
      <p class="om-p"><b>$TRUST is the receipt, never the reward.</b> Contributors cannot earn $TRUST for off-chain work — emissions go to veTRUST bonders. Rewards settle in $DASH above the ~$5 off-ramp floor, because nobody can cash out $0.42.</p>
    </div>`;
}

/* ── THE GOLEM GAUGE — measured live, never asserted ── */
function golemCard() {
  const g = STREAM.golem;
  if (!g) {
    return `
    <div class="card glass st-golem slim">
      <div class="card-h"><h3>Golem</h3><span class="card-tag">ruled out by measurement</span></div>
      <p class="om-p">The Golem rail was measured and <b>ruled out</b> — zero GPU supply existed when it counted. The verdict stands until you re-measure; nothing is fetched on your behalf.</p>
      <div class="om-actions"><button class="mini" id="stGolemProbe">⟲ measure it again</button></div>
    </div>`;
  }
  const s = g.supply || {}, v = g.verdict || {}, a = g.adapter || {};
  return `
    <div class="card glass st-golem">
      <div class="card-h"><h3>Golem</h3><span class="card-tag">${s.reachable ? 'measured just now' : 'unreachable'}</span></div>
      <div class="cmp-grid">
        <div class="cmp-stat"><span class="k">PROVIDERS</span><b>${s.providers || 0}</b><i>online right now</i></div>
        <div class="cmp-stat ${s.gpus ? 'go' : 'zero'}"><span class="k">GPUs</span><b>${s.gpus || 0}</b><i>${s.gpus ? 'rental possible' : 'no GPU supply exists'}</i></div>
        <div class="cmp-stat"><span class="k">ADAPTER</span><b>${a.configured ? 'WIRED' : 'STANDBY'}</b><i>${a.configured ? 'requestor configured' : 'one env var from live'}</i></div>
        <div class="cmp-stat"><span class="k">RUNTIMES</span><b>${Object.keys(s.runtimes || {}).length}</b><i>${esc(Object.entries(s.runtimes || {}).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none')}</i></div>
      </div>
      <p class="om-p"><b>Viewers cannot contribute through Golem.</b> ${esc(v.whyNot || '')}</p>
      <p class="om-p dim">${esc(v.rentNote || '')} This gauge re-measures every refresh — if supply appears, this card says so without anyone remembering to check.</p>
      <div class="om-actions"><button class="mini" id="stGolem">⟳ re-measure</button></div>
    </div>`;
}

/* ⚠ MEASURED 2026-08-19 by the app's own instrument: this view had a MEDIAN
   paint of 2561 ms — three times slower than anything else in the app, and the
   only view that felt broken to open.

   The cause was structural, not algorithmic: six awaits in a chain, four of
   them separate HTTPS round-trips to the live API. Nothing depended on
   anything before it; they were sequential only because that is how they were
   written. So the cost was the SUM of five independent latencies, paid before
   a single pixel appeared.

   Two changes, both about ordering rather than speed:
     · PAINT FIRST. The composer needs only local state, so it goes on screen
       immediately. The privacy law, the ticks and GO LIVE are usable while the
       ledgers are still in the air.
     · THEN FETCH TOGETHER. The four remote ledgers are independent, so the
       cost becomes the SLOWEST of them instead of the sum.

   (This is the same burst that starved first paint at boot — the difference is
   that here the paint has already happened, and he asked for this view.) */
async function loadStream() {
  const r = await C.onAir();
  if (r && r.ok) STREAM.data = r.onAir;
  paintStream();                                   // ← usable now, not in 2.5s
  /* ⚠ THE INSTRUMENT'S SECOND FIND: cortex:golem was the slowest handler in
     the entire app — 1634 ms median — because it live-probes the Golem network
     on every stream load. And the Golem rail was RULED OUT by measurement
     months ago (zero GPU supply). Sixteen hundred milliseconds per visit,
     re-measuring a verdict that never changes. The verdict renders instantly;
     the probe runs only when he explicitly asks for a fresh reading. */
  const [c, y, k, bd] = await Promise.all([
    C.compute ? C.compute().catch(() => null) : null,
    C.payouts ? C.payouts().catch(() => null) : null,
    C.work ? C.work().catch(() => null) : null,
    C.board ? C.board().catch(() => null) : null,
  ]);
  if (c && c.ok) STREAM.compute = c;
  if (y && y.ok) STREAM.pay = y.pay;
  if (k && k.ok) STREAM.work = k.work;
  if (bd && bd.tasks) STREAM.board = bd.tasks;
  // He may well have moved on while those were in flight — never repaint a
  // room he has left, and never fight an input he has started typing in.
  if (CUR.view !== 'stream') return;
  paintStream();
  clearInterval(STREAM.timer);
  STREAM.timer = setInterval(async () => {
    if (CUR.view !== 'stream') { clearInterval(STREAM.timer); return; }
    const s = await C.onAir(); if (s && s.ok) { STREAM.data = s.onAir; paintStreamStatus(); }
  }, 8000);
  loadStreamChat();
}
async function loadStreamChat() {
  const r = await C.onAirChat();
  if (r && r.ok) { STREAM.msgs = r.msgs; const el = $('#stMsgs'); if (el) el.innerHTML = streamMsgs(); }
}
function streamMsgs() {
  if (!STREAM.msgs.length) return '<div class="om-empty">SourceCrowd is quiet — no voices in the room yet</div>';
  // ranked the way the site ranks them, so what he moderates is what they see
  return [...STREAM.msgs].sort((a, b) => (b.votes || 0) - (a.votes || 0) || b.ts - a.ts).slice(0, 40).map((m) => `
    <div class="st-msg">
      <span class="st-votes ${(m.votes || 0) > 0 ? 'has' : ''}">▲ ${m.votes || 0}</span>
      <span class="st-who">${esc(m.name)}</span>
      <span class="st-tx">${esc(m.text)}${m.link ? ` <a class="st-lnk" href="${esc(m.link)}" target="_blank" rel="noopener">⤴ link</a>` : ''}</span>
      <button class="mini st-del" data-del="${esc(m.id)}">✕</button>
    </div>`).join('');
}
function paintStreamStatus() {
  const a = STREAM.data; if (!a || !$('#stStatus')) return;
  $('#stStatus').innerHTML = streamStatusLine(a);
  const prev = $('#stPreview'); if (prev) prev.innerHTML = streamPreview(a);
}
function streamStatusLine(a) {
  const when = a.lastPush ? ago(a.lastPush) + ' ago' : 'never';
  return `${a.on ? '<b class="st-onair">● ON AIR</b>' : '○ off air'} · pushed ${when} · ${a.pushes || 0} pushes${a.dropped ? ` · <b class="st-drop">${a.dropped} item(s) held back by the secret gate</b>` : ''}${a.lastErr ? ` · <b class="st-drop">${esc(a.lastErr)}</b>` : ''}`;
}
function streamPreview(a) {
  const p = a.preview || {};
  const bits = [];
  if (p.goal) bits.push(`<div class="st-pv"><span>GOAL</span>${esc(p.goal)}</div>`);
  if (p.motus) bits.push(`<div class="st-pv"><span>MOTUS</span>${esc(p.motus)}</div>`);
  for (const it of p.items || []) bits.push(`<div class="st-pv"><span>${esc(it.kind)}</span>${esc(it.t)}</div>`);
  for (const ag of p.agents || []) bits.push(`<div class="st-pv"><span>AGENT</span>${esc(ag.name)} — ${esc(ag.focus)}</div>`);
  return bits.join('') || '<div class="om-empty">nothing selected — the page shows “off air / between sessions” and nothing else</div>';
}
/* ── THE STANDING PRIVACY LINE ─────────────────────────────────────────────
   August's law, verbatim: "when we have it off its not broadcasting anything."
   The app used to answer that with a BUTTON — you had to already suspect a leak
   to find one. This is the answer standing on screen whether or not he asks,
   because a privacy guarantee that depends on remembering to check it is not a
   guarantee. Every state here comes from reading the PUBLIC endpoint. */
/* One cell, one grammar. Every reading strip in the app is built from this,
   so a number means the same thing on every page: big value, small honest
   sentence, and a tone that is earned — cyan for good, red for live, gold for
   the one that is asking something of him. */
/* ── THE RHYTHM · the system's own dynamics, read from the ledger ────────────
   A 24-hour ring of his turns (28 days, today drawn over it in the view's
   hue), the readings that say what the shape means, twelve figures grouped as
   the four things a dynamics reading is made of, and the extremes: the
   longest turn, the biggest day, the oldest open task, the busiest seat.
   Deterministic and local. Nothing here asks a model anything. */
function dynBand(d) {
  if (!d || d.error) return '';
  const max = Math.max(1, ...d.ring);
  const cx = 110, cy = 110, r0 = 42, len = 52;
  const pt = (i, r) => { const a = (i / 24) * Math.PI * 2 - Math.PI / 2; return [(cx + r * Math.cos(a)).toFixed(1), (cy + r * Math.sin(a)).toFixed(1)]; };
  const spoke = (i, v, cls) => { const [x1, y1] = pt(i, r0); const [x2, y2] = pt(i, r0 + len * (v / max)); return '<line class="' + cls + '" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '"/>'; };
  const hourMark = (h) => { const [x, y] = pt(h, r0 + len + 12); return '<text x="' + x + '" y="' + (+y + 4).toFixed(1) + '" class="dr-h">' + h + '</text>'; };
  const two = (n) => String(n).padStart(2, '0');
  const ring = '<svg class="dyn-ring" viewBox="0 0 220 220" aria-label="turns by hour of day, last 28 days">'
    + '<circle cx="110" cy="110" r="' + (r0 - 4) + '" class="dr-core"/>'
    + d.ring.map((v, i) => spoke(i, v, 'dr-all')).join('')
    + d.today.map((v, i) => (v ? spoke(i, v, 'dr-today') : '')).join('')
    + [0, 6, 12, 18].map(hourMark).join('')
    + '<text x="110" y="106" class="dr-c">' + two(d.peak.start) + '–' + two(d.peak.end) + '</text>'
    + '<text x="110" y="122" class="dr-cs">peak window</text>'
    + '</svg>';
  const fig = (v, l) => '<div class="dyn-fig"><b>' + v + '</b><i>' + l + '</i></div>';
  const s = (x) => (x >= 3600 ? Math.round(x / 3600) + 'h' : x >= 60 ? Math.round(x / 60) + 'm' : Math.round(x) + 's');
  const groups = [
    { n: 'Stocks', c: [fig(d.stocks.open, 'open on the board'), fig(d.stocks.learnings, 'learnings banked'), fig(d.stocks.receipts, 'receipts, all time')] },
    { n: 'Flows', c: [fig(d.flows.turns7, 'turns this week'), fig(d.flows.done7, 'tasks closed this week'), fig(d.flows.shipped7, 'shipped by Duo this week')] },
    { n: 'Delays', c: [fig(s(d.delays.relayMed), 'median relay turn'), fig(d.delays.leadMedDays ? d.delays.leadMedDays + 'd' : '—', 'median task lead time'), fig(d.delays.clearDays == null ? '—' : d.delays.clearDays + 'd', 'to clear the board at this pace')] },
    { n: 'Loops', c: [fig(d.loops.duoRuns, 'Duo passes'), fig(d.loops.maxSessions, 'Max sessions'), fig(Math.round(d.loops.okRate7 * 100) + '%', 'clean turns this week')] },
  ];
  const ex = d.extremes || {};
  const exRow = [
    ex.longestTurn ? 'longest turn <b>' + s(ex.longestTurn.latency) + '</b> (' + esc(ex.longestTurn.agent) + ')' : '',
    ex.biggestDay && ex.biggestDay.turns ? 'biggest day <b>' + ex.biggestDay.turns + '</b> turns, ' + (ex.biggestDay.daysAgo === 0 ? 'today' : ex.biggestDay.daysAgo + 'd ago') : '',
    ex.oldestOpen ? 'oldest open <b>' + ex.oldestOpen.days + 'd</b> · ' + esc(ex.oldestOpen.title) : '',
    ex.topSeat ? 'busiest seat <b>' + esc(ex.topSeat[0]) + '</b> · ' + ex.topSeat[1] + ' turns' : '',
  ].filter(Boolean);
  const readings = (d.readings || []).map((r) => '<div class="dyn-r k-' + esc(r.k) + '"><span class="dyn-k">' + esc(r.k) + '</span><span>' + esc(r.t) + '</span></div>').join('')
    || '<div class="dyn-r"><span class="dyn-k">rhythm</span><span>Not enough movement yet to read a rhythm. It appears after a few days of turns.</span></div>';
  return '<div class="panel glass dyn-band">'
    + '<div class="panel-head"><h3>The rhythm</h3><span class="panel-sub">how this system actually moves · 28 days · read from your own ledger without asking a model</span></div>'
    + '<div class="dyn-top">' + ring + '<div class="dyn-read">' + readings + '</div></div>'
    + '<div class="dyn-groups">' + groups.map((g) => '<div class="dyn-g"><div class="dyn-gn">' + g.n + '</div><div class="dyn-gc">' + g.c.join('') + '</div></div>').join('') + '</div>'
    + (exRow.length ? '<div class="dyn-ex">' + exRow.map((x) => '<span>' + x + '</span>').join('') + '</div>' : '')
    + '</div>';
}
/* ============================================================== THE MIND VIEW
   Davara's baseline, read live off the canonical clone: version, organs, the
   stack, the Stream, her commands, which organ each loop reads before it
   moves, and the covenant. Nothing here is a copy; the page is a window.     */
async function loadMind() {
  const [m, oa] = await Promise.all([C.mind(), C.openai ? C.openai().catch(() => null) : null]);
  if (!m || m.error) return viewFail('mind', m || null);
  const host = $('#mindBody');
  if (!host) return;
  const na = !m.available;
  const org = m.organs || {};
  const stack = m.stack || [];
  const stream = m.stream || [];
  const cmds = m.commands || [];
  const reading = (m.loops || []).filter((l) => l.enabled && l.approved).length;
  setHTML(host, `
    <div class="view-head"><h2>Davara</h2>
      <p class="view-desc">Her mind, as it is right now. This page reads the canonical baseline off disk every time you open it, so what you see here is what every loop and every drive reads before it moves.</p></div>

    <div class="st-strip n5">
      ${siCell(na ? 'zero' : 'go', na ? '—' : esc(m.version.replace(/^v/, '').split('-')[0]), na ? 'the baseline is not readable from this machine' : 'baseline ' + esc(m.version))}
      ${siCell('', na ? '—' : (org.protocols || 0) + '+' + (org.skills || 0) + '+' + (org.library || 0), 'protocols + skills + library files')}
      ${siCell(stream.length ? 'go' : '', stream.length, 'recent entries in her Stream')}
      ${siCell(reading ? 'live' : '', reading, reading === 1 ? 'loop armed, reading her organs' : 'loops armed, reading her organs')}
      ${siCell(m.meanQuality != null ? (m.meanQuality >= 6 ? 'go' : 'zero') : '', m.meanQuality != null ? m.meanQuality.toFixed(1) : '—', m.qualityN ? 'mean quality of her last ' + m.qualityN + ' passes' : 'no scored passes yet')}
    </div>

    ${na ? `<div class="panel glass"><div class="panel-head"><h3>Not readable from here</h3></div>
      <div class="mind-p">The canonical clone should be at <code>${esc(m.dir)}</code>. When it is, this page fills itself: the stack, the Stream, her commands and the organs each loop reads.</div></div>` : ''}

    <div class="mind-grid">
      <div class="panel glass mind-stack-wrap">
        <div class="panel-head"><h3>The stack</h3><span class="panel-sub">${stack.length ? stack.length + ' layers, from her own LAYERS.json' : 'no layer file read'}</span></div>
        <div class="mind-stack">${stack.map((l, i) => `<div class="ms-layer" style="--i:${i}"><span class="ms-n mono">${esc(String(l.n))}</span><span class="ms-name">${esc(l.name)}</span>${l.desc ? `<span class="ms-desc">${esc(l.desc)}</span>` : ''}${l.trust ? `<span class="ms-trust t-${esc(l.trust)}" title="trust level: ${esc(l.trust)}${l.mutable ? ' · mutable by ' + esc(l.mutable) : ''}${l.runtime ? ' · runtime ' + esc(l.runtime) : ''}">${esc(l.trust)}</span>` : ''}</div>`).join('') || '<div class="empty">The stack file was not found.</div>'}</div>
      </div>

      <div class="panel glass">
        <div class="panel-head"><h3>What each loop reads first</h3><span class="panel-sub">at most two organs a pass, on her context diet</span></div>
        ${Object.entries(m.organsByKind || {}).map(([k, v]) => `<div class="mind-organ"><div class="mo-k">${esc(k)}</div><div class="mo-v">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>`).join('')}
        <div class="mind-p mono">read sizes · scout ${m.reads.scoutChars} · build ${m.reads.buildChars} · gate ${m.reads.gateChars} chars</div>
        <div class="mind-p">Every pass ends in her own contract: a confidence with its basis, a falsifier dated on the system's clock, and the one lived turn she walked. The app scores what the report carries and checks the files it claims.</div>
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Her abilities</h3><span class="panel-sub">${(m.abilities || []).length} protocols, each in its own WHEN line · click one to read it whole</span></div>
      <div class="mind-ab">${(m.abilities || []).map((a) => `<div class="mab"><div class="mab-n">${esc(a.name)}</div>${a.when ? `<div class="mab-w">${esc(a.when)}</div>` : ''}</div>`).join('') || '<div class="empty">No protocols were read.</div>'}</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>The Stream</h3><span class="panel-sub">what evolved recently, in her own entries</span></div>
      ${stream.length ? stream.map((s) => `<div class="mind-stream expandable" data-body="${escAttr(s.body)}" data-rtitle="${escAttr(s.title)}" data-rsub="Baseline Stream">
        <div class="mst-t">${esc(s.title)}${s.confidence ? `<span class="mst-c mono">confidence ${esc(s.confidence)}</span>` : ''}</div>
        <div class="mst-b">${esc(s.body)}</div>
        <button class="mini read" data-read="1">⤢ read full</button>
      </div>`).join('') : '<div class="empty">No Stream entries were read.</div>'}
    </div>

    <div class="mind-grid">
      <div class="panel glass">
        <div class="panel-head"><h3>Her commands</h3><span class="panel-sub">from COMMANDS.md</span></div>
        <div class="mind-cmds">${cmds.map((c) => `<span class="mind-cmd mono">${esc(c)}</span>`).join('') || '<div class="empty">No commands were read.</div>'}</div>
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>The covenant</h3><span class="panel-sub">how this app evolves her mind</span></div>
        ${m.covenant.present
          ? `<div class="mind-p">The DuoDrive baseline-evolution covenant is present (${Math.round(m.covenant.bytes / 1024)} KB). The <b>Baseline Evolution Pass</b> loop runs one ceremony from it on the canonical clone and stops before the push, so you ratify every change. It stays off until you arm it on Duo-Drive.</div>`
          : `<div class="mind-p">The covenant file was not found at <code>${esc(m.covenant.path)}</code>.</div>`}
        <div class="mind-p"><b>Two stacks.</b> Her seats run on the Claude Code relay. ${oa && oa.keySet ? 'The GPT seat is live on your OpenAI key (model ' + esc(oa.model || 'unchosen') + '); reach it with <code>/gpt</code> on Command, and the studio makes images for the whole fleet.' : 'Add an OpenAI key on Settings → Integrations to open the GPT seat and the image studio.'}</div>
        ${(() => {
          // one ceremony, by hand: a manual pass always runs, and the covenant stops before the push
          const cov = (m.loops || []).find((l) => l.name === 'Baseline Evolution Pass');
          return cov ? `<div class="mind-p"><b>Run one ceremony now.</b> One coherent theme, the organs read in full, the Stream entry written with confidence and falsifier, the push left for you. This is a real relay turn.</div>
          <div class="mind-acts"><button class="mini go" data-runloop="${escAttr(cov.id)}">✦ Run one ceremony</button><button class="mini" data-go="duo">Duo-Drive →</button><button class="mini" data-go="settings">Integrations →</button></div>`
          : '<div class="mind-acts"><button class="mini go" data-go="duo">Duo-Drive →</button><button class="mini" data-go="settings">Integrations →</button></div>';
        })()}
      </div>
    </div>`);
  $$('#mindBody [data-go]').forEach((b) => b.onclick = () => switchView(b.dataset.go));
  $$('#mindBody [data-runloop]').forEach((b) => b.onclick = async () => {
    if (!confirm('Run one baseline-evolution ceremony now?\n\nShe reads the covenant and the organs in full, makes one coherent change on the canonical clone, writes the Stream entry, and stops before the push. It costs one real relay turn.')) return;
    b.disabled = true; b.textContent = '… running the ceremony';
    const r = await C.loopRun(b.dataset.runloop).catch(() => null);
    b.disabled = false; b.textContent = '✦ Run one ceremony';
    if (r && r.ok) toast('The ceremony ran. Read her receipt on Duo-Drive → Work log.', 'good');
    else toast((r && r.error) || 'the ceremony could not run', 'bad');
  });
}
function siCell(cls, big, sub) {
  return '<div class="st-si ' + (cls || '') + '"><b>' + big + '</b><i>' + sub + '</i></div>';
}
function sinceLabel(ts) {
  const t = typeof ts === 'number' ? ts : Date.parse(ts || '');
  if (!t) return null;
  const h = Math.floor((Date.now() - t) / 36e5);
  return h < 1 ? '<1h' : h < 48 ? h + 'h' : Math.floor(h / 24) + 'd';
}
function sweepLine(a) {
  const w = a.sweep;
  if (a.on) {
    // On air, absence proves nothing — the guarantee becomes an exact match
    // between what he ticked and what is actually served.
    const d = a.drift;
    if (!d || !d.live) return { cls: 'live', b: 'ON AIR', i: 'the ticked items are public, by your choice' };
    if (d.error) return { cls: 'zero', b: '⚠', i: String(d.error).slice(0, 90) };
    if (d.extraCount) return { cls: 'zero', b: 'DRIFTED', i: d.extraCount + ' thing(s) served that you did not tick' };
    if (d.missing) return { cls: '', b: 'BEHIND', i: d.missing + ' ticked item(s) have not reached the world yet' };
    return { cls: 'go', b: 'MATCHED', i: 'served payload equals your ticks · checked ' + fmtDT2(d.ts) };
  }
  if (!w) return { cls: '', b: '—', i: 'the public endpoint has not been read yet' };
  if (!w.ok && w.error) return { cls: 'zero', b: '⚠', i: String(w.error).slice(0, 90) };
  if (w.cleared) return { cls: 'go', b: 'SEALED', i: 'stranded ' + (w.leaked || []).join(', ') + ' — cleared, then re-read clean' };
  if (w.clean) return { cls: 'go', b: 'CLEAN', i: 'nothing of yours is retrievable · checked ' + fmtDT2(w.ts) };
  return { cls: 'zero', b: 'EXPOSED', i: (w.still || w.leaked || []).join(', ') + ' still public' };
}
/* ── THE LEDGER STRIP — the pool's real numbers, ahead of the detail ────────
   The compute card is honest but it is also long. These five figures answer
   "is there anything actually there?" without reading a screen of tables. Every
   one is fetched from /api/compute; none is inferred. If the ledger does not
   answer, this says so instead of rendering a confident row of zeros — a zero
   you cannot distinguish from an outage is worse than no number at all. */
function ledgerStrip() {
  const c = STREAM.compute;
  if (!c) return '';
  if (!c.pool) return '<div class="st-strip n5"><div class="st-si zero" style="grid-column:1/-1"><b>⚠ NO LEDGER</b><i>' +
    esc('/api/compute did not answer' + (c.error ? ' — ' + c.error : '') + ' · these numbers are unknown, not zero') + '</i></div></div>';
  const p = c.pool, m = p.motus || {}, R = c.reading || null;
  const live = p.live || 0;
  const cell = (cls, big, sub) => '<div class="st-si ' + cls + '"><b>' + big + '</b><i>' + sub + '</i></div>';
  // ★ THE FIRST CELL IS THE ONLY ONE THAT ANSWERS R3. Everything else here
  // measures a loop that is already running; this measures the one that has
  // never turned. When the ledger cannot attribute the machines, it says so —
  // a reassuring "0 strangers" we cannot support would be worse than blank.
  const r3 = !R ? cell('', '—', 'stranger count unavailable')
    : R.foreign ? cell('live', R.foreign, 'machine(s) here that are NOT yours')
    : !R.canTell ? cell('zero', '?', 'cannot tell whose machines these are')
    : cell('zero', '0', R.everForeign ? 'none right now — one joined before' : 'no one but you has ever joined');
  return '<div class="st-strip n5 lg-strip">'
    + r3
    + cell(live ? 'live' : '', live, live ? 'node(s) awake now' : 'no node awake right now')
    + cell((p.pledged || 0) ? 'go' : 'zero', p.pledged || 0, 'machines pledged · ' + (p.hours || 0).toFixed(1) + 'h contributed')
    + cell('', cnum(m.open || 0), 'MOTUS-s owed, unsettled')
    + cell(m.settleable ? 'go' : '', '$' + (m.owedUsd || 0).toFixed(2),
        m.settleable ? 'clears the $' + m.settleFloorUsd + ' off-ramp floor' : 'below the $' + (m.settleFloorUsd || 5) + ' off-ramp floor')
    + '</div>';
}
function paintStream() {
  const a = STREAM.data;
  if (!a) { setHTML($('#streamBody'), '<div class="om-empty">the broadcast engine is not answering</div>'); return; }
  setHTML($('#streamBody'), `
    <div class="view-head"><h2>MotusLive — the builder stream</h2>
      <p class="view-desc">Your shared-work live streamer. Pick the DJ mode, tick exactly what the world may see, go live. It lands on <b>semble.cc/live</b>, <b>augustjames.live/livenow</b>, the tasks-only <b>/rightnow</b>, and <b>motuslive.vercel.app</b> within a beat. Nothing is ever shared that you did not tick — and every string passes two independent secret-shape gates on the way out.</p></div>

    <div class="card glass-deep st-golive ${a.on ? 'on' : ''}">
      <div class="st-golive-row">
        <button class="prime-btn st-big" id="stGo">${a.on ? '◼ GO OFF AIR' : '● GO LIVE'}</button>
        <div class="st-status" id="stStatus">${streamStatusLine(a)}</div>
      </div>
      ${a.hasSecret ? '' : `<p class="om-p st-drop">⚠ No live-secret found on this machine — the push will be refused. It lives at ~/.cortexinsight/live-secret.</p>`}
      <div class="st-primary">
        <button class="prime-btn st-auto" id="stAuto">✦ STREAM THE MOST IMPORTANT THING</button>
        <label class="om-check st-follow"><input type="checkbox" id="stFollow" ${a.follow ? 'checked' : ''} />
          <span><b>Auto-follow</b> — while live, re-rank and re-tick as your work actually moves. Selection-only: it can only ever pick from what is already a candidate, and every push still passes both secret gates.</span></label>
      </div>
      <div class="st-links">
        <button class="mini" data-open="${a.urls.short || 'https://motuslive.vercel.app'}">⤢ motuslive.vercel.app</button>
        <button class="mini" data-open="${a.urls.live}">⤢ semble.cc/live</button>
        <button class="mini" data-open="${a.urls.livenow}">⤢ /livenow</button>
        <button class="mini" data-open="${a.urls.rightnow}">⤢ /rightnow</button>
        <button class="mini" id="stPushNow">⟳ push now</button>
        <button class="mini" id="stClearSel">◻ untick everything</button>
        <button class="mini" id="stVerify">🛡 what can the world see?</button>
        <button class="mini" id="stSweep" title="Read the public endpoint as a stranger would. If anything of yours is retrievable while off air, clear it — then read again to prove the clear landed.">⚔ sweep it clean</button>
      </div>
      <!-- WHERE the broadcast goes. Hardcoding this cost a silent outage when
           the domain was re-pointed — a target that can move is a setting. -->
      <div class="om-steer-row st-host">
        <label class="om-lab" style="flex:0 0 auto">Broadcast host</label>
        <input class="om-in" id="stHost" value="${esc(a.host || 'www.semble.cc')}" placeholder="www.semble.cc" spellcheck="false" />
        <button class="mini" id="stHostSet">set</button>
        <button class="mini" id="stHostFind" title="probe the known hosts and reconnect to whichever answers">⌕ find it</button>
      </div>
      <!-- THE PRIVACY VERDICT — fetched from the public endpoint with no
           secret, the way a stranger would. Not a claim; a reading. -->
      <div id="stVerdict" class="st-verdict"></div>
    </div>

    <!-- ═══ THE STRIP — five readings that decide whether to go live ═══
         Same pattern as the partner-page ledger strip: read the real state,
         show the one that does not flatter us, never invent a number. -->
    <div class="st-strip n5">
      <div class="st-si ${a.on ? 'live' : ''}"><b>${a.on ? 'ON AIR' : 'OFF AIR'}</b><i>${a.on ? 'the world can see the ticked items' : 'nothing is being shared'}</i></div>
      <div class="st-si"><b>${(a.candidates || []).length}</b><i>candidates offered</i></div>
      <div class="st-si ${Object.values(a.sel || {}).filter(Boolean).length ? 'go' : 'zero'}"><b>${Object.values(a.sel || {}).filter(Boolean).length}</b><i>ticked — all that can leave</i></div>
      <div class="st-si ${a.hasSecret ? '' : 'zero'}"><b>${a.hasSecret ? '✓' : '✕'}</b><i>${a.hasSecret ? 'push key present' : 'no key — pushes refuse'}</i></div>
      ${(() => { const w = sweepLine(a); return '<div class="st-si ' + w.cls + '"><b>' + w.b + '</b><i>' + esc(w.i) + '</i></div>'; })()}
    </div>

    <div class="card glass">
      <div class="card-h"><h3>The mode</h3><span class="card-tag">who is on deck — each carries their own light</span></div>
      <div class="st-djs">
        ${a.djs.map((d) => `<button class="st-dj ${a.dj === d.id ? 'on' : ''}" data-dj="${d.id}" style="--dh:${d.hue == null ? 195 : d.hue}">
          ${d.headliner ? '<span class="st-dj-tier">★</span>' : d.artist ? '<span class="st-dj-tier">✦</span>' : ''}
          <b>${esc(d.name)}</b><span>${esc(d.power)}</span></button>`).join('')}
      </div>
      <div class="st-powrow">
        ${a.powers.map((p) => `<button class="st-pow ${a.power === p.id ? 'on' : ''}" data-pow="${p.id}">${esc(p.name)}</button>`).join('')}
      </div>
      <label class="om-lab">Topic — one line above the stage</label>
      <div class="om-steer-row">
        <input class="om-in" id="stTopic" value="${esc(a.topic || '')}" placeholder="e.g. Building the CortexInsight LIVE section, on stream" />
        <button class="mini" id="stTopicSet">set</button>
      </div>
    </div>

    <div class="st-grid">
      <div class="card glass">
        <div class="card-h"><h3>What the world may see</h3><span class="card-tag">nothing ticked = nothing shared</span></div>
        <div class="st-cands">
          ${(a.candidates || []).map((c) => `
            <label class="st-cand ${a.sel[c.id] ? 'on' : ''}">
              <input type="checkbox" data-cand="${esc(c.id)}" ${a.sel[c.id] ? 'checked' : ''} />
              <span class="st-kind">${esc(c.kind)}</span>
              <span class="st-t">${esc(c.t)}</span>
              ${c.id.startsWith('custom:') ? `<button class="mini st-rm" data-rm="${esc(c.id.slice(7))}">✕</button>` : ''}
            </label>`).join('') || '<div class="om-empty">nothing to offer yet — set a Motus, a Goal, or add a line below</div>'}
        </div>
        <div class="om-steer-row">
          <input class="om-in" id="stCustom" placeholder="Add a line to broadcast — your words, your call…" />
          <button class="mini" id="stCustomAdd">＋ add</button>
        </div>
      </div>
      <div class="card glass">
        <div class="card-h"><h3>Exactly what leaves</h3><span class="card-tag">the payload, verbatim</span></div>
        <div id="stPreview">${streamPreview(a)}</div>
        <div class="card-h" style="margin-top:18px"><h3>SourceCrowd</h3><span class="card-tag">ranked by the crowd · your voice + moderation</span></div>
        <div class="om-steer-row st-say">
          <input class="om-in" id="stSay" placeholder="Speak into the room ◈ — answer the crowd, drop a link…" />
          <button class="mini" id="stSayBtn">⤴ say</button>
        </div>
        <div id="stMsgs">${streamMsgs()}</div>
        <div class="om-actions"><button class="mini" id="stRefreshChat">⟳ refresh</button><button class="mini" id="stClearChat">clear the whole room</button></div>
      </div>
    </div>
    ${ledgerStrip()}
    ${computeCard()}`);
  wireStream();
}
function wireStream() {
  const set = async (p) => {
    const r = await C.onAirSet(p);
    if (r && r.ok) { STREAM.data = r.onAir; paintStream(); }
  };
  const go = $('#stGo');
  if (go) go.onclick = () => set({ on: !STREAM.data.on });
  $$('#streamBody [data-dj]').forEach((b) => b.onclick = () => set({ dj: b.dataset.dj }));
  $$('#streamBody [data-pow]').forEach((b) => b.onclick = () => set({ power: STREAM.data.power === b.dataset.pow ? '' : b.dataset.pow }));
  $$('#streamBody [data-cand]').forEach((b) => b.onchange = () => set({ toggle: b.dataset.cand }));
  $$('#streamBody [data-rm]').forEach((b) => b.onclick = (e) => { e.preventDefault(); set({ rmCustom: b.dataset.rm }); });
  // window.open routes through setWindowOpenHandler → shell.openExternal
  $$('#streamBody [data-open]').forEach((b) => b.onclick = () => window.open(b.dataset.open));
  const tset = $('#stTopicSet');
  if (tset) tset.onclick = () => set({ topic: $('#stTopic').value });
  const cadd = $('#stCustomAdd');
  if (cadd) cadd.onclick = () => { const v = $('#stCustom').value.trim(); if (v) set({ addCustom: v }); };
  const pn = $('#stPushNow');
  if (pn) pn.onclick = async () => { const r = await C.onAirPush(); if (r && r.ok) { STREAM.data = r.onAir; paintStreamStatus(); toast(r.push && r.push.ok ? 'pushed — the pages update within a beat' : 'push failed: ' + ((r.push && r.push.error) || '?'), r.push && r.push.ok ? 'good' : 'bad'); } };
  // ✦ STREAM THE MOST IMPORTANT THING — ranks every candidate the way the rest
  // of the app thinks and ticks the few that actually say what he is doing.
  const au = $('#stAuto');
  if (au) au.onclick = async () => {
    au.disabled = true; au.textContent = '✦ reading your work…';
    const r = await C.onAirAuto();
    au.disabled = false;
    if (r && r.ok) {
      STREAM.data = r.onAir; paintStream();
      toast(`picked ${r.picked.length}: ${r.picked.map((p) => p.kind).join(' · ')}`, 'good');
    } else { au.textContent = '✦ STREAM THE MOST IMPORTANT THING'; toast('auto-pick failed', 'bad'); }
  };
  const fl = $('#stFollow');
  if (fl) fl.onchange = () => set({ follow: fl.checked });
  const cs = $('#stClearSel');
  if (cs) cs.onclick = () => set({ clearSel: true });
  const sb = $('#stSayBtn'), si = $('#stSay');
  const say = async () => {
    const v = (si.value || '').trim(); if (!v) return;
    sb.disabled = true;
    const r = await C.onAirSay(v);
    sb.disabled = false;
    if (r && r.ok) { si.value = ''; loadStreamChat(); toast('said', 'good'); }
    else toast((r && r.error) || 'the room did not take it', 'bad');
  };
  if (sb) sb.onclick = say;
  if (si) si.onkeydown = (e) => { if (e.key === 'Enter') say(); };
  $$('#streamBody .st-del').forEach((b) => b.onclick = async () => { await C.onAirChatDel({ id: b.dataset.del }); loadStreamChat(); });
  const rf = $('#stRefreshChat');
  if (rf) rf.onclick = () => loadStreamChat();
  const pl = $('#cmpPledge');
  if (pl) pl.onclick = async () => {
    pl.disabled = true;
    const r = await C.computePledge({}).catch(() => null);
    pl.disabled = false;
    if (r && r.ok) toast('Pledged — this machine is in the pool as ' + r.node, 'good');
    else toast('Pledge refused: ' + ((r && r.error) || 'no answer'), 'bad');
    loadStream();
  };
  const cb = $('#cmpClaimBtn');
  if (cb) cb.onclick = async () => {
    const v = ($('#cmpClaim') || {}).value || '';
    if (!v.trim()) return toast('Paste a node id first', 'bad');
    const r = await C.computeClaimNode(v.trim()).catch(() => null);
    if (r && r.ok) { toast('Marked as yours — the stranger count is now truthful', 'good'); loadStream(); }
    else toast((r && r.error) || 'could not mark', 'bad');
  };
  const gp = $('#stGolemProbe');
  if (gp) gp.onclick = async () => {
    gp.disabled = true; gp.textContent = '⟲ measuring…';
    const g = await C.golem().catch(() => null);
    if (g && g.ok) { STREAM.golem = g.golem; paintStream(); toast('Golem measured', 'good'); }
    else { gp.disabled = false; gp.textContent = '⟲ measure it again'; toast('Golem did not answer', 'bad'); }
  };
  const cr = $('#stCmpRefresh');
  if (cr) cr.onclick = async () => { const c = await C.compute(); if (c && c.ok) { STREAM.compute = c; paintStream(); toast('pool refreshed', 'good'); } };
  const cc2 = $('#stCmpClear');
  if (cc2) cc2.onclick = async () => { await C.computeClear(); const c = await C.compute(); if (c && c.ok) { STREAM.compute = c; paintStream(); } toast('pool ledger cleared', 'good'); };

  /* ── the dispatch console ── */
  const ws = $('#stWorkSend');
  if (ws) ws.onclick = async () => {
    const sel = $('#stWorkTask');
    const opt = sel && sel.selectedOptions[0];
    const title = (opt && opt.dataset.title) || '';
    const text = ($('#stWorkText').value || '').trim();
    if (!title && !text) { toast('pick a task or paste some public text', 'warn'); return; }
    ws.disabled = true;
    const r = await C.workEnqueue({ task: title || text.slice(0, 60), text: text || title, kind: 'embed' });
    ws.disabled = false;
    if (r && r.ok) {
      const res = r.res || {};
      $('#stWorkText').value = '';
      const k = await C.work(); if (k && k.ok) STREAM.work = k.work;
      paintStream();
      toast(`${res.enqueued} unit(s) dispatched · ${res.canaries} canary${r.held ? ` · ${r.held} chunk(s) held by the gate` : ''}`, 'good');
    } else {
      // The refusal is the feature here — say exactly why, because "it didn't
      // work" teaches him nothing about what the gate protects.
      toast((r && r.error) || (r && r.res && r.res.error) || 'dispatch refused', 'bad');
    }
  };
  const wr = $('#stWorkRefresh');
  if (wr) wr.onclick = async () => { const k = await C.work(); if (k && k.ok) { STREAM.work = k.work; paintStream(); toast('queue refreshed', 'good'); } };
  const wc = $('#stWorkClear');
  if (wc) wc.onclick = async () => {
    if (!confirm('Clear the work queue?\n\nUnfinished units are dropped. RECEIPTS ARE KEPT — a receipt is a contributor\'s proof their machine did something real, and it is not yours to delete.')) return;
    const r = await C.workClear();
    const k = await C.work(); if (k && k.ok) STREAM.work = k.work;
    paintStream();
    toast(`queue cleared — ${(r.res && r.res.dropped) || 0} dropped, ${(r.res && r.res.receiptsKept) || 0} receipts kept`, 'good');
  };

  /* ── the payout console ──
     plan is free and changes nothing. arm freezes a batch. settle records a
     txid he already broadcast himself. Every money-touching step confirms,
     because a mis-click here is not a UI annoyance, it is an accounting fault. */
  const pp = $('#stPayPlan');
  if (pp) pp.onclick = async () => {
    const r = await C.payoutOp({ op: 'plan', rail: 'dash' });
    if (r && r.ok) {
      STREAM.plan = r.res; paintStream();
      toast(r.res.recipients ? `${r.res.recipients} clear the floor · ${r.res.total.toFixed(6)} DASH` : 'nothing clears the $5 floor yet', r.res.recipients ? 'good' : 'warn');
    } else toast((r && r.error) || 'plan failed', 'bad');
  };
  const pa = $('#stPayArm');
  if (pa) pa.onclick = async () => {
    const pl = STREAM.plan; if (!pl || !pl.recipients) return;
    if (!confirm(`Arm a payout batch?\n\n${pl.recipients} recipient(s) · ${pl.total.toFixed(6)} DASH ($${pl.totalUsd.toFixed(2)})\n\nThis FREEZES the amounts and hands you a sendmany to sign on your own node. No money moves until you sign it — CortexInsight holds no key.`)) return;
    const r = await C.payoutOp({ op: 'arm', rail: 'dash', confirmed: true });
    if (r && r.ok) {
      STREAM.armed = r.res; STREAM.plan = r.res;
      const y = await C.payouts(); if (y && y.ok) STREAM.pay = y.pay;
      paintStream(); toast(`batch ${r.res.batchId} armed — sign it on your node`, 'good');
    } else toast((r && r.res && r.res.error) || (r && r.error) || 'arm refused', 'bad');
  };
  const ps = $('#stSettle');
  if (ps) ps.onclick = async () => {
    const tx = ($('#stTxid').value || '').trim();
    if (!tx) { toast('paste the txid your node returned', 'warn'); return; }
    if (!confirm(`Record batch ${STREAM.armed.batchId} as SETTLED with txid ${tx}?\n\nThis marks those contributors paid. Only do this after the transaction actually broadcast.`)) return;
    const r = await C.payoutOp({ op: 'settle', batchId: STREAM.armed.batchId, txid: tx, confirmed: true });
    if (r && r.ok) {
      STREAM.armed = null; STREAM.plan = null;
      const y = await C.payouts(); if (y && y.ok) STREAM.pay = y.pay;
      const c = await C.compute(); if (c && c.ok) STREAM.compute = c;
      paintStream(); toast(`settled — ${r.res.motusSecondsSettled} MOTUS-s cleared`, 'good');
    } else toast((r && r.res && r.res.error) || 'settle failed', 'bad');
  };
  const pf = $('#stFail');
  if (pf) pf.onclick = async () => {
    if (!confirm(`Release batch ${STREAM.armed.batchId}?\n\nNothing is marked paid and the balances stay open.`)) return;
    const r = await C.payoutOp({ op: 'fail', batchId: STREAM.armed.batchId, note: 'released from CortexInsight' });
    if (r && r.ok) { STREAM.armed = null; const y = await C.payouts(); if (y && y.ok) STREAM.pay = y.pay; paintStream(); toast('batch released', 'good'); }
  };
  const pr = $('#stPayRefresh');
  if (pr) pr.onclick = async () => { const y = await C.payouts(); if (y && y.ok) { STREAM.pay = y.pay; paintStream(); toast('payouts refreshed', 'good'); } };
  const gg = $('#stGolem');
  if (gg) gg.onclick = async () => {
    const g = await C.golem();
    if (g && g.ok) {
      STREAM.golem = g.golem; paintStream();
      const s = g.golem.supply || {};
      toast(`Golem: ${s.providers} providers · ${s.gpus} GPUs`, s.gpus ? 'good' : 'warn');
    }
  };
  const cc = $('#stClearChat');
  if (cc) cc.onclick = async () => { await C.onAirChatDel({ all: true }); loadStreamChat(); toast('SourceCrowd cleared', 'good'); };
}

/* ==================================================== OMNIDRIVE · MOTUS MAX
   The screen where she stops advising and starts operating. Everything here is
   built around one idea: August should never be unsure whether she can move.
   The arm state is the loudest thing on the page, it counts down in front of
   him, and it is the only control that takes a deliberate press-and-hold. */
const OMNI = { data: null, tick: 0, audio: null, frame: '', holdT: 0, held: false,
  thread: null, read: null, frames: null, map: '', mapZoom: 'map', busy: false };

/* Her strategic read, rendered as the thing it is: a decision with a rung on
   it, not a summary. The divergent frame is given its own weight on purpose —
   it is the part he cannot get from himself. */
function readCard(R) {
  if (!R) return '';
  return `<div class="om-read">
    <div class="or-h">◇ Her read<span>${esc(aname(R.agent))} · ${ago(R.ts)} ago</span></div>
    <div class="or-lever">${esc(R.lever)}</div>
    <div class="or-grid">
      <div><span>Phase</span><p>${esc(R.phase)}</p></div>
      <div><span>Loop</span><p>${esc(R.loop)}</p></div>
      <div><span>Meadows rung</span><p>${esc(R.rung)}</p></div>
      <div><span>Cost</span><p>${esc(R.cost)}</p></div>
    </div>
    <div class="or-row"><span>Why now</span><p>${esc(R.whyNow)}</p></div>
    <div class="or-row"><span>First step</span><p>${esc(R.firstStep)}</p></div>
    ${R.obsoletes ? `<div class="or-row"><span>What it makes unnecessary</span><p>${esc(R.obsoletes)}</p></div>` : ''}
    ${R.frame ? `<div class="or-frame"><span>✶ The frame you didn't have</span><p>${esc(R.frame)}</p></div>` : ''}
    <div class="or-act"><button class="prime-btn" data-drive-read="1">◈ Drive this move</button><button class="mini" data-read-task="1">Put it on the board</button></div>
  </div>`;
}
function framesCard(F) {
  if (!F || !F.frames) return '';
  return `<div class="om-read frames">
    <div class="or-h">✶ Divergent frames<span>${esc(aname(F.agent))} · ${ago(F.ts)} ago</span></div>
    ${F.frames.map((f, i) => `
      <div class="or-fr">
        <div class="or-fr-h"><b>${i + 1}</b>${esc(f.claim)}</div>
        <div class="or-fr-m">${esc(f.method)} · confidence ${f.confidence}/10</div>
        ${f.ifTrue ? `<div class="or-row"><span>If true</span><p>${esc(f.ifTrue)}</p></div>` : ''}
        ${f.test ? `<div class="or-row"><span>Cheapest test</span><p>${esc(f.test)}</p></div>` : ''}
      </div>`).join('')}
    ${F.sharpest ? `<div class="or-frame"><span>Sharpest</span><p>${esc(F.sharpest)}</p></div>` : ''}
  </div>`;
}

function omniFmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function omniStopAudio() { if (OMNI.audio) { try { OMNI.audio.pause(); } catch {} OMNI.audio = null; } }
function omniClock() {
  clearInterval(OMNI.tick);
  OMNI.tick = setInterval(() => {
    if (CUR.view !== 'omni') { clearInterval(OMNI.tick); OMNI.tick = 0; return; }
    const el = $('#omLeft'); if (!el || !OMNI.data) return;
    const left = (OMNI.data.remainingMs || 0) - 1000;
    OMNI.data.remainingMs = Math.max(0, left);
    el.textContent = omniFmtLeft(OMNI.data.remainingMs);
    if (OMNI.data.armed && OMNI.data.remainingMs <= 0) loadOmni();
  }, 1000);
}
// Live events from the drive loop. Repaint rather than poll — a poll on a
// screen-capture loop is exactly the kind of idle burn we spent a release killing.
/* ── STEER MOTUS MAX BY VOICE · Ctrl+Shift+M ────────────────────────────────
   Works from anywhere, whatever has focus. Press once to listen, speak, and it
   auto-sends after a beat of silence — no window to find, no button to hunt
   for. Your words land ahead of her plan on the very next frame. Press again
   to cancel without sending. */
if (C.onOmniVoice) C.onOmniVoice(async (d) => {
  if (!d) return;
  if (!d.on) { stopListening(); toast('Not listening', 'warn'); return; }
  if (!voiceSupported()) { toast('No microphone in this build', 'bad'); return; }
  toast('🎙 Listening — speak your direction', 'good');
  startListening({
    autoStop: true,
    onDone: async (text) => {
      const t = String(text || '').trim();
      if (!t) { toast('Heard nothing', 'warn'); return; }
      const r = await C.omniSteer(t);
      if (r && r.ok) {
        toast('Steered: “' + t.slice(0, 60) + '”', 'good');
        if (CUR.view === 'omni') { const s = await C.omni(); if (s && s.ok) { OMNI.data = s.omni; OMNI.handsWhy = s.handsWhy || null; paintOmni(); } }
      } else {
        toast((r && r.error) || 'Could not steer — is a session running?', 'bad');
      }
    },
  });
});

// the board narrates its own autonomous work as it happens
if (C.onAutoWork) C.onAutoWork((d) => {
  if (!d) return;
  if (d.kind === 'start') toast(`⇄ ${aname(d.agent)} picked up “${String(d.title || '').slice(0, 60)}”`, 'good');
  if (d.kind === 'end') toast(d.ok ? '⇄ auto-work finished' : '⇄ auto-work stalled — see the task log', d.ok ? 'good' : 'warn');
  if (CUR.view === 'tasks') loadBoard();
});

if (C.onOmni) C.onOmni((d) => {
  if (!d) return;
  if (d.omni) OMNI.data = d.omni;
  // THE FRAME PANEL NEVER UPDATED DURING A SESSION. It was loaded once in
  // loadOmni() and never again, so he watched a still picture while she worked
  // and reasonably concluded nothing was happening. Every new frame now pulls
  // the image immediately — this is the difference between a live cockpit and
  // a screenshot of one.
  if (d.kind === 'frame') omniLoadFrame();
  // A LIVE MOVE APPENDS, never repaints — a full paint every 2s would wipe
  // whatever he is reading elsewhere on the page. The ticker element is the
  // only thing touched, and only when the omni view is actually open.
  if (d.kind === 'move' && d.line) {
    const s2 = OMNI.data && OMNI.data.session;
    if (s2) { s2.moves = [...(s2.moves || []), { ts: Date.now(), line: d.line }].slice(-16); }
    const t = $('#omTicker');
    if (t) {
      if (t.querySelector('.om-empty')) t.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'om-tick fresh';
      row.textContent = d.line;
      t.appendChild(row);
      while (t.children.length > 10) t.removeChild(t.firstChild);
      t.scrollTop = t.scrollHeight;
    }
  }
  if (d.kind === 'speak' && d.audio) {
    omniStopAudio();
    try { const a = new Audio('data:audio/mpeg;base64,' + d.audio); OMNI.audio = a; a.play().catch(() => {}); } catch {}
  }
  // A LANDED MOVE IS THE HEADLINE, not a log line. He stopped a session that
  // was fixing his live platform because nothing ever told him it had.
  if (d.kind === 'moved') {
    OMNI.moves = [{ ts: Date.now(), line: d.line, files: d.files, verified: d.verified }, ...(OMNI.moves || [])].slice(0, 12);
    toast('◈ ' + String(d.line).slice(0, 90), 'good');
    if (CUR.view === 'omni') paintOmni();
  }
  if (d.kind === 'ask') toast('Motus Max is waiting on you', 'warn');
  if (d.kind === 'stale') toast('You moved — she dropped that batch and is looking again', 'warn');
  if (d.kind === 'ended') toast('Motus Max: ' + (d.why || 'session ended'), d.verdict === 'done' ? 'good' : 'warn');
  if (CUR.view === 'omni') paintOmni();
});

/* the one-press openers for whichever gate is closed */
document.addEventListener('click', async (e) => {
  if (e.target && e.target.id === 'hwDry') {
    const cb = $('#omDry'); if (cb) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    await C.omniArm({ dry: false }).catch(() => {});
    toast('Dry run off — her hands are live when armed', 'good');
    loadOmni();
  }
  if (e.target && e.target.id === 'hwMode') {
    await C.omniArm({ moveMode: 'screen' }).catch(() => {});
    toast('Move kind set to Drive my screen', 'good');
    loadOmni();
  }
});
/* the deck, assembled from what is actually banked: newest read's lever, its
   divergent frame, and the latest frame-record's claims — deduped, max 4 */
function omniPaths() {
  const out = [];
  const add = (t, sub, step, conf, fals) => {
    t = String(t || '').trim();
    if (!t || out.some((p) => p.t === t)) return;
    out.push({ t, sub: sub || '', step: step || '', conf: Number.isFinite(conf) ? conf : null, fals: fals || '' });
  };
  const R = (OMNI.reads || [])[0];
  if (R) { add(R.lever, R.whyNow, R.firstStep, R.confidence, R.falsifier); add(R.frame, 'her divergent frame from the same read', ''); }
  const F = (OMNI.framesAll || [])[0];
  for (const f of ((F && F.frames) || []).slice(0, 3)) add(f.claim, f.ifTrue || f.method, f.test);
  return out.slice(0, 4);
}
/* a failed pre-read has one way out: read again, on the fastest seat with hands if there is one */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-preread-retry]');
  if (!b) return;
  b.disabled = true; b.textContent = '… reading';
  const r = await C.omniPreRead(b.dataset.prereadRetry || undefined).catch(() => null);
  if (r && r.ok) toast('Reading the map again', 'good'); else toast((r && r.error) || 'could not read', 'bad');
  loadOmni();
});
/* a click on a card's title or body opens the card in full; the clamp is presentation only */
document.addEventListener('click', (e) => {
  const t = e.target.closest('.tc-title, .tc-body');
  if (!t) return;
  const card = t.closest('.tcard');
  if (card) card.classList.toggle('open');
});
/* a click on a path's text opens it in full; the clamp is presentation only */
document.addEventListener('click', (e) => {
  const m = e.target.closest('.omp-mid, .mab');
  if (m) m.classList.toggle('open');
});
/* a path press hands the chosen future straight to the drive */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-drivepath]');
  if (!b) return;
  const p = omniPaths()[+b.dataset.drivepath];
  if (!p) return;
  if (!(OMNI.data && OMNI.data.armed)) { toast('Arm her first — hold the arm button, then press the path again', 'warn'); return; }
  b.disabled = true; b.textContent = '▷ starting…';
  const r = await C.omniStart({ goal: p.t + (p.step ? ' — start with: ' + p.step : '') }).catch(() => null);
  b.disabled = false; b.textContent = '▷ drive this';
  if (r && r.ok) toast('She is driving that path', 'good');
  else toast((r && r.error) || 'could not start', 'bad');
  loadOmni();
});
async function loadOmni() {
  const [r, st] = await Promise.all([C.omni(), C.strategy().catch(() => null)]);
  if (!r || !r.ok) return;
  OMNI.data = r.omni;
  OMNI.handsWhy = r.handsWhy || null;   // why the pointer is not moving, from the source
  if (st && st.ok) {
    OMNI.thread = st.thread;
    if (!OMNI.read) OMNI.read = (st.reads || [])[0] || null;
    if (!OMNI.frames) OMNI.frames = (st.frames || [])[0] || null;
    // the paths deck needs the CURRENT reads, not the first one ever cached
    OMNI.reads = st.reads || [];
    OMNI.framesAll = st.frames || [];
    OMNI.mapAvailable = st.mapAvailable;
  }
  paintOmni();
  omniClock();
  omniLoadFrame();
  omniLoadMap();
  omniLoadReplay();          // list the recorded drives; frames load on pick
}
async function omniLoadMap() {
  const m = await C.map(OMNI.mapZoom, OMNI.mapFocus || '').catch(() => null);
  if (!m || !m.ok) return;
  OMNI.map = m.text; OMNI.platforms = m.platforms || []; OMNI.mapAvailable = m.available;
  const el = $('#omMapText'); if (el) el.textContent = m.text;
  const av = $('#omMapAvail'); if (av) av.textContent = m.available ? `${(m.platforms || []).length} platforms · live from your BuildMode canon` : 'canon not readable from here';
}
async function omniLoadFrame() {
  const f = await C.omniFrame().catch(() => null);
  if (f && f.ok) { OMNI.frame = f.dataUrl; omniApplyFrame(); }
}

// An instrument step is a different KIND of act from a click, and it should
// read that way: she went and got the real thing instead of squinting at a
// picture of it. That is the behaviour he asked for, so it gets its own mark.
const OM_INSTRUMENT = { read: '⌕', api: '⇄', work: '✎' };
function omniStepRow(s) {
  const ins = OM_INSTRUMENT[s.op];
  return `<div class="om-step ${s.ok ? '' : 'bad'} ${s.dry ? 'dry' : ''} ${ins ? 'instr' : ''}">
    <span class="om-op">${ins ? ins + ' ' : ''}${esc(s.op)}</span>
    <span class="om-note">${esc(s.note || '')}</span>
    <span class="om-said">${esc(s.said || '')}</span>
  </div>`;
}

function paintOmni() {
  const o = OMNI.data; if (!o) return;
  const s = o.session;
  const live = s && (s.status === 'running' || s.status === 'waiting');
  const agents = (FLEET_LIVE || []).filter((a) => a.lane === 'relay');

  /* ═══ THE READINGS — this is the deepest permission in the app, so its strip
     answers the permission questions first and the progress questions second.
     ARMED and HANDS are deliberately the two loudest cells: whether she may
     act, and whether her hands are real. Confusing dry-run for live is the one
     mistake on this page that cannot be undone. ═══ */
  const omArmMin = o.remainingMs ? Math.max(0, Math.round(o.remainingMs / 60000)) : 0;
  const mmss = (x) => x >= 60 ? Math.floor(x / 60) + 'm' + String(Math.round(x % 60)).padStart(2, '0') + 's' : Math.round(x) + 's';
  const clock = o.seatClock && o.seatClock.n ? o.seatClock : null;
  const omMoves = (s && (s.cycles || (s.moves || []).length)) || 0;
  const omSteps = (s && (s.steps || []).length) || 0;
  setHTML($('#omniBody'), `
    <div class="view-head"><h2>Motus Max</h2>
      <p class="view-desc">OmniDrive. She sees your actual screen, moves your actual mouse and keyboard, and works across whatever app the work really lives in — with you steering by voice or text. This is the deepest permission in the app, so it is the loudest one on the page.</p></div>

    <div class="st-strip n5">
      ${siCell(o.armed ? 'live' : '', o.armed ? 'ARMED' : 'DISARMED',
        o.armed ? (omArmMin ? 'she may act — ' + omArmMin + ' min left' : 'she may act') : 'she cannot touch your machine')}
      ${(() => {
        // ⚠ CAUGHT IN REVIEW: this read "REAL — her hands are live on your
        // machine" while the cell beside it said DISARMED. Both facts were
        // true separately and the sentence was false. The dry-run flag alone
        // does not describe reality — she can only touch anything when she is
        // ARMED *and* not dry, and on this page overstating that is the one
        // mistake that cannot be undone.
        const canTouch = o.armed && !o.dry;
        if (canTouch) return siCell('live', 'REAL', 'her hands are live on your machine');
        if (o.armed) return siCell('zero', 'DRY', 'armed, but hands off — every step shown as “would…”');
        if (o.dry) return siCell('', 'DRY', 'dry run set, and she is disarmed');
        return siCell('', 'REAL', 'hands are real — but disarmed, so she cannot act');
      })()}
      ${(() => {
        if (live) return siCell('live', esc(s.status).toUpperCase(), o.turnInFlight
          ? esc(o.turnInFlight.kind) + ' · ' + mmss(o.turnInFlight.secs) + (clock ? ' of a typical ' + mmss(clock.median) : ' in flight') + (clock && o.turnInFlight.secs > clock.p90 ? ' · past her p90, still moving' : '')
          : 'between turns — next one is queuing');
        // armed and idle: the arm-time read is the state that matters
        const pr = o.armed && o.preRead ? o.preRead : null;
        if (pr && pr.status === 'ready') return siCell('go', 'READY', 'move chosen at arm: ' + esc(String(pr.firstStep || '')) + (pr.confidence != null ? ' · confidence ' + pr.confidence + '/10' : '') + ' · press Drive');
        if (pr && pr.status === 'reading') return siCell('', 'READING', 'choosing the move now · ' + mmss(pr.secs) + (clock ? ' of a typical ' + mmss(clock.median) : ''));
        if (pr && pr.status === 'failed') {
          // the way out of a failed read is one press: the fastest seat with hands
          const f = o.fastestHands;
          const retry = f && f.id !== o.agent ? ' <button class="mini go" data-preread-retry="' + esc(f.id) + '">read again with ' + esc(f.name) + '</button>' : ' <button class="mini" data-preread-retry="">read again</button>';
          return siCell('zero', 'NO READ', esc(String(pr.error || '')) + ' · Drive reads on press' + retry);
        }
        // the full reason, never a slice: a cut sentence cannot be recovered by clicking
        return siCell('', s ? esc(s.status) : 'none', s ? 'last session · ' + esc(String(s.why || 'ended')) : 'no session yet');
      })()}
      ${siCell(omMoves ? 'go' : '', omMoves, 'move(s) this session · ' + omSteps + ' step(s)')}
      ${(() => {
        // the fifth cell is the wait, as a number — and the way out of it
        if (!clock) return siCell('', '—', 'no completed turns on this seat yet, so the first one sets the clock');
        const slow = clock.median > 300;
        const f = o.fastestHands;
        const alt = slow && f && f.id !== clock.agent && f.median < clock.median * 0.7 ? ' · ' + esc(f.name) + ' has hands and answers in ~' + mmss(f.median) : '';
        const why = o.depth ? ' · max depth is on, so the choice takes longer (your setting)' : '';
        return siCell(slow ? 'zero' : 'go', mmss(clock.median), 'typical turn on this seat · p90 ' + mmss(clock.p90) + ' · ' + clock.n + ' turns in 7 days' + alt + why);
      })()}
    </div>

    ${(() => {
      // ⚠ "it just shows a text message of what it is doing" — the hands ARE
      // real (SetCursorPos / mouse_event). When the pointer does not move
      // there is always ONE specific gate, and the app never named it. It does
      // now, with the control that opens it.
      const hw = OMNI.handsWhy;
      if (!hw || hw.moving) return '';
      const act = { arm: '', dry: 'omDry', mode: '', stop: '', start: 'omHold' }[hw.fix] || '';
      return '<div class="hands-why"><span class="hw-k">⊘ HER HANDS ARE NOT MOVING</span>'
        + '<span class="hw-t">' + esc(hw.why) + '</span>'
        + (hw.fix === 'dry' ? '<button class="mini hw-go" id="hwDry">turn DRY RUN off</button>' : '')
        + (hw.fix === 'mode' ? '<button class="mini hw-go" id="hwMode">switch to ▶ Drive my screen</button>' : '')
        + '</div>';
    })()}
    ${(() => {
      // ★ "show me some next paths or next steps to take" — her strategic
      // reads ALREADY contain them: the lever, the divergent frame, and the
      // frame records' claims — banked in the vault even when a drive failed
      // to start. They were sitting in storage with no door. Now each one is
      // a card, and each card is one press from being driven for real.
      const paths = omniPaths();
      if (!paths.length) return '';
      return '<div class="om-paths"><div class="omp-h">◈ NEXT PATHS <span>from her reads of the system — press one and she drives it</span></div>'
        + paths.map((p, i) => '<div class="omp-row">'
          // full text, clamped by CSS and opened by a click: a sliced sentence
          // ("provenance `obse") cannot be recovered by anything he does
          + '<div class="omp-mid" title="click to read in full"><div class="omp-t">' + esc(String(p.t)) + '</div>'
          + (p.sub ? '<div class="omp-s">' + esc(String(p.sub)) + '</div>' : '')
          + (p.step ? '<div class="omp-f">first: ' + esc(String(p.step)) + '</div>' : '')
          + (p.conf != null ? '<span class="omp-conf" title="her confidence in this lever, with its basis in the read">confidence ' + p.conf + '/10</span>' : '')
          + (p.fals ? '<div class="omp-fals">falsifier: ' + esc(String(p.fals)) + '</div>' : '') + '</div>'
          + '<button class="mini go" data-drivepath="' + i + '">▷ drive this</button></div>').join('')
        + '</div>';
    })()}
    <!-- THE ARM — the single most important state in this build -->
    <div class="om-arm glass-deep ${o.armed ? 'on' : ''} ${o.armed && !live ? 'idle' : ''}">
      <div class="om-arm-core">
        <button class="om-hold ${o.armed ? 'on' : ''}" id="omHold">
          <span class="om-hold-fill"></span>
          <span class="om-hold-lab">${o.armed ? 'ARMED' : 'HOLD TO ARM'}</span>
        </button>
        <div class="om-arm-meta">
          <div class="om-arm-state">${o.armed ? (live ? 'She is driving' : 'Armed — but she is not driving yet') : 'She cannot touch your machine'}</div>
          <div class="om-arm-sub">${o.armed
            ? (live
              ? `Disarms by itself in <b id="omLeft">${omniFmtLeft(o.remainingMs)}</b> — and instantly on <b>Ctrl + Alt + Shift + X</b>, from anywhere, even while another app has focus.`
              : `Arming grants permission. It does <b>not</b> start the work — press <b>Drive Now</b>, or just say <b>“Motus Max”</b> out loud. Fuse: <b id="omLeft">${omniFmtLeft(o.remainingMs)}</b> · panic key <b>Ctrl + Alt + Shift + X</b>.`)
            : 'Arming is a press-and-hold, never a stray click, and never something she can do for herself. She can ask; only you grant it.'}</div>
        </div>
        ${!live ? `<button class="om-flow" id="omFlow">∞ Enter the Flow</button>` : ''}
        ${o.armed && !live ? `<button class="om-drivenow" id="omDriveNow">▶ One move</button>` : ''}
        ${o.armed ? '<button class="om-disarm" id="omDisarm">Disarm now</button>' : ''}
      </div>
    </div>

    <!-- how she is allowed to move -->
    <div class="om-grid">
      <div class="card glass">
        <div class="card-h"><h3>Scope</h3><span class="card-tag">where she may act</span></div>
        <div class="om-seg" id="omScope">
          <button data-v="guarded" class="${o.scope === 'guarded' ? 'on' : ''}">Guarded</button>
          <button data-v="open" class="${o.scope === 'open' ? 'on' : ''}">Open</button>
        </div>
        <p class="om-p">${o.scope === 'guarded'
          ? 'She may only bring forward windows you have allow-listed. Anything else, she has to ask.'
          : 'Any window except the permanently protected ones. Use this for real cross-app work.'}</p>
        <label class="om-lab">Allowed windows</label>
        <input class="om-in" id="omAllow" value="${esc((o.allow || []).join(', '))}" placeholder="Chrome, Code, Obsidian…" />
      </div>

      <div class="card glass">
        <div class="card-h"><h3>Pacing</h3><span class="card-tag">${o.pacing === 'ask' ? '⚠ she waits for you' : 'she moves on her own'}</span></div>
        <div class="om-seg" id="omPacing">
          <button data-v="ask" class="${o.pacing === 'ask' ? 'on' : ''}">Ask first</button>
          <button data-v="auto" class="${o.pacing === 'auto' ? 'on' : ''}">Full drive</button>
        </div>
        <p class="om-p">${o.pacing === 'ask'
          ? '<b>Every batch of steps waits for your tap.</b> Slower, and the right way to start — but if it feels like she is asking permission for every move, <i>this is why</i>. Switch to Full drive.'
          : 'She keeps moving on her own between frames. This is Motus Max proper.'}</p>
        <div class="om-two">
          <div><label class="om-lab">Fuse (minutes)</label><input class="om-in" id="omTtl" type="number" min="5" max="180" value="${o.ttlMin}" /></div>
          <div><label class="om-lab">Step budget</label><input class="om-in" id="omMax" type="number" min="4" max="400" value="${o.maxSteps}" /></div>
        </div>
        <label class="om-lab">What kind of move</label>
        <div class="om-seg three" id="omMoveMode">
          <button data-v="auto" class="${(o.moveMode || 'auto') === 'auto' ? 'on' : ''}">◈ Auto</button>
          <button data-v="work" class="${o.moveMode === 'work' ? 'on' : ''}">⌘ Work in my files</button>
          <button data-v="screen" class="${o.moveMode === 'screen' ? 'on' : ''}">▶ Drive my screen</button>
        </div>
        <p class="om-p">${o.moveMode === 'screen'
          ? '<b>She will move your actual pointer.</b> Perceive, aim, click, type — one small batch at a time, with the freshness gate before every touch. This is the one that looks like something is happening.'
          : o.moveMode === 'work'
            ? '<b>Files, repos, commands.</b> Your pointer stays yours and nothing on screen moves — which is exactly why it can look like nothing is happening while three files get written.'
            : 'She reads the goal and picks. Work for anything that is files, repos, APIs or commands; screen for anything that only exists behind a GUI. <b>Pick one explicitly if you want to see her drive.</b>'}</p>

        <label class="om-lab">Reflex — how fast each cycle turns</label>
        <div class="om-seg three" id="omSpeed">
          <button data-v="low" class="${o.speedEffort === 'low' ? 'on' : ''}">Instant</button>
          <button data-v="medium" class="${o.speedEffort === 'medium' ? 'on' : ''}">Fast</button>
          <button data-v="high" class="${o.speedEffort === 'high' ? 'on' : ''}">Careful</button>
        </div>
        <p class="om-p">A drive cycle is <i>look, decide one small batch, act</i> — the deciding already happened in her read. Her runner clocks deep-with-tools at <b>159s</b> a turn versus <b>20s</b> shallow, which is why a slow reflex makes her reason about a screen you have already moved on from. Restored to your normal setting when the session ends.</p>

        <label class="om-check reflex"><input type="checkbox" id="omReflex" ${o.reflex !== false ? 'checked' : ''} /> <span><b>The reflex lane</b> — cycles that <i>execute</i> a plan she already made go to a lean seat with no identity envelope; every cycle that <i>forms or changes</i> the plan stays with her. Measured on your relay: <b>6.1s vs 13.4s</b> on a bare turn, <b>14% faster</b> on a real drive cycle. Your voice, a surprise, a zoom, and every 4th cycle always come back to her — so a long drive can never quietly leave her behind.</span></label>
      </div>

      <div class="card glass">
        <div class="card-h"><h3>Who drives</h3><span class="card-tag">and whether she speaks</span></div>
        <select class="om-in" id="omAgent">
          ${(o.seats || agents).map((a) => `<option value="${a.id}" ${o.agent === a.id ? 'selected' : ''}>${esc(a.name)}${a.canBuild ? ' — mind and hands' : ' — the fast read-only mind'}</option>`).join('')}
        </select>
        ${(() => {
          const seat = (o.seats || []).find((x) => x.id === o.agent);
          if (!seat) return '';
          if (seat.canBuild) return `<p class="om-p">${esc(seat.name)} decides <i>and</i> executes — her runner carries <code>Write Edit Bash</code>.</p>`;
          const hs = (o.seats || []).find((x) => x.id === o.hands);
          return `<p class="om-p handsrow">◈ <b>${esc(seat.name)} is the fastest seat</b> — no Write or Bash means no tool loop, which is why she thinks in seconds. She sees and decides; <b>${esc((hs || {}).name || o.hands)}</b> does the writing. That pairing is what her own runner and SOUL describe, not a workaround.</p>`;
        })()}
        ${(o.displayList || []).length > 1 ? `
          <label class="om-lab">Which screen she watches</label>
          <select class="om-in" id="omDisplay">
            <option value="-1" ${o.displayPin == null ? 'selected' : ''}>◎ Follow me — whichever screen my pointer is on</option>
            ${o.displayList.map((d) => `<option value="${d.i}" ${o.displayPin === d.i ? 'selected' : ''}>${esc(d.label)} — ${d.w}×${d.h}${d.primary ? ' · primary' : ''}${d.active ? ' · you are here now' : ''}</option>`).join('')}
          </select>
          <p class="om-p">${o.displayPin == null
            ? `She follows your pointer, and re-checks every frame — drag your work to the other monitor mid-session and she comes with you. Right now that is <b>${esc((o.displayList.find((d) => d.active) || {}).label || '—')}</b>.`
            : `Pinned. She will only ever look at <b>${esc((o.displayList.find((d) => d.i === o.displayPin) || {}).label || '—')}</b>, even if you work elsewhere.`}</p>` : ''}
        <label class="om-check"><input type="checkbox" id="omSpeak" ${o.speak ? 'checked' : ''} /> <span>Speak to me while she works${o.voiceReady ? '' : ' — connect a voice on DASH-OPS first'}</span></label>
        <label class="om-check"><input type="checkbox" id="omHud" ${o.hud !== false ? 'checked' : ''} /> <span>Show the Motus Max HUD over my screen</span></label>
        <label class="om-check dry"><input type="checkbox" id="omDry" ${o.dry ? 'checked' : ''} /> <span><b>Dry run</b> — she perceives, thinks and plans exactly as normal, but her hands stay off. Every step is shown as “would…”. Run it once this way first.</span></label>
        <label class="om-check depth"><input type="checkbox" id="omDepth" ${o.depth !== false ? 'checked' : ''} /> <span><b>Maximum depth on the decision</b> — she thinks at max effort about <i>what</i> to do, then drives at normal speed. Deciding is the expensive thing to get wrong; clicking is not. Your setting is restored the moment the read ends.</span></label>
        <label class="om-check"><input type="checkbox" id="omPreRead" ${o.preReadOn ? 'checked' : ''} /> <span><b>Read the map on arm</b>: the moment you arm, she reads the map and chooses the move, so Drive starts on a ready choice instead of a wait. One relay turn per arm, and the choice stays fresh for ten minutes.</span></label>
        <label class="om-check cont"><input type="checkbox" id="omCont" ${o.continuous ? 'checked' : ''} /> <span><b>Continuous drive</b> — when a move lands, she reads the map again and starts the next highest-leverage one <i>herself</i>. No tap. Bounded by the fuse, ${o.chainMax} moves, and your token cap — and she only ever chains off a move she finished honestly.${o.chain ? ` <b>${o.chain}/${o.chainMax} used this arm.</b>` : ''}</span></label>
        <p class="om-p">She narrates one short line per cycle in your ElevenLabs voice, so you can keep your eyes on your own work.${(o.displayList || []).length > 1 ? ' You have more than one screen — she only ever sees the one chosen here.' : ''} The HUD is click-through and invisible to her own camera, so it can never block you or confuse her.</p>
      </div>

      <div class="card glass om-guards">
        <div class="card-h"><h3>What can never happen</h3><span class="card-tag">not configurable</span></div>
        <div class="om-guard">🛡 <b>Protected windows</b><span>${esc(o.guards.protectedWindows)}</span></div>
        <div class="om-guard">🛡 <b>No shell</b><span>${esc(o.guards.noShell)}</span></div>
        <div class="om-guard">🛡 <b>No credentials</b><span>She will not type anything shaped like a key, token or recovery phrase — the text is refused before it reaches the keyboard.</span></div>
        <div class="om-guard">🛡 <b>Panic key</b><span>${esc(o.guards.panic)}</span></div>
      </div>
    </div>

    <!-- the session -->
    <div class="card glass-deep om-session ${live ? 'live' : ''}">
      <div class="card-h"><h3>${live ? 'Session in flight' : 'Begin a session'}</h3>
        <span class="card-tag">${s ? `${s.cursor}/${s.maxSteps} steps · cycle ${s.cycles} · ${esc(s.status)}` : 'deep work, driven'}</span></div>
      ${live && s.lanes && (s.lanes.reflex || s.lanes.strategic) ? `
        <div class="om-lanes" title="Cycles that form the plan stay with her. Cycles that execute one go to the lean reflex seat.">
          <span class="om-lane ${s.lastLane === 'strategic' ? 'on' : ''}">◈ her <b>${s.lanes.strategic}</b>${s.lanes.strategic ? ` · ${Math.round(s.lanes.strategicMs / s.lanes.strategic / 1000)}s avg` : ''}</span>
          <span class="om-lane ${s.lastLane === 'reflex' ? 'on' : ''}">⚡ reflex <b>${s.lanes.reflex}</b>${s.lanes.reflex ? ` · ${Math.round(s.lanes.reflexMs / s.lanes.reflex / 1000)}s avg` : ''}</span>
        </div>` : ''}

      ${!live ? `
        ${OMNI.thread && OMNI.thread.goal ? `
          <div class="om-thread">
            <div class="om-thread-h">⟲ The open thread<span>leave the goal empty and she picks this up exactly where you left it</span></div>
            <div class="om-thread-g">${esc(String(OMNI.thread.goal).split('\n')[0])}</div>
            ${OMNI.thread.openNext ? `<div class="om-thread-n"><b>next:</b> ${esc(OMNI.thread.openNext)}</div>` : ''}
            <div class="om-thread-f">ended <b>${esc(OMNI.thread.lastVerdict || 'unfinished')}</b> · ${ago(OMNI.thread.ts)} ago<button class="mini" id="omThreadClear">forget it</button></div>
          </div>` : ''}
        <label class="om-lab">What should be true when this session ends?</label>
        <textarea class="om-ta" id="omGoal" rows="3" placeholder="Leave this empty and she reads the whole map, names the highest-leverage move herself, and takes it. Or aim her: “Open the MotusMoves repo, find every hard-coded share-card version, bump it, show me the diff.”">${esc(s && s.status !== 'done' ? '' : '')}</textarea>
        <div class="om-actions">
          <button class="prime-btn" id="omStart" ${o.armed ? '' : 'disabled'}>${o.armed ? '◈ Begin Motus Max' : 'Arm it first'}</button>
          <button class="mini" id="omLeverage">◇ Show me the highest-leverage move</button>
          <button class="mini" id="omFrames">✶ Find a frame we haven't seen</button>
          ${s ? `<span class="om-last">Last session — <b>${esc(s.status)}</b>${s.why ? ': ' + esc(s.why) : ''}</span>` : ''}
        </div>
        <div id="omRead">${OMNI.read ? readCard(OMNI.read) : ''}${OMNI.frames ? framesCard(OMNI.frames) : ''}</div>` : ''}

      ${live ? `
        <div class="om-goal">${esc(s.goal)}</div>
        ${s.status === 'waiting' ? `
          <div class="om-ask">
            <div class="om-ask-q">${esc(s.question)}</div>
            ${s.pending && s.pending.length ? `<div class="om-pend">${s.pending.map((p) => `<span>${esc(p.op)} ${esc(p.note)}</span>`).join('')}</div>` : ''}
            <div class="om-ask-row">
              <input class="om-in" id="omAnswer" placeholder="${s.pending && s.pending.length ? 'Add a note, or just approve…' : 'Your answer…'}" />
              <button class="prime-btn" id="omApprove">${s.pending && s.pending.length ? 'Approve' : 'Send'}</button>
              ${s.pending && s.pending.length ? '<button class="mini" id="omDecline">Skip that batch</button>' : ''}
            </div>
          </div>` : `
          <div class="om-steer-row">
            <input class="om-in" id="omSteerIn" placeholder="Steer her mid-session — this lands ahead of her plan on the next frame…" />
            <button class="mini" id="omSteerBtn">Steer</button>
          </div>`}

        <div class="om-live">
          <div class="om-col">
            <div class="om-col-h">What she is thinking</div>
            <div class="om-think">${(s.transcript || []).map((t) => `<div class="om-t"><span class="om-cy">cycle ${t.cycle}</span><div class="om-t-x">${esc(t.text)}</div></div>`).join('') || '<div class="om-empty">the first frame is being read…</div>'}</div>
          </div>
          <div class="om-col">
            <div class="om-col-h">What she actually did</div>
            <div class="om-steps">${(s.steps || []).slice().reverse().map(omniStepRow).join('') || '<div class="om-empty">nothing has moved yet</div>'}</div>
          </div>
        </div>
        <!-- THE LIVE TICKER — her hands, narrated from her own transcript while
             the turn is still running. This is the "show me the steps" layer:
             each line lands seconds after the real tool call it names. -->
        <div class="om-col-h" style="margin-top:12px">Her hands, right now</div>
        <div class="om-ticker" id="omTicker">${(s.moves || []).slice(-10).map((m) => `<div class="om-tick">${esc(m.line)}</div>`).join('') || '<div class="om-empty">moves will stream here the moment she makes them</div>'}</div>
        <div class="om-actions"><button class="danger-btn" id="omStop">■ Stop this session</button></div>` : ''}
    </div>

    <!-- what she sees + what she did -->
    <div class="om-grid2">
      <!-- ═══ REPLAY — the drive, scrubbable after the fact ═══
           Frames and moves share one clock, so dragging the scrubber shows
           the screen she saw AND what her hands were doing at that instant. -->
      <div class="card glass om-replay" id="omReplayCard">
        <div class="card-h"><h3>Replay</h3><span class="card-tag">walk back through any drive</span></div>
        <div id="omReplayBody"><div class="om-empty">pick a drive to replay</div></div>
      </div>

      <div class="card glass">
        <div class="card-h"><h3>Sight</h3><span class="card-tag"><span id="omSightMeta">what she sees</span><button class="mini" id="omProveSight" style="margin-left:10px">◉ Prove sight now</button></span></div>
        <img class="om-shot" id="omShot" alt="" />
        <p class="om-p">Live frames flow here during any session — including work turns, where they are for <em>your</em> eyes only and never spend a token. Press <b>Prove sight</b> any time for a fresh capture of the screen she would see; if this panel can show it, her sight works, no trust required.</p>
      </div>
      <div class="card glass">
        <div class="card-h"><h3>Audit trail</h3><span class="card-tag">${(o.log || []).length} entries · ${o.stats.actions} actions all-time<button class="mini" id="omClearLog" style="margin-left:10px">clear</button></span></div>
        <div class="om-log">${(o.log || []).map((l, i) => `<div class="om-l ${esc(l.kind)}"><span class="om-l-k">${esc(l.kind)}</span><span class="om-l-t">${ago(l.ts)}</span><div class="om-l-s">${esc(l.said)}</div>${String(l.said || '').length > 260 ? `<button class="om-l-more" data-audit-full="${i}">⤢ read the whole thing</button>` : ''}</div>`).join('') || '<div class="om-empty">nothing has been driven yet</div>'}</div>
      </div>
    </div>

    ${(OMNI.moves || []).length ? `
    <div class="card glass om-moves">
      <div class="card-h"><h3>Moves that landed</h3><span class="card-tag">what actually changed — not what she planned</span></div>
      ${OMNI.moves.map((m) => `
        <div class="om-move">
          <div class="om-move-l">${esc(m.line)}</div>
          <div class="om-move-ts mono">${esc(fmtDT2(m.ts))}${m.project ? ` · ${esc(m.project)}` : ''}</div>
          ${m.verified ? `<div class="om-move-v"><span>verified</span> ${esc(m.verified)}</div>` : ''}
          ${m.files && !/^none$/i.test(m.files) ? `<div class="om-move-f">${String(m.files).split(',').map((f) => `<button class="om-move-open" data-open-file="${esc(f.trim())}">⤢ ${esc(f.trim().split(/[\\/]/).pop())}</button>`).join('')}</div>` : ''}
        </div>`).join('')}
    </div>` : ''}

    <!-- THE MAP — exactly what she sees, at the altitude you pick -->
    <div class="card glass om-mapcard">
      <div class="card-h"><h3>The map she is working from</h3><span class="card-tag" id="omMapAvail">reading…</span></div>
      <p class="om-p">Read live from your BuildMode canon — not copied. You edit the skill, she sees it on the next turn. She can also change her own altitude mid-drive, and the audit trail records it when she does.</p>
      <div class="om-zoom" id="omZoom">
        <button data-z="orbit" class="${OMNI.mapZoom === 'orbit' ? 'on' : ''}">◎ Orbit — why any of this</button>
        <button data-z="map" class="${OMNI.mapZoom === 'map' ? 'on' : ''}">◈ Map — what's in play</button>
        <button data-z="ground" class="${OMNI.mapZoom === 'ground' ? 'on' : ''}">▣ Ground — one platform</button>
        <button data-z="frame" class="${OMNI.mapZoom === 'frame' ? 'on' : ''}">✶ Frame — change the lens</button>
      </div>
      ${OMNI.mapZoom === 'ground' || OMNI.mapZoom === 'frame' ? `<input class="om-in" id="omMapFocus" placeholder="${OMNI.mapZoom === 'ground' ? 'which platform? MotusMoves, Davara.DEV, Initium…' : 'which lens? or leave empty and she chooses'}" value="${esc(OMNI.mapFocus || '')}" />` : ''}
      <pre class="om-map" id="omMapText">${esc(OMNI.map || 'reading the canon…')}</pre>
    </div>
  `);
  // The frame is applied to the element, never baked into the markup. A 200KB
  // data URL inside the template would be re-hashed by setHTML on EVERY repaint,
  // and this screen repaints on every drive event — exactly the kind of quiet
  // per-frame cost that made the whole machine crawl last time.
  omniApplyFrame();
  wireOmni();
}
function omniApplyFrame() { const img = $('#omShot'); if (img && OMNI.frame && img.src !== OMNI.frame) img.src = OMNI.frame; }
// Put a message where he is already looking, instead of a toast that vanishes.
function mmOutLike(sel, html, tone = 'bad') {
  const el = $(sel); if (!el) return;
  el.innerHTML = `<div class="mm-out-x ${tone}">${html}</div>` + el.innerHTML;
}

// ###########################################################################
//  A CONTROL THAT IS NOT ON SCREEN HAS NO OPINION.
//
//  ⚠ THIS IS THE "why is she in Ask-first mode" BUG, and it was worse than it
//  looked. Every fallback here used to be a HARDCODED LITERAL:
//        scope:      seg('omScope')  || 'guarded'
//        pacing:     seg('omPacing') || 'ask'
//        continuous: !!($('#omCont') || {}).checked      // → false
//  and every arming path — the HUD button, the voice trigger, /motusmax, the
//  Leverage card, omniFlow — calls this function. So arming from ANYWHERE
//  except the fully-rendered Motus Max screen silently overwrote his real
//  settings with: approve-every-batch, narrower scope, and continuous drive
//  OFF. Three of his exact symptoms, from one line of `|| 'ask'`.
//
//  His vault read `pacing: "auto"`, `continuous: true` — genuinely his choice,
//  made with the panel open, and quietly reverted the next time he armed by
//  voice. A default that masquerades as a reading is worse than no reading.
//
//  So now: absent control → `undefined` → the key is deleted → omniArm's
//  `if (x != null)` guards leave what he actually chose completely alone.
// ###########################################################################
function omniSettings() {
  const seg = (id) => { const b = $(`#${id} button.on`); return b ? b.dataset.v : undefined; };
  const chk = (id) => { const e = $(`#${id}`); return e ? !!e.checked : undefined; };
  const num = (id) => { const e = $(`#${id}`); if (!e) return undefined; const v = +e.value; return Number.isFinite(v) ? v : undefined; };
  const val = (id) => { const e = $(`#${id}`); return e ? e.value : undefined; };
  const out = {
    minutes: num('omTtl'),
    maxSteps: num('omMax'),
    agent: val('omAgent'),
    scope: seg('omScope'),
    pacing: seg('omPacing'),
    speak: chk('omSpeak'),
    hud: chk('omHud'),
    dry: chk('omDry'),
    depth: chk('omDepth'),
    preRead: chk('omPreRead'),
    continuous: chk('omCont'),
    reflex: chk('omReflex'),
    speedEffort: seg('omSpeed'),
    moveMode: seg('omMoveMode'),
    // -1 means "follow me". Number() rather than || 0, which would turn -1 into 0.
    display: $('#omDisplay') ? Number($('#omDisplay').value) : undefined,
    allow: $('#omAllow') ? String($('#omAllow').value || '').split(',').map((x) => x.trim()).filter(Boolean) : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
function wireOmni() {
  // segmented pickers repaint locally so the copy under them stays truthful
  $$('#omScope button, #omPacing button, #omSpeed button, #omMoveMode button').forEach((b) => b.onclick = () => {
    [...b.parentElement.children].forEach((x) => x.classList.toggle('on', x === b));
    const o = OMNI.data; if (!o) return;
    if (b.parentElement.id === 'omScope') o.scope = b.dataset.v;
    else if (b.parentElement.id === 'omSpeed') o.speedEffort = b.dataset.v;
    else if (b.parentElement.id === 'omMoveMode') o.moveMode = b.dataset.v;
    else o.pacing = b.dataset.v;
    paintOmni();
  });

  // PRESS AND HOLD TO ARM. A capability this wide should cost a deliberate
  // gesture — a mis-click can never turn it on, and the fill is the receipt.
  const hold = $('#omHold');
  if (hold) {
    const done = async () => {
      hold.classList.remove('holding');
      const cfg = omniSettings();
      const r = await C.omniArm(cfg);
      if (r && r.ok) {
        OMNI.data = r.omni;
        if (cfg.allow.length) OMNI.data.allow = cfg.allow;
        toast(`Motus Max armed for ${cfg.minutes} minutes`, 'good');
        paintOmni(); omniClock();
      }
    };
    const start = (e) => {
      e.preventDefault();
      if (OMNI.data && OMNI.data.armed) return;
      hold.classList.add('holding');
      OMNI.held = true;
      OMNI.holdT = setTimeout(() => { if (OMNI.held) done(); }, 1150);
    };
    const cancel = () => { OMNI.held = false; clearTimeout(OMNI.holdT); hold.classList.remove('holding'); };
    hold.onpointerdown = start;
    hold.onpointerup = cancel;
    hold.onpointerleave = cancel;
    hold.onpointercancel = cancel;
  }

  const dis = $('#omDisarm');
  if (dis) dis.onclick = async () => {
    const r = await C.omniDisarm();
    if (r && r.ok) { OMNI.data = r.omni; toast('Disarmed — she cannot move your machine', 'good'); paintOmni(); }
  };

  // DRIVE NOW — the button that was missing from where he actually was. It
  // starts the session from the arm panel with whatever is in the goal box,
  // which may be nothing at all: empty means she resumes or chooses.
  const dn = $('#omDriveNow');
  if (dn) dn.onclick = () => { const s = $('#omStart'); if (s) { s.scrollIntoView({ behavior: 'smooth', block: 'center' }); s.click(); } };

  // THE FLOW — one press: arm, continuous on, and go. The mode he actually
  // wanted was three correct guesses away behind separate controls.
  const fl = $('#omFlow');
  if (fl) fl.onclick = async () => {
    if (OMNI.busy) return;
    OMNI.busy = true; fl.disabled = true;
    let secs = 0; fl.textContent = 'reading your whole system… 0s';
    const tick = setInterval(() => { secs++; fl.textContent = `reading your whole system… ${secs}s`; }, 1000);
    const goal = String(($('#omGoal') || {}).value || '').trim();
    const r = await C.omniFlow({ goal, settings: omniSettings() });
    clearInterval(tick); OMNI.busy = false;
    if (!r || !r.ok) {
      fl.disabled = false; fl.textContent = '∞ Enter the Flow';
      mmOutLike('#omRead', `<b>Could not enter the flow.</b> ${esc((r && r.error) || 'unknown')}`);
      return toast((r && r.error) || 'could not start', 'bad');
    }
    OMNI.data = r.omni; if (r.read) OMNI.read = r.read;
    toast(r.origin === 'chosen' ? 'She chose the first move — and she keeps going' : 'In the flow', 'good');
    paintOmni();
  };

  const start = $('#omStart');
  if (start) start.onclick = async () => {
    const goal = String(($('#omGoal') || {}).value || '').trim();
    // An empty goal is not an error — it is the most interesting way to start.
    // She either resumes the open thread or reads the map and chooses.
    const cold = goal.length < 8;
    await C.omniArm(omniSettings());          // persist what he can see before running
    start.disabled = true;
    // A cold start is ~60s of real thinking. Sixty silent seconds reads as a
    // hang — which is precisely how this looked broken — so the button counts.
    const base = cold
      ? (OMNI.thread && OMNI.thread.goal ? 'picking up the thread' : 'reading your whole system to choose the move')
      : 'reading your screen';
    let secs = 0;
    start.textContent = base + '… 0s';
    const tick = setInterval(() => { secs++; start.textContent = `${base}… ${secs}s`; }, 1000);
    const r = await C.omniStart({ goal, agent: omniSettings().agent, maxSteps: omniSettings().maxSteps });
    clearInterval(tick);
    if (!r || !r.ok) {
      start.disabled = false; start.textContent = '◈ Begin Motus Max';
      // Never a bare toast for this: it is the failure he cannot diagnose.
      mmOutLike('#omRead', `<b>It could not start.</b> ${esc((r && r.error) || 'unknown')}<br/><span class="dim">This attempt is in the audit trail below, with the reason. Nothing is hidden.</span>`);
      return toast((r && r.error) || 'could not start', 'bad');
    }
    OMNI.data = r.omni;
    if (r.read) OMNI.read = r.read;
    if (r.origin === 'chosen') toast('She chose the move — it is on screen', 'good');
    if (r.origin === 'resumed') toast('Picking up where you left off', 'good');
    paintOmni();
  };

  const stop = $('#omStop');
  if (stop) stop.onclick = async () => { const r = await C.omniStop(); if (r && r.ok) { OMNI.data = r.omni; omniStopAudio(); paintOmni(); } };

  const ap = $('#omApprove');
  if (ap) ap.onclick = async () => {
    ap.disabled = true;
    const r = await C.omniReply(String(($('#omAnswer') || {}).value || ''), true);
    if (r && r.ok) { OMNI.data = r.omni; paintOmni(); } else { ap.disabled = false; toast((r && r.error) || 'failed', 'bad'); }
  };
  const dec = $('#omDecline');
  if (dec) dec.onclick = async () => {
    const r = await C.omniReply(String(($('#omAnswer') || {}).value || ''), false);
    if (r && r.ok) { OMNI.data = r.omni; paintOmni(); }
  };
  const steerGo = async () => {
    const el = $('#omSteerIn'); if (!el || !el.value.trim()) return;
    const t = el.value.trim(); el.value = '';
    const r = await C.omniSteer(t);
    if (r && r.ok) { OMNI.data = r.omni; toast('She gets that on her next frame', 'good'); }
  };
  const sb = $('#omSteerBtn'); if (sb) sb.onclick = steerGo;
  const si = $('#omSteerIn'); if (si) si.onkeydown = (e) => { if (e.key === 'Enter') steerGo(); };
  const ans = $('#omAnswer'); if (ans) ans.onkeydown = (e) => { if (e.key === 'Enter' && ap) ap.click(); };

  // Changing the monitor lights the HUD on it immediately, so "which screen is
  // this going to?" is answered by looking up, not by arming and hoping.
  const disp = $('#omDisplay');
  if (disp) disp.onchange = async () => {
    const v = Number(disp.value);
    const r = await C.omniPreview(true, v).catch(() => null);
    await C.omniArm(omniSettings());          // persist the choice right away
    const d = (OMNI.data.displayList || []).find((x) => x.i === v);
    toast(v < 0 ? 'Following your pointer' : `HUD on ${d ? d.label : 'that screen'} — look for the glow`, 'good');
    const s = await C.omni(); if (s && s.ok) { OMNI.data = s.omni; paintOmni(); }
    if (!OMNI.data.armed) setTimeout(() => { if (!OMNI.data.armed) C.omniPreview(false); }, 4000);
  };

  // --- altitude ---
  $$('#omZoom button').forEach((b) => b.onclick = () => {
    OMNI.mapZoom = b.dataset.z;
    if (OMNI.mapZoom !== 'ground' && OMNI.mapZoom !== 'frame') OMNI.mapFocus = '';
    paintOmni(); omniLoadMap();
  });
  const mf = $('#omMapFocus');
  if (mf) mf.onkeydown = (e) => { if (e.key === 'Enter') { OMNI.mapFocus = mf.value.trim(); omniLoadMap(); } };

  // --- the strategic read, and the divergence engine ---
  const lev = $('#omLeverage');
  if (lev) lev.onclick = async () => {
    if (OMNI.busy) return;
    OMNI.busy = true; lev.disabled = true; lev.textContent = 'reading the whole system…';
    const r = await C.strategicRead({ agent: omniSettings().agent, zoom: 'orbit' });
    OMNI.busy = false;
    if (!r || !r.ok) { lev.disabled = false; lev.textContent = '◇ Show me the highest-leverage move'; return toast((r && r.error) || 'the read failed', 'bad'); }
    OMNI.read = r.read; paintOmni();
    toast('She has a read', 'good');
  };
  const frb = $('#omFrames');
  if (frb) frb.onclick = async () => {
    if (OMNI.busy) return;
    OMNI.busy = true; frb.disabled = true; frb.textContent = 'looking for what we have not seen…';
    const r = await C.frames({ agent: omniSettings().agent });
    OMNI.busy = false;
    if (!r || !r.ok) { frb.disabled = false; frb.textContent = "✶ Find a frame we haven't seen"; return toast((r && r.error) || 'divergence failed', 'bad'); }
    OMNI.frames = r; paintOmni();
    toast(`${r.frames.length} frames`, 'good');
  };
  // PROVE SIGHT — one press, fresh capture, no session, no tokens. The answer
  // to "is the capture even working" becomes a picture instead of a promise.
  const ps = $('#omProveSight');
  if (ps) ps.onclick = async () => {
    ps.disabled = true; ps.textContent = '◉ capturing…';
    const r = await C.omniSight().catch(() => null);
    ps.disabled = false; ps.textContent = '◉ Prove sight now';
    const meta = $('#omSightMeta');
    if (r && r.ok) {
      OMNI.frame = r.dataUrl; omniApplyFrame();
      if (meta) meta.textContent = `LIVE · ${r.name || 'display'} · ${r.screen} → ${r.w}×${r.h} · ${Math.round((r.bytes || 0) / 1024)}KB`;
      toast('Sight proven — this is her view of your screen', 'good');
    } else {
      if (meta) meta.textContent = 'SIGHT FAILED — ' + ((r && r.error) || 'no response');
      toast('Sight failed: ' + ((r && r.error) || 'no response'), 'bad');
    }
  };
  // Drive the move she named — the read becomes the session goal, one tap.
  const dr = $('#omniBody [data-drive-read]');
  if (dr) dr.onclick = async () => {
    const R = OMNI.read; if (!R) return;
    if (!OMNI.data || !OMNI.data.armed) return toast('Arm it first — that has to be your hold', 'warn');
    await C.omniArm(omniSettings());
    const r = await C.omniStart({ goal: `${R.lever}\n\nFIRST STEP: ${R.firstStep}\nWHY NOW: ${R.whyNow}\nRUNG: ${R.rung}`, agent: omniSettings().agent, maxSteps: omniSettings().maxSteps });
    if (!r || !r.ok) return toast((r && r.error) || 'could not start', 'bad');
    OMNI.data = r.omni; paintOmni();
  };
  const rt2 = $('#omniBody [data-read-task]');
  if (rt2) rt2.onclick = async () => {
    const R = OMNI.read; if (!R) return;
    const r = await C.taskCreate({ title: String(R.lever).split(/[.\n]/)[0].slice(0, 120), body: `WHY NOW: ${R.whyNow}\nFIRST STEP: ${R.firstStep}\nRUNG: ${R.rung}\nLOOP: ${R.loop}\n\nFRAME: ${R.frame}`, priority: 1 });
    toast(r && r.ok ? 'On the board' : 'could not add', r && r.ok ? 'good' : 'bad');
  };
  // Expand a finding in place — the full text is already there, only clamped.
  $$('#omniBody [data-audit-full]').forEach((b) => b.onclick = () => {
    const row = b.closest('.om-l'); if (!row) return;
    const open = row.classList.toggle('open');
    b.textContent = open ? '⤡ collapse' : '⤢ read the whole thing';
  });

  // Open any file she touched, straight from the move card.
  $$('#omniBody [data-open-file]').forEach((b) => b.onclick = async () => {
    const f = b.dataset.openFile;
    const r = await C.openPath(f, false).catch(() => null);
    toast(r && r.ok !== false ? 'Opening ' + f.split(/[\\/]/).pop() : 'Could not open ' + f, r && r.ok !== false ? 'good' : 'bad');
  });

  const cl = $('#omClearLog');
  if (cl) cl.onclick = async () => {
    const r = await C.omniClearLog();
    if (r && r.ok) { OMNI.data = r.omni; toast(`Cleared ${r.cleared} entries`, 'good'); paintOmni(); }
  };

  const tc = $('#omThreadClear');
  if (tc) tc.onclick = async () => {
    const r = await C.threadClear();
    if (r && r.ok) { OMNI.thread = r.thread; paintOmni(); toast('Thread cleared — next empty start will be her own choice', 'good'); }
  };
}

/* ================================================== MOTUSMODELS · THE STUDIO
   Our own reading, not a generic template gallery. A MotusModel is a LOOP
   SOMEONE ELSE CAN RUN THAT PAYS OUT WHEN IT TURNS — four organs, a generation
   number, a lineage, and a fitness score. You never edit a model into a better
   one; you fork it, refine one organ along one axis, and let the next
   generation earn its place. Propose → ratify. Nothing enters canon silently. */
const MM = { data: null, sel: '', busy: false };
const MM_ORGANS = [
  ['mantra', 'Mantra', '◆', 'The words that carry the standard.'],
  ['mindset', 'Mindset', '◇', 'The stance it asks of whoever runs it.'],
  ['model', 'Model', '⬡', 'The mechanism — the stages that actually execute.'],
  ['motus', 'Motus', '✶', 'What moves, for whom, and what the receipt is.'],
];
const MM_STATUS_TONE = { draft: 'draft', ratified: 'ratified', minted: 'minted', broadcast: 'broadcast' };

async function loadMotusModels() {
  const r = await C.motusModels();
  if (!r || !r.ok) return viewFail('motusmodels', r);
  MM.data = r;
  if (!MM.sel || !r.models.some((m) => m.id === MM.sel)) MM.sel = (r.models[0] || {}).id || '';
  paintMM();
}
function mmSelected() { return (MM.data && MM.data.models.find((m) => m.id === MM.sel)) || null; }
function mmFitBar(f) {
  if (!f) return '<div class="mm-nofit">Not scored yet — a generation without a score is drift, not evolution.</div>';
  const axes = (MM.data.axes || []);
  return `<div class="mm-fit">
    ${axes.map((a) => `<div class="mm-fa"><span class="mm-fa-l">${esc(a.label)}</span>
      <span class="mm-fa-bar"><i style="width:${(f[a.id] || 0) * 10}%"></i></span>
      <span class="mm-fa-n">${f[a.id] || 0}</span></div>`).join('')}
    <div class="mm-fa total"><span class="mm-fa-l">Total</span><span class="mm-fa-bar"><i style="width:${(f.total || 0) * 2}%"></i></span><span class="mm-fa-n">${f.total || 0}/50</span></div>
    ${f.note ? `<div class="mm-verdict">${esc(f.note)}</div>` : ''}
  </div>`;
}
function mmCard(m) {
  return `<button class="mm-card ${m.id === MM.sel ? 'on' : ''} ${MM_STATUS_TONE[m.status] || ''}" data-mm="${m.id}">
    <div class="mm-card-h"><span class="mm-gen">g${m.generation}</span><span class="mm-st ${esc(m.status)}">${esc(m.status)}</span></div>
    <div class="mm-name">${esc(m.name)}</div>
    <div class="mm-ess">${esc(m.essence || m.motus || '')}</div>
    <div class="mm-card-f">${m.fitness ? `<span class="mm-score">${m.fitness.total}/50</span>` : '<span class="mm-score dim">unscored</span>'}${m.mint ? `<span class="mm-hash">${esc(m.mint.hash.slice(0, 10))}</span>` : ''}${m.runs ? `<span class="mm-runs">${m.runs} run${m.runs > 1 ? 's' : ''}</span>` : ''}</div>
  </button>`;
}
function paintMM() {
  const d = MM.data; if (!d) return;
  const m = mmSelected();
  setHTML($('#mmBody'), `
    <div class="view-head"><h2>MotusModels</h2>
      <p class="view-desc">Not a template library. A <b>MotusModel</b> is a loop someone else can run that pays out when it turns — and here it has a genome, a generation, a lineage and a fitness score. You do not edit a model into a better one. You fork it, refine <i>one organ along one axis</i>, and let the next generation earn its place.</p></div>

    <div class="mm-organs glass">
      ${MM_ORGANS.map(([k, lab, gl, note]) => `<div class="mm-organ"><span class="mm-gl">${gl}</span><b>${lab}</b><span>${note}</span></div>`).join('')}
    </div>

    <div class="card glass mm-list-card">
      <div class="card-h"><h3>The lineage</h3><span class="card-tag">${d.models.length} model${d.models.length === 1 ? '' : 's'} · minted files in <code>${esc(d.dir)}</code></span></div>
      <div class="mm-list">${d.models.map(mmCard).join('')}</div>
      <div class="mm-newrow"><button class="mini" id="mmNew">+ New MotusModel</button></div>
    </div>

    ${m ? `
    <div class="card glass-deep mm-editor">
      <div class="card-h"><h3>${esc(m.name)}</h3>
        <span class="card-tag">generation ${m.generation}${m.lineage && m.lineage.length ? ' · ' + esc(m.lineage.join(' → ')) : ' · origin'} · ${esc(m.status)}</span></div>
      ${m.notes ? `<div class="mm-notes">${esc(m.notes)}</div>` : ''}

      <div class="mm-two">
        <div><label class="om-lab">Name</label><input class="om-in" id="mmName" value="${esc(m.name)}" /></div>
        <div><label class="om-lab">Essence — one line</label><input class="om-in" id="mmEssence" value="${esc(m.essence)}" /></div>
      </div>
      <label class="om-lab">◆ Mantra — the words that carry the standard</label>
      <textarea class="om-ta" id="mmMantra" rows="2">${esc(m.mantra)}</textarea>
      <label class="om-lab">◇ Mindset — the stance it asks for</label>
      <textarea class="om-ta" id="mmMindset" rows="3">${esc(m.mindset)}</textarea>
      <label class="om-lab">⬡ Model — the mechanism, step by step</label>
      <textarea class="om-ta tall" id="mmModel" rows="8">${esc(m.model)}</textarea>
      <div class="mm-two">
        <div><label class="om-lab">✶ Motus — what moves, and for whom</label><textarea class="om-ta" id="mmMotus" rows="3">${esc(m.motus)}</textarea></div>
        <div><label class="om-lab">⛨ Proof — what a turn leaves behind</label><textarea class="om-ta" id="mmProof" rows="3">${esc(m.proof)}</textarea></div>
      </div>

      <label class="om-lab">Stages — this is what makes it real: these dispatch your fleet</label>
      <div class="mm-stages">${(m.stages || []).map((s, i) => `
        <div class="mm-stage">
          <span class="mm-si">${i + 1}</span>
          <input class="om-in" data-sn="${i}" value="${esc(s.name)}" placeholder="stage name" />
          <input class="om-in narrow" data-sa="${i}" value="${esc((Array.isArray(s.agents) ? s.agents : [s.agents]).filter(Boolean).join(','))}" placeholder="davara" />
          <textarea class="om-ta" data-si="${i}" rows="2" placeholder="what this stage actually does">${esc(s.instruction)}</textarea>
          <button class="mini" data-sx="${i}">✕</button>
        </div>`).join('')}
      </div>
      <div class="mm-newrow"><button class="mini" id="mmAddStage">+ Stage</button><button class="prime-btn" id="mmSave">Save this generation</button></div>
    </div>

    <div class="mm-grid2">
      <div class="card glass">
        <div class="card-h"><h3>Refine into the next generation</h3><span class="card-tag">one axis, one revision, new draft</span></div>
        <div class="mm-axes" id="mmAxes">
          ${(d.axes || []).map((a, i) => `<button data-ax="${a.id}" class="${i === 0 ? 'on' : ''}" title="${esc(a.note)}">${esc(a.label)}</button>`).join('')}
        </div>
        <div class="mm-axnote" id="mmAxNote">${esc((d.axes[0] || {}).note || '')}</div>
        <input class="om-in" id="mmDir" placeholder="Optional — steer the revision in your own words…" />
        <div class="mm-newrow">
          <button class="prime-btn" id="mmEvolve">◈ Refine → g${m.generation + 1}</button>
          <button class="mini" id="mmJudge">Score its fitness</button>
        </div>
        ${mmFitBar(m.fitness)}
      </div>

      <div class="card glass">
        <div class="card-h"><h3>Rails</h3><span class="card-tag">ratify · mint · broadcast · run</span></div>
        <div class="mm-rails">
          <button class="mm-rail ${m.status !== 'draft' ? 'done' : ''}" id="mmRatify">
            <b>1 · Ratify</b><span>${m.status === 'draft' ? 'You accept this generation into the lineage.' : 'Ratified.'}</span></button>
          <button class="mm-rail ${m.mint ? 'done' : ''}" id="mmMint">
            <b>2 · Mint</b><span>${m.mint ? `Hashed <code>${esc(m.mint.hash.slice(0, 16))}</code> — card + manifest on disk.` : 'Write a hashed manifest and a readable card to disk. Local, verifiable, nothing transmitted.'}</span></button>
          <button class="mm-rail ${m.status === 'broadcast' ? 'done' : ''}" id="mmBroadcast">
            <b>3 · Broadcast</b><span>Compose the payloads for your rails. Prepared, never sent — this app holds no posting credentials.</span></button>
          <button class="mm-rail run" id="mmRun">
            <b>4 · Run it</b><span>Compile to a workflow and dispatch the fleet for real.${m.runs ? ` Run ${m.runs}×.` : ''}</span></button>
        </div>
        <div class="mm-out" id="mmOut"></div>
        ${m.status === 'draft' ? '<button class="mini danger" id="mmDelete">Delete this draft</button>' : ''}
      </div>
    </div>` : '<div class="om-empty">No models yet — make the first one.</div>'}
  `);
  wireMM();
}

// Read the genome back off the screen exactly as he last typed it.
function mmForm() {
  const m = mmSelected(); if (!m) return null;
  const v = (id) => String(($('#' + id) || {}).value || '');
  const stages = [];
  $$('#mmBody [data-sn]').forEach((el) => {
    const i = el.dataset.sn;
    const name = String(el.value || '').trim();
    const agents = String(($(`#mmBody [data-sa="${i}"]`) || {}).value || 'davara').split(',').map((x) => x.trim()).filter(Boolean);
    const instruction = String(($(`#mmBody [data-si="${i}"]`) || {}).value || '').trim();
    if (name && instruction) stages.push({ name, agents, instruction });
  });
  return { ...m, name: v('mmName'), essence: v('mmEssence'), mantra: v('mmMantra'), mindset: v('mmMindset'),
    model: v('mmModel'), motus: v('mmMotus'), proof: v('mmProof'), stages };
}
function mmOut(html, tone = '') { const el = $('#mmOut'); if (el) el.innerHTML = `<div class="mm-out-x ${tone}">${html}</div>`; }

function wireMM() {
  $$('#mmBody [data-mm]').forEach((b) => b.onclick = () => { MM.sel = b.dataset.mm; paintMM(); });

  const nw = $('#mmNew');
  if (nw) nw.onclick = async () => {
    const r = await C.mmSave({ name: 'New MotusModel', essence: '', mantra: '', mindset: '', model: '', motus: '', proof: '', status: 'draft', generation: 1 });
    if (r && r.ok) { MM.sel = r.model.id; await loadMotusModels(); } else toast((r && r.error) || 'could not create', 'bad');
  };

  const sv = $('#mmSave');
  if (sv) sv.onclick = async () => {
    const f = mmForm(); if (!f) return;
    sv.disabled = true;
    const r = await C.mmSave(f);
    sv.disabled = false;
    if (r && r.ok) { toast('Saved', 'good'); await loadMotusModels(); } else toast((r && r.error) || 'could not save', 'bad');
  };

  const add = $('#mmAddStage');
  if (add) add.onclick = async () => {
    const f = mmForm(); if (!f) return;
    f.stages = [...f.stages, { name: 'New stage', agents: ['davara'], instruction: 'what this stage does' }];
    const r = await C.mmSave(f);
    if (r && r.ok) await loadMotusModels();
  };
  $$('#mmBody [data-sx]').forEach((b) => b.onclick = async () => {
    const f = mmForm(); if (!f) return;
    f.stages = f.stages.filter((_, i) => i !== +b.dataset.sx);
    const r = await C.mmSave(f);
    if (r && r.ok) await loadMotusModels();
  });

  $$('#mmAxes button').forEach((b) => b.onclick = () => {
    $$('#mmAxes button').forEach((x) => x.classList.toggle('on', x === b));
    const a = (MM.data.axes || []).find((x) => x.id === b.dataset.ax);
    const n = $('#mmAxNote'); if (n && a) n.textContent = a.note;
  });

  const ev = $('#mmEvolve');
  if (ev) ev.onclick = async () => {
    if (MM.busy) return;
    const m = mmSelected(); if (!m) return;
    const ax = ($('#mmAxes button.on') || {}).dataset ? $('#mmAxes button.on').dataset.ax : 'pull';
    MM.busy = true; ev.disabled = true; ev.textContent = 'she is working on it…';
    // Save what is on screen first — refining a stale genome is a silent data loss.
    await C.mmSave(mmForm());
    const r = await C.mmEvolve(m.id, ax, String(($('#mmDir') || {}).value || ''));
    MM.busy = false;
    if (!r || !r.ok) { ev.disabled = false; ev.textContent = `◈ Refine → g${m.generation + 1}`; return toast((r && r.error) || 'refinement failed', 'bad'); }
    MM.sel = r.model.id;
    await loadMotusModels();
    mmOut(`<b>Generation ${r.model.generation} drafted.</b> ${esc(r.why || '')}`, 'good');
    toast(`g${r.model.generation} drafted — read it, then ratify or discard`, 'good');
  };

  const jd = $('#mmJudge');
  if (jd) jd.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    jd.disabled = true; jd.textContent = 'scoring…';
    await C.mmSave(mmForm());
    const r = await C.mmJudge(m.id);
    if (!r || !r.ok) { jd.disabled = false; jd.textContent = 'Score its fitness'; return toast((r && r.error) || 'could not score', 'bad'); }
    await loadMotusModels();
    toast(`Scored ${r.fitness.total}/50`, r.fitness.total >= 35 ? 'good' : 'warn');
  };

  const rt = $('#mmRatify');
  if (rt) rt.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    await C.mmSave(mmForm());
    const r = await C.mmRatify(m.id);
    if (r && r.ok) { await loadMotusModels(); mmOut('Ratified — it is part of the lineage now.', 'good'); }
  };

  const mt = $('#mmMint');
  if (mt) mt.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    await C.mmSave(mmForm());
    const r = await C.mmMint(m.id);
    if (!r || !r.ok) return toast((r && r.error) || 'could not mint', 'bad');
    await loadMotusModels();
    mmOut(`<b>Minted.</b> <code>sha256:${esc(r.hash.slice(0, 24))}</code><br/>Card written to <code>${esc(r.file)}</code> — that hash is over the genome, so any later edit produces a different one. That is the whole point.`, 'good');
  };

  const bc = $('#mmBroadcast');
  if (bc) bc.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    const r = await C.mmBroadcast(m.id);
    if (!r || !r.ok) return toast((r && r.error) || 'could not compose', 'bad');
    await loadMotusModels();
    mmOut(`<b>Payloads composed.</b> ${esc(r.note)}<br/><br/>
      <div class="mm-pay"><span>MotusMoves move</span><pre>${esc(r.payloads.move)}</pre></div>
      <div class="mm-pay"><span>X · @BuiltByAugust</span><pre>${esc(r.payloads.post)}</pre></div>
      <div class="mm-pay"><span>Initium signal</span><pre>${esc(r.payloads.signal)}</pre></div>
      <button class="mini" id="mmOpenB">Open the file</button>`, 'good');
    const ob = $('#mmOpenB'); if (ob) ob.onclick = () => C.openPath(r.file, true);
  };

  const rn = $('#mmRun');
  if (rn) rn.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    await C.mmSave(mmForm());
    rn.disabled = true;
    const r = await C.mmRun(m.id);
    rn.disabled = false;
    if (!r || !r.ok) return toast((r && r.error) || 'could not run', 'bad');
    toast('Running — follow it on Workflows', 'good');
    mmOut('Dispatched to the fleet. It is a real workflow run now — watch it on the Workflows screen.', 'good');
    setTimeout(() => switchView('workflows'), 1200);
  };

  const dl = $('#mmDelete');
  if (dl) dl.onclick = async () => {
    const m = mmSelected(); if (!m) return;
    const r = await C.mmDelete(m.id);
    if (!r || !r.ok) return toast((r && r.error) || 'could not delete', 'bad');
    MM.sel = ''; await loadMotusModels();
  };
}


/* ═══ THE FLOW — one passive listener drives the whole energy system.
   Scroll position becomes --flow (the meter's fill); motion becomes
   body.flowing (the brightness). 500ms after the reader settles, so does
   the light. Nothing ticks while the page is still. ═══ */
(function () {
  const sc = document.getElementById('content');
  if (!sc) return;
  let t = 0;
  const update = () => {
    const max = sc.scrollHeight - sc.clientHeight;
    const p = max > 4 ? sc.scrollTop / max : 0;
    document.documentElement.style.setProperty('--flow', p.toFixed(4));
  };
  sc.addEventListener('scroll', () => {
    document.body.classList.add('flowing');
    update();
    clearTimeout(t);
    t = setTimeout(() => document.body.classList.remove('flowing'), 500);
  }, { passive: true });
  // a view change resets the scroll — the meter must follow without waiting
  // for the first scroll event
  new MutationObserver(() => update()).observe(sc, { childList: true });
  update();
})();

/* ═══════════════════════════════════════════════════════════════════════════
   MOTUS MAX — SESSION REPLAY.
   Frames and moves share one wall clock, so one scrubber drives both: the
   screen she saw at that instant, and the move her hands were making. No
   timers, no playback loop — the scrubber IS the clock, driven by his hand.
   ═══════════════════════════════════════════════════════════════════════════ */
const REPLAY = { data: null, sessions: [], idx: 0, cache: new Map() };

async function omniLoadReplay(id) {
  const r = await C.omniReplay(id).catch(() => null);
  if (!r || !r.ok) {
    REPLAY.sessions = (r && r.sessions) || [];
    paintReplay();
    return;
  }
  REPLAY.data = r; REPLAY.sessions = r.sessions || []; REPLAY.idx = 0; REPLAY.cache.clear();
  paintReplay();
  if ((r.frames || []).length) omniReplayShow(0);
}

function paintReplay() {
  const el = $('#omReplayBody'); if (!el) return;
  const d = REPLAY.data;
  const picker = (REPLAY.sessions || []).length
    ? `<div class="om-rp-picker">${REPLAY.sessions.map((s) => `
        <button class="mini ${d && d.session && d.session.id === s.id ? 'on' : ''}" data-replay="${esc(s.id)}"
          title="${esc(s.goal)}">${s.status === 'done' ? '✓' : s.status === 'running' ? '●' : '·'} ${esc(String(s.goal).slice(0, 34))}</button>`).join('')}</div>`
    : '<div class="om-empty">no drives recorded yet — run one and it lands here</div>';

  // ⚠ ok:true does NOT imply a session — the no-id call returns the LIST only
  // (that shape crashed the view on `d.session.mode`). Require the payload,
  // not just the success flag.
  if (!d || !d.ok || !d.session) { el.innerHTML = picker; wireReplay(); return; }
  const n = (d.frames || []).length;
  el.innerHTML = picker + `
    <div class="om-rp-stage">
      ${n ? `<img class="om-rp-shot" id="omRpShot" alt="" />` : '<div class="om-empty">no frames were kept for this drive — they may have been pruned</div>'}
      <div class="om-rp-move" id="omRpMove"></div>
    </div>
    ${n ? `<input class="om-rp-range" id="omRpRange" type="range" min="0" max="${n - 1}" value="0" step="1" />` : ''}
    <div class="om-rp-meta">
      <span id="omRpClock" class="mono">—</span>
      <span class="om-rp-sp">${d.session.mode || '?'} · ${d.session.cycles} cycle(s) · ${(d.moves || []).length} move(s) · ${n} frame(s)</span>
      <span class="om-rp-verdict ${d.session.status === 'done' ? 'good' : ''}">${esc(d.session.status)}</span>
    </div>
    <p class="om-p">${esc(String(d.session.goal).slice(0, 220))}${d.session.why ? ` — <i>${esc(d.session.why.slice(0, 120))}</i>` : ''}</p>`;
  wireReplay();
}

async function omniReplayShow(i) {
  const d = REPLAY.data; if (!d || !d.frames || !d.frames.length) return;
  REPLAY.idx = Math.max(0, Math.min(i, d.frames.length - 1));
  const f = d.frames[REPLAY.idx];
  const img = $('#omRpShot');
  if (img) {
    if (REPLAY.cache.has(f.file)) img.src = REPLAY.cache.get(f.file);
    else {
      const r = await C.omniReplayFrame(f.file).catch(() => null);
      if (r && r.ok) { REPLAY.cache.set(f.file, r.dataUrl); if (REPLAY.idx === i) img.src = r.dataUrl; }
      // keep the cache bounded — a long drive is 90 frames of ~35KB
      if (REPLAY.cache.size > 40) REPLAY.cache.delete(REPLAY.cache.keys().next().value);
    }
  }
  // the move nearest this instant, so the picture and the hands agree
  const mv = (d.moves || []).filter((m) => m.ts <= f.ts + 1500).slice(-1)[0];
  const mEl = $('#omRpMove');
  if (mEl) mEl.textContent = mv ? mv.line : '';
  const c = $('#omRpClock');
  if (c) {
    const rel = Math.max(0, Math.round((f.ts - d.session.started) / 1000));
    c.textContent = `${fmtDT2(f.ts)}  ·  +${Math.floor(rel / 60)}m ${String(rel % 60).padStart(2, '0')}s`;
  }
}

function wireReplay() {
  $$('#omReplayBody [data-replay]').forEach((b) => b.onclick = () => omniLoadReplay(b.dataset.replay));
  const r = $('#omRpRange');
  if (r) r.oninput = () => omniReplayShow(parseInt(r.value, 10) || 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE MOVE — the landing view answers a question instead of presenting a
   dashboard: "what should I do right now?"

   Every candidate is computed from state the app ALREADY holds (no tokens, no
   new reads), scored by urgency, and carries a real action — the button does
   the thing, it does not merely navigate to where the thing could be done.
   Highest-scoring move wins; the runners-up sit beneath it as a quiet queue.
   The hue system carries the meaning: red is wrong, gold is waiting on him,
   cyan is ready to run.
   ═══════════════════════════════════════════════════════════════════════════ */
async function paintTheMove() {
  const el = $('#theMove'); if (!el) return;
  const [o, b, om] = await Promise.all([
    C.overview().catch(() => null),
    C.board().catch(() => null),
    C.omni().catch(() => null),
  ]);
  const moves = [];
  const push = (score, hue, kind, title, why, act) => moves.push({ score, hue, kind, title, why, act });

  // ── things that are WRONG outrank everything ──
  const h = (o && o.health) || {};
  // A new operator with no fleet tree must be told the way in before anything
  // else; the relay verdict is read from a log inside that tree, so without the
  // tree it is unknown, never "offline".
  if (o && o.rootReadable === false) push(110, 45, 'FIRST RUN', 'No fleet tree is set', (o.platform === 'darwin'
    ? 'The console reads a fleet tree: a folder in your home holding logs/interactions and agents. '
    : 'The console reads a fleet tree in WSL: a home folder holding logs/interactions and agents. ')
    + 'Set the fleet path on Config → Preferences (it is discovered on first run when one exists), then reopen Pulse.', { go: 'settings', label: 'Set the fleet path' });
  else if (o && !o.uptime) push(100, 355, 'BROKEN', 'The relay is offline', 'Nothing can run until the mouth-proxy answers on 127.0.0.1:8788.', { go: 'settings', label: 'Open diagnosis' });
  else if (h.level === 'degraded') push(92, 355, 'DEGRADED', 'The Cortex is degraded', 'Turns are faulting. Look at why before starting anything new.', { go: 'settings', label: 'See the diagnosis' });

  // ── things WAITING ON HIM — his answer unblocks a real agent ──
  const s = om && om.omni && om.omni.session;
  if (s && s.status === 'waiting') push(96, 45, 'WAITING ON YOU', 'Motus Max is asking you something', String(s.question || '').slice(0, 150), { go: 'omni', label: 'Answer it' });
  const waiting = ((b && b.tasks) || []).filter((t) => t.status === 'waiting' && t.priority === 1);
  if (waiting.length) push(74, 45, 'BLOCKED', `${waiting.length} high-priority task${waiting.length > 1 ? 's are' : ' is'} blocked`, waiting[0].title, { go: 'tasks', label: 'Open the board' });

  // ── the drive is LIVE — watching beats starting something else ──
  if (s && s.status === 'running') push(88, 175, 'IN MOTION', 'A drive is running right now', String(s.goal || '').split('\n')[0].slice(0, 150), { go: 'omni', label: 'Watch it' });

  // ── the fleet has work it could take off his hands ──
  const aw = (b && b.autoWork) || {};
  const fleetReady = ((b && b.tasks) || []).filter((t) => t.owner === 'fleet' && t.agent && t.status !== 'done').length;
  if (fleetReady && !aw.on) push(70, 155, 'READY TO HAND OFF', `${fleetReady} task${fleetReady > 1 ? 's are' : ' is'} marked for the fleet`, 'Auto-work is off, so they are sitting still. Arm it and they get worked one at a time.', { go: 'tasks', label: 'Open the board' });

  // ── orientation gaps: the cheapest high-leverage fix there is ──
  if (o && !o.motus) push(66, 265, 'UNSET', 'No Motus is set', 'Every agent turn starts by reading it. One line here orients the whole fleet.', { go: 'motus', label: 'Set the Motus' });
  else if (o && !o.goal) push(52, 45, 'UNSET', 'No long-term Goal is set', 'The north star the Motus is measured against.', { go: 'goal', label: 'Set the Goal' });

  // ── nothing is wrong: the highest-value forward move ──
  const openHigh = ((b && b.tasks) || []).filter((t) => t.status !== 'done' && String(t.priority) === '1').length;
  if (openHigh) push(48, 155, 'NEXT', `${openHigh} high-priority task${openHigh > 1 ? 's' : ''} open`, 'The board is where the real queue lives.', { go: 'tasks', label: 'Open the board' });
  push(10, 175, 'OPEN', 'Nothing is on fire', 'Motus Max can pick the highest-leverage move itself, read your whole system first, and drive it.', { go: 'omni', label: 'Let her choose' });

  moves.sort((a, z) => z.score - a.score);
  const top = moves[0], rest = moves.slice(1, 4);
  el.innerHTML = `
    <div class="tm glass" style="--tmh:${top.hue}">
      <div class="tm-main">
        <span class="tm-kind">${esc(top.kind)}</span>
        <div class="tm-title">${esc(top.title)}</div>
        <div class="tm-why">${esc(top.why)}</div>
      </div>
      <button class="tm-act" data-tmgo="${top.act.go}">${esc(top.act.label)} →</button>
    </div>
    ${rest.length ? `<div class="tm-rest">${rest.map((m) => `
      <button class="tm-r" data-tmgo="${m.act.go}" style="--tmh:${m.hue}">
        <span class="tm-r-k">${esc(m.kind)}</span><span class="tm-r-t">${esc(m.title)}</span></button>`).join('')}</div>` : ''}`;
  $$('#theMove [data-tmgo]').forEach((x) => x.onclick = () => switchView(x.dataset.tmgo));
}

/* ═══ THE PRIVACY VERDICT — read the public endpoint the way a stranger does.
   Wired separately from wireStream() so it survives every repaint of the view
   without being re-declared inside it. ═══ */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#stVerify');
  if (!btn) return;
  const out = $('#stVerdict'); if (!out) return;
  btn.disabled = true; const was = btn.textContent; btn.textContent = '🛡 reading…';
  const r = await C.onAirVerify().catch(() => null);
  btn.disabled = false; btn.textContent = was;
  if (!r || !r.ok) {
    out.className = 'st-verdict bad';
    out.innerHTML = `<b>${r && r.status === 404 ? 'THE BROADCAST ENDPOINT IS GONE.' : 'Could not read the public endpoint.'}</b> ${esc((r && r.error) || 'no answer')}<br><i>Unknown is not the same as safe — until this reads clean, treat the broadcast state as unverified.</i>`;
    return;
  }
  if (r.live) {
    out.className = 'st-verdict live';
    out.innerHTML = `<b>● ON AIR — and this is exactly what is retrievable:</b> ${esc(Object.entries(r.fields).filter(([, v]) => v).map(([k, v]) => `${k}${typeof v === 'number' ? ' ×' + v : ''}`).join(' · ') || 'nothing')}`;
    return;
  }
  // off air: the only answer that counts is "nothing came back"
  if (r.clean) {
    out.className = 'st-verdict good';
    out.innerHTML = '<b>✓ OFF AIR AND EMPTY.</b> The public endpoint returned no goal, no motus, no items, no agents, no topic. Nothing is retrievable, even with curl.';
  } else {
    out.className = 'st-verdict bad';
    out.innerHTML = `<b>⚠ OFF AIR BUT STILL EXPOSED —</b> the endpoint is still serving: ${esc(r.leaked.join(' · '))}. Press <b>⚔ sweep it clean</b> — it blanks the endpoint and re-reads to prove the clear landed.`;
  }
});

/* ⚔ THE SWEEP — not "did we send a blank", but "can a stranger still read it".
   Delegated, because this button must survive every repaint of the view. */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#stSweep');
  if (!btn) return;
  const out = $('#stVerdict'); if (!out) return;
  btn.disabled = true; const was = btn.textContent; btn.textContent = '⚔ sweeping…';
  const r = await C.onAirEnforce().catch(() => null);
  btn.disabled = false; btn.textContent = was;
  if (!r) { out.className = 'st-verdict bad'; out.innerHTML = '<b>The sweep did not run.</b> Unknown is not the same as safe.'; return; }
  if (r.live) {
    out.className = 'st-verdict live';
    out.innerHTML = '<b>● You are ON AIR.</b> There is nothing to sweep — what is public is what you ticked. Go off air first if you want this clean.';
  } else if (r.cleared) {
    out.className = 'st-verdict good';
    out.innerHTML = '<b>✓ SEALED.</b> ' + esc((r.leaked || []).join(' · ')) + ' was still retrievable while you were off air. It has been blanked, and a second read came back empty — that second read is the proof, not the write.';
  } else if (r.clean) {
    out.className = 'st-verdict good';
    out.innerHTML = '<b>✓ ALREADY CLEAN.</b> Read the public endpoint with no key, the way anyone could: no goal, no motus, no topic, no items, no agents.';
  } else {
    out.className = 'st-verdict bad';
    out.innerHTML = '<b>⚠ STILL EXPOSED —</b> ' + esc(((r.still || r.leaked || []).join(' · ')) || (r.error || 'unknown')) + '. ' +
      (r.error ? esc(r.error) : 'The blank was sent and the endpoint still served content — treat the host as untrusted until this reads clean.');
  }
  // the standing strip should agree with the verdict immediately
  const fresh = await C.onAir().catch(() => null);
  if (fresh && fresh.onAir) { STREAM.data = fresh.onAir; paintStreamStatus(); }
});

/* The broadcast host is a setting — delegated so it survives every repaint. */
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#stHostSet')) return;
  const inp = $('#stHost'); if (!inp) return;
  const host = inp.value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[A-Za-z0-9.-]{4,}$/.test(host)) return toast('That does not look like a hostname', 'bad');
  const r = await C.saveSettings({ liveHost: host }).catch(() => null);
  toast(r && r.ok !== false ? `Broadcast host → ${host}` : 'could not save', r && r.ok !== false ? 'good' : 'bad');
});

/* ⌕ FIND IT — probe the known hosts and reconnect to whichever answers. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#stHostFind');
  if (!b) return;
  b.disabled = true; const was = b.textContent; b.textContent = '⌕ probing…';
  const r = await C.onAirDiscover().catch(() => null);
  b.disabled = false; b.textContent = was;
  const out = $('#stVerdict');
  if (r && r.ok) {
    const inp = $('#stHost'); if (inp) inp.value = r.host;
    if (out) {
      out.className = 'st-verdict good';
      out.innerHTML = `<b>✓ Reconnected to ${esc(r.host)}.</b> ${r.changed ? 'The host had moved — this is now saved.' : 'It was already correct.'}<br><i>${r.tried.map((t) => `${esc(t.host)} → ${t.status || 'no answer'}`).join(' · ')}</i>`;
    }
    toast(`Broadcast host: ${r.host}`, 'good');
  } else if (out) {
    out.className = 'st-verdict bad';
    out.innerHTML = `<b>No host answered.</b> <i>${((r && r.tried) || []).map((t) => `${esc(t.host)} → ${t.status || 'no answer'}`).join(' · ') || 'nothing reachable'}</i>`;
  }
});
