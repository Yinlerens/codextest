const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const ROLE_CN = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  idiot: '白痴',
  villager: '村民',
};

const DEFAULT_ROLES = ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'idiot', 'villager', 'villager'];

let game = null;

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const getPlayer = (id) => game.players.find((p) => p.id === id);
const alivePlayers = () => game.players.filter((p) => p.alive);
const aliveByRole = (role) => game.players.filter((p) => p.alive && p.role === role);

function requireApiConfig(players) {
  for (const p of players) {
    if (!p.api?.baseURL || !p.api?.apiKey || !p.api?.model) {
      return `${p.name} 缺少 API 配置`; 
    }
  }
  return null;
}

async function callPlayerLLM(player, systemPrompt, userPrompt, temperature = 0.7) {
  const { baseURL, apiKey, model } = player.api;
  const url = baseURL.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`${player.name} API失败: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${player.name} API返回为空`);
  return text;
}

function pickFromText(text, candidates) {
  const upper = String(text || '').toUpperCase();
  for (const c of candidates) {
    if (upper.includes(c.id.toUpperCase()) || upper.includes(c.name.toUpperCase())) return c.id;
  }
  return null;
}

function winnerCheck() {
  const wolves = aliveByRole('wolf').length;
  const others = alivePlayers().length - wolves;
  if (wolves <= 0) return 'good';
  if (wolves >= others) return 'wolf';
  return null;
}

function publicState() {
  return {
    day: game.day,
    phase: game.phase,
    step: game.step,
    status: game.status,
    sheriffId: game.sheriffId,
    userId: game.userId,
    winner: game.winner,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: game.status === 'ended' || p.id === game.userId || !p.alive ? p.role : null,
      isUser: p.id === game.userId,
      canVote: !p.idiotRevealed,
      apiReady: !!(p.api?.baseURL && p.api?.apiKey && p.api?.model),
    })),
    pending: game.pending,
    logs: game.logs.slice(-200),
  };
}

function log(msg) { game.logs.push(msg); }

function setPending(action) { game.pending = action; }

function clearPending() { game.pending = null; }

function startNight() {
  game.phase = 'night';
  game.step = 'wolf_kill';
  game.night = {
    wolfVotes: {},
    wolfAbstain: {},
    killTarget: null,
    seerTarget: null,
    witchSaved: false,
    witchPoisonTarget: null,
  };
  log(`🌙 第${game.day}夜：狼人刀人 / 预言家验人 / 女巫用药`);
}

function startDay() {
  game.phase = 'day';
  game.step = game.day === 1 && !game.sheriffDecided ? 'sheriff_signup' : 'speech';
  log(`☀️ 第${game.day}天开始。`);
}

async function askPlayerChoice(player, instruction, candidates, allowNone = false) {
  const prompt = `${instruction}\n候选: ${candidates.map((c) => `${c.id}(${c.name})`).join('、')}。${allowNone ? '可回答 NONE。' : ''}仅输出一个ID/名字${allowNone ? '或NONE' : ''}。`;
  const text = await callPlayerLLM(player, '你在狼人杀局中做决策，严格按格式输出。', prompt, 0.4);
  if (allowNone && /NONE|放弃|不选|SKIP/i.test(text)) return null;
  const picked = pickFromText(text, candidates);
  if (!picked) throw new Error(`${player.name} 未返回有效目标`);
  return picked;
}

async function askSpeech(player, extra = '') {
  return callPlayerLLM(player, '你在狼人杀群聊中发言。简洁，60字内。', `${extra}\n你是${player.name}(${ROLE_CN[player.role]})，请发言。`, 0.8);
}

function majorityWithRandomTie(votes) {
  const map = new Map();
  for (const v of votes) map.set(v, (map.get(v) || 0) + 1);
  let max = 0;
  for (const c of map.values()) max = Math.max(max, c);
  const tied = [...map.entries()].filter(([, n]) => n === max).map(([id]) => id);
  return tied[Math.floor(Math.random() * tied.length)];
}

function killPlayer(id, reason, allowHunterShot = true) {
  const p = getPlayer(id);
  if (!p || !p.alive) return;
  if (p.role === 'idiot' && reason === 'vote') {
    p.idiotRevealed = true;
    log(`🃏 ${p.name} 被公投后翻牌为白痴，不出局，失去投票权。`);
    return;
  }
  p.alive = false;
  log(`💀 ${p.name} 出局（${reason}），身份：${ROLE_CN[p.role]}`);
  if (p.role === 'hunter' && allowHunterShot && reason !== 'poison') {
    game.hunterCanShoot = p.id;
  }
  game.lastWordsQueue.push(p.id);
}

async function runNightFlow() {
  // 1 狼人刀人
  const wolves = aliveByRole('wolf');
  if (wolves.length) {
    const candidates = alivePlayers().filter((p) => p.role !== 'wolf');
    for (const wolf of wolves) {
      if (wolf.id === game.userId) {
        setPending({ type: 'wolf_kill', prompt: '狼人行动：选择击杀目标或放弃', allowAbstain: true, options: candidates.map((p) => ({ id: p.id, name: p.name })) });
        return;
      }
      const picked = await askPlayerChoice(wolf, '狼人夜间刀人，你可以放弃。', candidates, true);
      if (picked) game.night.wolfVotes[wolf.id] = picked;
      else game.night.wolfAbstain[wolf.id] = true;
    }
    const allVotes = Object.values(game.night.wolfVotes);
    if (allVotes.length) {
      game.night.killTarget = majorityWithRandomTie(allVotes);
      log('🐺 狼人完成夜间投票。');
    } else {
      log('🐺 狼人全体放弃刀人。');
    }
  }

  // 2 预言家验人
  const seer = aliveByRole('seer')[0];
  if (seer) {
    const cands = alivePlayers().filter((p) => p.id !== seer.id);
    if (seer.id === game.userId) {
      setPending({ type: 'seer_check', prompt: '预言家行动：选择查验目标', options: cands.map((p) => ({ id: p.id, name: p.name })) });
      return;
    }
    game.night.seerTarget = await askPlayerChoice(seer, '预言家夜间验人。', cands);
    const target = getPlayer(game.night.seerTarget);
    log(`🔮 ${seer.name} 查验了 ${target.name}`);
  }

  // 3 女巫技能
  const witch = aliveByRole('witch')[0];
  if (witch) {
    if (witch.id === game.userId) {
      const options = [{ id: 'skip', name: '不使用技能' }];
      if (!game.witch.saveUsed && game.night.killTarget && game.night.killTarget !== witch.id) {
        options.push({ id: 'save', name: `解药救 ${getPlayer(game.night.killTarget).name}` });
      }
      if (!game.witch.poisonUsed) {
        alivePlayers().filter((p) => p.id !== witch.id).forEach((p) => options.push({ id: `poison:${p.id}`, name: `毒杀 ${p.name}` }));
      }
      setPending({ type: 'witch_action', prompt: '女巫行动：可救/毒/跳过', options });
      return;
    }
    // AI女巫遵循规则：不可自救
    if (!game.witch.saveUsed && game.night.killTarget && game.night.killTarget !== witch.id) {
      const text = await callPlayerLLM(witch, '你是女巫，回答 SAVE 或 SKIP。', `今晚刀口是 ${getPlayer(game.night.killTarget).name}，是否使用解药？`);
      if (/SAVE|救/i.test(text)) {
        game.witch.saveUsed = true;
        game.night.witchSaved = true;
        log('🧪 女巫使用了解药。');
      }
    }
    if (!game.witch.poisonUsed) {
      const cands = alivePlayers().filter((p) => p.id !== witch.id);
      const picked = await askPlayerChoice(witch, '女巫是否使用毒药？可放弃。', cands, true);
      if (picked) {
        game.witch.poisonUsed = true;
        game.night.witchPoisonTarget = picked;
        log('☠️ 女巫使用了毒药。');
      }
    }
  }

  // 结算夜晚
  const dead = [];
  if (game.night.killTarget && !game.night.witchSaved) dead.push({ id: game.night.killTarget, reason: 'wolf' });
  if (game.night.witchPoisonTarget) dead.push({ id: game.night.witchPoisonTarget, reason: 'poison' });
  if (!dead.length) log('🌤️ 平安夜。');
  for (const d of dead) killPlayer(d.id, d.reason, d.reason !== 'poison');

  const w = winnerCheck();
  if (w) return endGame(w);

  startDay();
}

async function runSheriffElection() {
  // 6 警长竞选
  if (game.step === 'sheriff_signup') {
    game.sheriff = { signup: {}, speeches: [], candidates: [], dropped: {} };
    const alive = alivePlayers();
    for (const p of alive) {
      if (p.id === game.userId) {
        setPending({ type: 'sheriff_signup', prompt: '是否上警？（预言家必须上警）', options: [{ id: 'yes', name: '上警' }, { id: 'no', name: '不上警' }] });
        return;
      }
      let on = false;
      if (p.role === 'seer') on = true;
      else {
        const t = await callPlayerLLM(p, '回答 YES 或 NO。', '是否参与警长竞选？');
        on = /YES|上警|参加/i.test(t);
      }
      game.sheriff.signup[p.id] = on;
    }
    for (const p of alive) {
      if (p.role === 'seer') game.sheriff.signup[p.id] = true;
    }
    game.sheriff.candidates = alive.filter((p) => game.sheriff.signup[p.id]).map((p) => p.id);
    log(`👮 上警玩家：${game.sheriff.candidates.map((id) => getPlayer(id).name).join('、') || '无人'}`);
    game.step = 'sheriff_speech';
  }

  if (game.step === 'sheriff_speech') {
    for (const cid of game.sheriff.candidates) {
      const p = getPlayer(cid);
      if (!p?.alive || game.sheriff.dropped[cid]) continue;
      if (p.id === game.userId) {
        setPending({ type: 'sheriff_speech', prompt: '警长竞选发言（可顺带选择是否退水）', options: [{ id: 'stay', name: '继续竞选' }, { id: 'drop', name: '退水' }], withText: true });
        return;
      }
      const sp = await askSpeech(p, '你正在警长竞选发言。');
      log(`🗣️ [警上] ${p.name}: ${sp.slice(0, 120)}`);
      const drop = await callPlayerLLM(p, '回答 STAY 或 DROP。', '你发言后是否退水？');
      if (/DROP|退水/i.test(drop) && p.role !== 'seer') {
        game.sheriff.dropped[p.id] = true;
        log(`↩️ ${p.name} 选择退水。`);
      }
    }
    game.step = 'sheriff_vote';
  }

  if (game.step === 'sheriff_vote') {
    let candidates = game.sheriff.candidates.filter((id) => !game.sheriff.dropped[id] && getPlayer(id)?.alive);
    if (candidates.length === 0) {
      log('⚠️ 无有效警长候选人，警徽流失。');
      game.sheriffDecided = true;
      game.step = 'speech';
      return;
    }

    for (let round = 1; round <= 2; round += 1) {
      const votes = [];
      const voters = alivePlayers().filter((p) => !candidates.includes(p.id) || game.sheriff.dropped[p.id]);
      for (const v of voters) {
        if (v.id === game.userId) {
          setPending({ type: 'sheriff_vote', prompt: `第${round}轮警长投票`, options: candidates.map((id) => ({ id, name: getPlayer(id).name })) });
          return;
        }
        const chosen = await askPlayerChoice(v, `第${round}轮警长投票`, candidates.map((id) => getPlayer(id)));
        votes.push(chosen);
      }
      if (!votes.length) {
        game.sheriffId = candidates[0];
        break;
      }
      const map = new Map();
      for (const v of votes) map.set(v, (map.get(v) || 0) + 1);
      let max = 0;
      for (const n of map.values()) max = Math.max(max, n);
      const tie = [...map.entries()].filter(([, n]) => n === max).map(([id]) => id);
      if (tie.length === 1) {
        game.sheriffId = tie[0];
        break;
      }
      if (round === 1) {
        log(`⚖️ 警长竞选首轮平票：${tie.map((id) => getPlayer(id).name).join('、')}，进入第二轮。`);
        candidates = tie;
      } else {
        log('⚠️ 警长竞选二轮仍平票，警徽流失。');
      }
    }

    if (game.sheriffId) log(`👑 警长当选：${getPlayer(game.sheriffId).name}`);
    game.sheriffDecided = true;
    game.step = 'speech';
  }
}

async function runDayFlow() {
  if (game.day === 1 && !game.sheriffDecided) {
    await runSheriffElection();
    if (game.pending) return;
  }

  // 7 发言
  if (game.step === 'speech') {
    let order = alivePlayers().map((p) => p.id);
    if (game.sheriffId && getPlayer(game.sheriffId)?.alive) {
      const sheriff = getPlayer(game.sheriffId);
      if (sheriff.id === game.userId) {
        setPending({ type: 'speech_order', prompt: '你是警长，选择正序或逆序发言', options: [{ id: 'forward', name: '正序' }, { id: 'reverse', name: '逆序' }] });
        return;
      }
      const ord = await callPlayerLLM(sheriff, '回答 FORWARD 或 REVERSE。', '你是警长，选择发言顺序。');
      if (/REVERSE|逆/i.test(ord)) order = [...order].reverse();
    }

    for (const id of order) {
      const p = getPlayer(id);
      if (!p?.alive) continue;
      if (p.id === game.userId) {
        setPending({ type: 'day_speech', prompt: '白天发言（可选择狼人自爆）', options: p.role === 'wolf' ? [{ id: 'speak', name: '正常发言' }, { id: 'explode', name: '狼人自爆' }] : [{ id: 'speak', name: '发言' }], withText: true });
        return;
      }
      const sp = await askSpeech(p, '白天发言阶段。');
      log(`💬 ${p.name}: ${sp.slice(0, 120)}`);
    }
    game.step = 'vote';
  }

  // 8 投票
  if (game.step === 'vote') {
    const voters = alivePlayers().filter((p) => !p.idiotRevealed);
    const candidates = alivePlayers();
    const weights = new Map();
    for (const v of voters) {
      const cands = candidates.filter((x) => x.id !== v.id);
      let picked;
      if (v.id === game.userId) {
        setPending({ type: 'day_vote', prompt: '白天公投：选择放逐对象（白痴翻牌后不可投票）', options: cands.map((x) => ({ id: x.id, name: x.name })) });
        return;
      }
      picked = await askPlayerChoice(v, '白天放逐投票', cands);
      const w = v.id === game.sheriffId ? 1.5 : 1;
      weights.set(picked, (weights.get(picked) || 0) + w);
      log(`🗳️ ${v.name} 投票给 ${getPlayer(picked).name}${w > 1 ? '（警长1.5票）' : ''}`);
    }
    let max = -1;
    let top = [];
    for (const [id, n] of weights.entries()) {
      if (n > max) {
        max = n;
        top = [id];
      } else if (n === max) top.push(id);
    }
    if (top.length) {
      const out = top[Math.floor(Math.random() * top.length)];
      killPlayer(out, 'vote', true);
    }
    game.step = 'last_words';
  }

  // 9 遗言
  if (game.step === 'last_words') {
    for (const id of game.lastWordsQueue) {
      const p = getPlayer(id);
      if (id === game.userId) {
        setPending({ type: 'last_words', prompt: '遗言阶段（规则为120秒，这里文本代替）', options: [{ id: 'ok', name: '提交遗言' }], withText: true });
        return;
      }
      const lw = await askSpeech(p, '你已出局，请发表遗言。');
      log(`🕯️ ${p.name} 遗言: ${lw.slice(0, 180)}`);
    }
    game.lastWordsQueue = [];

    if (game.hunterCanShoot) {
      const hunter = getPlayer(game.hunterCanShoot);
      if (hunter.id === game.userId) {
        setPending({ type: 'hunter_shot', prompt: '猎人开枪：可开枪或放弃（被毒死不可开枪已处理）', options: [{ id: 'skip', name: '不开枪' }, ...alivePlayers().filter((p) => p.id !== hunter.id).map((p) => ({ id: p.id, name: `开枪 ${p.name}` }))] });
        return;
      }
      const cands = alivePlayers().filter((p) => p.id !== hunter.id);
      const shot = await askPlayerChoice(hunter, '你是猎人，可选择开枪或放弃。', cands, true);
      if (shot) {
        killPlayer(shot, 'hunter_shot', false);
        log(`🔫 猎人 ${hunter.name} 开枪带走 ${getPlayer(shot)?.name || shot}`);
      }
      game.hunterCanShoot = null;
    }

    const w = winnerCheck();
    if (w) return endGame(w);

    game.day += 1;
    startNight();
  }
}

function endGame(winner) {
  game.status = 'ended';
  game.winner = winner;
  log(winner === 'good' ? '🎉 好人阵营获胜' : '🐺 狼人阵营获胜');
}

async function progress() {
  if (!game || game.status !== 'running' || game.pending) return;
  if (game.phase === 'night') await runNightFlow();
  if (!game.pending && game.phase === 'day' && game.status === 'running') await runDayFlow();
}

app.post('/api/test-api', async (req, res) => {
  const { baseURL, apiKey, model } = req.body || {};
  if (!baseURL || !apiKey || !model) return res.status(400).json({ ok: false, error: 'baseURL/apiKey/model 必填' });
  try {
    const url = baseURL.replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'reply ok' }], max_tokens: 5 }),
    });
    if (!resp.ok) return res.status(400).json({ ok: false, error: `${resp.status} ${await resp.text()}` });
    const data = await resp.json();
    return res.json({ ok: true, reply: data.choices?.[0]?.message?.content || '' });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/new-game', async (req, res) => {
  const { players } = req.body || {};
  if (!Array.isArray(players) || players.length !== 10) return res.status(400).json({ error: '需要10名玩家配置' });
  const missing = requireApiConfig(players);
  if (missing) return res.status(400).json({ error: `无法开始：${missing}` });

  const roles = shuffle(DEFAULT_ROLES);
  game = {
    status: 'running',
    day: 1,
    phase: 'night',
    step: 'wolf_kill',
    winner: null,
    userId: 'P1',
    sheriffId: null,
    sheriffDecided: false,
    players: players.map((p, i) => ({
      id: `P${i + 1}`,
      name: p.name || `玩家${i + 1}`,
      role: roles[i],
      alive: true,
      idiotRevealed: false,
      api: { baseURL: p.api.baseURL, apiKey: p.api.apiKey, model: p.api.model },
    })),
    logs: [
      '📜 规则流程：狼人刀人→预言家验人→女巫技能→(白天)警长竞选→发言→投票→遗言。',
      '📜 特殊规则：女巫不可自救；白痴被公投翻牌不死但失去投票权；猎人仅被刀/公投可开枪，吃毒不可开枪；狼人可白天自爆。',
    ],
    pending: null,
    night: {},
    witch: { saveUsed: false, poisonUsed: false },
    sheriff: {},
    hunterCanShoot: null,
    lastWordsQueue: [],
  };

  startNight();
  await progress();
  res.json(publicState());
});

app.post('/api/action', async (req, res) => {
  if (!game) return res.status(400).json({ error: '请先开局' });
  if (!game.pending) return res.status(400).json({ error: '当前无待处理动作' });
  const { type } = game.pending;
  const { actionId, text } = req.body || {};

  if (type === 'wolf_kill') {
    if (actionId === 'skip') log('🐺 你选择放弃刀人');
    else game.night.wolfVotes[game.userId] = actionId;
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'seer_check') {
    const t = getPlayer(actionId);
    if (!t?.alive) return res.status(400).json({ error: '非法目标' });
    log(`🔮 你查验了 ${t.name}：${ROLE_CN[t.role]}`);
    game.night.seerTarget = actionId;
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'witch_action') {
    if (actionId === 'save') {
      if (game.witch.saveUsed) return res.status(400).json({ error: '解药已用过' });
      game.witch.saveUsed = true;
      game.night.witchSaved = true;
      log('🧪 你使用解药救人');
    } else if (String(actionId).startsWith('poison:')) {
      if (game.witch.poisonUsed) return res.status(400).json({ error: '毒药已用过' });
      const id = String(actionId).split(':')[1];
      if (!getPlayer(id)?.alive) return res.status(400).json({ error: '毒杀目标无效' });
      game.witch.poisonUsed = true;
      game.night.witchPoisonTarget = id;
      log(`☠️ 你毒杀了 ${getPlayer(id).name}`);
    }
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'sheriff_signup') {
    const me = getPlayer(game.userId);
    game.sheriff.signup[game.userId] = actionId === 'yes' || me.role === 'seer';
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'sheriff_speech') {
    if (text) log(`🗣️ [警上] 你: ${String(text).slice(0, 120)}`);
    if (actionId === 'drop') game.sheriff.dropped[game.userId] = true;
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'sheriff_vote') {
    game.sheriff.userVote = actionId;
    // 简化：用户票直接并入日志；实际计票在下一轮触发时可扩展
    log(`🗳️ 你投票给 ${getPlayer(actionId)?.name || actionId}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'speech_order') {
    game.sheriff.userOrder = actionId;
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'day_speech') {
    const me = getPlayer(game.userId);
    if (actionId === 'explode' && me.role === 'wolf') {
      me.alive = false;
      log(`💥 ${me.name} 狼人自爆，立即进入黑夜。`);
      if (game.day === 1 && !game.sheriffDecided) {
        log('⚠️ 警长竞选推迟一天。');
      }
      game.day += 1;
      startNight();
      clearPending();
      await progress();
      return res.json(publicState());
    }
    if (text) log(`💬 你: ${String(text).slice(0, 120)}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'day_vote') {
    game.userVote = actionId;
    log(`🗳️ 你投票给 ${getPlayer(actionId)?.name || actionId}`);
    // 简化：把用户票落地后继续流程
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'last_words') {
    if (text) log(`🕯️ 你的遗言: ${String(text).slice(0, 200)}`);
    clearPending();
    await progress();
    return res.json(publicState());
  }
  if (type === 'hunter_shot') {
    if (actionId !== 'skip') killPlayer(actionId, 'hunter_shot', false);
    game.hunterCanShoot = null;
    clearPending();
    await progress();
    return res.json(publicState());
  }

  return res.status(400).json({ error: '未知动作类型' });
});

app.get('/api/state', (req, res) => {
  if (!game) return res.status(404).json({ error: '暂无对局' });
  res.json(publicState());
});

app.listen(port, () => console.log(`Werewolf chat app running at http://localhost:${port}`));
