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
npm test             # 核心玩法冒烟测试（104 项）
npm run build        # 产物在 dist/，纯静态
```

只玩前端不需要后端——未登录时存档存在浏览器 localStorage（设备 UUID），断网可玩。

## 账号与会员体系

登录后进度云同步到**账号**（用户名 + 密码），换设备登录即可继续。两套等级并存：

- **游戏等级**（Lv / 经验）：客户端计算，存档时由网关做**合理性校验**（等级不倒退、单次跳跃封顶、经验不超过当前等级容量），挡掉本地改 localStorage 刷等级的作弊。
- **会员等级**（V1–V4）：按累计游玩时长自动晋升（1h→V2、4h→V3、12h→V4），管理后台可手动覆盖，只升不降。

登录态用 **JWT**（HMAC-SHA256，零依赖手写）。密码用 **pbkdf2** 加盐哈希，明文不出浏览器。管理后台走独立的 `x-admin-token`，与玩家 JWT 完全隔离。

## 后端：嫁接 cloudflarepool 数据湖

复用 cloudflarepool 的通用文档表，落在三个集合：

- `/t/cloudlet/c/saves` —— 玩家存档（owner = 设备 UUID 或账号 ID）
- `/t/cloudlet/c/accounts` —— 账号档案（密码哈希、等级、会员等级）
- `/t/cloudlet/c/usernames` —— 用户名 → 账号 ID 的唯一索引

**为什么必须有一层代理**：数据湖零 CORS（OPTIONS 直接 403）、一把服务密钥下所有玩家 owner 相同、写限流 60/分钟按密钥共享、没有 upsert、单条 GET 不校验 owner。走 `X-Sync-Key` 内部通道 + 注入 `X-User-Id`，五个问题一次解决，且该通道豁免限流。账号/密码/会话/JWT 全部由这一层兜底。

```bash
# 1. 在数据湖登记 app 与租户（幂等，只需一次）
export INTERNAL_KEY=<cloudflarepool 的 INTERNAL_KEY>
npm run init:tenant

# 2. 起网关（内存模式可零依赖本地联调，无需真实数据湖）
LAKE_BASE=memory://test JWT_SECRET=dev ADMIN_TOKEN=dev npm run server   # 127.0.0.1:8787
curl "http://127.0.0.1:8787/api/health"
```

`vite.config.ts` 已把 `/api` 与 `/admin` 代理到 8787，所以 `npm run dev` 下云同步与管理后台直接可用。

### 网关的安全红线

`INTERNAL_KEY` 是数据湖最高权限密钥（无 scope 约束、豁免限流、可读写任意租户）。因此：

- 只存在于网关进程的环境变量，绝不进前端产物
- 网关重新构造全部请求头，不透传客户端任何头
- 只允许访问 `/t/cloudlet/c/{saves,accounts,usernames}/` 前缀，不是通用网关
- 账号模式下 owner 直接取自 JWT，客户端不可伪造；设备模式设备 ID 必须是 UUID v4
- payload 上限 200KB；管理令牌与玩家令牌体系隔离

## 部署（无 Docker，裸机 + 宝塔反代，对齐微家事架构）

前端静态产物放在宝塔站点根目录，网关作为 pm2 常驻进程监听 `127.0.0.1:8787`，宝塔反向代理把 `/api` 与 `/admin` 指过去，二者同机同源。

```bash
# 一次性：在数据湖登记租户
export INTERNAL_KEY=...
npm run init:tenant

# 部署到 VPS（静态 → /www/wwwroot/cloudlet，网关 → /opt/cloudlet-api）
export VPS=user@your-server
export INTERNAL_KEY=... JWT_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=$(openssl rand -hex 16)
bash deploy/deploy.sh
```

部署后：站点根路径为游戏，管理后台在 `/admin`（用 `ADMIN_TOKEN` 进入）。网关用 `deploy/start.sh` 包装脚本加载 `.env` 后常驻（pm2 守护进程不继承交互 shell 的环境变量，故不能靠 `source .env && pm2 start`）。详见 `deploy/.env.example`。

## 结构

```
src/
  core/        纯逻辑，不依赖渲染。state / actions / simulation / economy / orders / save / cloud / auth
  data/        静态配置表：作物、工厂配方、建筑、物品颜色
  render/      Three.js 层：等距相机、程序化几何体、世界同步
  audio/       Web Audio 程序化 BGM（city pop / lo-fi / ambient）+ 外接电台
  ui/          HTML overlay：HUD、订单板、弹窗、飘字
server/        网关（node:http，零依赖）：云存档代理 + 账号 + 双等级校验 + 管理后台 + /admin 静态页
deploy/        pm2 配置(ecosystem/start.sh)、.env 示例、nginx 反代示例、初始化与部署脚本
test/          核心玩法冒烟测试
```

三条贯穿全局的约定：

1. **时间用绝对时间戳**（`readyAt`），不用累加计数——离线结算因此天然成立
2. **逻辑与渲染分离**——`core/` 可以在 Node 里跑测试，离线结算不需要渲染参与
3. **外观由种子决定**——存档只存 `seed`，同一颗种子永远长成同一棵树
