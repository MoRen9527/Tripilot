(() => {
	const vscode = acquireVsCodeApi();

	const $ = (sel) => document.querySelector(sel);
	const $$ = (sel) => Array.from(document.querySelectorAll(sel));
	const listEl = $('#modelList');
	const searchEl = $('#search');
	const refreshEl = $('#refresh');
	const modelsStatusEl = $('#modelsStatus');


	const navEls = $$('.navItem');
	const pages = $$('.page');

	const customAgentListEl = $('#customAgentList');
	const customAgentRefreshEl = $('#customAgentRefresh');
	const customAgentFileBaseEl = $('#customAgentFileBase');
	const customAgentCreateEl = $('#customAgentCreate');

	const agentsListEl = $('#agentsList');
	const agentsRefreshEl = $('#agentsRefresh');
	const agentsStatusEl = $('#agentsStatus');

	const builtinToolsEl = $('#builtinTools');
	const commandToolsEl = $('#commandTools');
	const mcpServersEl = $('#mcpServers');
	const mcpRefreshEl = $('#mcpRefresh');

	const agentProfileSelectEl = $('#agentProfileSelect');
	const agentProfileRemoveEl = $('#agentProfileRemove');
	const agentProfileIdEl = $('#agentProfileId');
	const agentProfileNameEl = $('#agentProfileName');
	const agentProfileAddEl = $('#agentProfileAdd');
	const followChatProfileEl = $('#followChatProfile');
	const syncChatProfileFromSettingsEl = $('#syncChatProfileFromSettings');
	const editsEnableHealingEl = $('#editsEnableHealing');
	const profileEditsEnableHealingModeEl = $('#profileEditsEnableHealingMode');

	const cmdToolNameEl = $('#cmdToolName');
	const cmdToolCommandEl = $('#cmdToolCommand');
	const cmdToolDescEl = $('#cmdToolDesc');
	const cmdToolAddEl = $('#cmdToolAdd');
	const cmdDiscoverQueryEl = $('#cmdDiscoverQuery');
	const cmdDiscoverEl = $('#cmdDiscover');
	const cmdDiscoverListEl = $('#cmdDiscoverList');

	const mcpIdEl = $('#mcpId');
	const mcpNameEl = $('#mcpName');
	const mcpTransportEl = $('#mcpTransport');
	const mcpUrlEl = $('#mcpUrl');
	const mcpCommandEl = $('#mcpCommand');
	const mcpArgsEl = $('#mcpArgs');
	const mcpAddEl = $('#mcpAdd');

	let allModels = [];
	let enabledIds = new Set();
	let modelsStatus = '';
	let defaultModelId = '';
		function renderModelsStatus() {
			if (!modelsStatusEl) return;
			const text = String(modelsStatus || '').trim();
			if (!text) {
				modelsStatusEl.textContent = '';
				return;
			}
			const parts = text.split(' · ').map((s) => String(s || '').trim()).filter(Boolean);
			const lines = [];
			lines.push('Models:');
			for (let i = 0; i < parts.length; i++) {
				const p = parts[i];
				if (i === 0 && !/[=:]/.test(p)) {
					lines.push(`provider: ${p}`);
				} else {
					lines.push(p);
				}
			}
			modelsStatusEl.textContent = lines.join('\n');
		}
	let builtinTools = [];
	let builtinToolCategories = {};
	let commandTools = [];
	let mcpServers = [];
	let discoveredCommands = [];
	let agentProfiles = [];
	let activeAgentProfileId = '';
	let followChatProfile = true;
	let syncChatProfileFromSettings = false;
	let editsEnableHealing = false;
	let profileEditsEnableHealingMode = 'inherit';
	let customAgents = [];
	let triLcAgents = [];
	let triLcStaffing = null; // FADE-004：roster { chainState, roster[], counts }

	function renderTriLcAgents() {
		if (!agentsListEl) return;
		agentsListEl.innerHTML = '';
		if (!triLcAgents.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No TriCompany agents. Start TriLC or click Refresh.';
			agentsListEl.appendChild(div);
			if (agentsStatusEl) agentsStatusEl.textContent = 'No agents found';
			return;
		}
		// FADE-004 候选岗位发布：岗位=JD（单一真源），勾选=上岗（CHO 审批），
		// 分身 spawn 是另一层 HC（clone-dispatch 协议）——提示行说明两者关系。
		if (triLcStaffing && Array.isArray(triLcStaffing.roster)) {
			const hint = document.createElement('div');
			hint.className = 'modelMeta';
			hint.style.margin = '0 0 8px 0';
			hint.textContent = `上岗名册（链态 ${triLcStaffing.chainState}）：在岗 ${triLcStaffing.counts.active}/${triLcStaffing.counts.total}` +
				(triLcStaffing.counts.pending > 0 ? `，待 CHO 审批 ${triLcStaffing.counts.pending}` : '') +
				'。勾选候选提交上岗（CHO 审批）；每个岗位可按分身派工协议创建多个分身并行执行任务。';
			agentsListEl.appendChild(hint);
		}
		if (agentsStatusEl) agentsStatusEl.textContent = `${triLcAgents.length} agents loaded`;
		const statusByRole = new Map(
			(triLcStaffing?.roster ?? []).map((r) => [r.roleId, r]),
		);
		for (const a of triLcAgents) {
			const st = statusByRole.get(a.id);
			const row = document.createElement('div');
			row.className = 'row';

			const left = document.createElement('div');
			const nameLine = document.createElement('div');
			nameLine.style.display = 'flex';
			nameLine.style.alignItems = 'center';
			nameLine.style.gap = '8px';

			// 上岗勾选框（FADE-004）：active=打钩锁定；candidate=可勾选；pending=审批中
			const cb = document.createElement('input');
			cb.type = 'checkbox';
			cb.id = `staffing-${a.id}`;
			cb.checked = st ? st.status === 'active' : false;
			cb.disabled = !st || st.status === 'active' || st.status === 'pending-cho';
			cb.title = !st ? '上岗名册不可达（老 daemon）'
				: st.status === 'active' ? '在岗（开业选定或已审批上岗）'
				: st.status === 'pending-cho' ? 'CHO 审批中'
				: '勾选提交上岗申请（CHO 审批）';
			cb.addEventListener('change', () => {
				if (cb.checked) {
					vscode.postMessage({ type: 'staffingOnboard', roleId: a.id, displayName: a.displayName });
				}
			});
			nameLine.appendChild(cb);

			const name = document.createElement('div');
			name.className = 'modelName';
			// 名字是实例属性：在岗显示开业/上岗赋予的员工名，未在岗显示「无名字」（CEO 2026-08-18）
			const empName = st ? (st.employeeName ?? null) : null;
			const jdName = (st && st.displayName) || a.displayName || a.id;
			name.textContent = empName ? `${jdName} · ${empName}` : `${jdName} · 无名字`;
			nameLine.appendChild(name);

			if (st && st.status === 'pending-cho') {
				const badge = document.createElement('span');
				badge.textContent = 'CHO 审批中';
				badge.style.fontSize = '11px';
				badge.style.color = 'var(--vscode-charts-orange, #d29922)';
				nameLine.appendChild(badge);
				const btnOk = document.createElement('button');
				btnOk.textContent = '批准';
				btnOk.className = 'iconButton';
				btnOk.style.marginLeft = '6px';
				btnOk.addEventListener('click', () =>
					vscode.postMessage({ type: 'staffingDecide', requestId: st.requestId, decision: 'approved', roleId: a.id }));
				const btnNo = document.createElement('button');
				btnNo.textContent = '驳回';
				btnNo.className = 'iconButton';
				btnNo.addEventListener('click', () =>
					vscode.postMessage({ type: 'staffingDecide', requestId: st.requestId, decision: 'rejected', roleId: a.id }));
				nameLine.appendChild(btnOk);
				nameLine.appendChild(btnNo);
			}
			if (st && st.status === 'active') {
				const badge = document.createElement('span');
				badge.textContent = '在岗';
				badge.style.fontSize = '11px';
				badge.style.color = 'var(--vscode-charts-green, #3fb950)';
				nameLine.appendChild(badge);
			}
			left.appendChild(nameLine);

			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			const parts = [a.id];
			if (a.role) parts.push(a.role);
			if (a.decisionRights) parts.push(a.decisionRights);
			meta.textContent = parts.join(' · ');
			left.appendChild(meta);

			row.appendChild(left);
			agentsListEl.appendChild(row);
		}
	}

	function renderFollowChatProfile() {
		if (!followChatProfileEl) return;
		followChatProfileEl.checked = !!followChatProfile;
	}

	function renderSyncChatProfileFromSettings() {
		if (!syncChatProfileFromSettingsEl) return;
		syncChatProfileFromSettingsEl.checked = !!syncChatProfileFromSettings;
	}

	function renderEditsEnableHealing() {
		if (!editsEnableHealingEl) return;
		editsEnableHealingEl.checked = !!editsEnableHealing;
	}

	function renderProfileEditsEnableHealingMode() {
		if (!profileEditsEnableHealingModeEl) return;
		const p = agentProfiles.find((x) => String(x?.id) === String(activeAgentProfileId));
		const v = p && Object.prototype.hasOwnProperty.call(p, 'editsEnableHealing') ? p.editsEnableHealing : undefined;
		profileEditsEnableHealingMode = v === true ? 'on' : v === false ? 'off' : 'inherit';
		profileEditsEnableHealingModeEl.value = profileEditsEnableHealingMode;
	}


	function renderCustomAgents() {
		if (!customAgentListEl) return;
		customAgentListEl.innerHTML = '';
		if (!customAgents.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No custom agents found in .github/agents.';
			customAgentListEl.appendChild(div);
			return;
		}

		for (const a of customAgents) {
			const row = document.createElement('div');
			row.className = 'row';
			row.dataset.id = String(a.id);

			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = a.name || a.id;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			const parts = [a.relativePath];
			if (a.isLegacy) parts.push('legacy');
			if (a.model) parts.push(`model: ${a.model}`);
			if (Array.isArray(a.tools) && a.tools.length) parts.push(`tools: ${a.tools.join(', ')}`);
			if (a.hidden) parts.push('hidden');
			meta.textContent = parts.join(' · ');
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const openBtn = document.createElement('button');
			openBtn.className = 'ghost';
			openBtn.textContent = 'Open';
			openBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'openWorkspaceCustomAgent', id: a.id });
			});

			const hideBtn = document.createElement('button');
			hideBtn.className = 'ghost';
			hideBtn.textContent = a.hidden ? 'Show' : 'Hide';
			hideBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'setWorkspaceCustomAgentHidden', id: a.id, hidden: !a.hidden });
			});

			const delBtn = document.createElement('button');
			delBtn.className = 'ghost';
			delBtn.textContent = 'Delete';
			delBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'deleteWorkspaceCustomAgent', id: a.id });
			});

			right.appendChild(openBtn);
			right.appendChild(hideBtn);
			right.appendChild(delBtn);

			row.appendChild(left);
			row.appendChild(right);
			customAgentListEl.appendChild(row);
		}
	}

	function renderAgentProfiles() {
		if (!agentProfileSelectEl) return;
		agentProfileSelectEl.innerHTML = '';
		for (const p of agentProfiles) {
			const opt = document.createElement('option');
			opt.value = p.id;
			opt.textContent = p.name;
			agentProfileSelectEl.appendChild(opt);
		}
		agentProfileSelectEl.value = activeAgentProfileId;
		// v0.1: all profiles are user-defined; none are built-in
		if (agentProfileRemoveEl) agentProfileRemoveEl.disabled = !agentProfiles.length;
	}

	function normalize(s) {
		return String(s ?? '').toLowerCase();
	}

	function render() {
		const q = normalize(searchEl.value).trim();
		const filtered = q
			? allModels.filter((m) => normalize(m.name).includes(q) || normalize(m.id).includes(q) || normalize(m.vendor).includes(q))
			: allModels;

		listEl.innerHTML = '';
		if (!filtered.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No models.';
			listEl.appendChild(div);
			return;
		}

		for (const m of filtered) {
			const row = document.createElement('div');
			row.className = 'row';

			const left = document.createElement('div');

			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = m.name;

			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			meta.textContent = `${m.id}${m.vendor ? ` · ${m.vendor}` : ''}`;

			left.appendChild(name);
			left.appendChild(meta);

			const toggle = document.createElement('label');
			toggle.className = 'toggle';

			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = enabledIds.has(m.id);
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'toggleModel', id: m.id, enabled: input.checked });
			});

			const slider = document.createElement('span');
			slider.className = 'slider';

			toggle.appendChild(input);
			toggle.appendChild(slider);

			row.appendChild(left);
			row.appendChild(toggle);
			listEl.appendChild(row);
		}

			// ── Default model dropdown ──
			// Show enabled models only (exclude 'auto')
			const enabledModels = allModels.filter((m) => enabledIds.has(m.id) && m.id !== 'auto');
			const selectedDefault = defaultModelId && enabledModels.some((m) => m.id === defaultModelId)
				? defaultModelId
				: (enabledModels.length ? enabledModels[0].id : '');
			const defaultSection = document.createElement('div');
			defaultSection.className = 'section';
			const sectionTitle = document.createElement('div');
			sectionTitle.className = 'sectionTitle';
			sectionTitle.textContent = '默认模型';
			defaultSection.appendChild(sectionTitle);

			const selectEl = document.createElement('select');
			selectEl.id = 'defaultModelSelect';
			if (!enabledModels.length) {
				const opt = document.createElement('option');
				opt.value = '';
				opt.textContent = '(请先启用模型)';
				selectEl.appendChild(opt);
			} else {
				for (const m of enabledModels) {
					const opt = document.createElement('option');
					opt.value = m.id;
					opt.textContent = m.name;
					if (m.id === selectedDefault) opt.selected = true;
					selectEl.appendChild(opt);
				}
				selectEl.addEventListener('change', () => {
					vscode.postMessage({ type: 'setDefaultModel', id: selectEl.value });
				});
			}
			defaultSection.appendChild(selectEl);

			const hint = document.createElement('div');
			hint.className = 'modelMeta';
			hint.textContent = '新对话将默认使用此模型。可在 Chat 界面中随时切换。';
			defaultSection.appendChild(hint);

			listEl.appendChild(defaultSection);
	}

	function setPage(page) {
		for (const el of navEls) {
			const active = el.getAttribute('data-page') === page;
			el.classList.toggle('active', active);
		}
		for (const p of pages) {
			const show = p.getAttribute('data-page') === page;
			p.classList.toggle('hidden', !show);
		}
	}

	function renderBuiltinTools() {
		if (!builtinToolsEl) return;
		builtinToolsEl.innerHTML = '';
		if (!builtinTools.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No built-in tools.';
			builtinToolsEl.appendChild(div);
			return;
		}

		const GROUP_ORDER = ['agent', 'edit', 'execute', 'read', 'search', 'todo', 'vscode', 'web'];
		const GROUP_LABEL = {
			agent: 'agent',
			edit: 'edit',
			execute: 'execute',
			read: 'read',
			search: 'search',
			todo: 'todo',
			vscode: 'vscode',
			web: 'web'
		};
		const GROUP_DESC = {
			agent: 'Run subagents',
			edit: 'Edit files',
			execute: 'Run tasks/commands',
			read: 'Read from VS Code',
			search: 'Search the workspace',
			todo: 'Progress tracking',
			vscode: 'Use VS Code features',
			web: '从 Web 提取信息'
		};

		const map = builtinToolCategories && typeof builtinToolCategories === 'object' ? builtinToolCategories : {};
		const buckets = new Map();
		for (const t of builtinTools) {
			const catRaw = map[t.name];
			const cat = GROUP_ORDER.includes(String(catRaw)) ? String(catRaw) : null;
			if (!cat) continue;
			if (!buckets.has(cat)) buckets.set(cat, []);
			buckets.get(cat).push(t);
		}
		for (const tools of buckets.values()) {
			tools.sort((a, b) => String(a.name).localeCompare(String(b.name)));
		}

		const renderToolRow = (t) => {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = t.name;
			left.appendChild(name);
			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!t.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setBuiltinToolEnabled', name: t.name, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);
			row.appendChild(left);
			row.appendChild(toggle);
			return row;
		};

		for (const cat of GROUP_ORDER) {
			const tools = buckets.get(cat);
			if (!tools || !tools.length) continue;

			const details = document.createElement('details');
			details.className = 'toolGroup';
			details.open = true;

			const summary = document.createElement('summary');
			summary.className = 'toolGroupSummary';

			const arrow = document.createElement('span');
			arrow.className = 'codicon codicon-chevron-right toolGroupArrow';

			const title = document.createElement('div');
			title.className = 'toolGroupTitle';
			title.textContent = `${GROUP_LABEL[cat] || cat} ${GROUP_DESC[cat] ? GROUP_DESC[cat] : ''}`.trim();

			const meta = document.createElement('div');
			meta.className = 'toolGroupMeta';
			meta.textContent = `${tools.length} tools`;

			summary.appendChild(arrow);
			summary.appendChild(title);
			summary.appendChild(meta);
			details.appendChild(summary);

			const list = document.createElement('div');
			list.className = 'list toolGroupList';
			for (const t of tools) {
				list.appendChild(renderToolRow(t));
			}
			details.appendChild(list);

			builtinToolsEl.appendChild(details);
		}
	}

	function renderCommandTools() {
		if (!commandToolsEl) return;
		commandToolsEl.innerHTML = '';
		if (!commandTools.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No command tools.';
			commandToolsEl.appendChild(div);
			return;
		}
		for (const t of commandTools) {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = t.name;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			meta.textContent = `${t.command}${t.description ? ` · ${t.description}` : ''}`;
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!t.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setCommandToolEnabled', name: t.name, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);

			const remove = document.createElement('button');
			remove.className = 'ghost';
			remove.textContent = 'Remove';
			remove.addEventListener('click', () => {
				vscode.postMessage({ type: 'removeCommandTool', name: t.name });
			});

			right.appendChild(toggle);
			right.appendChild(remove);

			row.appendChild(left);
			row.appendChild(right);
			commandToolsEl.appendChild(row);
		}
	}

	function toolNameFromCommandId(commandId) {
		const raw = String(commandId ?? '').trim();
		if (!raw) return '';
		const base = raw
			.split('.')
			.slice(-2)
			.join('_')
			.replace(/[^A-Za-z0-9_.\-]/g, '_');
		let name = base || raw.replace(/[^A-Za-z0-9_.\-]/g, '_');
		const existing = new Set((commandTools || []).map((t) => String(t?.name ?? '')));
		if (!existing.has(name)) return name;
		let i = 2;
		while (existing.has(`${name}_${i}`)) i++;
		return `${name}_${i}`;
	}

	function renderDiscoveredCommands() {
		if (!cmdDiscoverListEl) return;
		cmdDiscoverListEl.innerHTML = '';
		if (!discoveredCommands.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No command search results.';
			cmdDiscoverListEl.appendChild(div);
			return;
		}

		for (const id of discoveredCommands) {
			const row = document.createElement('div');
			row.className = 'row';

			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = id;
			left.appendChild(name);

			const right = document.createElement('div');
			right.className = 'rowRight';

			const add = document.createElement('button');
			add.className = 'ghost';
			add.textContent = 'Add as Tool';
			add.addEventListener('click', () => {
				const toolName = toolNameFromCommandId(id);
				if (!toolName) return;
				vscode.postMessage({
					type: 'addCommandTool',
					tool: { name: toolName, command: id, description: undefined, enabled: true }
				});
			});

			right.appendChild(add);
			row.appendChild(left);
			row.appendChild(right);
			cmdDiscoverListEl.appendChild(row);
		}
	}

	function renderMcpServers() {
		if (!mcpServersEl) return;
		mcpServersEl.innerHTML = '';
		if (!mcpServers.length) {
			const div = document.createElement('div');
			div.className = 'empty';
			div.textContent = 'No MCP servers.';
			mcpServersEl.appendChild(div);
			return;
		}
		for (const s of mcpServers) {
			const row = document.createElement('div');
			row.className = 'row';
			const left = document.createElement('div');
			const name = document.createElement('div');
			name.className = 'modelName';
			name.textContent = s.name;
			const meta = document.createElement('div');
			meta.className = 'modelMeta';
			const statusText = s.status === 'connected'
				? `Connected · ${s.toolCount} tools`
				: s.status === 'connecting'
				? 'Connecting…'
				: s.status === 'error'
				? `Error${s.lastError ? ` · ${s.lastError}` : ''}`
				: 'Disconnected';
			meta.textContent = `${s.id} · ${s.transport} · ${statusText}`;
			left.appendChild(name);
			left.appendChild(meta);

			const right = document.createElement('div');
			right.className = 'rowRight';
			const toggle = document.createElement('label');
			toggle.className = 'toggle';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.checked = !!s.enabled;
			input.addEventListener('change', () => {
				vscode.postMessage({ type: 'setMcpServerEnabled', id: s.id, enabled: input.checked });
			});
			const slider = document.createElement('span');
			slider.className = 'slider';
			toggle.appendChild(input);
			toggle.appendChild(slider);

			const remove = document.createElement('button');
			remove.className = 'ghost';
			remove.textContent = 'Remove';
			remove.addEventListener('click', () => {
				vscode.postMessage({ type: 'removeMcpServer', id: s.id });
			});

			right.appendChild(toggle);
			right.appendChild(remove);

			row.appendChild(left);
			row.appendChild(right);
			mcpServersEl.appendChild(row);
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;

		switch (msg.type) {
			case 'init':
				allModels = Array.isArray(msg.models) ? msg.models : [];
				enabledIds = new Set(Array.isArray(msg.visibleModelIds) ? msg.visibleModelIds : []);
					defaultModelId = msg.defaultModelId ? String(msg.defaultModelId) : '';
					modelsStatus = msg.modelsStatus ?? modelsStatus;
				agentProfiles = Array.isArray(msg.agentProfiles) ? msg.agentProfiles : [];
				activeAgentProfileId = String(msg.activeAgentProfileId || activeAgentProfileId);
				followChatProfile = msg.followChatProfile !== undefined ? !!msg.followChatProfile : followChatProfile;
				syncChatProfileFromSettings = msg.syncChatProfileFromSettings !== undefined ? !!msg.syncChatProfileFromSettings : syncChatProfileFromSettings;
				editsEnableHealing = msg.editsEnableHealing !== undefined ? !!msg.editsEnableHealing : editsEnableHealing;
				builtinTools = Array.isArray(msg.builtinTools) ? msg.builtinTools : [];
				builtinToolCategories = msg.builtinToolCategories && typeof msg.builtinToolCategories === 'object' ? msg.builtinToolCategories : {};
				commandTools = Array.isArray(msg.commandTools) ? msg.commandTools : [];
				mcpServers = Array.isArray(msg.mcpServers) ? msg.mcpServers : [];
				customAgents = Array.isArray(msg.customAgents) ? msg.customAgents : [];
				triLcAgents = Array.isArray(msg.triLcAgents) ? msg.triLcAgents : [];
				triLcStaffing = msg.triLcStaffing !== undefined ? msg.triLcStaffing : triLcStaffing;
				renderAgentProfiles();
				renderFollowChatProfile();
				renderSyncChatProfileFromSettings();
				renderEditsEnableHealing();
				renderProfileEditsEnableHealingMode();
				renderModelsStatus();
				render();
				renderBuiltinTools();
				renderCommandTools();
				renderMcpServers();
				renderCustomAgents();
				renderDiscoveredCommands();
				renderTriLcAgents();
				if (msg.initialPage) {
					setPage(String(msg.initialPage));
				}
				return;
			case 'update':
				allModels = Array.isArray(msg.models) ? msg.models : allModels;
				enabledIds = new Set(Array.isArray(msg.visibleModelIds) ? msg.visibleModelIds : Array.from(enabledIds));
					if (msg.defaultModelId !== undefined) defaultModelId = msg.defaultModelId ? String(msg.defaultModelId) : '';
					modelsStatus = msg.modelsStatus ?? modelsStatus;
				agentProfiles = Array.isArray(msg.agentProfiles) ? msg.agentProfiles : agentProfiles;
				activeAgentProfileId = msg.activeAgentProfileId ? String(msg.activeAgentProfileId) : activeAgentProfileId;
				followChatProfile = msg.followChatProfile !== undefined ? !!msg.followChatProfile : followChatProfile;
				syncChatProfileFromSettings = msg.syncChatProfileFromSettings !== undefined ? !!msg.syncChatProfileFromSettings : syncChatProfileFromSettings;
				editsEnableHealing = msg.editsEnableHealing !== undefined ? !!msg.editsEnableHealing : editsEnableHealing;
				builtinTools = Array.isArray(msg.builtinTools) ? msg.builtinTools : builtinTools;
				builtinToolCategories = msg.builtinToolCategories && typeof msg.builtinToolCategories === 'object' ? msg.builtinToolCategories : builtinToolCategories;
				commandTools = Array.isArray(msg.commandTools) ? msg.commandTools : commandTools;
				mcpServers = Array.isArray(msg.mcpServers) ? msg.mcpServers : mcpServers;
				customAgents = Array.isArray(msg.customAgents) ? msg.customAgents : customAgents;
				if (msg.triLcAgents !== undefined) triLcAgents = Array.isArray(msg.triLcAgents) ? msg.triLcAgents : triLcAgents;
				if (msg.triLcStaffing !== undefined) triLcStaffing = msg.triLcStaffing;
				renderAgentProfiles();
				renderFollowChatProfile();
				renderSyncChatProfileFromSettings();
				renderEditsEnableHealing();
				renderProfileEditsEnableHealingMode();
				renderModelsStatus();
				render();
				renderBuiltinTools();
				renderCommandTools();
				renderMcpServers();
				renderCustomAgents();
				renderDiscoveredCommands();
				renderTriLcAgents();
				return;
			case 'setPage':
				setPage(String(msg.page || 'models'));
				return;
			case 'discoveredCommands':
				discoveredCommands = Array.isArray(msg.commands) ? msg.commands : [];
				renderDiscoveredCommands();
				return;
				case 'setDefaultModel':
					// Handled by extension.ts — no local action needed
					return;
			}
	});


	searchEl.addEventListener('input', () => render());
	refreshEl.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));

	for (const el of navEls) {
		el.addEventListener('click', () => {
			const page = el.getAttribute('data-page') || 'models';
			setPage(page);
		});
	}

	agentProfileSelectEl?.addEventListener('change', () => {
		const id = String(agentProfileSelectEl.value || '').trim();
		if (!id) return;
		activeAgentProfileId = id;
		vscode.postMessage({ type: 'setActiveAgentProfile', id });
		renderProfileEditsEnableHealingMode();
	});

	followChatProfileEl?.addEventListener('change', () => {
		followChatProfile = !!followChatProfileEl.checked;
		vscode.postMessage({ type: 'setFollowChatProfile', enabled: followChatProfile });
	});

	syncChatProfileFromSettingsEl?.addEventListener('change', () => {
		syncChatProfileFromSettings = !!syncChatProfileFromSettingsEl.checked;
		vscode.postMessage({ type: 'setSyncChatProfileFromSettings', enabled: syncChatProfileFromSettings });
	});

	editsEnableHealingEl?.addEventListener('change', () => {
		editsEnableHealing = !!editsEnableHealingEl.checked;
		vscode.postMessage({ type: 'setEditsEnableHealing', enabled: editsEnableHealing });
	});

	profileEditsEnableHealingModeEl?.addEventListener('change', () => {
		const mode = String(profileEditsEnableHealingModeEl.value || 'inherit');
		profileEditsEnableHealingMode = mode;
		vscode.postMessage({
			type: 'setAgentProfileEditsEnableHealing',
			id: activeAgentProfileId,
			mode: mode === 'on' ? 'on' : mode === 'off' ? 'off' : 'inherit'
		});
	});

	agentProfileAddEl?.addEventListener('click', () => {
		const id = String(agentProfileIdEl?.value ?? '').trim();
		const name = String(agentProfileNameEl?.value ?? '').trim();
		if (!id || !name) return;
		vscode.postMessage({ type: 'addAgentProfile', profile: { id, name } });
		agentProfileIdEl.value = '';
		agentProfileNameEl.value = '';
	});

	agentProfileRemoveEl?.addEventListener('click', () => {
		const id = String(activeAgentProfileId || '').trim();
		if (!id) return;
		vscode.postMessage({ type: 'removeAgentProfile', id });
	});

	cmdToolAddEl?.addEventListener('click', () => {
		const name = String(cmdToolNameEl?.value ?? '').trim();
		const command = String(cmdToolCommandEl?.value ?? '').trim();
		const description = String(cmdToolDescEl?.value ?? '').trim();
		if (!name || !command) return;
		vscode.postMessage({
			type: 'addCommandTool',
			tool: { name, command, description: description || undefined, enabled: true }
		});
		cmdToolNameEl.value = '';
		cmdToolCommandEl.value = '';
		cmdToolDescEl.value = '';
	});

	cmdDiscoverEl?.addEventListener('click', () => {
		const query = String(cmdDiscoverQueryEl?.value ?? '').trim();
		vscode.postMessage({ type: 'discoverCommands', query });
	});
	cmdDiscoverQueryEl?.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		const query = String(cmdDiscoverQueryEl?.value ?? '').trim();
		vscode.postMessage({ type: 'discoverCommands', query });
	});

	mcpAddEl?.addEventListener('click', () => {
		const id = String(mcpIdEl?.value ?? '').trim();
		const name = String(mcpNameEl?.value ?? '').trim();
		const transport = String(mcpTransportEl?.value ?? 'stdio');
		const url = String(mcpUrlEl?.value ?? '').trim();
		const command = String(mcpCommandEl?.value ?? '').trim();
		const argsText = String(mcpArgsEl?.value ?? '').trim();
		let args;
		if (argsText) {
			try {
				args = JSON.parse(argsText);
				if (!Array.isArray(args)) args = undefined;
			} catch {
				args = undefined;
			}
		}
		if (!id || !name) return;
		vscode.postMessage({
			type: 'upsertMcpServer',
			server: {
				id,
				name,
				transport,
				enabled: true,
				url: url || undefined,
				command: command || undefined,
				args
			}
		});
	});

	mcpRefreshEl?.addEventListener('click', () => vscode.postMessage({ type: 'refreshToolsAndMcp' }));

	customAgentRefreshEl?.addEventListener('click', () => vscode.postMessage({ type: 'refreshCustomAgents' }));
	agentsRefreshEl?.addEventListener('click', () => vscode.postMessage({ type: 'refreshAgents' }));
	customAgentCreateEl?.addEventListener('click', () => {
		const base = String(customAgentFileBaseEl?.value ?? '').trim();
		if (!base) return;
		vscode.postMessage({ type: 'createWorkspaceCustomAgent', fileBaseName: base });
		customAgentFileBaseEl.value = '';
	});

	setPage('models');

	vscode.postMessage({ type: 'webviewReady' });
})();
