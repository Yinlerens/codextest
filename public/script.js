const messagesEl = document.getElementById('messages');
const metaEl = document.getElementById('meta');
const actionPanel = document.getElementById('actionPanel');
const modelsConfigEl = document.getElementById('modelsConfig');
const playersConfigEl = document.getElementById('playersConfig');

const ROLE_OPTS = [
  { value: 'wolf', label: '狼人' },
  { value: 'villager', label: '村民' },
  { value: 'witch', label: '女巫' },
  { value: 'seer', label: '预言家' },
];

const modelConfigs = [
  { key: 'model1', name: '模型一', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', tested: false },
  { key: 'model2', name: '模型二', baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', tested: false },
];

const players = [
  { name: '你', role: 'seer', modelKey: 'model1' },
  { name: 'AI-1', role: 'witch', modelKey: 'model1' },
  { name: 'AI-2', role: 'wolf', modelKey: 'model1' },
  { name: 'AI-3', role: 'wolf', modelKey: 'model2' },
  { name: 'AI-4', role: 'villager', modelKey: 'model2' },
  { name: 'AI-5', role: 'villager', modelKey: 'model2' },
];

function modelCard(m, idx) {
  return `
    <div class="player-card" data-mid="${idx}">
      <h3>${m.name} (${m.key})</h3>
      <label>Base URL<input class="baseURL" value="${m.baseURL}" /></label>
      <label>API Key<input class="apiKey" type="password" value="${m.apiKey}" /></label>
      <label>Model<input class="model" value="${m.model}" /></label>
      <div class="inline">
        <button class="testModelBtn">测试通信</button>
        <span class="result">${m.tested ? '✅ 已通过' : '未测试'}</span>
      </div>
    </div>
  `;
}

function playerCard(p, idx) {
  return `
    <div class="player-card" data-pid="${idx}">
      <h3>P${idx + 1}</h3>
      <label>名称<input class="name" value="${p.name}" /></label>
      <label>角色
        <select class="role">
          ${ROLE_OPTS.map((r) => `<option value="${r.value}" ${r.value === p.role ? 'selected' : ''}>${r.label}</option>`).join('')}
        </select>
      </label>
      <label>模型
        <select class="modelKey">
          ${modelConfigs.map((m) => `<option value="${m.key}" ${m.key === p.modelKey ? 'selected' : ''}>${m.name}</option>`).join('')}
        </select>
      </label>
    </div>
  `;
}

function renderModels() {
  modelsConfigEl.innerHTML = modelConfigs.map(modelCard).join('');
  [...modelsConfigEl.querySelectorAll('[data-mid]')].forEach((card) => {
    const idx = Number(card.dataset.mid);
    const bind = () => {
      modelConfigs[idx].baseURL = card.querySelector('.baseURL').value;
      modelConfigs[idx].apiKey = card.querySelector('.apiKey').value;
      modelConfigs[idx].model = card.querySelector('.model').value;
      modelConfigs[idx].tested = false;
      card.querySelector('.result').textContent = '未测试';
    };
    card.querySelectorAll('input').forEach((el) => el.addEventListener('change', bind));
    card.querySelector('.testModelBtn').onclick = async () => {
      bind();
      const result = card.querySelector('.result');
      result.textContent = '测试中...';
      try {
        const res = await fetch('/api/test-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseURL: modelConfigs[idx].baseURL, apiKey: modelConfigs[idx].apiKey, model: modelConfigs[idx].model }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '失败');
        modelConfigs[idx].tested = true;
        result.textContent = '✅ 已通过';
      } catch (e) {
        modelConfigs[idx].tested = false;
        result.textContent = `❌ ${e.message}`;
      }
    };
  });
}

function renderPlayers() {
  playersConfigEl.innerHTML = players.map(playerCard).join('');
  [...playersConfigEl.querySelectorAll('[data-pid]')].forEach((card) => {
    const idx = Number(card.dataset.pid);
    const bind = () => {
      players[idx].name = card.querySelector('.name').value;
      players[idx].role = card.querySelector('.role').value;
      players[idx].modelKey = card.querySelector('.modelKey').value;
    };
    card.querySelectorAll('input,select').forEach((el) => el.addEventListener('change', bind));
  });
}

function validateRoleCount() {
  const cnt = { wolf: 0, villager: 0, witch: 0, seer: 0 };
  for (const p of players) cnt[p.role] += 1;
  return cnt.wolf === 2 && cnt.villager === 2 && cnt.witch === 1 && cnt.seer === 1;
}

function renderState(s) {
  metaEl.innerHTML = `状态：${s.status} | 第${s.day}天 | ${s.phase}/${s.step} | 胜方：${s.winner || '未结束'}`;
  messagesEl.innerHTML = s.logs.map((l) => `<div class="msg">${l}</div>`).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderAction(s.pending);
}

function renderAction(pending) {
  actionPanel.innerHTML = '';
  actionPanel.classList.toggle('hidden', !pending);
  if (!pending) return;

  actionPanel.innerHTML = `<div>${pending.prompt}</div>`;
  let textArea = null;
  if (pending.withText) {
    textArea = document.createElement('textarea');
    textArea.placeholder = '输入文本';
    actionPanel.appendChild(textArea);
  }

  const select = document.createElement('select');
  const extra = pending.allowAbstain ? [{ id: 'skip', name: '放弃' }] : [];
  [...extra, ...(pending.options || [])].forEach((o) => {
    const op = document.createElement('option');
    op.value = o.id;
    op.textContent = `${o.id} - ${o.name}`;
    select.appendChild(op);
  });
  actionPanel.appendChild(select);

  const btn = document.createElement('button');
  btn.textContent = '提交操作';
  btn.onclick = async () => {
    try {
      const res = await fetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: select.value, text: textArea?.value || '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '提交失败');
      renderState(data);
    } catch (e) {
      alert(e.message);
    }
  };
  actionPanel.appendChild(btn);
}

async function refreshState() {
  const res = await fetch('/api/state');
  if (!res.ok) return;
  renderState(await res.json());
}

document.getElementById('startBtn').onclick = async () => {
  if (!validateRoleCount()) {
    alert('角色数量必须严格为：2狼人、2村民、1女巫、1预言家');
    return;
  }
  if (modelConfigs.some((m) => !m.baseURL || !m.apiKey || !m.model)) {
    alert('请先完成统一模型配置');
    return;
  }

  try {
    const res = await fetch('/api/new-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelConfigs: modelConfigs.map((m) => ({ key: m.key, baseURL: m.baseURL, apiKey: m.apiKey, model: m.model })),
        players: players.map((p) => ({ name: p.name, role: p.role, modelKey: p.modelKey })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '开局失败');
    renderState(data);
  } catch (e) {
    alert(e.message);
  }
};

document.getElementById('refreshBtn').onclick = refreshState;
renderModels();
renderPlayers();
refreshState();
