/* renderer-v4.js — the remote fleet, Greta, the signal, the gear.
   Loaded after renderer-v3.js; a function declared here with the same name as
   an earlier one replaces it (the same rule v2 and v3 were built on). */

/* ============================ THE REMOTE FLEET ============================ */
/* August, 2026-09-23: "I need to see the agents that are running on my VPS ...
   integrated into our stack so I can assign him and delegate tasks and see what
   he's working on ... same features as our other agents." So once linked, the
   Remote screen stops being a reading and a text box and becomes the other
   machine's fleet, driven from here: who is there and what each is doing this
   minute, the board, the live feed, what shipped, Duo-Drive, and the settings.
   One digest call paints it (every call is an SSH round trip), and every action
   goes through the same channel the far console's own screens use. */
const RF = { tab: 'agents', digest: null, at: 0, timer: 0, busy: false, liveAgent: '', live: [], talkAgent: '', hooked: false, newTask: false };
const RF_TABS = [['agents', 'Agents'], ['board', 'Board'], ['live', 'Live'], ['work', 'Work'], ['duo', 'Duo-Drive'], ['settings', 'Settings']];
const SS_MARK = { step: ['◆', 'ground'], ask: ['◇', 'keystone'], next: ['→', 'next'], friction: ['⧗', 'friction'], done: ['●', 'arrival'] };
const rfName = (id) => { const a = ((RF.digest || {}).agents || []).find((x) => x.id === id) || ((RF.digest || {}).fleet || []).find((x) => x.id === id); return a ? a.name : aname(id); };
const rfSince = (ts) => { const t = typeof ts === 'number' ? ts : Date.parse(String(ts || '').replace(' ', 'T')); return t ? ago(t) : '—'; };

async function paintRemoteLinked() {
  const wrap = $('#rmLinked');
  if (!wrap) return;
  if (!RF.hooked && C.remote.onEvent) {
    RF.hooked = true;
    C.remote.onEvent((m) => {
      if (!m || !m.channel) return;
      if (m.channel === 'cortex:liveEvent' && RF.tab === 'live' && m.payload && m.payload.agent === RF.liveAgent) {
        RF.live = RF.live.concat(m.payload.events || []).slice(-260);
        rfPaintLive(true);
      }
      if (m.channel === 'cortex:duoState' || m.channel === 'cortex:duoPass') rfRefresh(true);
    });
  }
  // The frame is built once; only the data region repaints, so a half-typed
  // message to AUGUSTTT is never wiped by the ten-second refresh.
  if (!$('#rfData')) {
    wrap.innerHTML = `
      <div class="rf-tabs" id="rfTabs"></div>
      <div id="rfData"><div class="rm-wait">reading that machine…</div></div>
      <div class="panel glass rf-talk">
        <div class="panel-head"><h3>Talk to that fleet</h3><span class="panel-sub">one real turn over there, on its own relay and subscription</span></div>
        <div class="rf-talk-row">
          <select id="rfTalkAgent" class="sel sm"></select>
          <label class="rf-chk"><input type="checkbox" id="rfAsTask"/> put it on its board as a task and run it</label>
        </div>
        <textarea id="rfText" class="focus-input" rows="3" placeholder="ask, assign, steer…" spellcheck="true"></textarea>
        <div class="focus-actions"><button class="prime-btn" id="rfSend">✦ Send</button><span class="focus-hint" id="rfSendHint">a deep turn can take minutes; this waits for it</span></div>
        <div id="rfReply"></div>
      </div>`;
    $('#rfSend').onclick = rfSend;
  }
  rfTabs();
  await rfRefresh(false);
  clearInterval(RF.timer);
  RF.timer = setInterval(() => {
    if (CUR.view !== 'remote' || !$('#rfData') || document.hidden) return;
    rfRefresh(true);
  }, 15000);
}

function rfTabs() {
  const t = $('#rfTabs'); if (!t) return;
  const d = RF.digest || {};
  const badge = (id) => id === 'board' && d.board ? ` <span class="tab-badge">${d.board.openCount || 0}</span>`
    : id === 'duo' && d.duo && d.duo.active ? ' <span class="tab-badge live">on</span>'
    : id === 'agents' && (d.agents || []).some((a) => a.inflight) ? ' <span class="tab-badge live">●</span>' : '';
  t.innerHTML = RF_TABS.map(([id, lab]) => `<button class="chip ${RF.tab === id ? 'on' : ''}" data-rft="${id}">${lab}${badge(id)}</button>`).join('');
  $$('#rfTabs [data-rft]').forEach((b) => b.onclick = () => {
    const was = RF.tab; RF.tab = b.dataset.rft;
    if (was === 'live' && RF.tab !== 'live') C.remote.invoke('cortex:liveStop');
    rfTabs(); rfPaint();
    if (RF.tab === 'live') rfStartLive(RF.liveAgent || (RF.digest || {}).primary);
  });
}

/* ============================ THE GEAR CHIP ============================ */
/* Always visible, one click. Cruise is the floor (Opus 5.5 at max); Motus
   Motivus is the second gear and cools down by itself. Said in Command, it
   flips the same switch. */
async function paintGearChip() {
  const b = $('#tbGear'); if (!b || !C.gear) return;
  const g = await C.gear().catch(() => null);
  if (!g || g.error) return;
  const f = g.fleet || {};
  b.classList.toggle('motivus', !!f.deep);
  b.innerHTML = f.deep ? 'MOTUS MOTIVUS' + (f.minutesLeft != null ? ' <span class="gear-t">' + f.minutesLeft + 'm</span>' : '') : 'CRUISE';
  b.title = f.deep ? 'Motus Motivus: every seat in deep-build discipline' + (f.minutesLeft != null ? ', ' + f.minutesLeft + ' min left' : '') + ' · click to return to cruise'
    : 'Cruise: every seat on Opus 5.5 at max · click for Motus Motivus (ultracode)';
  b.onclick = async () => {
    const to = f.deep ? 'cruise' : 'motivus';
    if (to === 'motivus' && !confirm('Enter Motus Motivus?\n\nEvery seat works in deep-build discipline for ' + (g.ttlMin ? g.ttlMin + ' minutes' : 'as long as you leave it on') + ': subagent fan-out, adversarial self-review, critique before claims, a longer turn budget. It costs more per turn and cools back to cruise by itself.')) return;
    const r = await C.gearSet(to);
    toast(r && r.ok ? (to === 'motivus' ? 'MOTUS MOTIVUS · ultracode on' : 'Back to cruise') : 'The gear did not change', r && r.ok ? 'good' : 'bad');
    paintGearChip();
  };
}
setTimeout(paintGearChip, 1500);
setInterval(paintGearChip, 60000);

async function rfRefresh(quiet) {
  if (RF.busy) return; RF.busy = true;
  try {
    const d = await C.remote.invoke('cortex:fleetDigest');
    if (!d || d.error) {
      // a console on an older build has no digest; say so rather than go blank
      if (!quiet) setHTML($('#rfData'), `<div class="rm-err">${esc((d && d.error) || 'that console did not answer')}${/No handler|not registered|unknown/i.test((d && d.error) || '') ? ' · it is on an older build. Run <b>cortex update</b> on that machine.' : ''}</div>`);
      return;
    }
    RF.digest = d; RF.at = Date.now();
    rfTalkPicker();
    rfTabs();
    // the live feed streams on its own; a timed repaint would only jump its scroll
    if (!(quiet && RF.tab === 'live')) rfPaint();
  } finally { RF.busy = false; }
}

function rfTalkPicker() {
  const s = $('#rfTalkAgent'); const d = RF.digest; if (!s || !d) return;
  const want = RF.talkAgent || d.primary;
  const html = (d.fleet || []).map((f) => `<option value="${escAttr(f.id)}" ${f.id === want ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  if (s.dataset.h !== html) { s.innerHTML = html; s.dataset.h = html; }
  s.onchange = () => { RF.talkAgent = s.value; };
}

function rfPaint() {
  const host = $('#rfData'); const d = RF.digest; if (!host || !d) return;
  const g = (d.gear || {}).fleet || {};
  const strip = `
    <div class="st-strip n5">
      ${siCell('live', esc(d.host || '—'), 'v' + esc(d.version || '') + ' · ' + esc(d.platform || ''))}
      ${siCell(d.control && d.control.stopped ? 'zero' : 'live', d.control && d.control.stopped ? 'OFF' : 'ON', d.control && d.control.stopped ? (d.control.hard ? 'hard-stopped: its runner refuses turns' : 'its agents are stopped') : 'its agents answer')}
      ${siCell('', (d.stats || {}).todayTurns || 0, 'turns today · ' + ((d.stats || {}).totalTurns || 0) + ' total')}
      ${siCell(g.deep ? 'go' : '', g.deep ? 'MOTIVUS' : 'CRUISE', g.deep ? (g.minutesLeft != null ? g.minutesLeft + ' min of ultracode left' : 'ultracode until told') : 'Opus 5.5 · max')}
      ${siCell(d.duo && d.duo.active ? 'live' : 'zero', d.duo && d.duo.active ? 'DRIVING' : 'PARKED', d.duo && d.duo.active ? 'Duo-Drive with ' + esc(rfName(d.duo.agent)) : 'Duo-Drive is off')}
    </div>
    ${d.reading && d.reading.line ? `<div class="rf-reading">${esc(d.reading.line)}</div>` : ''}`;
  const body = RF.tab === 'agents' ? rfAgents(d)
    : RF.tab === 'board' ? rfBoard(d)
    : RF.tab === 'live' ? rfLiveFrame(d)
    : RF.tab === 'work' ? rfWork(d)
    : RF.tab === 'duo' ? rfDuo(d)
    : rfSettings(d);
  // a form the operator is typing into is never repainted out from under them
  const typing = host.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (typing) return;
  setHTML(host, strip + body);
  rfWire(d);
  if (RF.tab === 'live') rfPaintLive(false);
}

/* ---- agents ------------------------------------------------------------- */
function rfAgentCard(a, primary) {
  const gear = a.gear && a.gear.active ? `<span class="rf-gear">${esc(a.gear.label || a.gear.mode)}</span>` : '';
  const now = a.now;
  const ss = (a.safestep || []).slice(0, primary ? 5 : 3);
  const rep = (a.replies || [])[0];
  return `
    <div class="rf-agent ${primary ? 'primary' : ''} ${a.inflight ? 'working' : ''} tone-${esc(a.tone || 'slate')}">
      <div class="rfa-top">
        <span class="rfa-orb ${a.inflight ? 'live' : ''}"></span>
        <div class="rfa-id">
          <div class="rfa-name">${esc(a.name)}${a.baseName && a.baseName !== a.name ? ` <span class="rfa-seat">seat ${esc(a.id)}</span>` : ''}</div>
          <div class="rfa-role">${esc(a.role || '')}</div>
        </div>
        <div class="rfa-chips">
          <span class="rf-chip">${esc(mlabel(a.model))}</span><span class="rf-chip">${esc(QLABEL[a.effort] || a.effort)}</span>${gear}
          ${a.paused ? '<span class="rf-chip warn">paused</span>' : ''}
        </div>
      </div>
      ${now ? `
        <div class="rfa-now">
          <div class="rfa-k">WORKING NOW · ${esc(rfSince(now.since))}${now.tools ? ' · ' + now.tools + ' tools' : ''}${a.subagents ? ' · ' + a.subagents + ' subagents' : ''}</div>
          <div class="rfa-ask expandable" data-body="${escAttr(now.ask)}" data-rtitle="${escAttr(a.name + ' is working on')}">${esc(now.ask)}</div>
          ${now.last ? `<div class="rfa-ev">${esc((now.last.name ? now.last.name + ' · ' : '') + (now.last.summary || ''))}</div>` : ''}
        </div>` : `
        <div class="rfa-idle">${a.last ? `idle · last answered ${esc(rfSince(a.last.ts))} ago${a.last.ok ? '' : ' · <b class="warn">that turn ' + esc(a.last.status) + '</b>'}` : 'no turns yet on this machine'}</div>`}
      ${ss.length ? `<div class="rfa-ss">${ss.map((s) => { const m = SS_MARK[s.kind] || ['·', s.kind]; return `<div class="ss-line ss-${esc(m[1])}"><span class="ss-m">${m[0]}</span><span class="ss-t">${esc(s.text)}</span><span class="ss-w mono">${esc(rfSince(s.ts))}</span></div>`; }).join('')}</div>` : ''}
      ${rep ? `<div class="rfa-rep expandable" data-body="${escAttr(rep.reply)}" data-rtitle="${escAttr(a.name + ' · last delivered')}" data-rsub="${escAttr(rep.ts)}">
          <div class="rfa-k">LAST DELIVERED · ${esc(rfSince(rep.ts))} ago · ${Math.round(rep.latency)}s</div>
          <div class="rfa-rep-t">${esc(rep.reply)}</div>
          <div class="dl-act"><button class="mini read" data-read="1">⤢ read full</button></div>
        </div>` : ''}
      <div class="rfa-foot">
        <span class="rfa-stat">${a.today} today${a.faults ? ` · <b class="warn">${a.faults} faulted</b>` : ''}${a.medLatency ? ' · median ' + Math.round(a.medLatency) + 's' : ''} · ${a.open} open</span>
        <button class="mini" data-rf-talk="${escAttr(a.id)}">✦ talk</button>
        <button class="mini" data-rf-assign="${escAttr(a.id)}">+ assign</button>
        <button class="mini" data-rf-watch="${escAttr(a.id)}">◉ watch live</button>
      </div>
    </div>`;
}
function rfAgents(d) {
  const ag = d.agents || [];
  const primary = ag.find((a) => a.id === d.primary);
  const rest = ag.filter((a) => a.id !== d.primary);
  return `
    ${primary ? rfAgentCard(primary, true) : ''}
    ${rest.length ? `<div class="rf-grid ${rest.length === 1 ? 'one' : ''}">${rest.map((a) => rfAgentCard(a, false)).join('')}</div>` : ''}
    ${!ag.length ? '<div class="empty">No seat on that machine has taken a turn yet.</div>' : ''}`;
}

/* ---- board -------------------------------------------------------------- */
function rfTaskRow(t, d) {
  const opts = (d.fleet || []).map((f) => `<option value="${escAttr(f.id)}" ${t.agent === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  return `
    <div class="rf-task p${t.priority || 2} st-${esc(t.status)} expandable" data-body="${escAttr(t.title + (t.body ? '\n\n' + t.body : '') + (t.lastJob ? '\n\n— ' + t.lastJob.note : ''))}" data-rtitle="${escAttr(t.title)}">
      <div class="rft-top">
        <span class="rm-t-st st-${esc(t.status)}">${esc(t.status)}</span>
        <span class="rft-title">${esc(t.title)}</span>
      </div>
      ${t.body ? `<div class="rft-body">${esc(t.body)}</div>` : ''}
      ${t.lastJob ? `<div class="rft-job ${t.lastJob.ok ? '' : 'bad'}">${esc(t.lastJob.note || '')}</div>` : ''}
      <div class="rft-act">
        <select class="sel sm" data-rf-owner="${escAttr(t.id)}"><option value="">nobody</option>${opts}</select>
        ${t.status !== 'done' ? `<button class="mini accent" data-rf-run="${escAttr(t.id)}" ${t.agent ? '' : 'disabled title="assign it first"'}>▷ run</button>
        <button class="mini" data-rf-done="${escAttr(t.id)}">✓ done</button>` : ''}
        <span class="rft-when mono">${esc(rfSince(t.updated || t.created))}</span>
      </div>
    </div>`;
}
function rfBoard(d) {
  const b = d.board || {};
  const open = b.open || [];
  const groups = ['active', 'waiting', 'inbox'].map((s) => [s, open.filter((t) => t.status === s)]);
  const opts = (d.fleet || []).map((f) => `<option value="${escAttr(f.id)}" ${f.id === d.primary ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  return `
    <div class="panel glass">
      <div class="panel-head"><h3>Its board</h3><span class="panel-sub">${b.openCount || 0} open · ${(b.counts || {}).done || 0} done</span>
        <button class="ghost-btn" id="rfNewTask">${RF.newTask ? '× close' : '+ New task'}</button></div>
      ${RF.newTask ? `
        <div class="rf-new">
          <input id="rfTTitle" class="txt big" placeholder="what needs doing, in one line" spellcheck="true"/>
          <textarea id="rfTBody" class="txt" rows="3" placeholder="the detail they need: where, why, what done looks like" spellcheck="true"></textarea>
          <div class="rf-new-row">
            <select id="rfTAgent" class="sel sm">${opts}</select>
            <select id="rfTPri" class="sel sm"><option value="1">high</option><option value="2" selected>normal</option><option value="3">low</option></select>
            <label class="rf-chk"><input type="checkbox" id="rfTRun" checked/> run it now</label>
            <button class="prime-btn" id="rfTAdd">Add to its board</button>
          </div>
        </div>` : ''}
      ${groups.map(([s, xs]) => xs.length ? `<div class="rf-lane"><div class="rf-lane-h">${esc(s)} · ${xs.length}</div>${xs.map((t) => rfTaskRow(t, d)).join('')}</div>` : '').join('') || '<div class="empty">Nothing open over there.</div>'}
      ${(b.done || []).length ? `<div class="rf-lane done"><div class="rf-lane-h">recently done</div>${b.done.slice(0, 8).map((t) => rfTaskRow(t, d)).join('')}</div>` : ''}
    </div>`;
}

/* ---- live --------------------------------------------------------------- */
function rfLiveFrame(d) {
  const ag = RF.liveAgent || d.primary;
  return `
    <div class="panel glass rf-live">
      <div class="panel-head"><h3>Live</h3><span class="panel-sub">the working seat's own transcript, as it happens over there</span>
        <select id="rfLiveAgent" class="sel sm">${(d.fleet || []).map((f) => `<option value="${escAttr(f.id)}" ${f.id === ag ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
      <div id="rfLiveFeed" class="rf-feed"><div class="rm-wait">opening the feed…</div></div>
    </div>`;
}
async function rfStartLive(agent) {
  if (!agent) return;
  RF.liveAgent = agent; RF.live = [];
  const r = await C.remote.invoke('cortex:liveWatch', [agent]);
  if (!r || r.error || r.ok === false) { RF.live = []; rfPaintLive(false, (r && r.error) || 'no feed for that seat yet'); return; }
  RF.live = (r.snapshot || []).slice(-200);
  rfPaintLive(false);
}
function rfPaintLive(append, err) {
  const f = $('#rfLiveFeed'); if (!f) return;
  if (err) { f.innerHTML = `<div class="empty">${esc(err)}</div>`; return; }
  const near = f.scrollHeight - f.scrollTop - f.clientHeight < 60;
  f.innerHTML = RF.live.length ? RF.live.map((e) => `<div class="lf-row k-${esc(e.kind || '')}${e.sub ? ' sub' : ''}"><span class="lf-t mono">${esc(String(e.ts || '').slice(11, 19))}</span><span class="lf-k">${esc(e.name || e.kind || '')}</span><span class="lf-x">${esc(e.summary || e.text || '')}</span></div>`).join('')
    : '<div class="empty">Quiet. Nothing has moved on this seat since the feed opened.</div>';
  if (!append || near) f.scrollTop = f.scrollHeight;
}

/* ---- work --------------------------------------------------------------- */
function rfWork(d) {
  const w = d.work || [];
  const reps = (d.agents || []).flatMap((a) => (a.replies || []).map((r) => ({ ...r, who: a.name })))
    .sort((x, y) => String(y.ts).localeCompare(String(x.ts))).slice(0, 6);
  return `
    <div class="rf-2">
      <div class="panel glass">
        <div class="panel-head"><h3>What shipped</h3><span class="panel-sub">Duo-Drive's ledger over there</span></div>
        ${w.length ? w.map((x) => `
          <div class="wk v-${esc(x.verdict)} expandable" data-body="${escAttr(x.title + '\n\n' + (x.did || '') + (x.next ? '\n\nNext: ' + x.next : ''))}" data-rtitle="${escAttr(x.title)}">
            <div class="wk-top"><span class="wk-v">${x.verdict === 'shipped' ? '✓ shipped' : x.verdict === 'skipped' ? '– skipped' : '◎ reported'}</span><span class="wk-loop">${esc(x.loopName || 'pass')}</span>${x.confidence ? `<span class="wk-conf mono">${x.confidence}/10</span>` : ''}<span class="wk-when mono">${esc(rfSince(x.ts))}</span></div>
            <div class="wk-title">${esc(x.title)}</div>
            ${x.did ? `<div class="wk-did">${esc(x.did)}</div>` : ''}
            ${(x.files || []).length ? `<div class="wk-files">${x.files.map((f) => `<span class="wk-file mono">${esc(f)}</span>`).join('')}</div>` : ''}
          </div>`).join('') : '<div class="empty">Nothing has shipped from Duo-Drive over there yet.</div>'}
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>What they said</h3><span class="panel-sub">the last answers each seat delivered</span></div>
        ${reps.length ? reps.map((r) => `
          <div class="rfa-rep expandable" data-body="${escAttr(r.reply)}" data-rtitle="${escAttr(r.who + ' · ' + r.ts)}">
            <div class="rfa-k">${esc(r.who)} · ${esc(rfSince(r.ts))} ago · ${esc(r.status)}</div>
            <div class="rfa-ask-q">${esc(r.ask)}</div>
            <div class="rfa-rep-t">${esc(r.reply)}</div>
            <div class="dl-act"><button class="mini read" data-read="1">⤢ read full</button></div>
          </div>`).join('') : '<div class="empty">No answers logged yet.</div>'}
      </div>
    </div>`;
}

/* ---- duo-drive ---------------------------------------------------------- */
function rfDuo(d) {
  const u = d.duo || {};
  const fleet = d.fleet || [];
  const fl = u.flights || [];
  const s2 = u.second || {};
  return `
    <div class="duo-hero glass-deep ${u.active ? 'on' : ''}">
      <div class="dh-orb ${u.active ? 'live' : ''}"><span></span></div>
      <div class="dh-mid">
        <div class="dh-state">${u.active ? `Running over there with ${esc(rfName(u.agent))}` : 'Duo-Drive is off on that machine'}</div>
        <div class="dh-sub">${u.loops.filter((l) => l.enabled).length} loop(s) armed · ${u.runs} passes · ${u.skipped} idle passes skipped${u.pending ? ` · <b>${u.pending}</b> loop(s) wait for your approval` : ''}${u.wrapUp ? ' · <b>wrapping up</b>' : ''}</div>
      </div>
      <div class="dh-act">
        <select id="rfDuoAgent" class="sel">${fleet.map((f) => `<option value="${escAttr(f.id)}" ${u.agent === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
        ${u.active ? `<button class="ghost-btn" id="rfDuoWrap" ${u.wrapUp ? 'disabled' : ''}>${u.wrapUp ? '◌ wrapping up…' : '◐ Wrap up'}</button>` : ''}
        <button class="prime-btn ${u.active ? 'danger' : ''}" id="rfDuoToggle">${u.active ? '■ Stop now' : '▶ Start'}</button>
      </div>
    </div>
    <div class="panel glass duo-flights">
      <div class="df-head"><span class="df-k">IN FLIGHT</span>${fl.length ? '' : '<span class="df-none">nothing is running right now</span>'}</div>
      ${fl.map((f) => `<div class="df-row"><span class="df-dot"></span><span class="df-who">${esc(rfName(f.agent))}</span><span class="df-what">${f.loop ? 'on “' + esc(f.loop) + '”' : 'reading the system'}</span><span class="df-t mono">${f.mins} min in</span>${f.lane === 'second' ? '<span class="df-lane">second lane</span>' : ''}</div>`).join('')}
      <div class="df-second">
        <label class="df-sl"><input type="checkbox" id="rfDuo2On" ${s2.active ? 'checked' : ''} ${u.active ? '' : 'disabled'}/> a second pair of hands</label>
        <select id="rfDuo2Agent" class="sel sm">${fleet.filter((f) => f.id !== u.agent).map((f) => `<option value="${escAttr(f.id)}" ${(s2.agent || 'davaris') === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Steer it</h3><span class="panel-sub">the standing brief it holds on every pass over there</span></div>
      <textarea id="rfDuoBrief" class="txt" rows="3" spellcheck="true" placeholder="what it should care about, and what it must leave alone">${esc(u.brief || '')}</textarea>
      <div class="rf-new-row">
        <select id="rfDuoCad" class="sel sm">${[10, 15, 25, 40, 60, 90, 120, 240].map((n) => `<option value="${n}" ${u.cadenceMin === n ? 'selected' : ''}>a pass every ${n}m</option>`).join('')}</select>
        <button class="ghost-btn" id="rfDuoSave">Save the steer</button>
        <button class="ghost-btn" id="rfDuoNow" ${u.active ? '' : 'disabled title="start it first"'}>✦ Run a pass now</button>
      </div>
    </div>
    <div class="rf-2">
      <div class="panel glass">
        <div class="panel-head"><h3>Its loops</h3><span class="panel-sub">what it runs, on what cadence</span></div>
        ${u.loops.length ? u.loops.map((l) => `<div class="rf-loop ${l.enabled ? 'on' : ''}"><button class="mini" data-rf-loop="${escAttr(l.id)}">${l.enabled ? '■ pause' : '▶ arm'}</button><span class="rfl-n">${esc(l.name)}</span><span class="rfl-m mono">${esc(l.kind)} · ${l.cadenceMin}m · ${l.runs} runs${l.lastRun ? ' · ' + esc(rfSince(l.lastRun)) + ' ago' : ''}</span></div>`).join('') : '<div class="empty">No approved loops over there.</div>'}
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>Its last passes</h3></div>
        ${(u.log || []).length ? u.log.map((e) => `<div class="rf-pass ${e.ok ? '' : 'bad'}"><span class="mono">${esc(rfSince(e.ts))}</span><span class="rfp-t">${esc(e.title || '')}</span>${e.confidence ? `<span class="mono">${e.confidence}/10</span>` : ''}${e.lane === 'second' ? '<span class="df-lane">2nd</span>' : ''}</div>`).join('') : '<div class="empty">No passes yet.</div>'}
      </div>
    </div>`;
}

/* ---- settings ----------------------------------------------------------- */
function rfSettings(d) {
  const g = d.gear || {};
  const ctl = d.control || {};
  const seats = d.agents || [];
  return `
    <div class="panel glass">
      <div class="panel-head"><h3>The gear over there</h3><span class="panel-sub">cruise is Opus 5.5 at max · motivus adds ultracode discipline and cools down by itself</span></div>
      <div class="rf-gearrow">
        <button class="gear-btn ${!(g.fleet || {}).deep ? 'on' : ''}" data-rf-gear="cruise">CRUISE</button>
        <button class="gear-btn motivus ${(g.fleet || {}).deep ? 'on' : ''}" data-rf-gear="motivus">MOTUS MOTIVUS</button>
        <select id="rfGearTtl" class="sel sm">${[30, 60, 120, 240, 480, 0].map((n) => `<option value="${n}" ${(g.ttlMin || 120) === n ? 'selected' : ''}>${n ? 'for ' + (n < 60 ? n + ' min' : n / 60 + ' h') : 'until I say cruise'}</option>`).join('')}</select>
      </div>
      <div class="rf-seats-gear">${Object.entries(g.seats || {}).filter(([, s]) => s.active).map(([id, s]) => `<span class="rf-chip">${esc(rfName(id))} · ${esc(s.label)}${s.until ? ' until ' + esc(new Date(s.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''}</span>`).join('') || '<span class="rf-dim">every seat is on cruise</span>'}</div>
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Its seats</h3><span class="panel-sub">model, depth and the name it wears here</span></div>
      ${seats.map((a) => `
        <div class="rf-seat">
          <span class="rfs-name">${esc(a.name)}</span>
          <select class="sel sm" data-rf-model="${escAttr(a.id)}">${(d.models || []).map((m) => `<option value="${escAttr(m.id)}" ${a.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
          <select class="sel sm" data-rf-effort="${escAttr(a.id)}">${(d.quality || []).map((q) => `<option value="${escAttr(q.id)}" ${a.effort === q.id ? 'selected' : ''}>${esc(q.label)}</option>`).join('')}</select>
          <input class="txt sm" data-rf-alias="${escAttr(a.id)}" value="${escAttr(a.name !== a.baseName ? a.name : '')}" placeholder="shown as ${escAttr(a.baseName || a.id)}" spellcheck="false"/>
          <label class="rf-chk"><input type="radio" name="rfPrimary" data-rf-primary="${escAttr(a.id)}" ${d.primary === a.id ? 'checked' : ''}/> talk to first</label>
        </div>`).join('')}
    </div>
    <div class="panel glass">
      <div class="panel-head"><h3>Its switches</h3></div>
      <div class="focus-actions">
        <button class="prime-btn" id="rfToggle">${ctl.stopped ? '▶ Turn its agents on' : '⏸ Turn its agents off'}</button>
        <button class="mini" id="rfHard">${ctl.stopped && ctl.hard ? 'hard stop is on' : 'and make its runner refuse turns'}</button>
        <span class="focus-hint">${ctl.stopped ? 'nothing over there is spending' : 'off stops that machine spending while you are away'}</span>
      </div>
    </div>`;
}

/* ---- wiring --------------------------------------------------------------- */
function rfWire(d) {
  const inv = (ch, ...args) => C.remote.invoke(ch, args);
  const after = async (p, msg) => { const r = await p; if (r && (r.error || r.ok === false)) toast((r.error || 'refused'), 'bad'); else if (msg) toast(msg, 'good'); rfRefresh(true); return r; };
  $$('#rfData [data-rf-talk]').forEach((b) => b.onclick = () => { RF.talkAgent = b.dataset.rfTalk; rfTalkPicker(); $('#rfText').focus(); });
  $$('#rfData [data-rf-assign]').forEach((b) => b.onclick = () => { RF.tab = 'board'; RF.newTask = true; rfTabs(); rfPaint(); const s = $('#rfTAgent'); if (s) s.value = b.dataset.rfAssign; const t = $('#rfTTitle'); if (t) t.focus(); });
  $$('#rfData [data-rf-watch]').forEach((b) => b.onclick = () => { RF.tab = 'live'; RF.liveAgent = b.dataset.rfWatch; rfTabs(); rfPaint(); rfStartLive(RF.liveAgent); });
  // board
  if ($('#rfNewTask')) $('#rfNewTask').onclick = () => { RF.newTask = !RF.newTask; rfPaint(); };
  if ($('#rfTAdd')) $('#rfTAdd').onclick = async () => {
    const title = $('#rfTTitle').value.trim(); if (!title) { toast('A title, at least', 'warn'); return; }
    const agent = $('#rfTAgent').value;
    const r = await inv('cortex:taskCreate', { title, body: $('#rfTBody').value.trim(), agent, priority: +$('#rfTPri').value, tags: ['from the desktop'] });
    if (!r || !r.ok) { toast((r && r.error) || 'it did not land', 'bad'); return; }
    RF.newTask = false;
    toast('On its board' + ($('#rfTRun') && $('#rfTRun').checked ? ', and running' : ''), 'good');
    if ($('#rfTRun') && $('#rfTRun').checked) inv('cortex:taskDispatch', { id: r.task.id }).then(() => rfRefresh(true));
    rfRefresh(true);
  };
  $$('#rfData [data-rf-owner]').forEach((s) => s.onchange = () => after(inv('cortex:taskUpdate', { id: s.dataset.rfOwner, patch: { agent: s.value } }), 'reassigned'));
  $$('#rfData [data-rf-run]').forEach((b) => b.onclick = () => { b.disabled = true; b.textContent = '… running'; toast('Handed over. It runs over there; the board updates when it lands.', 'good'); after(inv('cortex:taskDispatch', { id: b.dataset.rfRun })); });
  $$('#rfData [data-rf-done]').forEach((b) => b.onclick = () => after(inv('cortex:taskUpdate', { id: b.dataset.rfDone, patch: { status: 'done' } }), 'marked done'));
  // live
  if ($('#rfLiveAgent')) $('#rfLiveAgent').onchange = () => rfStartLive($('#rfLiveAgent').value);
  // duo
  if ($('#rfDuoToggle')) $('#rfDuoToggle').onclick = () => {
    const u = d.duo || {};
    if (!u.active && !confirm(`Start Duo-Drive on ${d.host} with ${rfName($('#rfDuoAgent').value)}?\n\nIt runs that machine's armed loops on their cadence, on that machine's subscription, and obeys its stop switch and budget.`)) return;
    after(inv('cortex:duo', { active: !u.active, agent: $('#rfDuoAgent').value }), u.active ? 'stopped over there' : 'driving over there');
  };
  if ($('#rfDuoWrap')) $('#rfDuoWrap').onclick = async () => { const r = await inv('cortex:duo', { wrapUp: true }); toast((r && r.said) || 'wrapping up', 'good'); rfRefresh(true); };
  if ($('#rfDuoSave')) $('#rfDuoSave').onclick = () => after(inv('cortex:duo', { agent: $('#rfDuoAgent').value, brief: $('#rfDuoBrief').value, cadenceMin: $('#rfDuoCad').value }), 'steer saved over there');
  if ($('#rfDuoNow')) $('#rfDuoNow').onclick = () => { toast('A pass is running over there. It lands in Work.', 'good'); after(inv('cortex:duoPass', { lane: 'main' })); };
  const s2 = () => inv('cortex:duo', { second: { active: !!($('#rfDuo2On') || {}).checked, agent: ($('#rfDuo2Agent') || {}).value } }).then(() => rfRefresh(true));
  if ($('#rfDuo2On')) $('#rfDuo2On').onchange = s2;
  if ($('#rfDuo2Agent')) $('#rfDuo2Agent').onchange = s2;
  $$('#rfData [data-rf-loop]').forEach((b) => b.onclick = () => after(inv('cortex:loopAct', { id: b.dataset.rfLoop, action: 'toggle' })));
  // settings
  $$('#rfData [data-rf-gear]').forEach((b) => b.onclick = () => after(inv('cortex:gearSet', { mode: b.dataset.rfGear, ttlMin: +($('#rfGearTtl') || {}).value }), b.dataset.rfGear === 'motivus' ? 'Motus Motivus over there' : 'cruise over there'));
  $$('#rfData [data-rf-model]').forEach((s) => s.onchange = () => after(inv('cortex:setAgentConfig', { agent: s.dataset.rfModel, model: s.value }), rfName(s.dataset.rfModel) + ' → ' + s.options[s.selectedIndex].text));
  $$('#rfData [data-rf-effort]').forEach((s) => s.onchange = () => after(inv('cortex:setAgentConfig', { agent: s.dataset.rfEffort, effort: s.value }), rfName(s.dataset.rfEffort) + ' → ' + s.options[s.selectedIndex].text));
  $$('#rfData [data-rf-alias]').forEach((i) => i.onchange = () => after(inv('cortex:agentAlias', { agent: i.dataset.rfAlias, name: i.value }), 'renamed'));
  $$('#rfData [data-rf-primary]').forEach((i) => i.onchange = () => after(inv('cortex:primaryAgent', { agent: i.dataset.rfPrimary }), 'talks to ' + rfName(i.dataset.rfPrimary) + ' first'));
  if ($('#rfToggle')) $('#rfToggle').onclick = () => after(inv('cortex:control', { stopped: !(d.control || {}).stopped, hard: false }));
  if ($('#rfHard')) $('#rfHard').onclick = () => { if (confirm('Make the runner over there refuse every turn, Telegram included?')) after(inv('cortex:control', { stopped: true, hard: true })); };
}

async function rfSend() {
  const t = $('#rfText').value.trim(); if (!t) return;
  const agent = ($('#rfTalkAgent') || {}).value || (RF.digest || {}).primary || 'august';
  const asTask = $('#rfAsTask') && $('#rfAsTask').checked;
  const out = $('#rfReply');
  const btn = $('#rfSend'); btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { const h = $('#rfSendHint'); if (h) h.textContent = rfName(agent) + ' is on it · ' + Math.round((Date.now() - t0) / 1000) + 's'; }, 1000);
  out.innerHTML = `<div class="rm-wait">${esc(rfName(agent))} has it…</div>`;
  try {
    if (asTask) {
      const lines = t.split('\n');
      const r = await C.remote.invoke('cortex:taskCreate', [{ title: lines[0].slice(0, 200), body: lines.slice(1).join('\n').trim() || t, agent, priority: 1, tags: ['from the desktop'] }]);
      if (!r || !r.ok) { out.innerHTML = `<div class="rm-err">${esc((r && r.error) || 'it did not land')}</div>`; return; }
      $('#rfText').value = '';
      const d = await C.remote.invoke('cortex:taskDispatch', [{ id: r.task.id }]);
      out.innerHTML = d && d.reply ? `<div class="mind-reply"><div class="mr-meta">${esc(rfName(agent))} · as a task · ${Math.round((Date.now() - t0) / 1000)}s</div><div class="mr-body">${esc(d.reply)}</div></div>`
        : `<div class="rm-err">${esc((d && d.error) || 'no answer')}</div>`;
    } else {
      const r = await C.remote.invoke('cortex:send', [{ agent, kind: 'chat', text: t }]);
      if (r && r.text) $('#rfText').value = '';
      out.innerHTML = r && r.text
        ? `<div class="mind-reply"><div class="mr-meta">${esc(rfName(agent))} · from that machine · ${Math.round((Date.now() - t0) / 1000)}s</div><div class="mr-body">${esc(r.text)}</div></div>`
        : `<div class="rm-err">${esc((r && r.error) || 'no answer')}</div>`;
    }
  } finally {
    clearInterval(tick); btn.disabled = false;
    const h = $('#rfSendHint'); if (h) h.textContent = 'a deep turn can take minutes; this waits for it';
    rfRefresh(true);
  }
}

/* ================================ GRETA ================================ */
/* The critic, as a room. What she judged, what she found, the smallest fix she
   named, what she said must survive, and what she taught every seat. Asking her
   by hand is one form away. */
const GV = { verdict: { PASS: 'pass', REVISE: 'revise', BLOCK: 'block' } };
function gretaCard(c) {
  const v = GV.verdict[c.verdict] || 'unread';
  const who = c.subject && c.subject.agent ? aname(c.subject.agent) : (c.manual ? 'asked by you' : '');
  const body = [c.flaw && 'FLAW: ' + c.flaw, c.fix && 'FIX: ' + c.fix, c.keep && 'KEEP: ' + c.keep, c.lesson && 'LESSON: ' + c.lesson].filter(Boolean).join('\n\n') + (c.body ? '\n\n' + c.body : '');
  return `
    <div class="gc v-${v} expandable" data-body="${escAttr(body)}" data-rtitle="${escAttr('Greta on “' + ((c.subject || {}).title || '') + '”')}" data-rsub="${escAttr(c.ts)}">
      <div class="gc-top">
        <span class="gc-v">${esc(c.verdict)}</span>
        ${c.score != null ? `<span class="gc-s mono">${c.score}/10</span>` : ''}
        <span class="gc-t">${esc((c.subject || {}).title || '')}</span>
        <span class="gc-w mono">${esc(who)}${who ? ' · ' : ''}${esc(ago(c.ts))} ago</span>
      </div>
      ${c.error ? `<div class="gc-l"><b>could not judge</b> ${esc(c.error)}</div>` : ''}
      ${c.flaw ? `<div class="gc-l"><b>flaw</b> ${esc(c.flaw)}</div>` : ''}
      ${c.fix ? `<div class="gc-l"><b>fix</b> ${esc(c.fix)}</div>` : ''}
      ${c.keep ? `<div class="gc-l keep"><b>keep</b> ${esc(c.keep)}</div>` : ''}
      ${c.lesson && !/^none/i.test(c.lesson) ? `<div class="gc-l lesson"><b>lesson</b> ${esc(c.lesson)}</div>` : ''}
      <div class="dl-act"><button class="mini read" data-read="1">⤢ read her full critique</button></div>
    </div>`;
}
async function loadGreta() {
  const host = $('#gretaBody'); if (!host) return;
  const g = await C.greta();
  if (!g || g.error) return viewFail('greta', g || null);
  setHTML(host, `
    <div class="view-head"><h2>Greta</h2>
      <p class="view-desc">The critic. Big moves pass through her before they count: a Duo-Drive pass that changed two or more files or any design, every Motus Max move that changed files, and anything a seat hands her. She never builds. She says what fails, the smallest change that would make it great, and what must survive the fix. A revision lands on the board for its author, a block lands on your phone, and a lesson she is sure of rides in every seat's brief.</p></div>
    <div class="st-strip n5">
      ${siCell(g.on ? 'live' : 'zero', g.on ? 'JUDGING' : 'OFF', g.on ? 'big moves pass through her' : 'nothing is judged automatically')}
      ${siCell('', g.judged || 0, 'judged')}
      ${siCell(g.avg != null && g.avg >= 7 ? 'go' : '', g.avg != null ? g.avg : '—', 'average score, last 60')}
      ${siCell('', (g.pass || 0) + ' · ' + (g.revise || 0) + ' · ' + (g.block || 0), 'pass · revise · block')}
      ${siCell('', (g.lessons || []).length, 'lessons she taught the fleet')}
    </div>
    <div class="panel glass greta-ask">
      <div class="panel-head"><h3>Ask her</h3><span class="panel-sub">one real turn on her seat · never capped when you ask</span>
        <label class="rf-chk"><input type="checkbox" id="grOn" ${g.on ? 'checked' : ''}/> judge big moves on her own</label>
        <select id="grPer" class="sel sm">${[4, 8, 12, 20, 30].map((n) => `<option value="${n}" ${g.perDay === n ? 'selected' : ''}>up to ${n} a day</option>`).join('')}</select></div>
      <input id="grTitle" class="txt big" placeholder="what to judge, in one line" spellcheck="true"/>
      <textarea id="grBody" class="txt" rows="3" placeholder="what was done, or paste the thing itself" spellcheck="true"></textarea>
      <input id="grFiles" class="txt" placeholder="files or a live URL (optional, comma separated)" spellcheck="false"/>
      <div class="focus-actions"><button class="prime-btn" id="grGo">◎ Judge it</button><span class="focus-hint" id="grHint">she opens what you name before she judges</span></div>
      <div id="grOut"></div>
    </div>
    <div class="rf-2">
      <div class="panel glass">
        <div class="panel-head"><h3>Her verdicts</h3><span class="panel-sub">newest first${g.queued ? ' · ' + g.queued + ' waiting' : ''}${g.busy ? ' · judging now' : ''}</span></div>
        ${(g.critiques || []).length ? g.critiques.map(gretaCard).join('') : '<div class="empty">Nothing judged yet. The first big move that ships will come to her, or ask her above.</div>'}
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>What she taught the fleet</h3><span class="panel-sub">each rides in every seat's brief</span></div>
        ${(g.lessons || []).length ? g.lessons.map((l) => `<div class="gl"><span class="gl-t">${esc(l.title)}</span><span class="gl-m mono">${esc(ago(l.ts))} ago${l.uses > 1 ? ' · confirmed ' + l.uses + '×' : ''}</span></div>`).join('') : '<div class="empty">No lesson yet. She banks one only when she is sure it holds for every seat.</div>'}
      </div>
    </div>`);
  $('#grOn').onchange = async () => { await C.greta({ on: $('#grOn').checked }); toast($('#grOn').checked ? 'Greta judges big moves' : 'Greta only judges when asked', 'good'); };
  $('#grPer').onchange = () => C.greta({ perDay: +$('#grPer').value });
  $('#grGo').onclick = async () => {
    const title = $('#grTitle').value.trim(), body = $('#grBody').value.trim(), f = $('#grFiles').value.trim();
    if (!title && !body) { toast('Tell her what to judge', 'warn'); return; }
    const url = /^https?:\/\//i.test(f) ? f : '';
    const btn = $('#grGo'); btn.disabled = true; const t0 = Date.now();
    const tick = setInterval(() => { $('#grHint').textContent = 'she is looking · ' + Math.round((Date.now() - t0) / 1000) + 's'; }, 1000);
    $('#grOut').innerHTML = '<div class="rm-wait">Greta is looking…</div>';
    const r = await C.critique({ title, body, files: url ? '' : f, url });
    clearInterval(tick); btn.disabled = false; $('#grHint').textContent = 'she opens what you name before she judges';
    $('#grOut').innerHTML = r && r.critique ? gretaCard(r.critique) : `<div class="rm-err">${esc((r && r.error) || 'she did not answer')}</div>`;
    if (r && r.ok) { $('#grTitle').value = ''; $('#grBody').value = ''; $('#grFiles').value = ''; setTimeout(loadGreta, 600); }
  };
}

/* ======================= WAITING ON YOU (the board) ======================= */
/* The decisions that went to the phone, answerable here as well. One press, or
   a few words, and the answer goes back to whoever asked. */
function decisionsStrip(b) {
  const s = b.signal || {};
  const open = s.open || [];
  if (!open.length && !s.path) return '';
  return `<div class="bd-dec">
    <div class="bd-dec-h"><b>Waiting on you</b><span>${open.length ? open.length + ' decision' + (open.length === 1 ? '' : 's') + (s.path ? ', also on your phone' : '') : 'nothing waits on you'}${s.path ? ' · by ' + esc(s.path) : ' · no phone path on this machine'}</span>
      <button class="mini" id="decTest" ${s.path ? '' : 'disabled'}>send a test</button></div>
    ${open.map((d) => `<div class="bd-dc">
      <div class="bdc-t"><span class="mono">${esc(d.id)}</span> ${esc(d.title)}${d.body ? `<div class="bdc-b">${esc(d.body)}</div>` : ''}</div>
      <div class="bdc-a"><button class="mini go" data-dec="${escAttr(d.id)}" data-ans="yes">yes</button><button class="mini" data-dec="${escAttr(d.id)}" data-ans="no">no</button><input class="txt sm" data-dec-text="${escAttr(d.id)}" placeholder="or say it" spellcheck="true"/></div>
    </div>`).join('')}
  </div>`;
}
function wireDecisions() {
  const t = $('#decTest');
  if (t) t.onclick = async () => { t.disabled = true; const r = await C.signal({ test: true }); t.disabled = false; toast(r && r.test && r.test.ok ? 'Sent. Check your phone.' : 'It did not go: ' + ((r && r.test && (r.test.error || r.test.skipped)) || 'no path'), r && r.test && r.test.ok ? 'good' : 'bad'); };
  const answer = async (id, text) => { const r = await C.signal({ answer: { id, text } }); toast(r && r.ok ? 'Answered ' + id : ((r && r.error) || 'could not answer'), r && r.ok ? 'good' : 'bad'); if (typeof loadBoard === 'function') loadBoard(); };
  $$('[data-dec][data-ans]').forEach((b) => b.onclick = () => answer(b.dataset.dec, b.dataset.ans));
  $$('[data-dec-text]').forEach((i) => i.onkeydown = (e) => { if (e.key === 'Enter' && i.value.trim()) answer(i.dataset.decText, i.value.trim()); });
}

/* ============================== THE RECKONING ============================== */
/* Beneath the drive: which moves held when their day came, which broke, and
   the fleet's confidence measured against that record. Motus Max reads the same
   record before it chooses; this is the operator's view of it. */
async function paintReckonPanel(sel) {
  const host = $(sel); if (!host || !C.reckon) return;
  const r = await C.reckon().catch(() => null);
  if (!r || !r.ok) return;
  const c = r.calibration || {};
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  setHTML(host, `
    <div class="panel glass reckon">
      <div class="panel-head"><h3>The reckoning</h3><span class="panel-sub">every shipped move is checked against its own falsifier on the day it named</span>
        <button class="ghost-btn" id="rkRun" ${r.due ? '' : 'disabled title="nothing is due yet"'}>check what is due${r.due ? ' (' + r.due + ')' : ''}</button></div>
      <div class="st-strip n5">
        ${siCell('', c.judged || 0, 'moves checked')}
        ${siCell(c.judged && c.held / c.judged >= 0.6 ? 'go' : '', pct(c.held || 0, c.judged || 0), 'held')}
        ${siCell('', pct(c.hiHeld || 0, c.hi || 0), 'of the ones called 8+/10')}
        ${siCell('', r.due || 0, 'due now')}
        ${siCell('', r.last ? ago(r.last.ts) + ' ago' : 'never', 'last reckoning')}
      </div>
      ${r.line ? '<div class="rk-line">' + esc(r.line) + '</div>' : '<div class="rk-line dim">The record starts once four shipped moves have reached the day they named. Until then, confidence is a claim.</div>'}
      ${(r.recent || []).map((x) => '<div class="rk-row r-' + esc(String(x.verdict).toLowerCase()) + '"><span class="rk-v">' + (x.verdict === 'HELD' ? '✓ held' : x.verdict === 'BROKE' ? '✕ broke' : '? unknown') + '</span><span class="rk-t">' + esc(x.title) + '</span><span class="rk-e">' + esc(x.evidence || '') + '</span><span class="rk-m mono">' + (x.confidence ? x.confidence + '/10 · ' : '') + esc(ago(x.ts)) + '</span></div>').join('')}
    </div>`);
  const b = $('#rkRun');
  if (b) b.onclick = async () => {
    b.disabled = true; b.textContent = 'Greta is checking…';
    const x = await C.reckon({ run: true });
    toast(x && x.ok ? (x.judged ? x.judged + ' move(s) checked' : 'nothing was due') : ((x && x.error) || 'it did not run'), x && x.ok ? 'good' : 'bad');
    paintReckonPanel(sel);
  };
}
