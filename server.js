const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const ROLE_CN = {
  wolf: '狼人',
  villager: '村民',
  witch: '女巫',
  seer: '预言家',
};
const REQUIRED_ROLE_COUNTS = { wolf: 2, villager: 2, witch: 1, seer: 1 };

let game = null;

const getPlayer = (id) => game.players.find((p) => p.id === id);
const alivePlayers = () => game.players.filter((p) => p.alive);
const aliveByRole = (role) => game.players.filter((p) => p.alive && p.role === role);

function countRoles(players) {
  const cnt = { wolf: 0, villager: 0, witch: 0, seer: 0 };
  for (const p of players) {
    if (cnt[p.role] === undefined) return null;
    cnt[p.role] += 1;
  }
  return cnt;
}

function validateSetup(players, modelConfigs) {
  if (!Array.isArray(players) || players.length !== 6) return '需要6名玩家';
  if (!Array.isArray(modelConfigs) || modelConfigs.length < 1) return '至少配置一个模型';

  const modelMap = new Map();
  for (const m of modelConfigs) {
    if (!m.key || !m.baseURL || !m.apiKey || !m.model) return '模型配置必须包含key/baseURL/apiKey/model';
    modelMap.set(m.key, m);
  }

  for (const p of players) {
    if (!p.name || !p.role || !p.modelKey) return '每位玩家都要设置名称、角色、模型';
    if (!modelMap.has(p.modelKey)) return `${p.name} 选择了不存在的模型`;
  }

  const cnt = countRoles(players);
  if (!cnt) return '角色非法';
  for (const [r, n] of Object.entries(REQUIRED_ROLE_COUNTS)) {
    if (cnt[r] !== n) return `角色数量不符合要求：${ROLE_CN[r]} 需要 ${n} 人`; 
  }
  return null;
}

function winnerCheck() {
  const wolves = aliveByRole('wolf').length;
  const good = alivePlayers().length - wolves;
  if (wolves <= 0) return 'good';
  if (wolves >= good) return 'wolf';
  return null;
}

function publicState() {
  return {
    status: game.status,
    day: game.day,
    phase: game.phase,
    step: game.step,
    userId: game.userId,
    winner: game.winner,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: game.status === 'ended' || p.id === game.userId || !p.alive ? p.role : null,
      modelKey: p.modelKey,
    })),
    pending: game.pending,
    logs: game.logs.slice(-180),
  };
}

function log(msg) { game.logs.push(msg); }
function setPending(payload) { game.pending = payload; }
function clearPending() { game.pending = null; }

async function callModel(modelCfg, systemPrompt, userPrompt, temperature = 0.7) {
  const url = modelCfg.baseURL.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelCfg.apiKey}` },
    body: JSON.stringify({
      model: modelCfg.model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`模型调用失败: ${resp.status} ${(await resp.text()).slice(0, 120)}`);
  const data = await resp.json();
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('模型返回为空');
  return out;
}

async function askPlayerChoice(player, instruction, candidates, allowNone = false) {
  const modelCfg = game.modelMap[player.modelKey];
  const prompt = `${instruction}\n你是${player.name}(${ROLE_CN[player.role]})。候选：${candidates.map((c) => `${c.id}(${c.name})`).join('、')}。${allowNone ? '可回答SKIP。' : ''}只回答一个ID${allowNone ? '或SKIP' : ''}。`;
  const text = await callModel(modelCfg, '你在狼人杀中做决策，严格按要求回答。', prompt, 0.4);
  if (allowNone && /SKIP|放弃|不选/i.test(text)) return null;
  const up = text.toUpperCase();
  for (const c of candidates) {
    if (up.includes(c.id.toUpperCase()) || up.includes(c.name.toUpperCase())) return c.id;
  }
  throw new Error(`${player.name} 未输出有效目标`);
}

async function askPlayerSpeech(player, hint = '') {
  const modelCfg = game.modelMap[player.modelKey];
  const text = await callModel(modelCfg, '你在狼人杀群聊发言，60字内。', `${hint}\n你是${player.name}，请发言。`, 0.8);
  return text.slice(0, 120);
}

function nightInit() {
  game.phase = 'night';
  game.step = 'wolf_kill';
  game.night = {
    wolfVotes: {},
    wolfTarget: null,
    seerTarget: null,
    witchSaved: false,
    poisonTarget: null,
  };
  log(`🌙 第${game.day}夜开始：狼人刀人 → 预言家验人 → 女巫技能`);
}

function dayInit() {
  game.phase = 'day';
  game.step = 'speech';
  log(`☀️ 第${game.day}天开始：发言 → 投票 → 遗言`);
}

function kill(id, reason) {
  const p = getPlayer(id);
  if (!p || !p.alive) return;
  p.alive = false;
  log(`💀 ${p.name} 出局（${reason}），身份：${ROLE_CN[p.role]}`);
  game.lastWordsQueue.push(id);
}

async function runNight() {
  // 1 狼人刀人（2狼投票，平票随机）
  if (game.step === 'wolf_kill') {
    const wolves = aliveByRole('wolf');
    const candidates = alivePlayers().filter((p) => p.role !== 'wolf');
    for (const wolf of wolves) {
      if (wolf.id === game.userId) {
        setPending({ type: 'wolf_kill', prompt: '狼人刀人：选择目标或放弃', allowAbstain: true, options: candidates.map((c) => ({ id: c.id, name: c.name })) });
        return;
      }
      const pick = await askPlayerChoice(wolf, '狼人夜间请选择击杀目标。', candidates, true);
      if (pick) game.night.wolfVotes[wolf.id] = pick;
    }
    const votes = Object.values(game.night.wolfVotes);
    if (votes.length) {
      const cnt = new Map();
      for (const v of votes) cnt.set(v, (cnt.get(v) || 0) + 1);
      let max = 0;
      for (const n of cnt.values()) max = Math.max(max, n);
      const tie = [...cnt.entries()].filter(([, n]) => n === max).map(([id]) => id);
      game.night.wolfTarget = tie[Math.floor(Math.random() * tie.length)];
      log('🐺 狼人投票完成。');
    } else {
      log('🐺 狼人放弃刀人。');
    }
    game.step = 'seer_check';
  }

  // 2 预言家验人
  if (game.step === 'seer_check') {
    const seer = aliveByRole('seer')[0];
    if (seer) {
      const candidates = alivePlayers().filter((p) => p.id !== seer.id);
      if (seer.id === game.userId) {
        setPending({ type: 'seer_check', prompt: '预言家验人：选择一名玩家查验', options: candidates.map((c) => ({ id: c.id, name: c.name })) });
        return;
      }
      game.night.seerTarget = await askPlayerChoice(seer, '预言家夜间请选择查验目标。', candidates);
      log(`🔮 ${seer.name} 完成查验。`);
    }
    game.step = 'witch_action';
  }

  // 3 女巫技能（不可自救）
  if (game.step === 'witch_action') {
    const witch = aliveByRole('witch')[0];
    if (witch) {
      if (witch.id === game.userId) {
        const options = [{ id: 'skip', name: '跳过' }];
        if (!game.witch.saveUsed && game.night.wolfTarget && game.night.wolfTarget !== witch.id) {
          options.push({ id: 'save', name: `使用解药救 ${getPlayer(game.night.wolfTarget).name}` });
        }
        if (!game.witch.poisonUsed) {
          alivePlayers().filter((p) => p.id !== witch.id).forEach((p) => options.push({ id: `poison:${p.id}`, name: `使用毒药毒 ${p.name}` }));
        }
        setPending({ type: 'witch_action', prompt: '女巫行动：救/毒/跳过', options });
        return;
      }

      const modelCfg = game.modelMap[witch.modelKey];
      if (!game.witch.saveUsed && game.night.wolfTarget && game.night.wolfTarget !== witch.id) {
        const t = await callModel(modelCfg, '你是女巫，回答 SAVE 或 SKIP。', `今晚刀口是 ${getPlayer(game.night.wolfTarget).name}，是否使用解药？`, 0.2);
        if (/SAVE|救/i.test(t)) {
          game.witch.saveUsed = true;
          game.night.witchSaved = true;
          log('🧪 女巫使用了解药。');
        }
      }
      if (!game.witch.poisonUsed) {
        const cands = alivePlayers().filter((p) => p.id !== witch.id);
        const pick = await askPlayerChoice(witch, '女巫是否使用毒药？可SKIP。', cands, true);
        if (pick) {
          game.witch.poisonUsed = true;
          game.night.poisonTarget = pick;
          log('☠️ 女巫使用了毒药。');
        }
      }
    }
    game.step = 'night_settle';
  }

  if (game.step === 'night_settle') {
    const dead = [];
    if (game.night.wolfTarget && !game.night.witchSaved) dead.push({ id: game.night.wolfTarget, reason: 'wolf' });
    if (game.night.poisonTarget) dead.push({ id: game.night.poisonTarget, reason: 'poison' });
    if (!dead.length) log('🌤️ 平安夜。');
    for (const d of dead) kill(d.id, d.reason);

    const w = winnerCheck();
    if (w) return endGame(w);
    dayInit();
  }
}

async function runDay() {
  // 7 发言
  if (game.step === 'speech') {
    for (const p of alivePlayers()) {
      if (p.id === game.userId) {
        setPending({ type: 'day_speech', prompt: '白天发言：输入你的发言', options: [{ id: 'ok', name: '提交发言' }], withText: true });
        return;
      }
      const sp = await askPlayerSpeech(p, '白天发言阶段');
      log(`💬 ${p.name}: ${sp}`);
    }
    game.step = 'vote';
  }

  // 8 投票
  if (game.step === 'vote') {
    const voters = alivePlayers();
    const score = new Map();
    for (const v of voters) {
      const cands = voters.filter((p) => p.id !== v.id);
      if (v.id === game.userId) {
        setPending({ type: 'day_vote', prompt: '白天投票：选择放逐对象', options: cands.map((c) => ({ id: c.id, name: c.name })) });
        return;
      }
      const pick = await askPlayerChoice(v, '白天投票请选择放逐对象。', cands);
      score.set(pick, (score.get(pick) || 0) + 1);
      log(`🗳️ ${v.name} 投给 ${getPlayer(pick).name}`);
    }

    let max = 0;
    let tie = [];
    for (const [id, n] of score.entries()) {
      if (n > max) {
        max = n;
        tie = [id];
      } else if (n === max) tie.push(id);
    }
    if (tie.length) {
      const out = tie[Math.floor(Math.random() * tie.length)];
      kill(out, 'vote');
    }
    game.step = 'last_words';
  }

  // 9 遗言
  if (game.step === 'last_words') {
    for (const id of game.lastWordsQueue) {
      const p = getPlayer(id);
      if (!p) continue;
      if (id === game.userId) {
        setPending({ type: 'last_words', prompt: '遗言（文本模拟120秒）', options: [{ id: 'ok', name: '提交遗言' }], withText: true });
        return;
      }
      const lw = await askPlayerSpeech(p, '你已出局，请发表遗言');
      log(`🕯️ ${p.name} 遗言: ${lw}`);
    }
    game.lastWordsQueue = [];

    const w = winnerCheck();
    if (w) return endGame(w);

    game.day += 1;
    nightInit();
  }
}

function endGame(winner) {
  game.status = 'ended';
  game.winner = winner;
  log(winner === 'good' ? '🎉 好人阵营获胜' : '🐺 狼人阵营获胜');
}

async function progress() {
  if (!game || game.status !== 'running' || game.pending) return;
  if (game.phase === 'night') await runNight();
  if (!game.pending && game.phase === 'day' && game.status === 'running') await runDay();
}

app.post('/api/test-model', async (req, res) => {
  const { baseURL, apiKey, model } = req.body || {};
  if (!baseURL || !apiKey || !model) return res.status(400).json({ ok: false, error: 'baseURL/apiKey/model 必填' });
  try {
    const out = await callModel({ baseURL, apiKey, model }, '只回复 ok', 'reply ok', 0);
    res.json({ ok: true, reply: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/new-game', async (req, res) => {
  const { players, modelConfigs } = req.body || {};
  const err = validateSetup(players, modelConfigs);
  if (err) return res.status(400).json({ error: err });

  const modelMap = Object.fromEntries(modelConfigs.map((m) => [m.key, m]));
  game = {
    status: 'running',
    winner: null,
    day: 1,
    phase: 'night',
    step: 'wolf_kill',
    userId: 'P1',
    modelMap,
    players: players.map((p, i) => ({
      id: `P${i + 1}`,
      name: p.name,
      role: p.role,
      modelKey: p.modelKey,
      alive: true,
    })),
    witch: { saveUsed: false, poisonUsed: false },
    night: {},
    lastWordsQueue: [],
    pending: null,
    logs: [
      '📜 固定板子：2狼人、2村民、1女巫、1预言家。',
      '📜 开局前可手动设置每位玩家角色，并选择统一模型配置池中的模型。',
    ],
  };

  nightInit();
  await progress();
  res.json(publicState());
});

app.post('/api/action', async (req, res) => {
  if (!game) return res.status(400).json({ error: '请先开始游戏' });
  if (!game.pending) return res.status(400).json({ error: '当前没有待处理动作' });

  const { type } = game.pending;
  const { actionId, text } = req.body || {};

  if (type === 'wolf_kill') {
    if (actionId !== 'skip') game.night.wolfVotes[game.userId] = actionId;
    clearPending();
    await progress();
    return res.json(publicState());
  }

  if (type === 'seer_check') {
    const t = getPlayer(actionId);
    if (!t?.alive) return res.status(400).json({ error: '目标非法' });
    game.night.seerTarget = actionId;
    log(`🔮 你查验了 ${t.name}，身份：${ROLE_CN[t.role]}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }

  if (type === 'witch_action') {
    if (actionId === 'save') {
      if (game.witch.saveUsed) return res.status(400).json({ error: '解药已使用' });
      game.witch.saveUsed = true;
      game.night.witchSaved = true;
      log('🧪 你使用了解药。');
    } else if (String(actionId).startsWith('poison:')) {
      if (game.witch.poisonUsed) return res.status(400).json({ error: '毒药已使用' });
      const id = String(actionId).split(':')[1];
      if (!getPlayer(id)?.alive) return res.status(400).json({ error: '毒杀目标非法' });
      game.witch.poisonUsed = true;
      game.night.poisonTarget = id;
      log(`☠️ 你毒杀了 ${getPlayer(id).name}`);
    }
    clearPending();
    await progress();
    return res.json(publicState());
  }

  if (type === 'day_speech') {
    if (text) log(`💬 你: ${String(text).slice(0, 120)}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }

  if (type === 'day_vote') {
    if (!getPlayer(actionId)?.alive) return res.status(400).json({ error: '投票目标非法' });
    game.userVote = actionId;
    log(`🗳️ 你投给 ${getPlayer(actionId).name}`);
    clearPending();
    // 将用户票写入当轮计票：为简化，直接在下次runDay重新触发前追加处理
    // 这里通过临时字段在 runDay 内生效
    game.pendingUserVote = actionId;
    // 手动结算本轮（因为 runDay 在等待用户时中断）
    const voters = alivePlayers();
    const score = new Map();
    for (const v of voters) {
      if (v.id === game.userId) {
        score.set(actionId, (score.get(actionId) || 0) + 1);
        continue;
      }
      const cands = voters.filter((p) => p.id !== v.id);
      const pick = await askPlayerChoice(v, '白天投票请选择放逐对象。', cands);
      score.set(pick, (score.get(pick) || 0) + 1);
      log(`🗳️ ${v.name} 投给 ${getPlayer(pick).name}`);
    }
    let max = 0;
    let tie = [];
    for (const [id, n] of score.entries()) {
      if (n > max) {
        max = n;
        tie = [id];
      } else if (n === max) tie.push(id);
    }
    if (tie.length) {
      const out = tie[Math.floor(Math.random() * tie.length)];
      kill(out, 'vote');
    }
    game.step = 'last_words';
    await progress();
    return res.json(publicState());
  }

  if (type === 'last_words') {
    if (text) log(`🕯️ 你的遗言: ${String(text).slice(0, 180)}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }

  return res.status(400).json({ error: '未知动作' });
});

app.get('/api/state', (req, res) => {
  if (!game) return res.status(404).json({ error: '暂无游戏' });
  res.json(publicState());
});

app.listen(port, () => console.log(`Werewolf app running at http://localhost:${port}`));
