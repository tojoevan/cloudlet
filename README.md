# 云上小镇 Cloudlet

参考《梦想城镇》的 low-poly 清新风休闲放置 Web 游戏。Three.js 等距视角，全部模型程序化生成，零美术资源。非商业，可挂在屏幕一旁当学习陪伴。

## 已实现

- **核心闭环**：种植 → 加工 → 订单 → 建造 → 等级解锁
- **放置**：离线结算（4~12 小时上限，随等级提升）、local-first 云同步
- **爽感**：一键收获/补种、Fever 热潮（连续 5 单收益翻倍）、飘字与音效反馈
- **长线**：图鉴 16 项（作物/加工品/建筑/工厂）、成就 18 项
- **陪伴**：番茄钟（25/45 分钟，专注期收益 ×1.5、工厂提速 50%、音乐自动压低）、居民闲逛、30 秒无操作自动环绕镜头、入夜窗户亮灯
- **音频**：程序化 city pop / lo-fi / ambient 三频道，外加自定义电台 URL

## 还没做

- 季节活动（每两周轮换，季节限定作物与装饰）
- 果园岛 / 牧场岛 / 温泉岛 / 云顶（数据结构已就绪，按繁荣度解锁）
- 装饰自由摆放

## 快速开始

```bash
npm install
npm run dev          # 前端 http://localhost:5173
npm test             # 核心玩法冒烟测试（51 项）
npm run build        # 产物在 dist/，纯静态
```

只玩前端不需要后端——存档默认存在浏览器 localStorage，断网可玩。

## 后端：嫁接 cloudflarepool 数据湖

存档复用 cloudflarepool 的 `collections` 通用文档表，落在 `/t/cloudlet/c/saves/<deviceId>`。

**为什么必须有一层代理**：数据湖零 CORS（OPTIONS 直接 403）、一把服务密钥下所有玩家 owner 相同、写限流 60/分钟按密钥共享、没有 upsert、单条 GET 不校验 owner。走 `X-Sync-Key` 内部通道 + 注入 `X-User-Id`，五个问题一次解决，且该通道豁免限流。

```bash
# 1. 在数据湖登记 app 与租户（幂等，只需一次）
export INTERNAL_KEY=<cloudflarepool 的 INTERNAL_KEY>
npm run init:tenant

# 2. 起代理
INTERNAL_KEY=$INTERNAL_KEY npm run server     # 127.0.0.1:8787
curl "http://127.0.0.1:8787/api/health"
```

`vite.config.ts` 已把 `/api` 代理到 8787，所以 `npm run dev` 下云同步直接可用。

### 代理的安全红线

`INTERNAL_KEY` 是数据湖最高权限密钥（无 scope 约束、豁免限流、可读写任意租户）。因此：

- 只存在于代理进程的环境变量，绝不进前端产物
- 代理重新构造全部请求头，不透传客户端任何头
- 只允许访问 `/t/cloudlet/c/saves/` 这一个前缀，不是通用网关
- deviceId 必须是 UUID v4，payload 上限 200KB

## 部署

```bash
export VPS=user@your-server
export INTERNAL_KEY=...
bash deploy/deploy.sh
```

Docker Compose 起两个服务：`web`（Nginx 托管静态 + 反代 `/api`）与 `api`（无状态代理）。代理没有本地数据，可随时重建。

## 结构

```
src/
  core/        纯逻辑，不依赖渲染。state / actions / simulation / economy / orders / save / cloud
  data/        静态配置表：作物、工厂配方、建筑、物品颜色
  render/      Three.js 层：等距相机、程序化几何体、世界同步
  audio/       Web Audio 程序化 BGM（city pop / lo-fi / ambient）+ 外接电台
  ui/          HTML overlay：HUD、订单板、弹窗、飘字
server/        云存档代理（node:http，零依赖）
deploy/        Nginx、Dockerfile、compose、初始化与部署脚本
test/          核心玩法冒烟测试
```

三条贯穿全局的约定：

1. **时间用绝对时间戳**（`readyAt`），不用累加计数——离线结算因此天然成立
2. **逻辑与渲染分离**——`core/` 可以在 Node 里跑测试，离线结算不需要渲染参与
3. **外观由种子决定**——存档只存 `seed`，同一颗种子永远长成同一棵树
