# 多AI + 用户狼人杀（6人局）

基于 OpenAI 兼容协议（`/v1/chat/completions`）的网页狼人杀演示。

## 特性
- 固定 6 人局：2 狼人、2 村民、1 女巫、1 预言家
- 用户 + 5 个 AI 同场
- 明确的夜晚/白天流程与胜利条件
- 支持接入 OpenAI 或任意 OpenAI 协议兼容模型服务
- 若不填 API 配置，AI 使用本地随机策略继续游戏

## 启动

```bash
npm install
npm start
```

打开 `http://localhost:3000`。

## API 说明
- `POST /api/new-game`：创建新局
- `POST /api/next`：推进游戏（当没有待操作时）
- `POST /api/action`：提交用户动作（投票/技能）
- `GET /api/state`：查看当前状态
