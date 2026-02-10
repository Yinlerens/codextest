const messagesEl = document.getElementById('messages');
const metaEl = document.getElementById('meta');
const actionPanel = document.getElementById('actionPanel');
const playersConfigEl = document.getElementById('playersConfig');

const defaultPlayers = Array.from({ length: 10 }).map((_, i) => ({
  name: i === 0 ? '你' : `AI-${i}`,
  api: { baseURL: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  tested: false,
}));

let state = null;

function playerCard(p, idx) {
  return `
    <div class="player-card" data-idx="${idx}">
      <h3>P${idx + 1} ${p.name}</h3>
      <label>名称<input class="name" value="${p.name}" /></label>
      <label>Base URL<input class="baseURL" value="${p.api.baseURL}" /></label>
      <label>API Key<input class="apiKey" type="password" value="${p.api.apiKey}" /></label>
      <label>Model<input class="model" value="${p.api.model}" /></label>
      <div class="inline">
        <button class="testBtn">测试通信</button>
        <span class="result">${p.tested ? '✅ 已通过' : '未测试'}</span>
      </div>
    </div>
  `;
}

function renderPlayersConfig() {
  playersConfigEl.innerHTML = defaultPlayers.map((p, i) => playerCard(p, i)).join('');
  [...playersConfigEl.querySelectorAll('.player-card')].forEach((card) => {
    const idx = Number(card.dataset.idx);
    const bind = () => {
      defaultPlayers[idx].name = card.querySelector('.name').value;
      defaultPlayers[idx].api.baseURL = card.querySelector('.baseURL').value;
      defaultPlayers[idx].api.apiKey = card.querySelector('.apiKey').value;
      defaultPlayers[idx].api.model = card.querySelector('.model').value;
      defaultPlayers[idx].tested = false;
      card.querySelector('.result').textContent = '未测试';
    };
    card.querySelectorAll('input').forEach((i) => i.addEventListener('change', bind));
    card.querySelector('.testBtn').onclick = async () => {
      bind();
      const result = card.querySelector('.result');
      result.textContent = '测试中...';
      try {
        const res = await fetch('/api/test-api', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(defaultPlayers[idx].api),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '失败');
        defaultPlayers[idx].tested = true;
        result.textContent = '✅ 已通过';
      } catch (e) {
        defaultPlayers[idx].tested = false;
        result.textContent = `❌ ${e.message}`;
      }
    };
  });
}

function renderState(s) {
  state = s;
  metaEl.innerHTML = `状态：${s.status} | 第${s.day}天 | ${s.phase}/${s.step} | 警长：${s.sheriffId || '无'} | 胜方：${s.winner || '未结束'}`;
  messagesEl.innerHTML = s.logs.map((l) => `<div class="msg">${l}</div>`).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderAction(s.pending);
}

function renderAction(pending) {
  actionPanel.innerHTML = '';
  actionPanel.classList.toggle('hidden', !pending);
  if (!pending) return;

  const title = document.createElement('div');
  title.textContent = pending.prompt;
  actionPanel.appendChild(title);

  let textArea = null;
  if (pending.withText) {
    textArea = document.createElement('textarea');
    textArea.placeholder = '输入文本';
    actionPanel.appendChild(textArea);
  }

  const sel = document.createElement('select');
  const extra = pending.allowAbstain ? [{ id: 'skip', name: '放弃选择' }] : [];
  [...extra, ...(pending.options || [])].forEach((o) => {
    const op = document.createElement('option');
    op.value = o.id;
    op.textContent = `${o.id} - ${o.name}`;
    sel.appendChild(op);
  });
  actionPanel.appendChild(sel);

  const btn = document.createElement('button');
  btn.textContent = '提交';
  btn.onclick = async () => {
    try {
      const res = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: sel.value, text: textArea?.value || '' }),
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
  if (defaultPlayers.some((p) => !p.api.baseURL || !p.api.apiKey || !p.api.model)) {
    alert('每位玩家都必须填写完整 API 配置');
    return;
  }
  try {
    const res = await fetch('/api/new-game', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: defaultPlayers.map((p) => ({ name: p.name, api: p.api })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '开局失败');
    renderState(data);
  } catch (e) {
    alert(e.message);
  }
};

document.getElementById('refreshBtn').onclick = refreshState;
renderPlayersConfig();
refreshState();
