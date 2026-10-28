/**
 * @hmharness/web - page/views.ts - 只读视图:任务看板、认知面板(五层记忆/世界模型/校准报告/漂移/技能候选/多智能体/迁移矩阵/轨迹回放)、设备、SSH、技能中心
 * P1-3 拆分自 page.ts(基线 682d4fc 行 1440-1792):逐字搬运的页面
 * 源码片段,由 page.ts 装配层按序拼接,字节级一致由拆分期守门脚本校验。
 * 模板字面量规则同 page.ts:无裸反引号,页面 JS 内不用插值(字符串拼接),
 * 正则反斜杠双写。
 */
export const VIEWS = `  /* ---- board / devices / skills views ---- */
  function sessTime(id) {
    var m = id.match(/^(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})/);
    return m ? m[1].slice(5) + ' ' + m[2] + ':' + m[3] : id.slice(0, 12);
  }
  function obFor(o) {
    var s = document.createElement('span');
    s.className = 'ob ' + (o === 'ok' ? 'ok' : o === 'error' ? 'err' : o === 'turn-budget' ? 'tb' : 'none');
    s.textContent = o || '\\u2014';
    return s;
  }
  /* ---- cognitive research panel (blueprint RD-001..008 seed): five-layer
     memory, episodic trajectory store, immutable evolution audit and the
     environment registry, from /api/cognitive. Read-only by design. ---- */
  function loadCognitive() {
    ['memory', 'world', 'traj', 'audit', 'env'].forEach(function (k) {
      var el = document.getElementById('cog-' + k);
      if (el) el.innerHTML = '<div class="hint">加载中…</div>';
    });
    api('/api/cognitive').then(function (r) { return r.json(); }).then(function (d) {
      var m = d.memory || {};
      var layers = [['working', '工作'], ['episodic', '情景'], ['semantic', '语义'], ['procedural', '程序'], ['world', '世界']];
      document.getElementById('cog-memory').innerHTML =
        layers.map(function (l) {
          return '<span class="ob ' + (m[l[0]] ? 'ok' : 'none') + '">' + l[1] + ' ' + (m[l[0]] || 0) + '</span>';
        }).join(' ') +
        (d.memoryContradictions ? ' <span class="ob err">矛盾待审 ' + d.memoryContradictions + '</span>' : '') +
        '<div class="hint" style="margin-top:6px">' + (m.total ? '共 ' + m.total + ' 条长期记录（只增不删，矛盾打标待审）' : '尚未产生认知记忆——跑一次任务即自动落盘（带溯源）') + '</div>';
      var wm = d.worldModel;
      var worldEl = document.getElementById('cog-world');
      if (wm && wm.beliefs && wm.beliefs.length) {
        worldEl.innerHTML = wm.beliefs.slice(0, 8).map(function (b) {
          return '<span class="ob ' + (b.confidence >= 0.6 ? 'ok' : b.confidence >= 0.3 ? 'tb' : 'err') + '">' + esc(b.actionType) + ' ' + (b.confidence * 100).toFixed(0) + '%<small>×' + b.evidenceCount + '</small></span>';
        }).join(' ') +
          '<div class="hint" style="margin-top:6px">' + wm.stepsReplayed + ' 步回放 · 校准 ' + (wm.calibration.meanError !== undefined ? '误差 ' + wm.calibration.meanError : '暂无预测') + ' · 可信动作 [' + (wm.plannerGate.trusted || []).map(esc).join(',') + ']</div>';
      } else {
        worldEl.innerHTML = '<div class="hint">暂无信念——任务轨迹积累后自动生成（预测先行=无泄漏回放）</div>';
      }
      // calibration report (§26-proven dimension, first-class)
      api('/api/cognitive/calibration').then(function (r) { return r.json(); }).then(function (c) {
        var el = document.getElementById('cog-calib');
        if (!c.predictedSteps) { el.innerHTML = '<div class="hint">尚无带预测的轨迹——探索/迁移实验自动记录预测</div>'; return; }
        var rows = (c.rows || []).slice(0, 6).map(function (row) {
          var cls = row.reliability >= 0.75 ? 'ok' : row.reliability >= 0.5 ? 'tb' : 'err';
          return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(row.actionType) + '</span> 可靠度 ' + (row.reliability * 100).toFixed(0) + '% <small>×' + row.predictions + ' 预测</small></div>';
        }).join('');
        el.innerHTML = '<div class="hint" style="margin-bottom:4px">总体 ' + (c.overallReliability * 100).toFixed(1) + '% 可靠（' + c.predictedSteps + '/' + c.totalSteps + ' 步带预测）</div>' + rows +
          '<div class="hint" style="margin-top:4px">校准维=harness 实证价值所在（迁移 +0.4166，全谱系唯一正读数）</div>';
      }).catch(function () {
        document.getElementById('cog-calib').innerHTML = '<div class="hint">加载失败</div>';
      });
      // per-environment learning curves (the measurable self-evolution evidence)
      Promise.all([
        api('/api/cognitive/calibration?trend=1&env=terminal').then(function (r) { return r.json(); }),
        api('/api/cognitive/calibration?trend=1&env=harmonyos').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=browser').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=desktop').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
        api('/api/cognitive/calibration?trend=1&env=arc3').then(function (r) { return r.json(); }).catch(function () { return { buckets: [] }; }),
      ]).then(function (trends) {
        var el = document.getElementById('cog-calib');
        if (!el) return;
        var html = '';
        [['terminal', trends[0]], ['harmonyos', trends[1]], ['browser', trends[2]], ['desktop', trends[3]], ['arc3', trends[4]]].forEach(function (pair) {
          var name = pair[0], t = pair[1];
          if (!t || !t.buckets || !t.buckets.length) return;
          var cls = t.verdict === 'improving' ? 'ok' : t.verdict === 'degrading' ? 'err' : 'tb';
          var spark = t.buckets.map(function (b) {
            var h = Math.max(2, Math.round(b.reliability * 28));
            return '<div style="display:inline-block;width:14px;margin-right:2px;background:var(--line);border-radius:2px 2px 0 0;height:' + h + 'px;vertical-align:bottom" title="' + esc(b.at.slice(0, 10)) + ' ' + (b.reliability * 100).toFixed(0) + '% (n=' + b.predictions + ')"></div>';
          }).join('');
          var delta = t.reliabilityDelta === null ? '' : (t.reliabilityDelta >= 0 ? ' +' : ' ') + (t.reliabilityDelta * 100).toFixed(1) + '%';
          html += '<div style="margin:4px 0"><span class="ob ' + cls + '">' + name + '</span>' + spark + '<small>' + delta + ' ' + t.verdict + '</small></div>';
        });
        if (html) el.insertAdjacentHTML('beforeend', '<div class="hint" style="margin-top:6px">学习曲线（按环境，自进化实证）：</div>' + html);
      }).catch(function () { /* curves are additive chrome */ });
      document.getElementById('cog-traj').innerHTML =
        '<span class="ob ' + (d.trajectories ? 'ok' : 'none') + '">' + (d.trajectories || 0) + ' 条轨迹</span>' +
        '<div class="hint" style="margin-top:6px">' + (d.trajectories ? '每次 agent 任务自动记录工具动作/结果/耗时（episodic 层）' : '任务运行后自动生成') + '</div>';
      var last = d.evolutionLastEvent;
      document.getElementById('cog-audit').innerHTML =
        '<span class="ob ' + (d.evolutionAuditEvents ? 'ok' : 'none') + '">' + (d.evolutionAuditEvents || 0) + ' 条事件</span>' +
        (last ? '<div class="hint" style="margin-top:6px">最近: ' + esc(String(last.event)) + ' · ' + esc(String(last.candidateId || '')) + '</div>' : '<div class="hint" style="margin-top:6px">进化轮次结束后自动追加（promoted/rejected/rolled-back 全记录）</div>');
      document.getElementById('cog-env').innerHTML = (d.environments || []).map(function (e) {
        return '<span class="ob ok">' + esc(e.id) + ' <small>v' + e.version + '</small></span>';
      }).join(' ') + '<div class="hint" style="margin-top:6px">环境适配器（terminal 原生 / harmonyos hdc / browser CDP / desktop / arc3 骨架）</div>';
      // lazy sections: goal drift timeline (time-ordered trend) + skill candidates
      api('/api/cognitive/drift?order=time').then(function (r) { return r.json(); }).then(function (dd) {
        var views = dd.views || [];
        var el = document.getElementById('cog-drift');
        if (!views.length) { el.innerHTML = '<div class="hint">暂无带目标的轨迹——设置会话目标后自动检测</div>'; return; }
        // mini timeline: newest last, each run a colored dot scaled by drift
        var dots = views.map(function (v) {
          var cls = v.driftScore >= 0.7 ? 'err' : v.driftScore >= 0.3 ? 'tb' : 'ok';
          return '<span class="ob ' + cls + '" title="' + esc(String(v.goalDescription).slice(0, 60)) + ' · 漂移 ' + v.driftScore.toFixed(2) + '">' + v.driftScore.toFixed(1) + '</span>';
        }).join(' → ');
        var worst = views.slice().sort(function (a, b) { return b.driftScore - a.driftScore; })[0];
        el.innerHTML =
          '<div style="margin-bottom:4px">' + dots + '</div>' +
          '<div class="hint">时间线（旧→新），最重漂移 ' + worst.driftScore.toFixed(2) + ' [' + esc(worst.recommendation) + ']：' + esc(String(worst.goalDescription).slice(0, 50)) + '</div>';
      }).catch(function () {
        document.getElementById('cog-drift').innerHTML = '<div class="hint">加载失败</div>';
      });
      api('/api/cognitive/skills').then(function (r) { return r.json(); }).then(function (dd) {
        var cands = dd.candidates || [];
        document.getElementById('cog-skills').innerHTML = cands.length
          ? cands.map(function (c) {
                  return '<div style="margin:2px 0"><span class="ob tb">' + esc(c.status) + '</span> ' + esc(c.procedure.join(' → ')) + ' <small>×' + c.evidenceTrajectories + ' 轨迹</small></div>';
            }).join('') + '<div class="hint" style="margin-top:4px">晋升仍需过基准门禁（verify → promote）</div>'
          : '<div class="hint">暂无候选——需要≥2 条含≥2 步成功动作序列的轨迹</div>';
      }).catch(function () {
        document.getElementById('cog-skills').innerHTML = '<div class="hint">加载失败</div>';
      });
      api('/api/cognitive/team').then(function (r) { return r.json(); }).then(function (dd) {
        var events = dd.events || [];
        var liveT = dd.live;
        var html = liveT && liveT.nodes && liveT.nodes.length
          ? '<div class="hint" style="margin-bottom:4px">当前拓扑: ' + liveT.nodes.map(function (n) {
              return '<span class="ob ' + (n.status === 'done' ? 'ok' : n.status === 'running' ? 'tb' : n.status === 'failed' ? 'err' : 'none') + '">' + esc(n.role) + '·' + esc(n.status) + '</span>';
            }).join(' ') + '</div>' : '';
        html += events.length
          ? events.slice(-8).reverse().map(function (e) {
              var cls = e.event === 'spawn.done' ? 'ok' : e.event === 'spawn.failed' ? 'err' : 'tb';
              var label = e.event === 'team.created' ? 'team · ' + esc(String(e.goal).slice(0, 40))
                : e.event === 'spawn.started' ? esc(e.nodeId) + ' [' + esc(e.role) + '] 预算' + e.budgetUnits
                : e.event === 'spawn.done' ? esc(e.nodeId) + ' [' + esc(e.role) + '] ' + e.durationMs + 'ms'
                : esc(e.nodeId) + ' [' + esc(e.role) + '] 失败';
              return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(String(e.at).slice(11, 19)) + '</span> ' + label + '</div>';
            }).join('')
          : '<div class="hint">暂无记录——跑一个带 spawn_agent 的任务后自动生成（角色契约+共享预算+不可变审计）</div>';
        document.getElementById('cog-team').innerHTML = html;
      }).catch(function () {
        document.getElementById('cog-team').innerHTML = '<div class="hint">加载失败</div>';
      });
      // transfer matrix: every recorded controlled experiment as a cell
      api('/api/cognitive/transfer').then(function (r) { return r.json(); }).then(function (dd) {
        var exps = dd.experiments || [];
        var el = document.getElementById('cog-transfer');
        if (!exps.length) { el.innerHTML = '<div class="hint">暂无实验——hmh cognitive transfer --run 后自动记录（双臂对照+校准差）</div>'; return; }
        var html = exps.slice(-8).reverse().map(function (e) {
          var cls = e.verdict === 'positive' ? 'ok' : e.verdict === 'negative' ? 'err' : 'tb';
          var cal = e.calibrationDelta !== undefined && e.calibrationDelta > 0 ? ' <small>校准 +' + e.calibrationDelta + '</small>' : '';
          return '<div style="margin:2px 0"><span class="ob ' + cls + '">' + esc(e.sourceEnv) + ' → ' + esc(e.targetEnv) + ' ' + esc(e.verdict) + '</span> ' +
            '<small>' + e.actionOverlap.length + ' 重叠动作</small>' + cal + '</div>';
        }).join('');
        el.innerHTML = html + '<div class="hint" style="margin-top:4px">正迁移=源知识改善目标预测；无重叠=诚实不构成检验</div>';
      }).catch(function () {
        document.getElementById('cog-transfer').innerHTML = '<div class="hint">加载失败</div>';
      });
      // trajectory replay viewer (RD-010): pick a run, inspect every step
      api('/api/cognitive/trajectories').then(function (r) { return r.json(); }).then(function (dd) {
        var list = dd.trajectories || [];
        var el = document.getElementById('cog-replay');
        if (!list.length) { el.innerHTML = '<div class="hint">暂无轨迹——跑任务/探索后自动生成</div>'; return; }
        var sel = '<select id="cog-replay-sel" style="background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px;max-width:100%">' +
          list.map(function (t) {
            return '<option value="' + esc(t.id) + '">' + (t.success ? '✓' : '✗') + ' ' + esc(t.id.slice(0, 34)) + ' · ' + t.actions + ' 步 · ' + esc(t.environmentId) + '</option>';
          }).join('') + '</select>';
        el.innerHTML = sel + '<div id="cog-replay-body" class="hint" style="margin-top:6px">选择上方轨迹查看逐步回放</div>';
        document.getElementById('cog-replay-sel').onchange = function () { loadReplay(this.value); };
        loadReplay(list[0].id);
      }).catch(function () {
        document.getElementById('cog-replay').innerHTML = '<div class="hint">加载失败</div>';
      });
    }).catch(function () {
      ['memory', 'world', 'traj', 'audit', 'env'].forEach(function (k) {
        var el = document.getElementById('cog-' + k);
        if (el) el.innerHTML = '<div class="hint err">加载失败</div>';
      });
    });
  }
  var cogRefresh = document.getElementById('cog-refresh');
  if (cogRefresh) cogRefresh.onclick = loadCognitive;
  function loadReplay(id) {
    var body = document.getElementById('cog-replay-body');
    if (!body) return;
    body.innerHTML = '<div class="hint">回放中…</div>';
    api('/api/cognitive/replay?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (v) {
      var steps = (v.steps || []).map(function (s) {
        var cls = s.outcome === 'success' ? 'ok' : s.outcome === 'failure' ? 'err' : 'none';
        var pred = s.prediction ? ' <small>预测 ' + Math.round(s.prediction.confidence * 100) + '%</small>' : '';
        var dur = s.durationMs !== undefined ? ' <small>' + s.durationMs + 'ms</small>' : '';
        return '<div style="margin:1px 0"><span class="ob ' + cls + '">' + s.step + '</span> ' + esc(s.actionType) + pred + dur + '</div>';
      }).join('');
      body.innerHTML =
        '<div class="hint" style="margin-bottom:4px">' + (v.goal ? '目标: ' + esc(String(v.goal).slice(0, 60)) + ' · ' : '') + esc(v.environmentId) + ' · 耗时 ' + Math.round((v.metrics.elapsedMs || 0) / 1000) + 's' + (v.metrics.brierScore !== undefined ? ' · Brier ' + v.metrics.brierScore : '') + '</div>' +
        (steps || '<div class="hint">（0 步）</div>');
    }).catch(function () {
      body.innerHTML = '<div class="hint err">回放失败</div>';
    });
  }
  function loadBoard() {
    var grid = document.getElementById('board-grid');
    grid.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>';
    fetch('/api/sessions').then(function (r) { return r.json(); }).then(function (d) {
      grid.innerHTML = '';
      var list = (d.sessions || []).slice(0, 24);
      if (!list.length) { grid.innerHTML = '<div class="hint">' + esc(L.none2) + '</div>'; return; }
      list.forEach(function (s) {
        var card = document.createElement('div');
        card.className = 'card';
        var crow = document.createElement('div'); crow.className = 'crow';
        crow.appendChild(obFor(s.outcome));
        var tm = document.createElement('span'); tm.textContent = sessTime(s.id);
        crow.appendChild(tm);
        var task = document.createElement('div'); task.className = 'ctask';
        task.textContent = s.task || s.id;
        var meta = document.createElement('div'); meta.className = 'cmeta';
        meta.textContent = (s.turns || 0) + ' ' + L.turnsL + ' \\u00B7 ' + (s.toolUses || 0) + ' ' + L.toolsL;
        card.appendChild(crow); card.appendChild(task); card.appendChild(meta);
        card.onclick = function () { viewSession(s.id); switchView('chat'); };
        grid.appendChild(card);
      });
      window.__AN.stagger('.card', grid);
    }).catch(function (e) { grid.innerHTML = '<div class="err">' + esc(String(e)) + '</div>'; });
  }
  /* Extension bridge row: renders FIRST and regardless of hdc — the user's
     real browser is a device too (green=connected, amber=bridge up but no
     extension attached, dim=bridge down). */
  function extBridgeRow(st) {
    var row = document.createElement('div'); row.className = 'devrow';
    var dot = document.createElement('span'); dot.className = 'st'; dot.textContent = '\u25CF';
    dot.style.color = st && st.connected ? 'var(--ok)' : (st && st.available ? 'var(--warn)' : 'var(--dim)');
    var tg = document.createElement('span'); tg.textContent = L.extBridge + ' 127.0.0.1:' + ((st && st.port) || 7789);
    var kd = document.createElement('span'); kd.className = 'kind';
    kd.textContent = !st || !st.available ? L.extDown : (st.connected ? L.extConn + (st.browser ? ' \u00B7 ' + st.browser : '') : L.extDisc);
    row.appendChild(dot); row.appendChild(tg); row.appendChild(kd);
    return row;
  }
  function loadDevices() {
    var box = document.getElementById('dev-body');
    box.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>';
    // extension status first (fast local probe), then the hdc inventory —
    // the ext row must survive the hdc empty/absent early-returns
    fetch('/api/extension/status').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (st) {
      var ext = extBridgeRow(st);
      fetch('/api/devices').then(function (r) { return r.json(); }).then(function (d) {
        box.innerHTML = '';
        box.appendChild(ext);
        if (!d.hdcAvailable) { var h = document.createElement('div'); h.className = 'hint'; h.textContent = L.noHdc; box.appendChild(h); return; }
        if (!d.devices.length) { var n = document.createElement('div'); n.className = 'hint'; n.textContent = L.noDev; box.appendChild(n); return; }
        d.devices.forEach(function (v) {
          var row = document.createElement('div'); row.className = 'devrow';
          var st2 = document.createElement('span'); st2.className = 'st'; st2.textContent = '\u25CF';
          var tg = document.createElement('span'); tg.textContent = v.target;
          var kd = document.createElement('span'); kd.className = 'kind';
          kd.textContent = v.kind === 'emulator' ? L.devEmu : L.devUsb;
          row.appendChild(st2); row.appendChild(tg); row.appendChild(kd);
          box.appendChild(row);
        });
        window.__AN.stagger('.devrow', box);
      }).catch(function (e) {
        box.innerHTML = '';
        box.appendChild(ext);
        var er = document.createElement('div'); er.className = 'err'; er.textContent = String(e);
        box.appendChild(er);
      });
    });
  }
  function renderSsh() {
    var box = document.getElementById('ssh-panels');
    var empty = document.getElementById('ssh-empty');
    var hosts = (state && state.sshHosts) || [];
    empty.style.display = hosts.length ? 'none' : '';
    if (!hosts.length) { empty.textContent = L.sshNoHosts; return; }
    box.innerHTML = '';
    hosts.forEach(function (h) {
      var card = document.createElement('div'); card.className = 'sshcard';
      var head = document.createElement('div'); head.className = 'sshhead';
      var dot = document.createElement('span'); dot.textContent = '\u25CF'; dot.style.color = 'var(--ok)';
      var name = document.createElement('b'); name.textContent = h.name;
      var addr = document.createElement('span'); addr.textContent = h.user + '@' + h.host + ':' + h.port;
      addr.style.color = 'var(--dim)';
      var st = document.createElement('span'); st.className = 'st'; st.textContent = '';
      head.appendChild(dot); head.appendChild(name); head.appendChild(addr); head.appendChild(st);
      var cmd = document.createElement('div'); cmd.className = 'sshcmd';
      var input = document.createElement('input'); input.placeholder = L.sshPh;
      var run = document.createElement('button'); run.className = 'primary sm'; run.type = 'button'; run.textContent = L.sshRun;
      cmd.appendChild(input); cmd.appendChild(run);
      var out = document.createElement('div'); out.className = 'sshout'; out.style.display = 'none';
      function send(approve) {
        var command = input.value.trim();
        if (!command) return;
        run.disabled = true;
        fetch('/api/ssh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: h.name, command: command, approve: approve === true }) })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
          .then(function (res) {
            run.disabled = false;
            if (res.status === 403 && res.d.needsApproval) {
              out.style.display = 'block';
              out.innerHTML = '';
              var warn = document.createElement('div'); warn.className = 'err'; warn.textContent = L.sshApproveFirst;
              var ok = document.createElement('button'); ok.className = 'danger sm'; ok.type = 'button'; ok.textContent = L.sshApprovedRun;
              ok.onclick = function () { send(true); };
              out.appendChild(warn); out.appendChild(ok);
              return;
            }
            out.style.display = 'block';
            if (res.d.error) { out.innerHTML = ''; var e = document.createElement('div'); e.className = 'err'; e.textContent = res.d.error; out.appendChild(e); }
            else { out.textContent = res.d.output || '(no output)'; }
            window.__AN && window.__AN.tick(out);
          })
          .catch(function (e) { run.disabled = false; out.style.display = 'block'; out.textContent = String(e); });
      }
      run.onclick = function () { send(false); };
      input.onkeydown = function (ev) { if (ev.key === 'Enter' && !ev.isComposing) send(false); };
      card.appendChild(head); card.appendChild(cmd); card.appendChild(out);
      box.appendChild(card);
    });
    window.__AN.stagger('.sshcard', box);
  }
  function skRow(name, desc, mark) {
    var r = document.createElement('div'); r.className = 'skrow';
    var nm = document.createElement('div'); nm.className = 'nm';
    nm.textContent = mark + ' ' + name;
    var ds = document.createElement('div'); ds.className = 'ds';
    ds.textContent = desc || '';
    r.appendChild(nm); r.appendChild(ds);
    return r;
  }
  function renderSkills() {
    var box = document.getElementById('sk-body');
    box.innerHTML = '';
    if (!state) { box.innerHTML = '<div class="hint">' + esc(L.loading) + '</div>'; return; }
    var h1 = document.createElement('h3'); h1.className = 'sec'; h1.textContent = L.skActive;
    box.appendChild(h1);
    if (!state.skills.active.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    state.skills.active.forEach(function (s) { box.appendChild(skRow(s.name, s.description, '+')); });
    var h2 = document.createElement('h3'); h2.className = 'sec'; h2.textContent = L.skDrafts;
    box.appendChild(h2);
    if (!state.skills.drafts.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    state.skills.drafts.forEach(function (s) { box.appendChild(skRow(s.name, s.description, '~')); });
    var h3 = document.createElement('h3'); h3.className = 'sec'; h3.textContent = L.skInsights;
    box.appendChild(h3);
    (state.insights || []).forEach(function (i) {
      var r = document.createElement('div'); r.className = 'skrow';
      var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = '[' + i.outcome + '] ' + (i.task || '').slice(0, 70);
      var ds = document.createElement('div'); ds.className = 'ds';
      ds.textContent = (i.time || '').slice(0, 16) + ' \\u00B7 ' + (i.tools || []).join(',');
      r.appendChild(nm); r.appendChild(ds);
      box.appendChild(r);
    });
    var h4 = document.createElement('h3'); h4.className = 'sec'; h4.textContent = L.skEvo;
    box.appendChild(h4);
    if (!(state.evolution || []).length) box.appendChild(Object.assign(document.createElement('div'), { className: 'hint', textContent: L.noSkills }));
    (state.evolution || []).forEach(function (e) {
      var r = document.createElement('div'); r.className = 'skrow';
      var ds = document.createElement('div'); ds.className = 'ds';
      ds.textContent = JSON.stringify(e).slice(0, 220);
      r.appendChild(ds);
      box.appendChild(r);
    });
    window.__AN.stagger('.skrow', box);
  }
`;
