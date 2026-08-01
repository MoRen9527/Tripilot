(() => {
  const vscode = acquireVsCodeApi();

  // --- Modal (Copilot-like) ---
  let modalRootEl = null;
  let modalBackdropEl = null;
  let modalDialogEl = null;
  let modalResolve = null;

  function ensureModalRoot() {
    if (modalRootEl && document.body.contains(modalRootEl)) return modalRootEl;

    modalRootEl = document.createElement('div');
    modalRootEl.className = 'modalRoot hidden';

    modalBackdropEl = document.createElement('div');
    modalBackdropEl.className = 'modalBackdrop';

    modalDialogEl = document.createElement('div');
    modalDialogEl.className = 'modalDialog';
    modalDialogEl.setAttribute('role', 'dialog');
    modalDialogEl.setAttribute('aria-modal', 'true');

    modalRootEl.appendChild(modalBackdropEl);
    modalRootEl.appendChild(modalDialogEl);
    document.body.appendChild(modalRootEl);

    modalBackdropEl.addEventListener('click', () => closeModal(false));

    window.addEventListener(
      'keydown',
      (e) => {
        if (!modalResolve) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeModal(false);
        }
      },
      true
    );

    return modalRootEl;
  }

  function closeModal(result) {
    if (!modalResolve) {
      if (modalRootEl) modalRootEl.classList.add('hidden');
      return;
    }
    const resolve = modalResolve;
    modalResolve = null;
    if (modalRootEl) modalRootEl.classList.add('hidden');
    try {
      resolve(!!result);
    } catch {
      // ignore
    }
  }

  function showConfirmModal({ title, message, confirmText, cancelText }) {
    ensureModalRoot();
    if (!modalDialogEl) return Promise.resolve(true);

    // If a modal is already open, treat it as cancelled.
    if (modalResolve) closeModal(false);

    modalDialogEl.innerHTML = '';

    const h = document.createElement('div');
    h.className = 'modalTitle';
    h.textContent = String(title || '确认');

    const p = document.createElement('div');
    p.className = 'modalMessage';
    p.textContent = String(message || '确定要继续吗？');

    const actions = document.createElement('div');
    actions.className = 'modalActions';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'ghost';
    btnCancel.textContent = String(cancelText || '取消');
    btnCancel.style.display = cancelText === '' ? 'none' : '';
    btnCancel.addEventListener('click', () => closeModal(false));

    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.textContent = String(confirmText || '确定');
    btnOk.addEventListener('click', () => closeModal(true));

    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);

    modalDialogEl.appendChild(h);
    modalDialogEl.appendChild(p);
    modalDialogEl.appendChild(actions);

    modalRootEl.classList.remove('hidden');

    // Focus primary action.
    setTimeout(() => {
      try {
        btnOk.focus();
      } catch {
        // ignore
      }
    }, 0);

    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }

  function showAlertModal({ title, message, okText }) {
    return showConfirmModal({
      title: title || '提示',
      message: message || '',
      confirmText: okText || '知道了',
      cancelText: ''
    }).then(() => true);
  }

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendEl = document.getElementById('send');
  const statusEl = document.getElementById('status');

  // --- DOM references (must be declared; optional chaining doesn't help undeclared identifiers) ---
  // Topbar
  const btnTopNewEl = document.getElementById('btnTopNew');
  const btnTopSettingsEl = document.getElementById('btnTopSettings');
  const btnTopMoreEl = document.getElementById('btnTopMore');
  const topNewMenuEl = document.getElementById('topNewMenu');
  const topMoreMenuEl = document.getElementById('topMoreMenu');

  // Sessions
  const sessionsEl = document.getElementById('sessions');
  const sessionNavEl = document.getElementById('sessionNav');
  const btnSessionBackEl = document.getElementById('btnSessionBack');
  const sessionNavTitleEl = document.getElementById('sessionNavTitle');
  const sessionsHeaderEl = document.querySelector('.sessionsHeader');
  const sessionsHeaderTextEl = document.getElementById('sessionsHeaderText');
  const sessionsHeaderActionsEl = document.getElementById('sessionsHeaderActions');
  const sessionsListEl = document.getElementById('sessionsList');
  const btnSessionsToggleEl = document.getElementById('btnSessionsToggle');
  const btnSessionsViewEl = document.getElementById('btnSessionsView');
  const btnSessionsRefreshEl = document.getElementById('btnSessionsRefresh');
  const btnSessionsSearchEl = document.getElementById('btnSessionsSearch');
  const btnSessionsFilterEl = document.getElementById('btnSessionsFilter');
  const btnHistoryEl = document.getElementById('btnHistory');
  const sessionsOverlayEl = document.getElementById('sessionsOverlay');
  const btnSessionsOverlayCloseEl = document.getElementById('btnSessionsOverlayClose');

  // Approval (edit review)
  const approvalEl = document.getElementById('approval');
  const approvalTextEl = document.getElementById('approvalText');
  const approvalFilesEl = document.getElementById('approvalFiles');
  const approvalPreviewEl = document.getElementById('approvalPreview');
  const approvalApplyEl = document.getElementById('approvalApply');
  const approvalCancelEl = document.getElementById('approvalCancel');

  // Composer
  const composerBoxEl = document.querySelector('.composerBox');
  const btnAddContextEl = document.getElementById('btnAddContext');
  const contextChipsEl = document.getElementById('contextChips');
  const toolChipsEl = document.getElementById('toolChips');
  const hashSuggestEl = document.getElementById('hashSuggest');

  // Bottom menus
  const btnAgentMenuEl = document.getElementById('btnAgentMenu');
  const btnModelMenuEl = document.getElementById('btnModelMenu');
  const btnToolsEl = document.getElementById('btnTools');
  const btnContinueEl = document.getElementById('btnContinue');
  const agentMenuEl = document.getElementById('agentMenu');
  const modelMenuEl = document.getElementById('modelMenu');
  const toolsMenuEl = document.getElementById('toolsMenu');
  const agentLabelEl = document.getElementById('agentLabel');
  const modelLabelEl = document.getElementById('modelLabel');

  // Temporary session UI
  const tempSessionToggleWrapEl = document.getElementById('tempSessionToggleWrap');
  const tempSessionToggleEl = document.getElementById('tempSessionToggle');
  const tempSessionPillEl = document.getElementById('tempSessionPill');

  function updateComposerTokensPresence() {
    const hasContext = !!(contextChipsEl && contextChipsEl.children && contextChipsEl.children.length);
    const hasTools = !!(toolChipsEl && toolChipsEl.children && toolChipsEl.children.length);
    const wrap =
      contextChipsEl?.closest?.('.composerTokens') ||
      toolChipsEl?.closest?.('.composerTokens') ||
      null;
    if (!wrap) return;
    wrap.classList.toggle('hidden', !(hasContext || hasTools));
  }

  // --- Restore checkpoint redo offer (Copilot-like) ---
  let redoOffer = null; // { checkpointId, redoToken }
  let redoToastEl = null;

  function ensureRedoToast() {
    if (redoToastEl && document.body.contains(redoToastEl)) return redoToastEl;

    redoToastEl = document.createElement('div');
    redoToastEl.className = 'redoToast hidden';

    const text = document.createElement('div');
    text.className = 'redoToastText';
    text.textContent = '已还原检查点';

    const actions = document.createElement('div');
    actions.className = 'redoToastActions';

    const btnDismiss = document.createElement('button');
    btnDismiss.type = 'button';
    btnDismiss.className = 'ghost';
    btnDismiss.textContent = '关闭';
    btnDismiss.addEventListener('click', () => hideRedoOffer());

    const btnRedo = document.createElement('button');
    btnRedo.type = 'button';
    btnRedo.textContent = '重做';
    btnRedo.addEventListener('click', async () => {
      if (!redoOffer) return;
      if (isBusy) {
        await showAlertModal({
          title: '无法重做',
          message: '正在运行中，无法重做。请先点击“停止”取消当前请求。',
          okText: '知道了'
        });
        return;
      }
      vscode.postMessage({
        type: 'checkpointAction',
        action: 'redo',
        checkpointId: redoOffer.checkpointId,
        redoToken: redoOffer.redoToken
      });
      hideRedoOffer();
    });

    actions.appendChild(btnDismiss);
    actions.appendChild(btnRedo);
    redoToastEl.appendChild(text);
    redoToastEl.appendChild(actions);

    document.body.appendChild(redoToastEl);
    return redoToastEl;
  }

  function showRedoOffer({ checkpointId, redoToken }) {
    const id = String(checkpointId || '').trim();
    const token = String(redoToken || '').trim();
    if (!id || !token) return;
    redoOffer = { checkpointId: id, redoToken: token };
    ensureRedoToast();
    redoToastEl.classList.remove('hidden');
  }

  function hideRedoOffer() {
    redoOffer = null;
    if (redoToastEl) redoToastEl.classList.add('hidden');
  }

  let currentAgentProfileId = null;
  let currentEnabledOptionalTools = new Set();
  let currentAllowedOptionalTools = null;
  let isBusy = false;
  const defaultPlaceholder = inputEl?.getAttribute('placeholder') ?? '';

  let sessionState = { isHistoryEnabled: false, sessions: [] };
  let sessionsMode = 'recent';

  // Sessions UI mode (Copilot-like compact view): selecting a session switches to a detail header with back button.
  // auto: active session -> detail, otherwise list.
  let sessionsUiMode = 'auto'; // 'auto' | 'list' | 'detail'
  let detailSessionId = null;

  let cachedSessionRowHeight = null;
  let renderSessionsRaf = 0;

  let subagentTreeWrapEl = null;
  let subagentTreeListEl = null;
  let subagentTreeDetailEl = null;
  let subagentTreeScopeEl = null;
  let subagentTreeStatusEl = null;
  let subagentTreeFocusPathBtnEl = null;
  let subagentTreeStatsEl = null;
  let sceneWrapEl = null;
  let sceneSummaryEl = null;
  let sceneListEl = null;
  let replayWrapEl = null;
  let replaySessionInputEl = null;
  let replayTraceInputEl = null;
  let replayPlayBtnEl = null;
  let replayStopBtnEl = null;
  let replayCadenceInputEl = null;
  let replayScrubEl = null;
  let replayListEl = null;
  let replayHintEl = null;
  let selectedSubagentNodeId = null;
  let subagentTreeNodes = [];
  let subagentTreeScope = 'all';
  let subagentTreeStatus = 'all';
  const collapsedSubagentNodeIdsBySession = new Map();
  const sceneState = {
    machineState: 'idle',
    reason: 'init',
    transition: 'init->idle',
    latestEventSeq: 0,
    recoveryAt: 0,
    updatedAt: 0,
    workstations: []
  };
  const replayState = {
    records: [],
    cursor: 0,
    playing: false,
    loadedSessionId: '',
    loadedTraceId: ''
  };
  const replayHostState = {
    active: false,
    playing: false,
    cursor: 0,
    locked: false,
    sessionId: '',
    traceId: '',
    totalRecords: 0,
    cadenceMs: 850
  };

  function postReplayControl(action, payload) {
    uiAction('replayControl', {
      action,
      ...(payload || {})
    });
  }

  function emitReplayControl(action, payload) {
    postReplayControl(action, {
      totalRecords: Array.isArray(replayState.records) ? replayState.records.length : 0,
      cadenceMs: Number.isFinite(Number(replayHostState.cadenceMs)) ? Number(replayHostState.cadenceMs) : 850,
      ...(payload || {})
    });
  }

  function clampReplayCursor() {
    const max = Math.max(0, replayState.records.length - 1);
    replayState.cursor = Math.min(max, Math.max(0, Number(replayState.cursor || 0)));
  }

  function getNodeSessionKey(node) {
    const sid = node?.sessionId == null ? '' : String(node.sessionId).trim();
    return sid || 'unknown';
  }

  function getCollapsedSetForSessionKey(sessionKey) {
    const key = String(sessionKey || 'unknown');
    let set = collapsedSubagentNodeIdsBySession.get(key);
    if (!set) {
      set = new Set();
      collapsedSubagentNodeIdsBySession.set(key, set);
    }
    return set;
  }

  function isSubagentNodeCollapsed(node) {
    return getCollapsedSetForSessionKey(getNodeSessionKey(node)).has(String(node?.id || ''));
  }

  function setSubagentNodeCollapsed(node, collapsed) {
    const id = String(node?.id || '');
    if (!id) return;
    const set = getCollapsedSetForSessionKey(getNodeSessionKey(node));
    if (collapsed) set.add(id);
    else set.delete(id);
  }

  function getCollapsibleSubagentNodeIds(nodes) {
    return Array.from(
      new Set(
        (Array.isArray(nodes) ? nodes : [])
          .map((node) => (node?.parentId == null ? '' : String(node.parentId)))
          .filter(Boolean)
      )
    );
  }

  function collapseAllSubagentNodes() {
    const nodes = filterSubagentNodes(subagentTreeNodes);
    const byId = new Map(nodes.map((node) => [String(node?.id || ''), node]));
    for (const id of getCollapsibleSubagentNodeIds(nodes)) {
      const node = byId.get(id);
      if (!node) continue;
      setSubagentNodeCollapsed(node, true);
    }
    renderSubagentTree();
  }

  function expandAllSubagentNodes() {
    const nodes = filterSubagentNodes(subagentTreeNodes);
    const currentIds = new Set(getCollapsibleSubagentNodeIds(nodes));
    for (const node of nodes) {
      const id = String(node?.id || '');
      if (!id || !currentIds.has(id)) continue;
      setSubagentNodeCollapsed(node, false);
    }
    renderSubagentTree();
  }

  function expandSelectedSubagentPath() {
    const selectedId = String(selectedSubagentNodeId || '').trim();
    if (!selectedId) {
      if (subagentTreeDetailEl) subagentTreeDetailEl.textContent = '请先在关系树中选中一个节点，再使用“仅展开选中路径”。';
      return;
    }

    const nodes = filterSubagentNodes(subagentTreeNodes);
    const byId = new Map(nodes.map((node) => [String(node?.id || ''), node]));
    const selected = byId.get(selectedId);
    if (!selected) {
      if (subagentTreeDetailEl) subagentTreeDetailEl.textContent = '当前过滤范围内未找到选中节点，请调整范围/状态后重试。';
      return;
    }

    const expandableIds = new Set(getCollapsibleSubagentNodeIds(nodes));
    const pathParentIds = new Set();

    let cursor = selected;
    while (cursor?.parentId != null) {
      const parentId = String(cursor.parentId);
      if (!parentId) break;
      pathParentIds.add(parentId);
      cursor = byId.get(parentId);
    }

    for (const id of expandableIds) {
      const node = byId.get(id);
      if (!node) continue;
      setSubagentNodeCollapsed(node, !pathParentIds.has(id));
    }

    renderSubagentTree();
  }

  function scheduleRenderSessions() {
    if (renderSessionsRaf) cancelAnimationFrame(renderSessionsRaf);
    renderSessionsRaf = requestAnimationFrame(() => {
      renderSessionsRaf = 0;
      renderSessions();
    });
  }

  function ensureSubagentTreePanel() {
    if (!sessionsEl) return null;
    if (subagentTreeWrapEl && sessionsEl.contains(subagentTreeWrapEl)) return subagentTreeWrapEl;

    subagentTreeWrapEl = document.createElement('div');
    subagentTreeWrapEl.className = 'subagentTree';

    const header = document.createElement('div');
    header.className = 'subagentTreeHeader';

    const title = document.createElement('div');
    title.className = 'subagentTreeTitle';
    title.textContent = 'SUBAGENT TREE (LIVE)';

    subagentTreeStatsEl = document.createElement('div');
    subagentTreeStatsEl.className = 'subagentTreeStats';
    subagentTreeStatsEl.textContent = 'W:0 · D:0 · E:0';

    const controls = document.createElement('div');
    controls.className = 'subagentTreeControls';

    subagentTreeScopeEl = document.createElement('select');
    subagentTreeScopeEl.className = 'subagentTreeSelect';
    subagentTreeScopeEl.title = '关系树范围';
    subagentTreeScopeEl.innerHTML = [
      '<option value="all">范围: 全部</option>',
      '<option value="current">范围: 当前会话</option>',
      '<option value="history">范围: 历史会话</option>'
    ].join('');
    subagentTreeScopeEl.value = subagentTreeScope;
    subagentTreeScopeEl.addEventListener('change', () => {
      subagentTreeScope = String(subagentTreeScopeEl?.value || 'all');
      renderSubagentTree();
    });

    subagentTreeStatusEl = document.createElement('select');
    subagentTreeStatusEl.className = 'subagentTreeSelect';
    subagentTreeStatusEl.title = '关系树状态过滤';
    subagentTreeStatusEl.innerHTML = [
      '<option value="all">状态: 全部</option>',
      '<option value="working">状态: 进行中</option>',
      '<option value="done">状态: 完成</option>',
      '<option value="error">状态: 异常</option>'
    ].join('');
    subagentTreeStatusEl.value = subagentTreeStatus;
    subagentTreeStatusEl.addEventListener('change', () => {
      applySubagentStatusFilter(String(subagentTreeStatusEl?.value || 'all'));
    });

    const collapseAllBtn = document.createElement('button');
    collapseAllBtn.className = 'subagentTreeAction ghost';
    collapseAllBtn.type = 'button';
    collapseAllBtn.textContent = '全收起';
    collapseAllBtn.title = '折叠当前范围内所有可折叠节点';
    collapseAllBtn.addEventListener('click', () => collapseAllSubagentNodes());

    const expandAllBtn = document.createElement('button');
    expandAllBtn.className = 'subagentTreeAction ghost';
    expandAllBtn.type = 'button';
    expandAllBtn.textContent = '全展开';
    expandAllBtn.title = '展开当前范围内所有可折叠节点';
    expandAllBtn.addEventListener('click', () => expandAllSubagentNodes());

    subagentTreeFocusPathBtnEl = document.createElement('button');
    subagentTreeFocusPathBtnEl.className = 'subagentTreeAction ghost';
    subagentTreeFocusPathBtnEl.type = 'button';
    subagentTreeFocusPathBtnEl.textContent = '仅展开选中路径';
    subagentTreeFocusPathBtnEl.title = '保留选中节点祖先路径展开，其他分支折叠';
    subagentTreeFocusPathBtnEl.addEventListener('click', () => expandSelectedSubagentPath());

    const refresh = document.createElement('button');
    refresh.className = 'icon ghost';
    refresh.type = 'button';
    refresh.title = '刷新关系树';
    refresh.setAttribute('aria-label', '刷新关系树');
    refresh.innerHTML = '<span class="codicon codicon-refresh"></span>';
    refresh.addEventListener('click', () => renderSubagentTree());

    controls.appendChild(subagentTreeScopeEl);
    controls.appendChild(subagentTreeStatusEl);
    controls.appendChild(collapseAllBtn);
    controls.appendChild(expandAllBtn);
    controls.appendChild(subagentTreeFocusPathBtnEl);
    header.appendChild(title);
    header.appendChild(subagentTreeStatsEl);
    header.appendChild(controls);
    header.appendChild(refresh);

    subagentTreeListEl = document.createElement('div');
    subagentTreeListEl.className = 'subagentTreeList';

    subagentTreeDetailEl = document.createElement('div');
    subagentTreeDetailEl.className = 'subagentTreeDetail';
    subagentTreeDetailEl.textContent = '选择节点后可查看事件详情并执行跳转。';

    subagentTreeWrapEl.appendChild(header);
    subagentTreeWrapEl.appendChild(subagentTreeListEl);
    subagentTreeWrapEl.appendChild(subagentTreeDetailEl);

    sceneWrapEl = document.createElement('div');
    sceneWrapEl.className = 'sceneState';

    const sceneHeader = document.createElement('div');
    sceneHeader.className = 'sceneStateHeader';
    sceneHeader.textContent = 'SCENE STATE (MVP)';

    sceneSummaryEl = document.createElement('div');
    sceneSummaryEl.className = 'sceneStateSummary';

    sceneListEl = document.createElement('div');
    sceneListEl.className = 'sceneStateList';

    sceneWrapEl.appendChild(sceneHeader);
    sceneWrapEl.appendChild(sceneSummaryEl);
    sceneWrapEl.appendChild(sceneListEl);
    subagentTreeWrapEl.appendChild(sceneWrapEl);

    replayWrapEl = document.createElement('div');
    replayWrapEl.className = 'replayConsole';

    const replayHeader = document.createElement('div');
    replayHeader.className = 'replayHeader';
    replayHeader.textContent = 'REPLAY (MVP)';

    const replayInputs = document.createElement('div');
    replayInputs.className = 'replayInputs';

    replaySessionInputEl = document.createElement('input');
    replaySessionInputEl.className = 'replayInput';
    replaySessionInputEl.placeholder = 'sessionId';

    replayTraceInputEl = document.createElement('input');
    replayTraceInputEl.className = 'replayInput';
    replayTraceInputEl.placeholder = 'traceId';

    const replayLoadBtn = document.createElement('button');
    replayLoadBtn.type = 'button';
    replayLoadBtn.className = 'replayAction ghost';
    replayLoadBtn.textContent = 'Load';
    replayLoadBtn.addEventListener('click', () => loadReplayRecords());

    replayInputs.appendChild(replaySessionInputEl);
    replayInputs.appendChild(replayTraceInputEl);
    replayInputs.appendChild(replayLoadBtn);

    const replayControls = document.createElement('div');
    replayControls.className = 'replayControls';

    replayPlayBtnEl = document.createElement('button');
    replayPlayBtnEl.type = 'button';
    replayPlayBtnEl.className = 'replayAction ghost';
    replayPlayBtnEl.textContent = 'Play';
    replayPlayBtnEl.addEventListener('click', () => {
      if (!replayState.records.length) {
        loadReplayRecords();
        if (!replayState.records.length) return;
      }
      if (replayState.playing) {
        stopReplayTimer();
        emitReplayControl('pause', {
          cursor: replayState.cursor,
          sessionId: replayState.loadedSessionId,
          traceId: replayState.loadedTraceId
        });
      } else {
        replayState.playing = true;
        emitReplayControl(replayHostState.active && replayHostState.locked ? 'resume' : 'play', {
          cursor: replayState.cursor,
          sessionId: replayState.loadedSessionId,
          traceId: replayState.loadedTraceId
        });
      }
      renderReplayConsole();
    });

    replayStopBtnEl = document.createElement('button');
    replayStopBtnEl.type = 'button';
    replayStopBtnEl.className = 'replayAction ghost';
    replayStopBtnEl.textContent = 'Stop';
    replayStopBtnEl.addEventListener('click', () => {
      stopReplayTimer();
      replayState.cursor = 0;
      emitReplayControl('stop', {
        sessionId: replayState.loadedSessionId,
        traceId: replayState.loadedTraceId
      });
      uiAction('requestSubagentTree');
      renderReplayConsole();
    });

    const cadenceWrap = document.createElement('label');
    cadenceWrap.className = 'replayCadence';
    cadenceWrap.textContent = 'cadence';

    replayCadenceInputEl = document.createElement('input');
    replayCadenceInputEl.type = 'number';
    replayCadenceInputEl.min = '250';
    replayCadenceInputEl.max = '3000';
    replayCadenceInputEl.step = '50';
    replayCadenceInputEl.className = 'replayCadenceInput';
    replayCadenceInputEl.value = String(replayHostState.cadenceMs || 850);
    replayCadenceInputEl.title = '回放节拍（毫秒）';
    replayCadenceInputEl.addEventListener('change', () => {
      const raw = Number(replayCadenceInputEl?.value || '850');
      const nextMs = Number.isFinite(raw) ? Math.max(250, Math.min(3000, Math.floor(raw))) : 850;
      replayHostState.cadenceMs = nextMs;
      if (replayCadenceInputEl) replayCadenceInputEl.value = String(nextMs);
      emitReplayControl('config', {
        cursor: replayState.cursor,
        sessionId: replayState.loadedSessionId,
        traceId: replayState.loadedTraceId,
        cadenceMs: nextMs
      });
      renderReplayConsole();
    });
    cadenceWrap.appendChild(replayCadenceInputEl);

    replayScrubEl = document.createElement('input');
    replayScrubEl.type = 'range';
    replayScrubEl.min = '0';
    replayScrubEl.max = '0';
    replayScrubEl.value = '0';
    replayScrubEl.className = 'replayScrub';
    replayScrubEl.addEventListener('input', () => {
      replayState.cursor = Number(replayScrubEl?.value || '0');
      stopReplayTimer();
      emitReplayControl('scrub', {
        cursor: replayState.cursor,
        sessionId: replayState.loadedSessionId,
        traceId: replayState.loadedTraceId
      });
      const row = replayState.records[replayState.cursor];
      if (row?.node) {
        jumpToSubagentEvent(row.node, {
          silent: !!replayHostState.active,
          source: replayHostState.active ? 'replay-scrub' : 'subagent-tree-live'
        });
      }
      renderReplayConsole();
    });

    replayControls.appendChild(replayPlayBtnEl);
    replayControls.appendChild(replayStopBtnEl);
    replayControls.appendChild(cadenceWrap);
    replayControls.appendChild(replayScrubEl);

    replayHintEl = document.createElement('div');
    replayHintEl.className = 'replayHint';

    replayListEl = document.createElement('div');
    replayListEl.className = 'replayList';

    replayWrapEl.appendChild(replayHeader);
    replayWrapEl.appendChild(replayInputs);
    replayWrapEl.appendChild(replayControls);
    replayWrapEl.appendChild(replayHintEl);
    replayWrapEl.appendChild(replayListEl);

    subagentTreeWrapEl.appendChild(replayWrapEl);
    sessionsEl.appendChild(subagentTreeWrapEl);
    renderSceneStatePanel();
    renderReplayConsole();
    return subagentTreeWrapEl;
  }

  function renderSceneStatePanel() {
    if (!sceneSummaryEl || !sceneListEl) return;
    const machine = String(sceneState.machineState || 'idle');
    const reason = String(sceneState.reason || 'n/a');
    const transition = String(sceneState.transition || 'n/a');
    const latestSeq = Number.isFinite(Number(sceneState.latestEventSeq)) ? Number(sceneState.latestEventSeq) : 0;
    const stations = Array.isArray(sceneState.workstations) ? sceneState.workstations : [];
    const toolEntries = Array.from(sceneToolInvocations.entries()).map(([invocationId, info]) => ({
        id: invocationId,
        label: String(info?.toolName || 'tool'),
        status: String(info?.status || 'started'),
        atMs: Number(info?.atMs || 0)
      }));
    const failedTools = toolEntries
      .filter((item) => item.status === 'failed')
      .sort((a, b) => Number(b?.atMs || 0) - Number(a?.atMs || 0));
    const recentNonFailed = toolEntries
      .filter((item) => item.status !== 'failed')
      .sort((a, b) => Number(b?.atMs || 0) - Number(a?.atMs || 0))
      .slice(0, 6);
    const toolRows = [...failedTools, ...recentNonFailed];
    sceneSummaryEl.textContent = `machine=${machine} · reason=${reason} · transition=${transition} · seq=${latestSeq} · stations=${stations.length}`;

    sceneListEl.innerHTML = '';
    if (!stations.length) {
      const empty = document.createElement('div');
      empty.className = 'sceneStateEmpty';
      empty.textContent = '暂无工位映射（等待事件）。';
      sceneListEl.appendChild(empty);
    }

    if (stations.length) {
      for (const station of stations.slice(0, 8)) {
        const row = document.createElement('div');
        const recovered = !!station?.recovered;
        const focusHit = sceneFocus.kind === String(station?.kind || 'subagent') && sceneFocus.id === String(station?.eventId || station?.id || '');
        row.className = `sceneStateRow is-${String(station?.state || 'idle')}${recovered ? ' is-recovered' : ''}${focusHit ? ' is-focused' : ''}`;
        row.textContent = `${String(station?.label || station?.id || 'station')} · ${String(station?.state || 'idle')}${recovered ? ' · recovered' : ''}`;
        row.title = [
          `kind=${String(station?.kind || 'subagent')}`,
          `event=${String(station?.eventId || '-')}`,
          `seq=${String(station?.eventSeq ?? '-')}`,
          `mappingKey=${String(station?.mappingKey || '-')}`,
          `session=${String(station?.sessionId || '-')}`,
          `trace=${String(station?.traceId || '-')}`
        ].join(' | ');
        row.addEventListener('click', () => {
          if (String(station?.kind || '') === 'approval') {
            focusTimelineApproval(String(station?.eventId || station?.id || ''));
            return;
          }
          const nodeId = String(station?.nodeId || '').trim();
          if (!nodeId) return;
          const node = (Array.isArray(subagentTreeNodes) ? subagentTreeNodes : []).find((n) => String(n?.id || '') === nodeId);
          if (node) jumpToSubagentEvent(node, { silent: false, source: 'scene-panel' });
        });
        sceneListEl.appendChild(row);
      }
    }

    for (const tool of toolRows) {
      const focusHit = sceneFocus.kind === 'tool' && sceneFocus.id === String(tool.id);
      const row = document.createElement('div');
      row.className = `sceneStateRow is-tool is-${String(tool.status || 'started')}${focusHit ? ' is-focused' : ''}`;
      row.textContent = `[tool] ${String(tool.label || tool.id)} · ${String(tool.status || 'started')}`;
      row.title = `invocationId=${String(tool.id)}`;
      row.addEventListener('click', () => focusTimelineToolInvocation(String(tool.id)));
      sceneListEl.appendChild(row);
    }
  }

  function flattenSubagentNodes(nodes, parentId, depth, out) {
    const pid = parentId == null ? null : String(parentId);
    for (const node of nodes) {
      const npid = node?.parentId == null ? null : String(node.parentId);
      if (npid !== pid) continue;
      out.push({ node, depth });
      if (isSubagentNodeCollapsed(node)) continue;
      flattenSubagentNodes(nodes, String(node.id), depth + 1, out);
    }
  }

  function setSubagentDetail(node) {
    if (!subagentTreeDetailEl || !node) return;
    const active = (Array.isArray(sessionState.sessions) ? sessionState.sessions : []).find((s) => !!s?.isActive);
    const activeSessionId = active?.sessionId ? String(active.sessionId) : '';
    const nodeSessionId = node?.sessionId ? String(node.sessionId) : '';
    const source = nodeSessionId && activeSessionId && nodeSessionId === activeSessionId ? 'current' : 'history';
    const lines = [
      ['label', node?.label],
      ['status', node?.status],
      ['source', source],
      ['session', node?.sessionId],
      ['trace', node?.traceId],
      ['event', node?.eventId],
      ['node', node?.id]
    ];
    subagentTreeDetailEl.innerHTML = lines
      .map(([k, v]) => `<div><strong>${k}</strong>: ${escapeHtml(String(v ?? '-'))}</div>`)
      .join('');
  }

  function filterSubagentNodes(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const active = (Array.isArray(sessionState.sessions) ? sessionState.sessions : []).find((s) => !!s?.isActive);
    const activeSessionId = active?.sessionId ? String(active.sessionId) : '';

    const byScope = list.filter((node) => {
      const sid = node?.sessionId ? String(node.sessionId) : '';
      const isCurrent = !!sid && !!activeSessionId && sid === activeSessionId;
      if (subagentTreeScope === 'current') return isCurrent;
      if (subagentTreeScope === 'history') return !isCurrent;
      return true;
    });

    if (subagentTreeStatus === 'all') return byScope;
    return byScope.filter((node) => String(node?.status || '') === subagentTreeStatus || String(node?.type || '') === 'main');
  }

  function applySubagentStatusFilter(nextStatus) {
    const allowed = new Set(['all', 'working', 'done', 'error']);
    const status = allowed.has(String(nextStatus || '')) ? String(nextStatus) : 'all';
    subagentTreeStatus = status;
    if (subagentTreeStatusEl) subagentTreeStatusEl.value = status;
    renderSubagentTree();
  }

  function stopReplayTimer() {
    replayState.playing = false;
  }

  function getReplayRecords(args) {
    const sid = String(args?.sessionId || '').trim();
    const tid = String(args?.traceId || '').trim();
    const list = Array.isArray(subagentTreeNodes) ? subagentTreeNodes : [];
    const rows = [];
    let sourceIndex = 0;
    for (const node of list) {
      if (String(node?.type || '') !== 'subagent') continue;
      const nodeSid = String(node?.sessionId || '').trim();
      const nodeTid = String(node?.traceId || '').trim();
      if (sid && nodeSid !== sid) continue;
      if (tid && nodeTid !== tid) continue;
      const eventId = String(node?.eventId || '').trim();
      if (!eventId) continue;
      const explicitSeq = Number(node?.eventSeq);
      const seqMatch = eventId.match(/_(\d+)$/);
      const seqFromEventId = seqMatch ? Number(seqMatch[1]) : Number.NaN;
      const seq = Number.isFinite(explicitSeq)
        ? Math.max(0, Math.floor(explicitSeq))
        : Number.isFinite(seqFromEventId)
          ? Math.max(0, Math.floor(seqFromEventId))
          : Number.MAX_SAFE_INTEGER;
      rows.push({
        node,
        sessionId: nodeSid,
        traceId: nodeTid,
        eventId,
        status: String(node?.status || 'unknown'),
        seq,
        sourceIndex
      });
      sourceIndex += 1;
    }
    rows.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
      if (a.traceId !== b.traceId) return a.traceId.localeCompare(b.traceId);
      if (a.eventId !== b.eventId) return a.eventId.localeCompare(b.eventId);
      const aid = String(a?.node?.id || '');
      const bid = String(b?.node?.id || '');
      if (aid !== bid) return aid.localeCompare(bid);
      return a.sourceIndex - b.sourceIndex;
    });
    return rows;
  }

  function renderReplayConsole() {
    if (!replayListEl || !replayScrubEl || !replayPlayBtnEl || !replayHintEl) return;
    const rows = replayState.records;
    const max = Math.max(0, rows.length - 1);
    replayScrubEl.max = String(max);
    replayScrubEl.value = String(Math.min(max, Math.max(0, replayState.cursor || 0)));
    replayScrubEl.disabled = rows.length === 0;
    replayPlayBtnEl.disabled = rows.length <= 1;
    if (replayStopBtnEl) replayStopBtnEl.disabled = !replayHostState.active;
    replayPlayBtnEl.textContent = replayState.playing
      ? 'Pause'
      : replayHostState.active && replayHostState.locked
        ? 'Resume'
        : 'Play';
    replayHintEl.textContent = rows.length
      ? `records=${rows.length} · cursor=${Math.min(rows.length, replayState.cursor + 1)}/${rows.length} · cadence=${replayHostState.cadenceMs}ms`
      : '未加载回放记录。请输入 sessionId/traceId 后点击 Load。';

    replayListEl.innerHTML = '';
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `replayRow${i === replayState.cursor ? ' isActive' : ''}`;
      item.textContent = `${row.eventId} · ${row.node?.label || row.node?.id || 'node'} · ${row.status}`;
      item.title = `session=${row.sessionId} trace=${row.traceId}`;
      item.addEventListener('click', () => {
        replayState.cursor = i;
        stopReplayTimer();
        emitReplayControl('scrub', {
          cursor: replayState.cursor,
          sessionId: replayState.loadedSessionId,
          traceId: replayState.loadedTraceId
        });
        jumpToSubagentEvent(row.node, {
          silent: !!replayHostState.active,
          source: replayHostState.active ? 'replay-select' : 'subagent-tree-live'
        });
        renderReplayConsole();
      });
      replayListEl.appendChild(item);
    }
  }

  function loadReplayRecords() {
    const sid = String(replaySessionInputEl?.value || '').trim();
    const tid = String(replayTraceInputEl?.value || '').trim();
    replayState.records = getReplayRecords({ sessionId: sid, traceId: tid });
    replayState.cursor = 0;
    replayState.loadedSessionId = sid;
    replayState.loadedTraceId = tid;
    stopReplayTimer();
    if (!replayState.records.length) {
      emitReplayControl('stop', { sessionId: sid, traceId: tid });
      uiAction('requestSubagentTree');
      renderReplayConsole();
      return;
    }
    emitReplayControl('load', {
      cursor: replayState.cursor,
      sessionId: sid,
      traceId: tid
    });
    renderReplayConsole();
  }

  function jumpToSubagentEvent(node, options) {
    if (!node) return;
    const silent = !!options?.silent;
    const source = String(options?.source || 'subagent-tree-live');
    selectedSubagentNodeId = String(node.id);
    setSubagentDetail(node);
    uiAction('jumpToSubagentEvent', {
      nodeId: node.id,
      eventId: node.eventId,
      traceId: node.traceId,
      sessionId: node.sessionId,
      status: node.status,
      source,
      silent
    });
    renderSubagentTree();
  }

  function renderSubagentTree() {
    ensureSubagentTreePanel();
    if (!subagentTreeListEl) return;

    const scopeOnlyNodes = (() => {
      const list = Array.isArray(subagentTreeNodes) ? subagentTreeNodes : [];
      const active = (Array.isArray(sessionState.sessions) ? sessionState.sessions : []).find((s) => !!s?.isActive);
      const activeSessionId = active?.sessionId ? String(active.sessionId) : '';
      return list.filter((node) => {
        const sid = node?.sessionId ? String(node.sessionId) : '';
        const isCurrent = !!sid && !!activeSessionId && sid === activeSessionId;
        if (subagentTreeScope === 'current') return isCurrent;
        if (subagentTreeScope === 'history') return !isCurrent;
        return true;
      });
    })();

    const nodes = filterSubagentNodes(subagentTreeNodes);
    const counters = { working: 0, done: 0, error: 0 };
    for (const node of scopeOnlyNodes) {
      if (String(node?.type || '') !== 'subagent') continue;
      const st = String(node?.status || '');
      if (st === 'working' || st === 'done' || st === 'error') counters[st] += 1;
    }
    if (subagentTreeStatsEl) {
      const items = [
        { key: 'working', label: `W:${counters.working}`, title: '过滤进行中节点' },
        { key: 'done', label: `D:${counters.done}`, title: '过滤已完成节点' },
        { key: 'error', label: `E:${counters.error}`, title: '过滤异常节点' }
      ];
      subagentTreeStatsEl.innerHTML = '';
      for (const item of items) {
        const active = subagentTreeStatus === item.key;
        const btn = document.createElement('button');
        btn.className = `subagentTreeStat ghost${active ? ' isActive' : ''}`;
        btn.type = 'button';
        btn.textContent = item.label;
        btn.title = active ? '再次点击恢复全部状态' : item.title;
        btn.addEventListener('click', () => applySubagentStatusFilter(active ? 'all' : item.key));
        subagentTreeStatsEl.appendChild(btn);
      }
    }

    const selectedId = String(selectedSubagentNodeId || '').trim();
    const selectedVisible = !!selectedId && nodes.some((node) => String(node?.id || '') === selectedId);
    const selectedNode = selectedVisible ? nodes.find((node) => String(node?.id || '') === selectedId) : null;
    if (subagentTreeFocusPathBtnEl) {
      subagentTreeFocusPathBtnEl.disabled = !selectedVisible;
      subagentTreeFocusPathBtnEl.title = selectedVisible
        ? '保留选中节点祖先路径展开，其他分支折叠'
        : '请先选中当前过滤范围内的一个节点';
    }

    if (selectedNode) {
      if (replaySessionInputEl && !String(replaySessionInputEl.value || '').trim()) replaySessionInputEl.value = String(selectedNode.sessionId || '');
      if (replayTraceInputEl && !String(replayTraceInputEl.value || '').trim()) replayTraceInputEl.value = String(selectedNode.traceId || '');
    }

    const nodeIds = new Set(nodes.map((node) => String(node?.id || '')).filter(Boolean));
    const parentIds = new Set(getCollapsibleSubagentNodeIds(nodes));

    const validBySession = new Map();
    for (const node of nodes) {
      const key = getNodeSessionKey(node);
      if (!validBySession.has(key)) validBySession.set(key, new Set());
      validBySession.get(key).add(String(node?.id || ''));
    }
    for (const [key, set] of collapsedSubagentNodeIdsBySession.entries()) {
      const valid = validBySession.get(key);
      if (!valid) {
        collapsedSubagentNodeIdsBySession.delete(key);
        continue;
      }
      for (const id of Array.from(set)) {
        if (!valid.has(id) || !nodeIds.has(id)) set.delete(id);
      }
      if (!set.size) collapsedSubagentNodeIdsBySession.delete(key);
    }
    const ordered = [];
    flattenSubagentNodes(nodes, null, 0, ordered);

    subagentTreeListEl.innerHTML = '';
    if (!ordered.length) {
      const empty = document.createElement('div');
      empty.className = 'subagentTreeEmpty';
      empty.textContent = '暂无子代理关系数据（等待真实事件）。';
      subagentTreeListEl.appendChild(empty);
      return;
    }

    for (const item of ordered) {
      const row = document.createElement('div');
      row.className = 'subagentTreeRow';
      row.style.setProperty('--depth', String(item.depth));

      const hasChildren = parentIds.has(String(item.node.id));
      if (hasChildren) {
        const toggleBtn = document.createElement('button');
        const isCollapsed = isSubagentNodeCollapsed(item.node);
        toggleBtn.className = 'subagentTreeToggle ghost';
        toggleBtn.type = 'button';
        toggleBtn.textContent = isCollapsed ? '▸' : '▾';
        toggleBtn.title = isCollapsed ? '展开子节点' : '折叠子节点';
        toggleBtn.setAttribute('aria-label', toggleBtn.title);
        toggleBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setSubagentNodeCollapsed(item.node, !isSubagentNodeCollapsed(item.node));
          renderSubagentTree();
        });
        row.appendChild(toggleBtn);
      }

      const nodeBtn = document.createElement('button');
      const isSelected = String(selectedSubagentNodeId || '') === String(item.node.id);
      nodeBtn.className = `subagentTreeNode${isSelected ? ' isSelected' : ''}`;
      nodeBtn.type = 'button';
      nodeBtn.textContent = `${item.node.label} (${item.node.status})`;
      nodeBtn.title = `node=${item.node.id}`;
      nodeBtn.addEventListener('click', () => {
        selectedSubagentNodeId = String(item.node.id);
        setSubagentDetail(item.node);
        renderSubagentTree();
      });

      const jumpBtn = document.createElement('button');
      jumpBtn.className = 'subagentTreeJump ghost';
      jumpBtn.type = 'button';
      jumpBtn.textContent = '事件跳转';
      jumpBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToSubagentEvent(item.node);
      });

      row.appendChild(nodeBtn);
      row.appendChild(jumpBtn);
      subagentTreeListEl.appendChild(row);
    }

    renderReplayConsole();
  }

  function measureSessionRowHeight() {
    if (cachedSessionRowHeight) return cachedSessionRowHeight;
    if (!sessionsEl) return 44;
    const row = document.createElement('div');
    row.className = 'sessionRow';
    row.style.position = 'absolute';
    row.style.visibility = 'hidden';
    row.style.left = '-9999px';
    row.innerHTML = `
      <div class="sessionMain">
        <div class="sessionTitle">(无标题)</div>
        <div class="sessionMeta">本地 · 刚刚 · 预览</div>
      </div>
      <div class="sessionActions"></div>
    `;
    sessionsEl.appendChild(row);
    const h = Math.max(36, Math.round(row.getBoundingClientRect().height || 44));
    row.remove();
    cachedSessionRowHeight = h;
    return h;
  }

  function getRecentSessionsLimit() {
    // Sessions now live in an independent overlay with its own scrollbar,
    // so we no longer need to compete for vertical space with messages.
    // Return a generous limit; the overlay scrolls if needed.
    return 12;
  }

  // --- Sessions overlay toggle (Copilot-like) ---
  function openSessionsOverlay() {
    if (!sessionsOverlayEl) return;
    sessionsOverlayEl.classList.remove('hidden');
    setTimeout(() => {
      try { btnSessionsOverlayCloseEl?.focus(); } catch { /* ignore */ }
    }, 0);
  }

  function closeSessionsOverlay() {
    if (!sessionsOverlayEl) return;
    sessionsOverlayEl.classList.add('hidden');
  }

  function toggleSessionsOverlay() {
    if (!sessionsOverlayEl) return;
    if (sessionsOverlayEl.classList.contains('hidden')) {
      openSessionsOverlay();
    } else {
      closeSessionsOverlay();
    }
  }

  btnHistoryEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSessionsOverlay();
  });

  btnSessionsOverlayCloseEl?.addEventListener('click', () => {
    closeSessionsOverlay();
  });

  // Continue is only available when the last rendered message is assistant and we're not busy.
  // Copilot-like: after the user sends, it becomes unavailable until assistant replies.
  let lastMessageRole = null; // 'user' | 'assistant' | 'tool' | null

  // --- Minimal, safe Markdown renderer (subset, Copilot-like) ---
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHref(url) {
    const u = String(url ?? '').trim();
    if (!u) return null;
    // Allow http(s) + mailto only.
    if (/^https?:\/\//i.test(u)) return u;
    if (/^mailto:/i.test(u)) return u;
    return null;
  }

  function inlineMd(text) {
    let s = escapeHtml(text);
    // Inline code
    s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
    // Bold, italic, strike (simple)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const href = safeHref(url);
      if (!href) return `${label} (${escapeHtml(url)})`;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return s;
  }

  function renderMarkdown(markdown) {
    const src = String(markdown ?? '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    let i = 0;
    let html = '';

    const eatBlank = () => {
      while (i < lines.length && !lines[i].trim()) i++;
    };

    while (i < lines.length) {
      eatBlank();
      if (i >= lines.length) break;

      // Fenced code block (allow indentation)
      const fence = lines[i].match(/^\s*```\s*([a-z0-9_-]+)?\s*$/i);
      if (fence) {
        const lang = fence[1] ? String(fence[1]).toLowerCase() : '';
        i++;
        let code = '';
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code += lines[i] + '\n';
          i++;
        }
        if (i < lines.length && /^\s*```/.test(lines[i])) i++;
        html += `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`;
        continue;
      }

      // Heading
      const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        html += `<h${level}>${inlineMd(h[2] ?? '')}</h${level}>`;
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s+/.test(lines[i])) {
        let content = '';
        while (i < lines.length && /^>\s+/.test(lines[i])) {
          content += lines[i].replace(/^>\s+/, '') + '\n';
          i++;
        }
        html += `<blockquote>${renderMarkdown(content)}</blockquote>`;
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(lines[i])) {
        html += '<ul>';
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          const li = lines[i].replace(/^\s*[-*+]\s+/, '');
          html += `<li>${inlineMd(li)}</li>`;
          i++;
        }
        html += '</ul>';
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(lines[i])) {
        html += '<ol>';
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = lines[i].replace(/^\s*\d+\.\s+/, '');
          html += `<li>${inlineMd(li)}</li>`;
          i++;
        }
        html += '</ol>';
        continue;
      }

      // Paragraph: consume until blank line
      let para = '';
      while (i < lines.length && lines[i].trim()) {
        para += (para ? '\n' : '') + lines[i];
        i++;
      }
      html += `<p>${inlineMd(para)}</p>`;
    }

    return html;
  }

  function renderMarkdownInto(el, markdownText) {
    if (!el) return;
    el.classList.add('md');
    el.innerHTML = renderMarkdown(markdownText);
  }

  function updateContinueButton() {
    if (!btnContinueEl) return;
    const canContinue = !isBusy && lastMessageRole === 'assistant';
    btnContinueEl.disabled = !canContinue;
    btnContinueEl.setAttribute('aria-disabled', String(!canContinue));
  }

  function syncToolsMenuFromProfile() {
    if (!toolsMenuEl) return;

    const allowed = currentAllowedOptionalTools;

    const inputs = toolsMenuEl.querySelectorAll('input[type="checkbox"][data-tool]');
    for (const el of inputs) {
      const toolName = el.getAttribute('data-tool');
      if (!toolName) continue;

      // Sync checked state from backend profile.
      const shouldBeChecked = currentEnabledOptionalTools.has(toolName);
      el.checked = shouldBeChecked;

      // v0.1: no more ask-study mode restrictions
      el.disabled = false;
    }
  }

  function updateSendButton() {
    const icon = sendEl?.querySelector('span.codicon');
    if (!sendEl || !icon) return;

    if (isBusy) {
      icon.classList.remove('codicon-send');
      icon.classList.add('codicon-primitive-square');
      sendEl.classList.add('isStop');
      sendEl.title = '停止（取消本次请求）';
      sendEl.setAttribute('aria-label', 'Stop');
    } else {
      icon.classList.add('codicon-send');
      icon.classList.remove('codicon-primitive-square');
      sendEl.classList.remove('isStop');
      sendEl.title = '发送';
      sendEl.setAttribute('aria-label', 'Send');
    }

	// Make cancel more obvious by disabling input while busy.
	if (inputEl) {
		inputEl.disabled = !!isBusy;
		inputEl.setAttribute('aria-disabled', String(!!isBusy));
		inputEl.placeholder = isBusy ? '正在运行中…点击停止以取消' : defaultPlaceholder;
	}

  updateContinueButton();
  }

  function appendMessage(role, text) {
    const item = document.createElement('div');
    item.className = `msg msg-${role}`;
    const body = document.createElement('div');
    body.className = 'body';
	if (role === 'assistant') {
		renderMarkdownInto(body, text);
	} else {
		body.textContent = text;
	}
    item.appendChild(body);

    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;

	lastMessageRole = role;
	updateContinueButton();
  }

  // --- Structured response parts (Copilot-like) ---
  let currentToolGroup = null; // { item, summaryEl, listEl, count, runningCount }
  const toolInvocations = new Map(); // invocationId -> { statusEl, outputEl, rootEl }
  const sceneToolInvocations = new Map(); // invocationId -> { toolName, status, atMs }
  let sceneFocus = { kind: '', id: '' };
  let lastTodoCardEl = null;
  let pendingEditsCardByRequestId = new Map();
  let pendingEditModeByRequestId = new Map();
  let checkpointCardsById = new Map();

  function setSceneFocus(kind, id) {
    sceneFocus = { kind: String(kind || ''), id: String(id || '') };
    renderSceneStatePanel();
    sceneWrapEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function focusTimelineElement(el) {
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    el.classList.add('is-focused');
    const timerKey = '__focusTimer';
    const prev = el[timerKey];
    if (prev) clearTimeout(prev);
    el[timerKey] = setTimeout(() => {
      el.classList.remove('is-focused');
      el[timerKey] = 0;
    }, 1300);
  }

  function focusTimelineToolInvocation(invocationId) {
    const id = String(invocationId || '').trim();
    if (!id) return;
    const hit = toolInvocations.get(id);
    const fallback = messagesEl?.querySelector?.(`.toolInvocation[data-invocation-id="${CSS.escape(id)}"]`) || null;
    const rootEl = hit?.rootEl || fallback;
    if (!rootEl) return;
    if (rootEl.tagName?.toLowerCase?.() === 'details') rootEl.open = true;
    focusTimelineElement(rootEl);
  }

  function focusTimelineApproval(requestId) {
    const id = String(requestId || '').trim();
    if (!id) return;
    const card = pendingEditsCardByRequestId.get(id)
      || messagesEl?.querySelector?.(`.msg-part-edits[data-request-id="${CSS.escape(id)}"]`)
      || null;
    if (!card) return;
    focusTimelineElement(card);
  }

  function appendCheckpointCard(checkpointIdRaw) {
    const checkpointId = String(checkpointIdRaw || '').trim();
    if (!checkpointId) return;
    if (checkpointCardsById.has(checkpointId)) return;

    const handleRestoreClick = async () => {
      if (isBusy) {
        await showAlertModal({
          title: '无法还原',
          message: '正在运行中，无法还原。请先点击“停止”取消当前请求。',
          okText: '知道了'
        });
        return;
      }

      const ok = await showConfirmModal({
        title: '还原检查点',
        message: '还原检查点将撤销此点之后的所有工作区修改，并将聊天还原到此点。\n\n确定要继续吗？',
        confirmText: '还原',
        cancelText: '取消'
      });
      if (!ok) return;
      vscode.postMessage({ type: 'checkpointAction', action: 'restore', checkpointId });
    };

    const item = document.createElement('div');
    item.className = 'msg msg-checkpoint';

    const body = document.createElement('div');
    body.className = 'body';

    const divider = document.createElement('div');
    divider.className = 'checkpointDivider';
    divider.dataset.checkpointId = checkpointId;

    const iconBtn = document.createElement('button');
    iconBtn.type = 'button';
    iconBtn.className = 'checkpointIconBtn';
    iconBtn.title = '还原检查点';
    iconBtn.setAttribute('aria-label', '还原检查点');
    iconBtn.addEventListener('click', handleRestoreClick);

    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('class', 'checkpointIcon');
    iconSvg.setAttribute('viewBox', '0 0 24 24');
    iconSvg.setAttribute('fill', 'currentColor');
    iconSvg.setAttribute('aria-hidden', 'true');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    iconPath.setAttribute('d', 'M7 3h10a2 2 0 0 1 2 2v16l-7-4-7 4V5a2 2 0 0 1 2-2z');
    iconPath.setAttribute('fill', 'currentColor');
    iconSvg.appendChild(iconPath);
    iconBtn.appendChild(iconSvg);

    const line = document.createElement('div');
    line.className = 'checkpointLine';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'checkpointPill';
    pill.textContent = '还原检查点';
    pill.addEventListener('click', handleRestoreClick);

    divider.appendChild(iconBtn);
    divider.appendChild(line);
    divider.appendChild(pill);

    body.appendChild(divider);
    item.appendChild(body);

    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    checkpointCardsById.set(checkpointId, item);
  }

  function appendPartContainer({ kind, title }) {
    const item = document.createElement('div');
    item.className = `msg msg-part msg-part-${kind}`;

    const badge = document.createElement('div');
    badge.className = 'badge';
    badge.textContent = '';

    const body = document.createElement('div');
    body.className = 'body body-rich';

    if (title) {
      const h = document.createElement('div');
      h.className = 'partTitle';
      h.textContent = title;
      body.appendChild(h);
    }

    item.appendChild(badge);
    item.appendChild(body);
    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return { item, body };
  }

  function ensureToolGroup() {
    if (currentToolGroup && currentToolGroup.item && messagesEl.contains(currentToolGroup.item)) {
      return currentToolGroup;
    }

    const { item, body } = appendPartContainer({ kind: 'tools', title: null });
    const details = document.createElement('details');
    details.className = 'toolGroup';
    details.open = false; // Copilot-like: collapsed by default

    const summary = document.createElement('summary');
    summary.className = 'toolGroupSummary';
    summary.textContent = '工具调用';
    details.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'toolGroupList';
    details.appendChild(list);

    body.appendChild(details);

    currentToolGroup = { item, detailsEl: details, summaryEl: summary, listEl: list, count: 0, runningCount: 0 };
    return currentToolGroup;
  }

  function updateToolGroupSummary() {
    if (!currentToolGroup) return;
    const { count, runningCount } = currentToolGroup;
    const running = runningCount > 0;
    currentToolGroup.summaryEl.textContent = running
      ? `正在调用工具（${count}）`
      : `已调用工具（${count}）`;
  }

  function onToolInvocationBegin(msg) {
    const g = ensureToolGroup();
    g.count++;
    g.runningCount++;
    updateToolGroupSummary();

    const id = String(msg.invocationId || '');

    const root = document.createElement('details');
    root.className = 'toolInvocation';
    root.open = false;
    root.dataset.invocationId = id;

    const summary = document.createElement('summary');
    summary.className = 'toolInvocationSummary';
    summary.addEventListener('click', () => {
      if (!id) return;
      setSceneFocus('tool', id);
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'toolName';
    nameEl.textContent = String(msg.toolName || 'tool');

    const statusEl = document.createElement('span');
    statusEl.className = 'toolStatus toolStatus-running';
    statusEl.textContent = '运行中';

    summary.appendChild(nameEl);
    summary.appendChild(statusEl);
    root.appendChild(summary);

    if (msg.inputPreview) {
      const pre = document.createElement('pre');
      pre.className = 'toolCode toolInput';
      pre.textContent = String(msg.inputPreview);
      root.appendChild(pre);
    }

    const out = document.createElement('pre');
    out.className = 'toolCode toolOutput';
    out.textContent = '';
    root.appendChild(out);

    g.listEl.appendChild(root);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (id) toolInvocations.set(id, { statusEl, outputEl: out, rootEl: root });
    if (id) {
      sceneToolInvocations.set(id, {
        toolName: String(msg.toolName || 'tool'),
        status: 'started',
        atMs: Date.now()
      });
      renderSceneStatePanel();
    }
  }

  function onToolInvocationEnd(msg) {
    const id = String(msg.invocationId || '');
    const record = id ? toolInvocations.get(id) : null;
    const ok = !!msg.ok;
    const durationMs = typeof msg.durationMs === 'number' ? msg.durationMs : null;

    if (record) {
      record.statusEl.classList.remove('toolStatus-running');
      record.statusEl.classList.add(ok ? 'toolStatus-ok' : 'toolStatus-error');
      record.rootEl?.classList?.toggle('is-failed', !ok);
      record.statusEl.textContent = ok
        ? (durationMs != null ? `完成（${Math.round(durationMs)}ms）` : '完成')
        : (durationMs != null ? `失败（${Math.round(durationMs)}ms）` : '失败');

      if (msg.outputFull || msg.outputPreview) {
        record.outputEl.textContent = String(msg.outputFull || msg.outputPreview || '');
      }
    }

    if (currentToolGroup) {
      currentToolGroup.runningCount = Math.max(0, (currentToolGroup.runningCount || 0) - 1);
      updateToolGroupSummary();
    }

    if (id) {
      const prev = sceneToolInvocations.get(id);
      sceneToolInvocations.set(id, {
        toolName: String(msg.toolName || prev?.toolName || 'tool'),
        status: ok ? 'finished' : 'failed',
        atMs: Date.now()
      });
      if (!ok) {
        setSceneFocus('tool', id);
      }
      renderSceneStatePanel();
    }
  }

  function renderTodoList(todoList, note) {
    const items = Array.isArray(todoList) ? todoList : [];
    if (!items.length) return;

  const total = items.length;
  const done = items.filter((t) => String(t.status) === 'completed').length;

    let card = lastTodoCardEl;
    if (!card || !messagesEl.contains(card)) {
    const created = appendPartContainer({ kind: 'todo', title: null });
      card = created.item;
      card._todoBody = created.body;
    // Copilot-like: collapsible Todos card with counts.
    const details = document.createElement('details');
    details.className = 'todoGroup';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'todoGroupSummary';
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'todoGroupList';
    details.appendChild(list);
    created.body.appendChild(details);
    card._todoDetails = details;
    card._todoSummary = summary;
    card._todoList = list;
      lastTodoCardEl = card;
    }

  if (card._todoSummary) {
    card._todoSummary.textContent = `Todos (${done}/${total})`;
  }

  const list = card._todoList || card.querySelector('.todoGroupList');
  if (!list) return;
  list.innerHTML = '';

    if (note) {
      const n = document.createElement('div');
      n.className = 'todoNote';
      n.textContent = String(note);
    list.appendChild(n);
    }

    for (const t of items) {
      const row = document.createElement('div');
    row.className = 'todoItem';

    const icon = document.createElement('span');
    const st = String(t.status ?? 'not-started');
    icon.className =
      'codicon ' +
      (st === 'completed'
        ? 'codicon-pass todoIcon todoIcon-done'
        : st === 'in-progress'
          ? 'codicon-sync todoIcon todoIcon-progress'
          : 'codicon-circle-large-outline todoIcon todoIcon-todo');
    row.appendChild(icon);

      const title = document.createElement('div');
      title.className = 'todoItemTitle';
    title.textContent = `${String(t.id ?? '')}. ${String(t.title ?? '')}`.trim();

      const status = document.createElement('span');
      status.className = 'todoItemStatus';
    status.textContent =
    st === 'completed' ? '已完成' : st === 'in-progress' ? '进行中' : '未开始';
      title.appendChild(status);
      row.appendChild(title);

      if (t.description) {
        const desc = document.createElement('div');
        desc.className = 'todoItemDesc';
        desc.textContent = String(t.description);
        row.appendChild(desc);
      }

      list.appendChild(row);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function upsertPendingEditsCard(msg) {
    const requestId = String(msg.requestId || '');
    if (!requestId) return;
	const mode = String(msg.mode || 'approval');
    let card = pendingEditsCardByRequestId.get(requestId);
    if (!card || !messagesEl.contains(card)) {
	  const title = mode === 'review' ? '已应用的更改' : '待确认的更改';
	  const created = appendPartContainer({ kind: 'edits', title });
      card = created.item;
      card._editsBody = created.body;
      pendingEditsCardByRequestId.set(requestId, card);
    }
	pendingEditModeByRequestId.set(requestId, mode);
  card.classList.remove('timelineApproval-request', 'timelineApproval-resolved');
  card.classList.add(mode === 'review' ? 'timelineApproval-resolved' : 'timelineApproval-request');
  card.dataset.requestId = requestId;
  card.onclick = () => setSceneFocus('approval', requestId);
    const body = card._editsBody || card.querySelector('.body');
    if (!body) return;
    while (body.children.length > 1) body.removeChild(body.lastChild);

    const summary = document.createElement('div');
    summary.className = 'editsSummary';
    summary.textContent = String(msg.summary || '有待审批的修改');
    body.appendChild(summary);

    const files = Array.isArray(msg.files) ? msg.files : [];
    if (files.length) {
      const list = document.createElement('div');
      list.className = 'editsFiles';
      list.textContent = files.map((f) => `• ${f.relativePath} (${f.editCount})`).join('\n');
      body.appendChild(list);
    }

  const diffStats = msg.diffStats;
  if (diffStats && typeof diffStats === 'object') {
    const filesChanged = Number(diffStats.filesChanged ?? files.length);
    const additions = Number(diffStats.additions ?? 0);
    const deletions = Number(diffStats.deletions ?? 0);
    const stat = document.createElement('div');
    stat.className = 'editsStatLine';
    stat.textContent = `${filesChanged} files changed  +${additions}  -${deletions}`;
    body.appendChild(stat);
  }

  const actions = document.createElement('div');
  actions.className = 'editsActions';

  const btnPreview = document.createElement('button');
  btnPreview.className = 'ghost';
  btnPreview.type = 'button';
	btnPreview.textContent = '预览';
  btnPreview.disabled = !msg.canPreview;
  btnPreview.addEventListener('click', () => {
    if (mode === 'review') {
      sendEditReview(requestId, 'preview');
    } else {
      currentApprovalRequestId = requestId;
      sendApproval('preview');
    }
  });
  actions.appendChild(btnPreview);

  if (mode === 'review') {
    const btnUndo = document.createElement('button');
    btnUndo.className = 'ghost';
    btnUndo.type = 'button';
	  btnUndo.textContent = '撤销';
    btnUndo.addEventListener('click', () => {
      sendEditReview(requestId, 'undo');
    });

    const btnKeep = document.createElement('button');
    btnKeep.type = 'button';
	  btnKeep.textContent = '保留';
    btnKeep.addEventListener('click', () => {
      sendEditReview(requestId, 'keep');
    });

	  actions.appendChild(btnKeep);
	  actions.appendChild(btnUndo);
  } else {
    const btnApply = document.createElement('button');
    btnApply.type = 'button';
	  btnApply.textContent = '应用';
    btnApply.addEventListener('click', () => {
      currentApprovalRequestId = requestId;
      sendApproval('apply');
    });

    const btnCancel = document.createElement('button');
    btnCancel.className = 'ghost';
    btnCancel.type = 'button';
	  btnCancel.textContent = '取消';
    btnCancel.addEventListener('click', () => {
      currentApprovalRequestId = requestId;
      sendApproval('cancel');
    });

    actions.appendChild(btnApply);
    actions.appendChild(btnCancel);
  }

  body.appendChild(actions);
  }

  let streamingAssistantBodyEl = null;
	let streamingAssistantMarkdown = '';

  function startAssistantStream(initialText) {
    // If a stream is already active, keep appending into it.
    if (streamingAssistantBodyEl) {
      if (typeof initialText === 'string' && initialText.length) {
			streamingAssistantMarkdown = initialText;
			streamingAssistantBodyEl.textContent = initialText;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      return;
    }

    const item = document.createElement('div');
    item.className = 'msg msg-assistant';

    const body = document.createElement('div');
    body.className = 'body';
  item.appendChild(body);
  messagesEl.appendChild(item);

  streamingAssistantBodyEl = body;
  streamingAssistantMarkdown = typeof initialText === 'string' ? initialText : '';
  // While streaming, keep plaintext; finalize to markdown on end.
  body.textContent = streamingAssistantMarkdown;
  messagesEl.scrollTop = messagesEl.scrollHeight;

  lastMessageRole = 'assistant';
  updateContinueButton();
  }

  function appendAssistantDelta(delta) {
    if (!streamingAssistantBodyEl) {
      startAssistantStream('');
    }
	streamingAssistantMarkdown = (streamingAssistantMarkdown || '') + String(delta || '');
	streamingAssistantBodyEl.textContent = streamingAssistantMarkdown;
    messagesEl.scrollTop = messagesEl.scrollHeight;

	lastMessageRole = 'assistant';
	updateContinueButton();
  }

  function setStatus(status, detail) {
    const map = {
      idle: '',
      thinking: 'Thinking…',
      'running-tools': 'Running tools…',
      error: 'Error'
    };
    const base = map[status] ?? '';
    statusEl.textContent = detail ? `${base} ${detail}` : base;

    isBusy = status === 'thinking' || status === 'running-tools';
    updateSendButton();
    updateContinueButton();
    renderSubagentTree();
    if (!replayHostState.active) uiAction('requestSubagentTree');
  }

  function sendCurrent() {
    const text = (inputEl.value || '').trim();
    if (!text) return;
	// Copilot-like: any new user input dismisses the redo-after-restore offer.
	hideRedoOffer();
    inputEl.value = '';
    autoResize();
	// Copilot-like: after sending a user message, Continue becomes unavailable immediately.
	lastMessageRole = 'user';
	updateContinueButton();
    vscode.postMessage({ type: 'chatUserMessage', text });
  }

  function uiAction(action, payload) {
    // Add a client-side timestamp for end-to-end latency debugging.
    vscode.postMessage({ type: 'uiAction', action, payload: payload ?? null, clientTs: Date.now() });
  }

  function autoResize() {
    // Copilot Chat-style grow up to a max height.
    inputEl.style.height = 'auto';
    const max = 160;
    const next = Math.min(inputEl.scrollHeight, max);
    inputEl.style.height = `${next}px`;
	// Composer height can change, which affects the space available for sessions.
	if (sessionsMode === 'recent') scheduleRenderSessions();
  }

  sendEl.addEventListener('click', () => {
    if (isBusy) {
      vscode.postMessage({ type: 'cancel' });
      return;
    }
    sendCurrent();
  });

  btnAddContextEl?.addEventListener('click', () => uiAction('addContext'));
  btnContinueEl?.addEventListener('click', () => {
    if (btnContinueEl.disabled) return;
    // Prevent double-clicking; backend will echo a user message and set busy.
    lastMessageRole = 'user';
    updateContinueButton();
    uiAction('continueChat');
  });

  btnSessionBackEl?.addEventListener('click', () => {
    sessionsUiMode = 'list';
    detailSessionId = null;
    renderSessions();
  });

  function hideMenus() {
    agentMenuEl?.classList.add('hidden');
    modelMenuEl?.classList.add('hidden');
    toolsMenuEl?.classList.add('hidden');
    topNewMenuEl?.classList.add('hidden');
    topMoreMenuEl?.classList.add('hidden');
  }

  let hashSuggest = {
    open: false,
    items: [],
    activeIndex: 0,
    ctx: null,
    lastPrefix: null,
    reqTimer: 0
  };

  function hideHashSuggest() {
    if (!hashSuggestEl) return;
    hashSuggest.open = false;
    hashSuggest.items = [];
    hashSuggest.activeIndex = 0;
    hashSuggest.ctx = null;
    hashSuggestEl.classList.add('hidden');
    hashSuggestEl.innerHTML = '';
  }

  function computeHashContext() {
    if (!inputEl) return null;
    const text = String(inputEl.value ?? '');
    const pos = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : text.length;

    let hashIdx = text.lastIndexOf('#', Math.max(0, pos - 1));
    while (hashIdx >= 0) {
      const before = hashIdx === 0 ? ' ' : text[hashIdx - 1];
      if (hashIdx === 0 || /\s/.test(before)) break;
      hashIdx = text.lastIndexOf('#', hashIdx - 1);
    }
    if (hashIdx < 0) return null;

    const token = text.slice(hashIdx + 1, pos);
    // Only when caret is within a single token (no spaces/newlines).
    if (!token && text[hashIdx] !== '#') return null;
    if (token.startsWith('#')) return null;
    if (/\s/.test(token)) return null;

    return { hashIdx, pos, token };
  }

  function positionHashSuggest() {
    if (!hashSuggestEl || !composerBoxEl || !inputEl) return;
    const boxRect = composerBoxEl.getBoundingClientRect();
    const inputRect = inputEl.getBoundingClientRect();
    // Anchor the dropdown to expand upward above the input.
    const bottom = Math.max(8, Math.round(boxRect.bottom - inputRect.top + 6));
    hashSuggestEl.style.top = 'auto';
    hashSuggestEl.style.bottom = `${bottom}px`;
  }

  function renderHashSuggest() {
    if (!hashSuggestEl) return;
    const items = Array.isArray(hashSuggest.items) ? hashSuggest.items : [];
    if (!hashSuggest.open || !items.length) {
      hideHashSuggest();
      return;
    }

    positionHashSuggest();
    hashSuggestEl.classList.remove('hidden');
    hashSuggestEl.innerHTML = '';

    const active = clamp(hashSuggest.activeIndex, 0, items.length - 1);
    hashSuggest.activeIndex = active;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hashSuggestItem' + (i === active ? ' active' : '');
      btn.setAttribute('role', 'option');
      btn.dataset.index = String(i);

      const left = document.createElement('span');
      left.className = 'hashSuggestLeft';

      const icon = document.createElement('span');
      icon.className = it.kind === 'file' ? 'codicon codicon-file' : 'codicon codicon-tools';
      left.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'hashSuggestLabel';
      label.textContent = String(it.label ?? '');
      left.appendChild(label);

      const detail = document.createElement('span');
      detail.className = 'hashSuggestDetail';
      detail.textContent = String(it.detail ?? '');

      btn.appendChild(left);
      btn.appendChild(detail);

      btn.addEventListener('mouseenter', () => {
        hashSuggest.activeIndex = i;
        renderHashSuggest();
      });

      btn.addEventListener('pointerdown', (e) => {
        // Accept on pointerdown to avoid focus/blur quirks and global handlers.
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        acceptHashSuggestion(i);
      });

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        acceptHashSuggestion(i);
      });

      hashSuggestEl.appendChild(btn);
    }
  }

  function acceptHashSuggestion(index) {
    const items = Array.isArray(hashSuggest.items) ? hashSuggest.items : [];
    const it = items[index];
    if (!it || !inputEl) return;

    const ctxNow = computeHashContext();
    const ctx = ctxNow || hashSuggest.ctx;
    if (!ctx) return;

    // Copilot-like: selecting a suggestion turns it into a chip (not raw text).
    // Remove the current #token from the textarea and create draft refs on the extension side.
    const text = String(inputEl.value ?? '');
    const before = text.slice(0, ctx.hashIdx);
    const after = text.slice(ctx.pos);
    inputEl.value = before + after;
    const caret = before.length;
    inputEl.focus();
    inputEl.setSelectionRange(caret, caret);
    autoResize();

    if (it.kind === 'file') {
      const ref = String(it.insertText ?? '').replace(/^#file:/i, '').trim();
      if (ref) uiAction('attachFileRef', { ref });
    } else if (it.kind === 'tool') {
      const name = String(it.label ?? '').trim();
      if (name) uiAction('addToolRef', { name });
    }

    hideHashSuggest();
  }

  function requestHashSuggest() {
    if (!hashSuggestEl) return;
    const ctx = computeHashContext();
    if (!ctx) {
      hideHashSuggest();
      return;
    }

    hashSuggest.ctx = ctx;
    const prefix = String(ctx.token ?? '');
    if (hashSuggest.lastPrefix === prefix && hashSuggest.open) return;
    hashSuggest.lastPrefix = prefix;

    if (hashSuggest.reqTimer) clearTimeout(hashSuggest.reqTimer);
    hashSuggest.reqTimer = setTimeout(() => {
      uiAction('hashSuggest', { prefix });
    }, 90);
  }

  function toggleMenu(menuEl) {
    if (!menuEl) return;
    const isHidden = menuEl.classList.contains('hidden');
    hideMenus();
    if (isHidden) menuEl.classList.remove('hidden');
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function openMenuAnchored(menuEl, anchorEl, options) {
    if (!menuEl || !anchorEl) return;
    const opts = options || {};
    hideMenus();

    // Show first (hidden) so we can measure.
    menuEl.classList.remove('hidden');
    menuEl.style.visibility = 'hidden';

    requestAnimationFrame(() => {
      try {
        const anchorRect = anchorEl.getBoundingClientRect();

        const parent = menuEl.offsetParent || document.body;
        const parentRect = parent.getBoundingClientRect();

        // Clamp within the *visible* webview viewport.
        // In WebviewView, the internal document can be wider than the visible sidebar;
        // clamping to the viewport avoids the menu overflowing into the editor area.
        const vw = document.documentElement?.clientWidth || window.innerWidth || 0;
        const vh = document.documentElement?.clientHeight || window.innerHeight || 0;

        const pad = 8;

        // Constrain width before measuring, otherwise long model names can make the
        // menu wider than the sidebar and it will be host-clipped by the editor area.
        const maxW = Math.max(160, Math.floor(vw - pad * 2));
        menuEl.style.maxWidth = `${maxW}px`;
        if (menuEl.classList.contains('menuModel')) {
          menuEl.style.width = `${Math.min(360, maxW)}px`;
        } else {
          menuEl.style.width = '';
        }

        const menuRect = menuEl.getBoundingClientRect();
        // Visible viewport range, expressed in the offsetParent's coordinate space.
        const minLeft = Math.round(-parentRect.left + pad);
        const maxLeft = Math.round(-parentRect.left + vw - menuRect.width - pad);

        let left;
        if (opts.alignRight) {
          left = anchorRect.right - parentRect.left - menuRect.width;
        } else {
          left = anchorRect.left - parentRect.left;
        }
        left = clamp(Math.round(left), minLeft, maxLeft);

        menuEl.style.left = `${left}px`;

        // Prefer a computed top so the menu is fully visible regardless of height.
        const gap = 6;
        const minTop = Math.round(-parentRect.top + pad);
        const maxTop = Math.round(-parentRect.top + vh - menuRect.height - pad);

        const topAbove = anchorRect.top - parentRect.top - menuRect.height - gap;
        const topBelow = anchorRect.bottom - parentRect.top + gap;

        // Prefer opening above the button; if not enough room, open below.
        let top = topAbove;
        if (top < minTop && topBelow <= maxTop) {
          top = topBelow;
        }
        top = clamp(Math.round(top), minTop, maxTop);

        menuEl.style.top = `${top}px`;
        menuEl.style.bottom = 'auto';
      } finally {
        menuEl.style.visibility = 'visible';
      }
    });
  }

  btnAgentMenuEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Toggle: clicking the same button closes the menu.
    if (agentMenuEl && !agentMenuEl.classList.contains('hidden')) {
      hideMenus();
      return;
    }
    openMenuAnchored(agentMenuEl, btnAgentMenuEl, { alignRight: false });
  });
  btnModelMenuEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Toggle: clicking the same button closes the menu.
    if (modelMenuEl && !modelMenuEl.classList.contains('hidden')) {
      hideMenus();
      return;
    }
    uiAction('requestModels');
    openMenuAnchored(modelMenuEl, btnModelMenuEl, { alignRight: true });
  });
  btnToolsEl?.addEventListener('click', (e) => {
    e.stopPropagation();

    // Default: open full Tools & MCP configuration.
    // Power-user: Shift+click keeps the quick toggle menu.
    if (e && e.shiftKey) {
      openMenuAnchored(toolsMenuEl, btnToolsEl, { alignRight: true });
      return;
    }

    hideMenus();
    uiAction('openToolsSettings');
  });

  btnTopNewEl?.addEventListener('click', (e) => {
    e.stopPropagation();

    if (topNewMenuEl && btnTopNewEl) {
      const rect = btnTopNewEl.getBoundingClientRect();
      topNewMenuEl.style.left = `${Math.max(8, rect.right - 220)}px`;
      topNewMenuEl.style.top = `${rect.bottom + 6}px`;
    }
    toggleMenu(topNewMenuEl);
  });

  btnTopMoreEl?.addEventListener('click', (e) => {
    e.stopPropagation();

    if (topMoreMenuEl && btnTopMoreEl) {
      const rect = btnTopMoreEl.getBoundingClientRect();
      topMoreMenuEl.style.left = `${Math.max(8, rect.right - 240)}px`;
      topMoreMenuEl.style.top = `${rect.bottom + 6}px`;
    }
    toggleMenu(topMoreMenuEl);
  });

  btnTopSettingsEl?.addEventListener('click', () => uiAction('openSettings'));

  agentMenuEl?.addEventListener('click', (e) => {
    const target = e.target;
    const item = target?.closest ? target.closest('.menuItem') : target;
    if (!item || !item.dataset) return;
    const value = item.dataset.value;
    if (!value) return;
    if (agentLabelEl) {
      const labelEl = item.querySelector?.('.menuItemLabel');
      agentLabelEl.textContent = (labelEl?.textContent || item.textContent || 'agent&vm').trim();
    }
    uiAction('setAgentProfile', { id: value });
    hideMenus();
  });

  modelMenuEl?.addEventListener('click', (e) => {
    const target = e.target;
    const item = target?.closest ? target.closest('.menuItem') : target;
    if (!item || !item.dataset) return;
    const value = item.dataset.value;
    if (!value) return;

    if (value === 'manageModels') {
      uiAction('manageModels');
      hideMenus();
      return;
    }

    if (value === 'clearModelWhitelist') {
      uiAction('clearModelWhitelist');
      hideMenus();
      return;
    }

    if (modelLabelEl) {
      const labelEl = item.querySelector?.('.menuItemLabel');
      modelLabelEl.textContent = (labelEl?.textContent || item.textContent || 'Model').trim();
    }
    uiAction('setModel', { id: value });
    hideMenus();
  });

  topNewMenuEl?.addEventListener('click', (e) => {
    const target = e.target;
    const action = target?.dataset?.action;
    if (!action) return;
    if (action === 'newSession') {
	  // Copilot-like: after creating a new session, follow backend active session.
	  sessionsUiMode = 'auto';
	  detailSessionId = null;
	  renderSessions();
      uiAction('newSession');
      hideMenus();
      return;
    }
    uiAction(action);
    hideMenus();
  });

  topMoreMenuEl?.addEventListener('click', (e) => {
    const target = e.target;
    const action = target?.dataset?.action;
    if (!action) return;
    uiAction(action);
    hideMenus();
  });

  toolsMenuEl?.addEventListener('change', () => {
    const enabled = [];
    const inputs = toolsMenuEl.querySelectorAll('input[type="checkbox"][data-tool]');
    for (const el of inputs) {
      if (el.checked) {
        const t = el.getAttribute('data-tool');
        if (t) enabled.push(t);
      }
    }
    uiAction('setEnabledTools', { tools: enabled });
  });

  function renderSessions() {
    if (!sessionsEl || !sessionsListEl || !sessionsHeaderTextEl || !btnSessionsToggleEl) return;

    // Temp session ON means history is disabled.
    if (tempSessionToggleEl) {
      tempSessionToggleEl.checked = !sessionState.isHistoryEnabled;
    }

    if (!sessionState.isHistoryEnabled) {
      sessionsUiMode = 'list';
      detailSessionId = null;
      sessionsHeaderTextEl.textContent = 'RECENT SESSIONS';
      sessionsListEl.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'sessionMeta';
      empty.textContent = 'Chat History 未启用（tripilot.chatHistory.enabled=false）';
      sessionsListEl.appendChild(empty);
      btnSessionsToggleEl.classList.add('hidden');
	  sessionsHeaderEl?.classList.remove('hidden');
	  sessionsListEl.classList.remove('hidden');
	  btnSessionsViewEl?.classList.remove('hidden');
	  sessionNavEl?.classList.add('hidden');
      return;
    }

    const all = Array.isArray(sessionState.sessions) ? sessionState.sessions : [];
		const recentLimit = sessionsMode === 'recent' ? getRecentSessionsLimit() : all.length;
    const visible = sessionsMode === 'recent' ? all.slice(0, recentLimit) : all;

    const activeSession = all.find((s) => !!s.isActive);

    // In auto mode, follow backend's active session.
    if (sessionsUiMode === 'auto' && activeSession) {
      detailSessionId = activeSession.sessionId;
    }

    const effectiveUiMode = sessionsUiMode === 'auto' ? (activeSession ? 'detail' : 'list') : sessionsUiMode;
    const detailSession =
      (detailSessionId ? all.find((s) => s.sessionId === detailSessionId) : null) ||
      activeSession ||
      null;

    if (effectiveUiMode === 'detail' && detailSession) {
      sessionNavEl?.classList.remove('hidden');
      if (sessionNavTitleEl) sessionNavTitleEl.textContent = detailSession.title || '(无标题)';
      sessionsHeaderEl?.classList.add('hidden');
      sessionsListEl.classList.add('hidden');
      btnSessionsToggleEl.classList.add('hidden');
      btnSessionsRefreshEl?.classList.add('hidden');
      btnSessionsSearchEl?.classList.add('hidden');
      btnSessionsFilterEl?.classList.add('hidden');
      btnSessionsViewEl?.classList.add('hidden');
      return;
    }

    sessionNavEl?.classList.add('hidden');
    sessionsHeaderEl?.classList.remove('hidden');
    sessionsListEl.classList.remove('hidden');
    btnSessionsViewEl?.classList.remove('hidden');

    sessionsHeaderTextEl.textContent = sessionsMode === 'recent' ? 'RECENT SESSIONS' : 'ALL SESSIONS';
    btnSessionsToggleEl.textContent = sessionsMode === 'recent' ? 'Show All Sessions' : 'Show Recent Sessions';
    btnSessionsToggleEl.classList.toggle('hidden', all.length === 0 || (sessionsMode === 'recent' && all.length <= visible.length));

    const isAll = sessionsMode === 'all';
    btnSessionsRefreshEl?.classList.toggle('hidden', !isAll);
    btnSessionsSearchEl?.classList.toggle('hidden', !isAll);
    btnSessionsFilterEl?.classList.toggle('hidden', !isAll);

    sessionsListEl.innerHTML = '';

    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'sessionMeta';
      empty.textContent = '没有找到已保存的会话。';
      sessionsListEl.appendChild(empty);
      return;
    }

    for (const s of visible) {
      const row = document.createElement('div');
      row.className = `sessionRow${s.isActive ? ' isActive' : ''}`;
      row.setAttribute('data-session-id', s.sessionId);
      row.setAttribute('role', 'button');
      row.tabIndex = 0;

      const main = document.createElement('div');
      main.className = 'sessionMain';

      const title = document.createElement('div');
      title.className = 'sessionTitle';
      title.textContent = s.title || '(无标题)';

      const meta = document.createElement('div');
      meta.className = 'sessionMeta';
      const rel = (s.relativeTime || '').trim();
      const preview = (s.preview || '').trim();
      meta.textContent = rel ? `本地 · ${rel}${preview ? `  ·  ${preview}` : ''}` : (preview || s.sessionId);

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'sessionActions';

      const del = document.createElement('button');
      del.className = 'icon ghost sessionDelete';
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete');
      del.innerHTML = '<span class="codicon codicon-trash"></span>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        uiAction('deleteSession', { sessionId: s.sessionId });
      });
      actions.appendChild(del);

      const archive = document.createElement('button');
      archive.className = 'icon ghost sessionArchive';
      archive.title = 'Archive / Export';
      archive.setAttribute('aria-label', 'Archive / Export');
      archive.innerHTML = '<span class="codicon codicon-archive"></span>';
      archive.addEventListener('click', (e) => {
        e.stopPropagation();
        uiAction('archiveOrExportSession', { sessionId: s.sessionId });
      });
      actions.appendChild(archive);

      row.addEventListener('click', () => {
        sessionsUiMode = 'detail';
        detailSessionId = s.sessionId;
        renderSessions();
        uiAction('loadSession', { sessionId: s.sessionId });
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          sessionsUiMode = 'detail';
          detailSessionId = s.sessionId;
          renderSessions();
          uiAction('loadSession', { sessionId: s.sessionId });
        }
      });

      row.appendChild(main);
      row.appendChild(actions);
      sessionsListEl.appendChild(row);
    }
  }

  btnSessionsToggleEl?.addEventListener('click', () => {
    sessionsMode = sessionsMode === 'recent' ? 'all' : 'recent';
	sessionsUiMode = 'list';
	detailSessionId = null;
    renderSessions();
  });

  window.addEventListener('resize', () => {
    // Recompute recent sessions limit on resize.
    if (sessionsMode === 'recent') scheduleRenderSessions();
  });

  btnSessionsRefreshEl?.addEventListener('click', () => uiAction('requestSessions'));
  btnSessionsSearchEl?.addEventListener('click', () => uiAction('sessionsSearch'));
  btnSessionsFilterEl?.addEventListener('click', () => uiAction('sessionsFilter'));
  btnSessionsViewEl?.addEventListener('click', () => {
    // Copilot-like: jump into ALL sessions view.
    sessionsMode = 'all';
	sessionsUiMode = 'list';
	detailSessionId = null;
    renderSessions();
    uiAction('requestSessions');
  });

  tempSessionToggleEl?.addEventListener('change', () => {
    const enabled = !!tempSessionToggleEl.checked;
    uiAction('setTempSession', { enabled });
  });

  // Close menus/suggestions on pointerdown outside (Copilot-like), using capture phase
  // to avoid click/blur ordering issues in webviews.
  document.addEventListener('pointerdown', (e) => {
    const target = e?.target;

    // Keep the hash suggestion interactive.
    if (hashSuggest.open && hashSuggestEl && target && hashSuggestEl.contains(target)) return;
    if (hashSuggest.open && inputEl && target === inputEl) return;

    // Keep menus interactive.
    if (
      target && (
        agentMenuEl?.contains(target) ||
        modelMenuEl?.contains(target) ||
        toolsMenuEl?.contains(target) ||
        topNewMenuEl?.contains(target) ||
        topMoreMenuEl?.contains(target)
      )
    ) {
      return;
    }

    hideMenus();
    hideHashSuggest();
    // Close sessions overlay on click outside
    if (sessionsOverlayEl && !sessionsOverlayEl.classList.contains('hidden')) {
      if (target && sessionsOverlayEl.contains(target)) return;
      if (target === btnHistoryEl) return;
      closeSessionsOverlay();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenus();
      hideHashSuggest();
      if (sessionsOverlayEl && !sessionsOverlayEl.classList.contains('hidden')) {
        closeSessionsOverlay();
      }
    }
  });

  inputEl.addEventListener('keydown', (e) => {
    if (hashSuggest.open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        hashSuggest.activeIndex = clamp(hashSuggest.activeIndex + 1, 0, Math.max(0, hashSuggest.items.length - 1));
        renderHashSuggest();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        hashSuggest.activeIndex = clamp(hashSuggest.activeIndex - 1, 0, Math.max(0, hashSuggest.items.length - 1));
        renderHashSuggest();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideHashSuggest();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        acceptHashSuggestion(hashSuggest.activeIndex);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
	  // Enter always sends; stop is via the button only.
	  sendCurrent();
    }
  });

  inputEl.addEventListener('input', () => {
    autoResize();
    requestHashSuggest();
  });
  inputEl.addEventListener('click', () => requestHashSuggest());
  inputEl.addEventListener('keyup', () => requestHashSuggest());
  autoResize();
  updateSendButton();
  updateContinueButton();
  updateComposerTokensPresence();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        // noop
        return;
      case 'chatReset':
        if (messagesEl) messagesEl.innerHTML = '';
		streamingAssistantBodyEl = null;
    streamingAssistantMarkdown = '';
		currentToolGroup = null;
		toolInvocations.clear();
		lastTodoCardEl = null;
		pendingEditsCardByRequestId = new Map();
    checkpointCardsById = new Map();
    closeModal(false);
    hideRedoOffer();
		// Copilot-like: reset any pinned session detail view and follow active session.
		sessionsUiMode = 'auto';
		detailSessionId = null;
    selectedSubagentNodeId = null;
    collapsedSubagentNodeIdsBySession.clear();
		scheduleRenderSessions();
        renderSubagentTree();
        // Also clear approval UI state.
        currentApprovalRequestId = null;
        approvalEl?.classList.add('hidden');
        approvalTextEl.textContent = '';
        approvalFilesEl.textContent = '';
        return;
      case 'chatAppend':
        appendMessage(msg.role, msg.text);
        return;
    case 'chatCheckpoint':
    appendCheckpointCard(msg.checkpointId);
    return;
	  case 'chatAssistantStart':
		startAssistantStream(msg.initialText);
		return;
	  case 'chatAssistantDelta':
		appendAssistantDelta(msg.delta);
		return;
	  case 'chatAssistantEnd':
    // Finalize markdown rendering.
    renderMarkdownInto(streamingAssistantBodyEl, streamingAssistantMarkdown);
    streamingAssistantBodyEl = null;
    streamingAssistantMarkdown = '';
		return;
    case 'chatToolInvocationBegin':
    onToolInvocationBegin(msg);
    if (!replayHostState.active) uiAction('requestSubagentTree');
    return;
    case 'chatToolInvocationEnd':
    onToolInvocationEnd(msg);
    if (!replayHostState.active) uiAction('requestSubagentTree');
    return;
    case 'chatTodoList':
    renderTodoList(msg.todoList, msg.note);
    return;
    case 'checkpointRedoOffer':
    showRedoOffer({ checkpointId: msg.checkpointId, redoToken: msg.redoToken });
    return;
    case 'checkpointRedoClear':
    hideRedoOffer();
    return;
      case 'chatSetStatus':
        setStatus(msg.status, msg.detail);
        return;
      case 'workspaceContext':
        // noop
        return;

      case 'sessions':
        sessionState = {
          isHistoryEnabled: !!msg.isHistoryEnabled,
          sessions: Array.isArray(msg.sessions) ? msg.sessions : []
        };
        renderSessions();
        if (!replayHostState.active) uiAction('requestSubagentTree');
        renderSubagentTree();
        return;

      case 'subagentTree':
        subagentTreeNodes = Array.isArray(msg.nodes) ? msg.nodes : [];
        renderSubagentTree();
        renderSceneStatePanel();
        return;

      case 'sceneState':
        sceneState.machineState = String(msg.machineState || 'idle');
        sceneState.reason = String(msg.reason || 'n/a');
        sceneState.transition = String(msg.transition || 'n/a');
        sceneState.latestEventSeq = Number.isFinite(Number(msg.latestEventSeq)) ? Number(msg.latestEventSeq) : 0;
        sceneState.recoveryAt = Number.isFinite(Number(msg.recoveryAt)) ? Number(msg.recoveryAt) : 0;
        sceneState.updatedAt = Number.isFinite(Number(msg.updatedAt)) ? Number(msg.updatedAt) : Date.now();
        sceneState.workstations = Array.isArray(msg.workstations) ? msg.workstations : [];
        renderSceneStatePanel();
        return;

      case 'replayState':
        {
        const prevCursor = Number.isFinite(Number(replayState.cursor)) ? Number(replayState.cursor) : 0;
        replayHostState.active = !!msg.active;
        replayHostState.playing = !!msg.playing;
        replayHostState.cursor = Number.isFinite(Number(msg.cursor)) ? Number(msg.cursor) : 0;
        replayHostState.locked = !!msg.locked;
        replayHostState.sessionId = String(msg.sessionId || '');
        replayHostState.traceId = String(msg.traceId || '');
        replayHostState.totalRecords = Number.isFinite(Number(msg.totalRecords)) ? Math.max(0, Math.floor(Number(msg.totalRecords))) : 0;
        replayHostState.cadenceMs = Number.isFinite(Number(msg.cadenceMs)) ? Math.max(250, Math.floor(Number(msg.cadenceMs))) : 850;
        if (replayCadenceInputEl) replayCadenceInputEl.value = String(replayHostState.cadenceMs);
        replayState.playing = replayHostState.playing;
        if (Number.isFinite(replayHostState.cursor)) replayState.cursor = Number(replayHostState.cursor);
        clampReplayCursor();
        if (!replayHostState.active) stopReplayTimer();
        if (replayHostState.active && replayState.cursor !== prevCursor) {
          const row = replayState.records[replayState.cursor];
          if (row?.node) {
            jumpToSubagentEvent(row.node, {
              silent: true,
              source: 'replay-host-tick'
            });
          }
        }
        if (replayHintEl && replayHostState.active) {
          replayHintEl.textContent = `host-replay: active · ${replayHostState.playing ? 'playing' : 'paused'} · cursor=${replayHostState.cursor + 1}`;
        }
        renderReplayConsole();
        return;
        }

      case 'editApprovalRequest': {
        currentApprovalRequestId = msg.requestId;
			// Copilot-like: surface approvals inline in the message stream.
			// Keep the legacy bottom approval bar hidden to avoid duplicated UX.
			if (approvalEl) approvalEl.classList.add('hidden');
      upsertPendingEditsCard({ ...msg, mode: 'approval' });
		scheduleRenderSessions();
        return;
      }

      case 'editApprovalClear': {
        if (currentApprovalRequestId && msg.requestId !== currentApprovalRequestId) return;
        currentApprovalRequestId = null;
			if (approvalEl) approvalEl.classList.add('hidden');
			if (approvalTextEl) approvalTextEl.textContent = '';
			if (approvalFilesEl) approvalFilesEl.textContent = '';
		const card = pendingEditsCardByRequestId.get(String(msg.requestId || ''));
		if (card && card.parentElement) card.parentElement.removeChild(card);
		pendingEditsCardByRequestId.delete(String(msg.requestId || ''));
    pendingEditModeByRequestId.delete(String(msg.requestId || ''));
		scheduleRenderSessions();
        return;
      }

    case 'editReviewRequest': {
      upsertPendingEditsCard({ ...msg, mode: 'review' });
      scheduleRenderSessions();
      return;
    }

    case 'editReviewClear': {
      const rid = String(msg.requestId || '');
      const card = pendingEditsCardByRequestId.get(rid);
      if (card && card.parentElement) card.parentElement.removeChild(card);
      pendingEditsCardByRequestId.delete(rid);
      pendingEditModeByRequestId.delete(rid);
      scheduleRenderSessions();
      return;
    }

      case 'contextChips': {
        const chips = Array.isArray(msg.items) ? msg.items : [];
        if (!contextChipsEl) return;
        contextChipsEl.innerHTML = '';
        for (const c of chips) {
      const isObj = c && typeof c === 'object';
      const label = isObj ? String(c.label ?? '') : String(c);
      const id = isObj ? String(c.id ?? '') : '';
      const badge = isObj ? String(c.badge ?? '') : '';
      const title = isObj ? String(c.title ?? '') : '';

          const span = document.createElement('span');
          span.className = 'chip';
          if (title) span.title = title;

      if (badge) {
        const b = document.createElement('span');
        b.className = 'chipBadge';
        b.textContent = badge;
        span.appendChild(b);
      }

      const text = document.createElement('span');
      text.className = 'chipText';
      text.textContent = label;
      span.appendChild(text);

      if (id) {
      const btn = document.createElement('button');
      btn.className = 'chipRemove';
      btn.type = 'button';
      btn.textContent = '×';
      btn.title = '移除上下文';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        uiAction('removeContext', { id });
      });
      span.appendChild(btn);
      }

          contextChipsEl.appendChild(span);
        }
        updateComposerTokensPresence();
        return;
      }

      case 'toolChips': {
        const items = Array.isArray(msg.items) ? msg.items : [];
        if (!toolChipsEl) return;
        toolChipsEl.innerHTML = '';
        for (const nameRaw of items) {
          const name = String(nameRaw ?? '').trim();
          if (!name) continue;
          const span = document.createElement('span');
          span.className = 'chip chipTool';

          const icon = document.createElement('span');
          icon.className = 'chipIcon codicon codicon-tools';
          span.appendChild(icon);

          const text = document.createElement('span');
          text.className = 'chipText';
          text.textContent = name.startsWith('#') ? name : `#${name}`;
          span.appendChild(text);

          const btn = document.createElement('button');
          btn.className = 'chipRemove';
          btn.type = 'button';
          btn.textContent = '×';
          btn.title = '移除工具引用';
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uiAction('removeToolRef', { name });
          });
          span.appendChild(btn);

          toolChipsEl.appendChild(span);
        }
        updateComposerTokensPresence();
        return;
      }

      case 'hashSuggestions': {
        const items = Array.isArray(msg.items) ? msg.items : [];
        // Only show suggestions when we're currently in a hash context.
        const ctx = computeHashContext();
        if (!ctx || !items.length) {
          hideHashSuggest();
          return;
        }
        hashSuggest.open = true;
        hashSuggest.items = items;
        hashSuggest.activeIndex = 0;
        hashSuggest.ctx = ctx;
        renderHashSuggest();
        return;
      }

      case 'lmModels': {
        const models = Array.isArray(msg.models) ? msg.models : [];
        const selectedId = msg.selectedModelId;
        if (!modelMenuEl) return;

        modelMenuEl.innerHTML = '';

        for (const m of models) {
          const btn = document.createElement('button');
          btn.className = 'menuItem';
          btn.setAttribute('role', 'menuitem');
          btn.dataset.value = String(m.id);
          const label = document.createElement('span');
          label.className = 'menuItemLabel';
          label.textContent = String(m.name || m.id);
          btn.appendChild(label);

          const vendor = (m && typeof m === 'object' && m.vendor != null) ? String(m.vendor).trim() : '';
          const right = (m && typeof m === 'object' && m.rightText != null) ? String(m.rightText).trim() : '';
          const metaText = vendor || right;
          if (metaText) {
            const meta = document.createElement('span');
            meta.className = 'menuItemMeta';
            meta.textContent = metaText;
            if (vendor && right && right !== vendor) {
              meta.title = right;
            }
            btn.appendChild(meta);
          }
          modelMenuEl.appendChild(btn);
        }

        const divider = document.createElement('div');
        divider.className = 'menuDivider';
        divider.setAttribute('role', 'separator');
        modelMenuEl.appendChild(divider);

        const manage = document.createElement('button');
        manage.className = 'menuItem';
        manage.setAttribute('role', 'menuitem');
        manage.dataset.value = 'manageModels';
        manage.textContent = '管理模型...';
        modelMenuEl.appendChild(manage);


        // (menuHint removed; keep the menu focused on selection.)

        const picked = models.find((x) => String(x.id) === String(selectedId));
        if (modelLabelEl) modelLabelEl.textContent = picked ? String(picked.name || picked.id) : (models[0]?.name || 'Model');
        return;
      }

      case 'agents': {
        const agents = Array.isArray(msg.agents) ? msg.agents : [];
        if (!agentMenuEl) return;
        agentMenuEl.innerHTML = '';
        if (msg.loading) {
          const loading = document.createElement('button');
          loading.className = 'menuItem muted';
          loading.setAttribute('role', 'menuitem');
          loading.textContent = 'TriLC 正在加载，请稍后...';
          loading.disabled = true;
          agentMenuEl.appendChild(loading);
          return;
        }
        for (const a of agents) {
          if (!a) continue;
          const id = String(a.id ?? '').trim();
          if (!id) continue;
          if (id === '---') {
            const div = document.createElement('div');
            div.className = 'menuDivider';
            div.setAttribute('role', 'separator');
            agentMenuEl.appendChild(div);
            continue;
          }
          const btn = document.createElement('button');
          btn.className = 'menuItem';
          btn.setAttribute('role', 'menuitem');
          btn.dataset.value = id;
          const label = document.createElement('span');
          label.className = 'menuItemLabel';
          label.textContent = String(a.label ?? id);
          btn.appendChild(label);
          const desc = (a && typeof a === 'object' && a.description != null) ? String(a.description).trim() : '';
          if (desc) {
            const meta = document.createElement('span');
            meta.className = 'menuItemMeta';
            meta.textContent = desc;
            btn.appendChild(meta);
          }
          agentMenuEl.appendChild(btn);
        }
        return;
      }

      case 'agentProfile': {
        currentAgentProfileId = String(msg.id ?? '');
        const allowed = Array.isArray(msg.allowedOptionalTools) ? msg.allowedOptionalTools : null;
        currentAllowedOptionalTools = allowed ? new Set(allowed.map((s) => String(s))) : null;
        const enabled = Array.isArray(msg.enabledOptionalTools) ? msg.enabledOptionalTools : [];
        currentEnabledOptionalTools = new Set(enabled.map((s) => String(s)));
        if (agentLabelEl) agentLabelEl.textContent = String(msg.label ?? msg.id ?? 'agent&vm');
        syncToolsMenuFromProfile();
        return;
      }
    }
  });

  function sendApproval(action) {
    if (!currentApprovalRequestId) return;
    vscode.postMessage({ type: 'editApprovalAction', requestId: currentApprovalRequestId, action });
  }

  function sendEditReview(requestId, action) {
    const rid = String(requestId || '');
    if (!rid) return;
    vscode.postMessage({ type: 'editReviewAction', requestId: rid, action });
  }

  approvalPreviewEl.addEventListener('click', () => sendApproval('preview'));
  approvalApplyEl.addEventListener('click', () => sendApproval('apply'));
  approvalCancelEl.addEventListener('click', () => sendApproval('cancel'));

  vscode.postMessage({ type: 'webviewReady' });

  // Sidebar-only: fetch sessions list (best-effort, also pushed by backend).
  const hostIsEditor = document.body.classList.contains('host-editor');
  if (!hostIsEditor) {
    renderSubagentTree();
    uiAction('requestSessions');
    uiAction('requestSubagentTree');
    uiAction('requestReplayState');
  }
})();
