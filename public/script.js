const stateDiv = document.getElementById('state');
const logsEl = document.getElementById('logs');
const actionBox = document.getElementById('actionBox');
const nextBtn = document.getElementById('nextBtn');

let current = null;

async function post(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function renderState(s) {
  current = s;
  const statusText = s.status === 'ended'
    ? `已结束，胜利方：${s.winner === 'good' ? '好人' : '狼人'}`
    : `进行中（第${s.day}天，${s.phase === 'night' ? '夜晚' : '白天'}）`;

  stateDiv.innerHTML = `
    <div><strong>${statusText}</strong></div>
    <div>你的身份：<strong>${roleName(s.userRole)}</strong></div>
    <div style="margin-top:8px;">${s.players
      .map((p) => `<span class="badge">${p.name} ${p.alive ? '🟢' : '💀'} ${p.role ? '·' + roleName(p.role) : ''}</span>`)
      .join('')}</div>
  `;

  logsEl.textContent = s.logs.join('\n');
  logsEl.scrollTop = logsEl.scrollHeight;

  renderAction(s.pendingAction);
  nextBtn.classList.toggle('hidden', !!s.pendingAction || s.status === 'ended');
}

function roleName(role) {
  return {
    werewolf: '狼人',
    villager: '村民',
    witch: '女巫',
    seer: '预言家',
  }[role] || role;
}

function renderAction(pending) {
  actionBox.innerHTML = '';
  actionBox.classList.toggle('hidden', !pending);
  if (!pending) return;

  const title = document.createElement('div');
  title.innerHTML = `<strong>待操作：</strong>${pending.prompt}`;
  actionBox.appendChild(title);

  let speechInput = null;
  if (pending.withSpeech) {
    speechInput = document.createElement('textarea');
    speechInput.placeholder = '你的发言（可选，80字内）';
    speechInput.maxLength = 80;
    speechInput.style.width = '100%';
    speechInput.style.marginTop = '8px';
    actionBox.appendChild(speechInput);
  }

  const select = document.createElement('select');
  select.style.marginTop = '8px';
  pending.options.forEach((o) => {
    const op = document.createElement('option');
    op.value = o.id;
    op.textContent = `${o.id} - ${o.name}`;
    select.appendChild(op);
  });
  actionBox.appendChild(select);

  const btn = document.createElement('button');
  btn.textContent = '提交操作';
  btn.style.marginLeft = '8px';
  btn.onclick = async () => {
    try {
      const body = { actionId: select.value };
      if (speechInput) body.speech = speechInput.value;
      const s = await post('/api/action', body);
      renderState(s);
    } catch (e) {
      alert(e.message);
    }
  };
  actionBox.appendChild(btn);
}

document.getElementById('startBtn').onclick = async () => {
  try {
    const s = await post('/api/new-game', {
      userName: document.getElementById('userName').value,
      baseURL: document.getElementById('baseURL').value,
      apiKey: document.getElementById('apiKey').value,
      model: document.getElementById('model').value,
    });
    renderState(s);
  } catch (e) {
    alert(e.message);
  }
};

nextBtn.onclick = async () => {
  try {
    const s = await post('/api/next');
    renderState(s);
  } catch (e) {
    alert(e.message);
  }
};
