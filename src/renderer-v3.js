/* renderer-v3.js — the focus rooms as instruments, and Davara's abilities as
   things you can press. Loaded after renderer-v2.js; the same-named functions
   below supersede the earlier declarations (a later function declaration
   wins), so the older bodies stay as dead code rather than risky deletions.

   THE GRAVITY WELL. A Motus is a prime mover: work either orbits it or drifts
   away. The well draws that literally, from the same alignment the main
   process now feeds to the close and the brief: aligned work on the inner
   ring, partial on the middle, drifting on the outer. The orbits turn slowly
   on transform only, pause with the idle brake, and never blur anything. */

function prefillCommand(text) {
  switchView('chat');
  setTimeout(() => {
    const box = $('#chatBox');
    if (!box) return;
    box.value = text;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }, 120);
}

function gravityWell(al, glyph) {
  const W = 360, C = W / 2;
  const ring = (arr, r, cls) => (arr || []).slice(0, 40).map((x, i) => {
    const a = i * 2.399963 + r / 37;                       // the golden angle: even spread, no clumps
    const cx = C + Math.cos(a) * r, cy = C + Math.sin(a) * r;
    const done = x.status === 'done';
    return `<circle class="gw-dot ${cls} ${done ? 'done' : ''}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${done ? 3 : 4.6}"><title>${escAttr(x.title)} · ${esc(x.status)}</title></circle>`;
  }).join('');
  return `<svg class="gw" viewBox="0 0 ${W} ${W}" role="img" aria-label="the gravity well: aligned work orbits close, drifting work far">
    <circle class="gw-ring" cx="${C}" cy="${C}" r="70"/>
    <circle class="gw-ring" cx="${C}" cy="${C}" r="112"/>
    <circle class="gw-ring far" cx="${C}" cy="${C}" r="154"/>
    <g class="gw-orbit in">${ring(al.aligned, 70, 'in')}</g>
    <g class="gw-orbit mid">${ring(al.partial, 112, 'mid')}</g>
    <g class="gw-orbit out">${ring(al.drifting, 154, 'out')}</g>
    <circle class="gw-core" cx="${C}" cy="${C}" r="17"/>
    <text class="gw-glyph" x="${C}" y="${C + 7}" text-anchor="middle">${glyph}</text>
  </svg>`;
}

async function loadFocusV3(which) {
  const host = $(which === 'motus' ? '#motusBody' : '#goalBody'); if (!host) return;
  const meta = FOCUS_V2[which];
  const [f, board, ov] = await Promise.all([C.focus(), C.board(), C.overview()]);
  if (!f || f.error) return viewFail(which, f);
  const cur = which === 'motus' ? f.motus : f.goal;
  const other = which === 'motus' ? f.goal : f.motus;
  const tasks = (board && board.tasks) || [];
  const done = tasks.filter((t) => t.status === 'done');
  const al = f.alignment || { set: false, aligned: [], drifting: [], partial: [], pct: 0, total: tasks.length };
  const ev = (f.evidence && f.evidence[which]) || null;
  const hist = (f.history || []).filter((h) => h.kind === which);
  const heldDays = ev ? ev.days : (cur && cur.ts ? Math.max(0, Math.floor((Date.now() - Date.parse(cur.ts)) / 864e5)) : 0);
  const bag = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const share = (a, b) => { const A = bag(a), B = bag(b); if (!A.size || !B.size) return 0; let n = 0; for (const w of B) if (A.has(w)) n++; return n / Math.min(A.size, B.size); };
  const todayDone = done.filter((t) => { const d = new Date(t.doneAt || t.updated || 0); const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); }).length;
  const todayTurns = (ov && ov.stats && ov.stats.todayTurns) || 0;

  const evidenceStrip = ev ? `
    <div class="st-strip n5 focus-ev">
      ${siCell('', heldDays === 0 ? 'today' : heldDays, heldDays === 1 ? 'day held' : 'days held')}
      ${siCell(ev.turns ? 'go' : '', ev.turns, 'turn' + (ev.turns === 1 ? '' : 's') + ' since it was named')}
      ${siCell(ev.closed ? 'go' : '', ev.closed, 'closed since')}
      ${siCell(ev.shipped ? 'live' : '', ev.shipped, 'shipped by the loops since')}
      ${siCell(ev.learned ? 'go' : '', ev.learned, 'learning' + (ev.learned === 1 ? '' : 's') + ' banked since')}
    </div>` : '';

  const sharpen = `
    <div class="sharpen" id="sharpen-${which}">
      <button class="mini go" id="sharpenBtn-${which}" title="one real relay turn: she returns one line and a falsifier; nothing changes until you use it">✦ Sharpen with Davara</button>
      <span class="focus-hint">she returns one line and one falsifier; you decide</span>
      <div class="sharpen-out" id="sharpenOut-${which}"></div>
    </div>`;

  const setPanel = `
    <div class="focus-set glass">
      <div class="fs-lbl">${cur ? 'Change it' : `Name your ${meta.title.toLowerCase()}`}</div>
      <textarea class="focus-input" id="focusInput-${which}" rows="2" placeholder="${escAttr(meta.ph)}" spellcheck="true">${esc(cur ? cur.text : '')}</textarea>
      <div class="focus-actions">
        <button class="prime-btn" id="focusSet-${which}">${meta.icon} ${cur ? 'Update' : 'Set'} ${meta.title.toLowerCase()}</button>
        <span class="focus-hint">or type <code>${meta.cmd} …</code> in Command${which === 'goal' && cur ? ' · a goal should change rarely' : ''}</span>
      </div>
      ${sharpen}
      <div class="focus-status" id="focusStatus-${which}"></div>
    </div>`;

  const history = hist.length ? `
    <div class="panel glass">
      <div class="panel-head"><h3>${which === 'motus' ? 'Movers held before' : 'Stars steered by before'}</h3><span class="panel-sub">what each one earned while it stood</span></div>
      <div class="fhist">${hist.slice(0, 8).map((h) => {
        const e = h.evidence || {};
        const days = h.ts && h.endedTs ? Math.max(0, Math.round((Date.parse(h.endedTs) - Date.parse(h.ts)) / 864e5)) : 0;
        return `<div class="fh-row"><div class="fh-text">${esc(h.text)}</div><div class="fh-meta mono">${days} day${days === 1 ? '' : 's'} · ${e.turns || 0} turns · ${e.closed || 0} closed · ${e.shipped || 0} shipped${h.endedTs ? ' · ended ' + fmtDT2(h.endedTs) : ''}</div></div>`;
      }).join('')}</div>
    </div>` : '';

  const motusPanels = `
    <div class="mgrid">
      <div class="panel glass gw-wrap">
        <div class="panel-head"><h3>The well</h3><span class="panel-sub">work orbits the prime mover or drifts from it</span></div>
        ${al.set ? gravityWell(al, meta.icon) : '<div class="empty">Name the Motus and the board arranges itself around it.</div>'}
        ${al.set ? `<div class="gw-legend"><span class="in">● ${al.aligned.length} moving on it</span><span class="mid">● ${al.partial.length} near it</span><span class="out">● ${al.drifting.length} drifting</span></div>` : ''}
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>Alignment current</h3><span class="panel-sub">the same reading the close and the brief use</span></div>
        ${al.set ? `
          <div class="align">
            <div class="al-col">
              <div class="al-h ok">◆ Moving on it <span>${al.aligned.length}</span></div>
              ${al.aligned.length ? al.aligned.slice(0, 6).map((x) => `
                <div class="al-row ${x.status === 'done' ? 'is-done' : ''}"><span class="al-dot"></span><span class="al-t" title="${escAttr(x.title)}">${esc(x.title)}</span><span class="al-s mono">${esc(x.status)}</span></div>`).join('') : '<div class="al-empty">Nothing on the board matches this yet. Either the board or the Motus is out of date.</div>'}
            </div>
            <div class="al-col">
              <div class="al-h drift">◇ Drifting <span>${al.drifting.length}</span></div>
              ${al.drifting.length ? al.drifting.slice(0, 6).map((x) => `
                <div class="al-row"><span class="al-dot d"></span><span class="al-t" title="${escAttr(x.title)}">${esc(x.title)}</span><span class="al-s mono">${esc(x.status)}</span></div>`).join('') : '<div class="al-empty">Nothing open is pulling away from the Motus. Clean line.</div>'}
            </div>
          </div>
          <div class="al-note">Word overlap between this Motus and your real tasks: a deterministic signal that costs nothing. It now feeds two actors: a task that drifts for a week becomes a decision on THE CLOSE, and the brief tells every agent how many open tasks share no words with the Motus. ${done.length} of ${tasks.length} board items are finished.</div>`
        : '<div class="empty">Set a Motus and this fills with what is actually moving on it.</div>'}
      </div>
    </div>`;

  const goalPanels = `
    <div class="mgrid">
      <div class="panel glass">
        <div class="panel-head"><h3>The ladder</h3><span class="panel-sub">from the sky to the ground, and back up as learning</span></div>
        <div class="ladder">
          <div class="lr sky"><span class="lr-k">◎ Goal</span><span class="lr-v">${cur ? esc(cur.text) : 'not set'}</span></div>
          <div class="lr-arrow">↓ names the push</div>
          <div class="lr ${other ? '' : 'dim'}"><span class="lr-k">◆ Motus</span><span class="lr-v">${other ? esc(other.text) : 'not set; the fleet is guessing at the push'}</span></div>
          <div class="lr-arrow">↓ becomes turns</div>
          <div class="lr"><span class="lr-k">today</span><span class="lr-v">${todayTurns} turn${todayTurns === 1 ? '' : 's'} · ${todayDone} closed</span></div>
          <div class="lr-arrow">↓ banks</div>
          <div class="lr"><span class="lr-k">learned</span><span class="lr-v">${ev ? ev.learned : 0} learning${ev && ev.learned === 1 ? '' : 's'} since the star was set${ev && ev.shipped ? ' · ' + ev.shipped + ' shipped by the loops' : ''}</span></div>
        </div>
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>Bearing</h3><span class="panel-sub">how today's push serves the star</span></div>
        <div class="bearing">
          <div class="bg-item"><div class="bg-k">◎ Goal</div><div class="bg-v">${cur ? esc(cur.text) : 'not set'}</div></div>
          <div class="bg-arrow">↑ serves</div>
          <div class="bg-item"><div class="bg-k">◆ Motus</div><div class="bg-v">${other ? esc(other.text) : 'not set'}</div></div>
        </div>
        ${cur && other ? `<div class="bg-read ${share(cur.text, other.text) >= 0.12 ? 'ok' : 'warn'}">${share(cur.text, other.text) >= 0.12
          ? 'Your prime mover reads as on-bearing for the star.'
          : 'Your prime mover and your star do not visibly share language. That can be right, a stepping stone often looks unlike the destination, but it is worth a glance.'}</div>` : ''}
      </div>
    </div>`;

  setHTML(host, `
    <div class="view-head"><h2>${meta.title}</h2><p class="view-desc">${esc(meta.sub)}</p></div>

    <div class="focus-hero glass-deep f-${which} ${cur ? 'set' : 'empty'}">
      <div class="fh-glyph">${meta.icon}</div>
      <div class="fh-mid">
        <div class="fh-tag">${esc(meta.tag)}</div>
        <div class="fh-text">${cur ? esc(cur.text) : `Nothing set yet. Every agent is optimising against a weaker signal.`}</div>
        ${cur ? `<div class="fh-meta">held <b>${heldDays === 0 ? 'today' : heldDays + ' day' + (heldDays === 1 ? '' : 's')}</b> · carried by ${esc(aname((cur && cur.agent) || 'davara'))} · rides at the top of every agent's brief</div>` : ''}
      </div>
      ${cur && which === 'motus' && al.set ? `<div class="fh-ring"><div class="fhr-v">${al.pct}%</div><div class="fhr-l">of the board<br>orbits this</div></div>` : ''}
      ${cur && which === 'goal' && other ? `<div class="fh-ring"><div class="fhr-v">${share(cur.text, other.text) >= 0.12 ? '◆' : '◇'}</div><div class="fhr-l">${share(cur.text, other.text) >= 0.12 ? 'motus on<br>bearing' : 'motus off<br>bearing'}</div></div>` : ''}
    </div>

    ${evidenceStrip}
    ${which === 'motus' ? motusPanels : goalPanels}
    ${history}
    ${setPanel}`);

  const btn = $(`#focusSet-${which}`), ta = $(`#focusInput-${which}`), st = $(`#focusStatus-${which}`);
  if (btn) btn.onclick = async () => {
    const text = (ta.value || '').trim();
    if (!text) { toast(`Write the ${meta.title.toLowerCase()} first`, 'bad'); return; }
    if (which === 'goal' && cur && !confirm('Change your north star?\n\nA goal is meant to change rarely; everything the fleet learns is weighed against it.\n\nProceed?')) return;
    btn.disabled = true; if (st) st.textContent = 'Sending to Davara…';
    try {
      await C.send({ agent: 'davara', kind: which, text });
      if (st) st.textContent = '✓ Set. The fleet is holding it.';
      toast(`${meta.title} set ${meta.icon}`, 'good');
      setTimeout(() => loadFocusV3(which), 600);
    } catch (e) { if (st) st.textContent = 'Could not set. Try again.'; toast('Failed to set', 'bad'); btn.disabled = false; }
  };
  const sb = $(`#sharpenBtn-${which}`), so = $(`#sharpenOut-${which}`);
  if (sb) sb.onclick = async () => {
    const draft = (ta && ta.value.trim()) || (cur && cur.text) || '';
    if (!draft) { toast('Write a draft first, then sharpen it', 'bad'); return; }
    sb.disabled = true; sb.textContent = '… she is sharpening it';
    if (so) so.innerHTML = '<div class="sh-wait">one relay turn, usually under a minute</div>';
    const r = await C.focusSharpen({ which, text: draft }).catch(() => null);
    sb.disabled = false; sb.textContent = '✦ Sharpen with Davara';
    if (!r || !r.ok) { if (so) so.innerHTML = `<div class="sh-err">${esc((r && r.error) || 'no answer')}</div>`; return; }
    if (so) so.innerHTML = `
      <div class="sh-line">${esc(r.line)}</div>
      ${r.falsifier ? `<div class="sh-f"><b>falsifier</b> ${esc(r.falsifier)}</div>` : ''}
      ${r.why ? `<div class="sh-w"><b>why</b> ${esc(r.why)}</div>` : ''}
      <div class="focus-actions"><button class="mini go" id="sharpenUse-${which}">Use this line</button><span class="focus-hint">${r.latency ? Math.round(r.latency) + 's on the relay' : ''}</span></div>`;
    const use = $(`#sharpenUse-${which}`);
    if (use) use.onclick = () => { if (ta) { ta.value = r.line; ta.focus(); } toast('Line placed. Press Set to hold it.', 'good'); };
  };
}
function loadMotus() { return loadFocusV3('motus'); }
function loadGoal() { return loadFocusV3('goal'); }

/* ============================================================ DAVARA · v3
   Her commands and her protocols were a list. Now each one is a control: a
   command pre-fills Command with itself, a protocol pre-fills an invocation,
   and her console asks her through one chosen protocol on the relay, with the
   reply inline. Nothing here spends a turn until you press the button that
   says it does. */
async function loadMindV3() {
  const [m, oa] = await Promise.all([C.mind(), C.openai ? C.openai().catch(() => null) : null]);
  if (!m || m.error) return viewFail('mind', m || null);
  const host = $('#mindBody');
  if (!host) return;
  const na = !m.available;
  const org = m.organs || {};
  const stack = m.stack || [];
  const stream = m.stream || [];
  const cmds = (m.commands || []).map((c) => (typeof c === 'string' ? { name: c, what: '' } : c));
  const abilities = m.abilities || [];
  const reading = (m.loops || []).filter((l) => l.enabled && l.approved).length;
  setHTML(host, `
    <div class="view-head"><h2>Davara</h2>
      <p class="view-desc">Her mind, as it is right now. This page reads the canonical baseline off disk every time you open it, so what you see here is what every loop and every drive reads before it moves. Her commands and protocols are controls: press one and it is in your hands on Command.</p></div>

    <div class="st-strip n5">
      ${siCell(na ? 'zero' : 'go', na ? '—' : esc(m.version.replace(/^v/, '').split('-')[0]), na ? 'the baseline is not readable from this machine' : 'baseline ' + esc(m.version))}
      ${siCell('', na ? '—' : (org.protocols || 0) + '+' + (org.skills || 0) + '+' + (org.library || 0), 'protocols + skills + library files')}
      ${siCell(stream.length ? 'go' : '', stream.length, 'recent entries in her Stream')}
      ${siCell(reading ? 'live' : '', reading, reading === 1 ? 'loop armed, reading her organs' : 'loops armed, reading her organs')}
      ${siCell(m.meanQuality != null ? (m.meanQuality >= 6 ? 'go' : 'zero') : '', m.meanQuality != null ? m.meanQuality.toFixed(1) : '—', m.qualityN ? 'mean quality of her last ' + m.qualityN + ' passes' : 'no scored passes yet')}
    </div>

    ${na ? `<div class="panel glass"><div class="panel-head"><h3>Not readable from here</h3></div>
      <div class="mind-p">The canonical clone should be at <code>${esc(m.dir)}</code>. When it is, this page fills itself: the stack, the Stream, her commands and the organs each loop reads.</div></div>` : ''}

    <div class="panel glass mind-console">
      <div class="panel-head"><h3>Her console</h3><span class="panel-sub">a subject, through one of her protocols, on the relay</span></div>
      <div class="mc-row">
        <label class="fr-lbl">Through</label>
        <select id="mcProto" class="sel">
          <option value="">her whole mind, no single protocol</option>
          ${abilities.map((a) => `<option value="${escAttr(a.name)}">${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <textarea id="mcText" class="focus-input" rows="3" placeholder="the subject: a page, a decision, a system, a draft, a question…" spellcheck="true"></textarea>
      <div class="focus-actions">
        <button class="prime-btn" id="mcRun">✦ Ask her</button>
        <button class="mini" id="mcToCommand">→ put it on Command instead</button>
        <span class="focus-hint">one real relay turn when you press Ask</span>
      </div>
      <div id="mcOut"></div>
    </div>

    <div class="mind-grid">
      <div class="panel glass mind-stack-wrap">
        <div class="panel-head"><h3>The stack</h3><span class="panel-sub">${stack.length ? stack.length + ' layers, from her own LAYERS.json' : 'no layer file read'}</span></div>
        <div class="mind-stack">${stack.map((l, i) => `<div class="ms-layer" style="--i:${i}"><span class="ms-n mono">${esc(String(l.n))}</span><span class="ms-name">${esc(l.name)}</span>${l.desc ? `<span class="ms-desc">${esc(l.desc)}</span>` : ''}${l.trust ? `<span class="ms-trust t-${esc(l.trust)}" title="trust level: ${esc(l.trust)}${l.mutable ? ' · mutable by ' + esc(l.mutable) : ''}${l.runtime ? ' · runtime ' + esc(l.runtime) : ''}">${esc(l.trust)}</span>` : ''}</div>`).join('') || '<div class="empty">The stack file was not found.</div>'}</div>
      </div>

      <div class="panel glass">
        <div class="panel-head"><h3>What each loop reads first</h3><span class="panel-sub">two organs a pass, at most</span></div>
        ${Object.entries(m.organsByKind || {}).map(([k, v]) => `<div class="mind-organ"><div class="mo-k">${esc(k)}</div><div class="mo-v">${v.map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>`).join('')}
        <div class="mind-p mono">read sizes · scout ${m.reads.scoutChars} · build ${m.reads.buildChars} · gate ${m.reads.gateChars} chars</div>
        <div class="mind-p">Every pass ends in her own contract: a confidence with its basis, a falsifier dated on the system's clock, and the one lived turn she walked. The app scores what the report carries and checks the files it claims.</div>
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Her abilities</h3><span class="panel-sub">${abilities.length} protocols, each in its own WHEN line · press one to invoke it on Command, or choose it in her console above</span></div>
      <div class="mind-ab">${abilities.map((a) => `<div class="mab" data-invoke="${escAttr(a.name)}" title="invoke on Command"><div class="mab-n">${esc(a.name)}</div>${a.when ? `<div class="mab-w">${esc(a.when)}</div>` : ''}<div class="mab-act">invoke →</div></div>`).join('') || '<div class="empty">No protocols were read.</div>'}</div>
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
        <div class="panel-head"><h3>Her commands</h3><span class="panel-sub">from COMMANDS.md · press one and it is typed for you on Command</span></div>
        <div class="mind-cmds">${cmds.map((c) => `<button class="mind-cmd mono" data-cmd="${escAttr(c.name)}" title="${escAttr(c.what || 'run on Command')}">${esc(c.name)}${c.what ? `<span class="mc-what">${esc(c.what)}</span>` : ''}</button>`).join('') || '<div class="empty">No commands were read.</div>'}</div>
      </div>
      <div class="panel glass">
        <div class="panel-head"><h3>The covenant</h3><span class="panel-sub">how this app evolves her mind</span></div>
        ${m.covenant.present
          ? `<div class="mind-p">The DuoDrive baseline-evolution covenant is present (${Math.round(m.covenant.bytes / 1024)} KB). The <b>Baseline Evolution Pass</b> loop runs one ceremony from it on the canonical clone and stops before the push, so you ratify every change. It stays off until you arm it on Duo-Drive.</div>`
          : `<div class="mind-p">The covenant file was not found at <code>${esc(m.covenant.path)}</code>.</div>`}
        <div class="mind-p"><b>Two stacks.</b> Her seats run on the Claude Code relay. ${oa && oa.keySet ? 'The GPT seat is live on your OpenAI key (model ' + esc(oa.model || 'unchosen') + '); reach it with <code>/gpt</code> on Command, and the studio makes images for the whole fleet.' : 'Add an OpenAI key on Settings → Integrations to open the GPT seat and the image studio.'}</div>
        ${(() => {
          const cov = (m.loops || []).find((l) => l.name === 'Baseline Evolution Pass');
          return cov ? `<div class="mind-p"><b>Run one ceremony now.</b> One coherent theme, the organs read in full, the Stream entry written with confidence and falsifier, the push left for you. This is a real relay turn.</div>
          <div class="mind-acts"><button class="mini go" data-runloop="${escAttr(cov.id)}">✦ Run one ceremony</button><button class="mini" data-go="duo">Duo-Drive →</button><button class="mini" data-go="settings">Integrations →</button></div>`
          : '<div class="mind-acts"><button class="mini go" data-go="duo">Duo-Drive →</button><button class="mini" data-go="settings">Integrations →</button></div>';
        })()}
      </div>
    </div>`);
  $$('#mindBody [data-go]').forEach((b) => b.onclick = () => switchView(b.dataset.go));
  $$('#mindBody [data-cmd]').forEach((b) => b.onclick = () => prefillCommand(b.dataset.cmd + ' '));
  $$('#mindBody [data-invoke]').forEach((b) => b.onclick = () => prefillCommand('Apply the protocol «' + b.dataset.invoke + '» in full to: '));
  $$('#mindBody [data-runloop]').forEach((b) => b.onclick = async () => {
    if (!confirm('Run one baseline-evolution ceremony now?\n\nShe reads the covenant and the organs in full, makes one coherent change on the canonical clone, writes the Stream entry, and stops before the push. It costs one real relay turn.')) return;
    b.disabled = true; b.textContent = '… running the ceremony';
    const r = await C.loopRun(b.dataset.runloop).catch(() => null);
    b.disabled = false; b.textContent = '✦ Run one ceremony';
    if (r && r.ok) toast('The ceremony ran. Read her receipt on Duo-Drive → Work log.', 'good');
    else toast((r && r.error) || 'the ceremony could not run', 'bad');
  });
  const mcRun = $('#mcRun'), mcText = $('#mcText'), mcProto = $('#mcProto'), mcOut = $('#mcOut'), mcTo = $('#mcToCommand');
  const compose = () => {
    const subject = (mcText.value || '').trim();
    const proto = mcProto.value;
    if (!subject) return '';
    return proto
      ? `/PROTOCOL «${proto}» — apply it in full to what follows, and report in your contract (TITLE · CONFIDENCE with BASIS · FALSIFIER · SHUTTLE · DID · FILES · NEXT).\n\n${subject}`
      : subject;
  };
  if (mcTo) mcTo.onclick = () => { const t = compose(); if (!t) { toast('Write the subject first', 'bad'); return; } prefillCommand(t); };
  if (mcRun) mcRun.onclick = async () => {
    const t = compose();
    if (!t) { toast('Write the subject first', 'bad'); return; }
    mcRun.disabled = true; mcRun.textContent = '… she is on it';
    if (mcOut) mcOut.innerHTML = '<div class="sh-wait">one relay turn; the reply lands here</div>';
    const r = await C.send({ agent: 'davara', text: t }).catch(() => null);
    mcRun.disabled = false; mcRun.textContent = '✦ Ask her';
    if (!r || !r.ok) { if (mcOut) mcOut.innerHTML = `<div class="sh-err">${esc((r && r.error) || 'no answer')}</div>`; return; }
    if (mcOut) mcOut.innerHTML = `<div class="mind-reply expandable" data-body="${escAttr(r.text || '')}" data-rtitle="${escAttr(mcProto.value || 'Davara')}" data-rsub="${escAttr('Davara · ' + (r.latency ? Math.round(r.latency) + 's' : ''))}">
      <div class="mr-meta mono">Davara${mcProto.value ? ' · through ' + esc(mcProto.value) : ''}${r.latency ? ' · ' + Math.round(r.latency) + 's' : ''}</div>
      <div class="mr-body">${esc(r.text || '')}</div>
      <div class="dl-act"><span class="dl-more">click to expand</span><button class="mini read" data-read="1">⤢ read full</button></div>
    </div>`;
  };
}
async function loadMind() { return loadMindV3(); }

/* ============================ REMOTE ============================ */
/* A console that runs somewhere else — a server with no screen — reached over
   SSH. Two locks, and the page says why: SSH proves you have an account on that
   machine, the passphrase proves you are the operator of the console on it.
   Nothing here ever holds a secret; the main process seals both and hands back
   a yes or no. */
let REMOTE_STATE = null;
let REMOTE_WATCHING = false;

async function loadRemote() {
  const host = $('#remoteBody');
  if (!host) return;
  const r = await C.remote.get();
  if (!r || r.error) return viewFail('remote', r || null);
  REMOTE_STATE = r;

  const connected = !!r.connected;
  setHTML(host, `
    <div class="view-head"><h2>Remote</h2>
      <p class="view-desc">A console running on another machine, driven from this one. It is reached over SSH, so that machine opens no new port and nothing extra is exposed to the internet. Two things have to be true before anything moves: SSH proves you have an account there, and the passphrase proves you are the operator of the console running on it.</p></div>

    <div class="st-strip n5">
      ${siCell(connected ? 'live' : 'zero', connected ? 'LINKED' : 'OFF', connected ? 'this console is driving that one' : 'not connected')}
      ${siCell('', r.host ? esc(r.host) : '—', 'the machine')}
      ${siCell('', r.user ? esc(r.user) : '—', 'the account there')}
      ${siCell(r.hostKey ? 'go' : '', r.hostKey ? 'PINNED' : 'NEW', r.hostKey ? 'its host key is remembered' : 'its host key has not been seen yet')}
      ${siCell(r.lastConnected ? 'go' : '', r.lastConnected ? new Date(r.lastConnected).toLocaleDateString() : '—', 'last connected')}
    </div>

    ${!r.available ? `<div class="panel glass rm-warn"><div class="panel-head"><h3>The SSH client is missing from this build</h3></div>
      <div class="rm-p">Run <code>npm install</code> in the project folder and start the app again.</div></div>` : ''}

    <div class="panel glass">
      <div class="panel-head"><h3>The machine</h3><span class="panel-sub">where the other console runs</span></div>
      <div class="rm-form">
        <label class="fr-lbl">Host</label>
        <input id="rmHost" class="txt" type="text" value="${escAttr(r.host)}" placeholder="203.0.113.10 or vps.example.com" spellcheck="false"/>
        <label class="fr-lbl">Port</label>
        <input id="rmPort" class="txt sm" type="number" value="${escAttr(String(r.port || 22))}" min="1" max="65535"/>
        <label class="fr-lbl">User</label>
        <input id="rmUser" class="txt" type="text" value="${escAttr(r.user)}" placeholder="the account you log in with" spellcheck="false"/>
        <label class="fr-lbl">Sign in with</label>
        <select id="rmAuth" class="sel sm">
          <option value="password"${r.auth === 'password' ? ' selected' : ''}>a password</option>
          <option value="key"${r.auth === 'key' ? ' selected' : ''}>a key file</option>
        </select>
        ${r.auth === 'key' ? `
        <label class="fr-lbl">Key file</label>
        <input id="rmKeyPath" class="txt" type="text" value="${escAttr(r.keyPath)}" placeholder="C:\\Users\\you\\.ssh\\id_ed25519" spellcheck="false"/>
        <label class="fr-lbl">Key passphrase</label>
        <input id="rmPass" class="txt" type="password" placeholder="${r.hasPassword ? 'stored — leave blank to keep it' : 'only if your key has one; most do not'}" autocomplete="off"/>
        ` : `
        <label class="fr-lbl">SSH password</label>
        <input id="rmPass" class="txt" type="password" placeholder="${r.hasPassword ? 'stored — leave blank to keep it' : 'the password for that account'}" autocomplete="off"/>
        `}
        <label class="fr-lbl">Its passphrase</label>
        <input id="rmPhrase" class="txt" type="password" placeholder="${r.hasPhrase ? 'stored — leave blank to keep it' : 'the gate passphrase of the console over there'}" autocomplete="off"/>
      </div>
      <div class="focus-actions">
        <button class="prime-btn" id="rmConnect">${connected ? '⏻ Disconnect' : '⇄ Connect'}</button>
        <button class="mini" id="rmSave">Save without connecting</button>
        ${r.hostKey ? '<button class="mini" id="rmForget">Forget its host key</button>' : ''}
        <span class="focus-hint">both secrets are sealed by this machine's keystore and never shown again</span>
      </div>
      <div id="rmOut">${r.lastError ? `<div class="rm-err">${esc(r.lastError)}</div>` : ''}</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>What this does over there</h3></div>
      <div class="rm-p">Everything the console answers here, it answers there: the reading, the board, the fleet, the focus, the loops. Turning the agents off from this page turns them off on that machine, which is the setting that stops it spending anything while you are not using it.</div>
      <div class="rm-p mono">on that machine, the same things are: <b>cortex status</b> · <b>cortex board</b> · <b>cortex off</b></div>
    </div>

    <div id="rmLinked">${connected ? '<div class="rm-p">reading that machine…</div>' : ''}</div>
  `);

  $('#rmAuth').onchange = async () => {
    // ⚠ The stored secret means different things in the two modes: an account
    // password in one, a key's own passphrase in the other. Carrying it across
    // silently would hand ssh2 a passphrase for a key that has none, or an old
    // key passphrase as an account password, and the failure would look like
    // the server refusing you. Changing the mode forgets it.
    await C.remote.save({ auth: $('#rmAuth').value, password: null });
    loadRemote();
  };
  $('#rmSave').onclick = () => saveRemote(false);
  $('#rmConnect').onclick = () => (connected ? disconnectRemote() : saveRemote(true));
  if ($('#rmForget')) $('#rmForget').onclick = async () => {
    await C.remote.save({ forgetHostKey: true });
    loadRemote();
  };
  if (connected) paintRemoteLinked();
}

function remoteFields() {
  const auth = $('#rmAuth') ? $('#rmAuth').value : 'password';
  const p = {
    host: $('#rmHost') ? $('#rmHost').value.trim() : '',
    port: $('#rmPort') ? Number($('#rmPort').value) || 22 : 22,
    user: $('#rmUser') ? $('#rmUser').value.trim() : '',
    auth,
  };
  if (auth === 'key' && $('#rmKeyPath')) p.keyPath = $('#rmKeyPath').value.trim();
  if ($('#rmPass') && $('#rmPass').value) p.password = $('#rmPass').value;
  if ($('#rmPhrase') && $('#rmPhrase').value) p.phrase = $('#rmPhrase').value;
  return p;
}

async function saveRemote(thenConnect) {
  const out = $('#rmOut');
  const p = remoteFields();
  if (!p.host || !p.user) { out.innerHTML = '<div class="rm-err">A host and a user, at least.</div>'; return; }
  const s = await C.remote.save(p);
  if (s && s.error) { out.innerHTML = `<div class="rm-err">${esc(s.error)}</div>`; return; }
  // the fields are emptied the moment they are sealed; nothing readable stays on screen
  if ($('#rmPass')) $('#rmPass').value = '';
  if ($('#rmPhrase')) $('#rmPhrase').value = '';
  if (!thenConnect) { out.innerHTML = '<div class="rm-ok">saved</div>'; return; }
  await connectRemote(false);
}

async function connectRemote(acceptHostKey) {
  const out = $('#rmOut');
  out.innerHTML = '<div class="rm-wait">reaching that machine…</div>';
  const r = await C.remote.connect({ acceptHostKey });

  if (r && r.unknownHost) {
    // First contact. The operator has to say yes to this machine once, and they
    // should be able to compare the fingerprint with the one the server prints.
    out.innerHTML = `
      <div class="rm-host">
        <div class="rm-host-h">This machine has not been seen before</div>
        <div class="rm-p">Its key fingerprint is</div>
        <div class="rm-fp mono">${esc(r.fingerprint)}</div>
        <div class="rm-p">On the server, <code>ssh-keyscan -t ed25519 localhost | ssh-keygen -lf -</code> prints the same thing. If they match, this is the machine you think it is.</div>
        <div class="focus-actions"><button class="prime-btn" id="rmTrust">Trust this machine</button><button class="mini" id="rmCancel">Not now</button></div>
      </div>`;
    $('#rmTrust').onclick = () => connectRemote(true);
    $('#rmCancel').onclick = () => { out.innerHTML = ''; };
    return;
  }

  if (r && r.mismatch) {
    out.innerHTML = `<div class="rm-err rm-loud"><b>The host key changed.</b><br>${esc(r.error)}<br><span class="mono">${esc(r.fingerprint)}</span></div>`;
    return;
  }

  if (!r || !r.ok) { out.innerHTML = `<div class="rm-err">${esc((r && r.error) || 'it did not connect')}</div>`; return; }

  out.innerHTML = `<div class="rm-ok">connected to ${esc(r.host || '')} · v${esc(r.version || '')}</div>`;
  if (!REMOTE_WATCHING) { REMOTE_WATCHING = true; C.remote.watch(); }
  loadRemote();
}

async function disconnectRemote() {
  await C.remote.disconnect();
  REMOTE_WATCHING = false;
  loadRemote();
}

/* Once linked, the far console is read exactly like this one — same channels,
   same shapes — so this is a thin painting of what it answers. */
async function paintRemoteLinked() {
  const wrap = $('#rmLinked');
  if (!wrap) return;
  // The reading is its own channel. Asking the overview for it returned nothing
  // every time and the room quietly said "no reading yet" about a machine that
  // had one.
  const [ov, ctl, board, rd] = await Promise.all([
    C.remote.invoke('cortex:overview'),
    C.remote.invoke('cortex:control'),
    C.remote.invoke('cortex:board'),
    C.remote.invoke('cortex:reading'),
  ]);
  if (!ov || ov.error) { wrap.innerHTML = `<div class="rm-err">${esc((ov && ov.error) || 'that console did not answer')}</div>`; return; }
  const stopped = ctl && ctl.stopped;
  const tasks = (board && board.tasks) || [];
  wrap.innerHTML = `
    <div class="st-strip n5">
      ${siCell(ov.rootReadable ? 'go' : 'zero', ov.stats ? ov.stats.totalTurns : 0, 'turns on that machine')}
      ${siCell('', ov.stats ? ov.stats.todayTurns : 0, 'today')}
      ${siCell(ov.health && ov.health.level === 'nominal' ? 'go' : 'zero', ov.health ? ov.health.score : '—', 'health there')}
      ${siCell(stopped ? 'zero' : 'live', stopped ? 'OFF' : 'ON', stopped ? 'its agents are stopped' : 'its agents are answering')}
      ${siCell('', ov.openTasks || 0, 'open on its board')}
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Its reading</h3><span class="panel-sub">${esc(ov.model || '')}</span></div>
      <div class="rm-reading">${esc((rd && rd.line) || 'that machine has not read itself yet')}</div>
      ${rd && rd.more ? `<div class="rm-p">${esc(rd.more)}</div>` : ''}
      <div class="focus-actions">
        <button class="prime-btn" id="rmToggle">${stopped ? '▶ Turn its agents on' : '⏸ Turn its agents off'}</button>
        <button class="mini" id="rmHard">${stopped && ctl.hard ? 'hard stop is on' : 'and make its runner refuse turns'}</button>
        <span class="focus-hint">${stopped ? 'nothing over there is spending' : 'turning them off stops that machine spending while you are away'}</span>
      </div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Its board</h3><span class="panel-sub">${tasks.length} task(s)</span></div>
      <div class="rm-tasks">${tasks.slice(0, 10).map((t) => `<div class="rm-task"><span class="rm-t-st st-${esc(t.status)}">${esc(t.status)}</span><span class="rm-t-ti">${esc(t.title)}</span>${t.agent ? `<span class="rm-t-ag">${esc(t.agent)}</span>` : ''}</div>`).join('') || '<div class="empty">nothing on it</div>'}</div>
    </div>

    <div class="panel glass">
      <div class="panel-head"><h3>Talk to it</h3><span class="panel-sub">one real turn on that machine's subscription</span></div>
      <textarea id="rmText" class="focus-input" rows="3" placeholder="ask the fleet over there…" spellcheck="true"></textarea>
      <div class="focus-actions"><button class="prime-btn" id="rmSend">✦ Send</button><span class="focus-hint">it answers from there, on its own relay</span></div>
      <div id="rmReply"></div>
    </div>`;

  $('#rmToggle').onclick = async () => {
    await C.remote.invoke('cortex:control', [{ stopped: !stopped, hard: false }]);
    paintRemoteLinked();
  };
  $('#rmHard').onclick = async () => {
    await C.remote.invoke('cortex:control', [{ stopped: true, hard: true }]);
    paintRemoteLinked();
  };
  $('#rmSend').onclick = async () => {
    const t = $('#rmText').value.trim();
    if (!t) return;
    $('#rmReply').innerHTML = '<div class="rm-wait">asking…</div>';
    const r = await C.remote.invoke('cortex:send', [{ agent: 'davara', text: t }]);
    $('#rmReply').innerHTML = r && r.text
      ? `<div class="mind-reply"><div class="mr-meta">from that machine</div><div class="mr-body">${esc(r.text)}</div></div>`
      : `<div class="rm-err">${esc((r && r.error) || 'no answer')}</div>`;
  };
}
