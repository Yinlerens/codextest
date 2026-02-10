const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const ROLES = ['werewolf', 'werewolf', 'villager', 'villager', 'witch', 'seer'];
const ROLE_CN = { werewolf: '狼人', villager: '村民', witch: '女巫', seer: '预言家' };

let game = null;

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const getPlayer = (state, id) => state.players.find((p) => p.id === id);
const livingByRole = (state, role) => state.players.filter((p) => p.alive && p.role === role);

function checkWinner(state) {
  const wolves = livingByRole(state, 'werewolf').length;
  const good = state.players.filter((p) => p.alive).length - wolves;
  if (wolves <= 0) return 'good';
  if (wolves >= good) return 'wolf';
  return null;
}

function cleanState(state) {
  return {
    day: state.day,
    phase: state.phase,
    status: state.status,
    winner: state.winner,
    userPlayerId: state.userPlayerId,
    userRole: getPlayer(state, state.userPlayerId)?.role,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      isUser: p.isUser,
      role: p.alive || p.isUser || state.status === 'ended' ? p.role : null,
    })),
    logs: state.logs.slice(-120),
    pendingAction: state.pendingAction,
  };
}

async function callOpenAICompatible(state, systemPrompt, userPrompt) {
  if (!state.config.apiKey || !state.config.baseURL || !state.config.model) return null;
  const url = state.config.baseURL.replace(/\/$/, '') + '/chat/completions';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.config.apiKey}` },
      body: JSON.stringify({
        model: state.config.model,
        temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
    });
    if (!resp.ok) {
      state.logs.push(`⚠️ AI接口错误 ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    state.logs.push(`⚠️ AI接口调用失败: ${err.message}`);
    return null;
  }
}

function extractTargetByName(text, candidates) {
  if (!text) return null;
  for (const c of candidates) if (text.includes(c.name)) return c.id;
  const m = text.match(/P\d+/i);
  if (m && candidates.some((c) => c.id === m[0].toUpperCase())) return m[0].toUpperCase();
  return null;
}

async function aiChooseTarget(state, actor, candidates, instruction) {
  if (candidates.length === 1) return candidates[0].id;
  const prompt = `${instruction}\n你是${actor.name}(${ROLE_CN[actor.role]})。候选：${candidates
    .map((c) => `${c.id}(${c.name})`)
    .join('、')}。只回答一个目标ID或名字。`;
  const ans = await callOpenAICompatible(state, '你在玩狼人杀，严格按要求输出。', prompt);
  return extractTargetByName(ans, candidates) || candidates[Math.floor(Math.random() * candidates.length)].id;
}

async function aiSpeech(state, actor) {
  const alive = state.players.filter((p) => p.alive).map((p) => p.name).join('、');
  const prompt = `你在狼人杀白天发言，玩家${actor.name}，身份${ROLE_CN[actor.role]}（仅你知道）。存活:${alive}。输出1-2句中文，不超过45字。`;
  return (await callOpenAICompatible(state, '你是狼人杀玩家，发言简短自然。', prompt)) || '我建议大家根据昨夜信息谨慎投票。';
}

function createGame({ userName, apiKey, baseURL, model }) {
  const names = [userName || '你', 'AI-阿尔法', 'AI-贝塔', 'AI-伽马', 'AI-德尔塔', 'AI-西格玛'];
  const roles = shuffle(ROLES);
  return {
    day: 1,
    phase: 'night',
    status: 'running',
    winner: null,
    userPlayerId: 'P1',
    players: names.map((name, idx) => ({ id: `P${idx + 1}`, name, role: roles[idx], alive: true, isUser: idx === 0 })),
    logs: [
      '游戏开始：6人局（2狼人、2村民、1女巫、1预言家）。',
      '规则：夜晚依次狼人刀人->预言家查验->女巫救/毒；白天全员发言并投票放逐。',
      '胜利条件：所有狼人出局则好人胜；狼人数量≥其余人数则狼人胜。',
    ],
    pendingAction: null,
    night: {
      step: 'wolf',
      wolfTarget: null,
      saveUsed: false,
      poisonUsed: false,
      savedTonight: false,
      poisonedTonight: null,
    },
    config: { apiKey: apiKey || '', baseURL: baseURL || '', model: model || '' },
  };
}

async function runNight(state) {
  if (state.night.step === 'wolf') {
    state.logs.push(`🌙 第${state.day}夜开始。`);
    const wolves = livingByRole(state, 'werewolf');
    if (wolves.length) {
      const candidates = state.players.filter((p) => p.alive && p.role !== 'werewolf');
      const decider = wolves[Math.floor(Math.random() * wolves.length)];
      if (decider.isUser) {
        state.pendingAction = { type: 'wolf_kill', actorId: decider.id, options: candidates.map((c) => ({ id: c.id, name: c.name })), prompt: '你是狼人，请选择今晚刀的目标。' };
        return;
      }
      state.night.wolfTarget = await aiChooseTarget(state, decider, candidates, '请选择今晚狼队要击杀的目标。');
      state.logs.push('🐺 狼人在暗中选定了目标。');
    }
    state.night.step = 'seer';
  }

  if (state.night.step === 'seer') {
    const seer = livingByRole(state, 'seer')[0];
    if (seer) {
      const candidates = state.players.filter((p) => p.alive && p.id !== seer.id);
      if (seer.isUser) {
        state.pendingAction = { type: 'seer_check', actorId: seer.id, options: candidates.map((c) => ({ id: c.id, name: c.name })), prompt: '你是预言家，请选择要查验的人。' };
        return;
      }
      const targetId = await aiChooseTarget(state, seer, candidates, '请选择你今晚查验的对象。');
      state.logs.push(`🔮 ${seer.name} 查验了 ${getPlayer(state, targetId).name}。`);
    }
    state.night.step = 'witch';
  }

  if (state.night.step === 'witch') {
    const witch = livingByRole(state, 'witch')[0];
    if (witch) {
      const wolfTarget = state.night.wolfTarget ? getPlayer(state, state.night.wolfTarget) : null;
      if (witch.isUser) {
        const options = [];
        if (!state.night.saveUsed && wolfTarget) options.push({ id: 'save', name: `使用解药救 ${wolfTarget.name}` });
        if (!state.night.poisonUsed) state.players.filter((x) => x.alive && x.id !== witch.id).forEach((p) => options.push({ id: `poison:${p.id}`, name: `使用毒药毒 ${p.name}` }));
        options.push({ id: 'skip', name: '跳过' });
        state.pendingAction = { type: 'witch_action', actorId: witch.id, options, prompt: wolfTarget ? `你是女巫，今晚${wolfTarget.name}将被刀。可选择救人、毒人或跳过。` : '你是女巫，可选择毒人或跳过。' };
        return;
      }
      if (!state.night.saveUsed && wolfTarget && Math.random() < 0.55) {
        state.night.savedTonight = true;
        state.night.saveUsed = true;
        state.logs.push('🧪 女巫使用了解药。');
      }
      if (!state.night.poisonUsed && Math.random() < 0.35) {
        const candidates = state.players.filter((p) => p.alive && p.id !== witch.id);
        state.night.poisonedTonight = await aiChooseTarget(state, witch, candidates, '你是女巫，可选择毒一个人。');
        state.night.poisonUsed = true;
        state.logs.push('☠️ 女巫在夜里使用了毒药。');
      }
    }
    state.night.step = 'done';
  }

  if (state.night.step === 'done') settleNight(state);
}

function settleNight(state) {
  const dead = [];
  if (state.night.wolfTarget && !state.night.savedTonight) {
    const victim = getPlayer(state, state.night.wolfTarget);
    if (victim?.alive) { victim.alive = false; dead.push(victim.name); }
  }
  if (state.night.poisonedTonight) {
    const victim = getPlayer(state, state.night.poisonedTonight);
    if (victim?.alive) { victim.alive = false; dead.push(victim.name); }
  }
  state.logs.push(dead.length ? `🌤️ 天亮了，昨夜死亡：${dead.join('、')}。` : '🌤️ 天亮了，昨夜是平安夜。');
  state.phase = 'day';

  const winner = checkWinner(state);
  if (winner) {
    state.status = 'ended';
    state.winner = winner;
    state.logs.push(winner === 'good' ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
  }
}

async function runDay(state) {
  state.logs.push(`☀️ 第${state.day}天讨论开始。`);
  for (const p of state.players.filter((x) => x.alive && !x.isUser)) state.logs.push(`💬 ${p.name}: ${await aiSpeech(state, p)}`);

  const user = getPlayer(state, state.userPlayerId);
  if (user.alive) {
    state.pendingAction = {
      type: 'user_vote', actorId: user.id, withSpeech: true,
      options: state.players.filter((p) => p.alive && p.id !== user.id).map((p) => ({ id: p.id, name: p.name })),
      prompt: '请输入你的发言（可选）并选择要投票放逐的玩家。',
    };
    return;
  }
  await resolveVoteWithoutUser(state, null);
}

async function resolveVoteWithoutUser(state, forcedUserVote) {
  const alive = state.players.filter((p) => p.alive);
  const tally = new Map();
  for (const actor of alive) {
    const candidates = alive.filter((p) => p.id !== actor.id);
    const targetId = actor.isUser && forcedUserVote ? forcedUserVote : await aiChooseTarget(state, actor, candidates, '白天投票阶段，请选择你要放逐的对象。');
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
    state.logs.push(`🗳️ ${actor.name} 投票给 ${getPlayer(state, targetId).name}`);
  }
  let max = -1; let eliminated = null;
  for (const [id, c] of tally.entries()) if (c > max) { max = c; eliminated = id; }
  const out = getPlayer(state, eliminated);
  if (out) {
    out.alive = false;
    state.logs.push(`🚪 ${out.name} 被放逐出局。其身份是：${ROLE_CN[out.role]}。`);
  }

  const winner = checkWinner(state);
  if (winner) {
    state.status = 'ended';
    state.winner = winner;
    state.logs.push(winner === 'good' ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
    return;
  }

  state.day += 1;
  state.phase = 'night';
  state.night.step = 'wolf';
  state.night.savedTonight = false;
  state.night.poisonedTonight = null;
  state.night.wolfTarget = null;
}

async function progressGame(state) {
  if (state.status !== 'running' || state.pendingAction) return;
  if (state.phase === 'night') await runNight(state);
  if (state.status === 'running' && !state.pendingAction && state.phase === 'day') await runDay(state);
}

app.post('/api/new-game', async (req, res) => {
  const { userName, apiKey, baseURL, model } = req.body || {};
  game = createGame({ userName, apiKey, baseURL, model });
  await progressGame(game);
  res.json(cleanState(game));
});

app.post('/api/next', async (req, res) => {
  if (!game) return res.status(400).json({ error: '请先开始游戏' });
  await progressGame(game);
  res.json(cleanState(game));
});

app.post('/api/action', async (req, res) => {
  if (!game) return res.status(400).json({ error: '请先开始游戏' });
  const pending = game.pendingAction;
  if (!pending) return res.status(400).json({ error: '当前没有待处理动作' });

  const { actionId, speech } = req.body || {};

  if (pending.type === 'wolf_kill') {
    if (!pending.options.some((o) => o.id === actionId)) return res.status(400).json({ error: '非法目标' });
    game.night.wolfTarget = actionId;
    game.night.step = 'seer';
    game.logs.push('🐺 你选择了今晚的击杀目标。');
    game.pendingAction = null;
    await progressGame(game);
    return res.json(cleanState(game));
  }

  if (pending.type === 'seer_check') {
    const target = getPlayer(game, actionId);
    if (!target?.alive) return res.status(400).json({ error: '非法目标' });
    game.logs.push(`🔮 你查验了 ${target.name}，其身份是：${ROLE_CN[target.role]}。`);
    game.night.step = 'witch';
    game.pendingAction = null;
    await progressGame(game);
    return res.json(cleanState(game));
  }

  if (pending.type === 'witch_action') {
    if (actionId === 'save' && !game.night.saveUsed) {
      game.night.savedTonight = true;
      game.night.saveUsed = true;
      game.logs.push('🧪 你使用了解药。');
    } else if (actionId?.startsWith('poison:') && !game.night.poisonUsed) {
      const id = actionId.split(':')[1];
      const target = getPlayer(game, id);
      if (!target?.alive) return res.status(400).json({ error: '非法毒杀目标' });
      game.night.poisonedTonight = id;
      game.night.poisonUsed = true;
      game.logs.push(`☠️ 你使用毒药毒死了 ${target.name}。`);
    } else if (actionId !== 'skip') {
      return res.status(400).json({ error: '非法操作' });
    }
    game.night.step = 'done';
    game.pendingAction = null;
    await progressGame(game);
    return res.json(cleanState(game));
  }

  if (pending.type === 'user_vote') {
    if (speech) game.logs.push(`💬 你: ${String(speech).slice(0, 80)}`);
    if (!pending.options.some((o) => o.id === actionId)) return res.status(400).json({ error: '非法投票目标' });
    game.pendingAction = null;
    await resolveVoteWithoutUser(game, actionId);
    await progressGame(game);
    return res.json(cleanState(game));
  }

  return res.status(400).json({ error: '未知动作' });
});

app.get('/api/state', (req, res) => {
  if (!game) return res.status(404).json({ error: '暂无游戏' });
  res.json(cleanState(game));
});

app.listen(port, () => console.log(`Werewolf server running: http://localhost:${port}`));
