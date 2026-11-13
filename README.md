# 校招星图 · Netlify 线上审批版

按省份浏览中国校招企业的地图网站，**访问需管理员实时审批授权**。本版本专为 Netlify 打造：

- **前端**：静态页面（`public/`），由 Netlify CDN 全球分发，自带 HTTPS。
- **后端**：Netlify Functions（无服务器函数，`netlify/functions/api.js`），无需自己运维服务器。
- **存储**：Netlify Blobs（平台自带持久化存储，强一致），申请 / 审批 / 授权 / 岗位数据多人实时共享。

功能与之前的线上版完全一致：访客申请 → 管理员实时审批 → 自动解锁；作废授权立即踢出；岗位上下架对所有访客实时生效；内置 34 省地图、97 家企业、347 个岗位。

---

## 一、上线前提

- 一个 **Netlify 账号**（免费即可，https://app.netlify.com 注册）。
- 本机安装 **Node.js 18+**（用于命令行部署；若用 Git 方式则只需浏览器）。

> 免费额度说明：Netlify 免费版包含静态托管、每月一定额度的函数调用与 Blobs 存储，足够个人 / 小范围使用。超出后按量计费，详见 Netlify 官网定价。

---

## 二、方式 A：Git 连接自动部署（推荐，最省心）

1. 把整个 `校招星图-Netlify版` 目录推送到一个 Git 仓库（GitHub / GitLab / Gitee 均可）。
   - 注意：`node_modules/` 不要提交（已在 `.gitignore` 忽略）。
2. 登录 Netlify → **Add new site → Import an existing project** → 选择该仓库。
3. 构建设置会自动读取 `netlify.toml`，确认：
   - **Publish directory**：`public`
   - **Build command**：留空
   - **Functions directory**：`netlify/functions`
4. 点 **Deploy**。Netlify 会自动安装依赖（`@netlify/blobs`）、打包函数、上线。
5. 部署完成后得到一个 `https://<站点名>.netlify.app` 网址，即可访问。
6. 以后每次 `git push`，Netlify 自动重新部署。

---

## 三、方式 B：命令行手动部署（无需 Git）

在 `校招星图-Netlify版` 目录下：

```bash
# 1. 安装依赖（含 Netlify CLI）
npm install

# 2. 登录 Netlify（会打开浏览器授权）
npx netlify login

# 3. 初始化站点（首次，按提示创建新站点）
npx netlify init

# 4. 部署到生产环境
npx netlify deploy --prod
```

`netlify deploy --prod` 会上传 `public/` 静态文件并部署 `netlify/functions/` 函数，完成后输出正式网址。

> 也可以先 `npx netlify deploy`（不带 --prod）生成一个预览网址测试，确认无误后再 `--prod`。

---

## 四、本地预览（部署前验证）

```bash
npm install
npx netlify dev
```

`netlify dev` 会在本地完整模拟 Netlify 运行环境（函数 + Blobs 本地沙箱 + 重定向），打开 http://localhost:8888 即可体验与线上一致的效果。

> 本地 Blobs 是独立沙箱，不读取线上数据；首次打开同样需要设置管理员口令。

---

## 五、使用流程

**管理员**
1. 打开网址 → 「管理员入口」→ 首次设置管理员口令（≥6 位）→ 进入后台。
2. 「访问审批」：访客申请实时出现 → 点「同意」，对方页面几秒内自动解锁（也可复制授权码手动发给对方）；可「直接发放授权」「作废」（作废后对方立即被踢出）。
3. 「岗位管理」：新增 / 编辑企业岗位、点击状态上下架、批量操作、JSON 导入导出。
4. 「安全设置」修改管理员口令。

**访客**
1. 打开网址 → 「申请访问」填称呼与联系方式 → 提交。
2. 等管理员同意，页面自动解锁；或在「已有授权码」粘贴授权码进入。
3. 浏览地图、按省份看企业、查看岗位、收藏、跳转官方招聘入口。

---

## 六、数据与运维

- 所有数据存于该站点的 Netlify Blobs（store 名 `starmap`），**重新部署不会丢数据**（站点级存储跨部署共享）。
- 可在 Netlify 控制台 **Data & Storage → Blobs** 查看 / 下载数据。
- 「导出 JSON」可备份企业岗位；「导入 JSON」可批量恢复 / 迁移。
- 函数日志：Netlify 控制台 **Functions → api → Logs**，或 `npx netlify logs:function api`。

---

## 七、安全说明

- 管理员口令 **scrypt 加盐哈希**存储；登录 / 申请 / 授权接口有频率限制。
- 授权码由服务器随机生成并校验，作废后**立即失效**且对应在线会话被实时清除。
- 未授权用户无法读取任何企业 / 岗位数据（函数层鉴权）。
- 公开接口只下发**在招上架**岗位。
- Netlify 自动提供 HTTPS；请设置强管理员口令。
- Netlify Blobs 默认「最终一致」，本项目已开启 **strong 强一致**，确保审批 / 上下架改动即时对所有访客可见。
- 单管理员场景下并发写入极少；Blobs 为「最后写入获胜」，如需多管理员高并发协作，建议升级为 Netlify Database（Postgres）。

---

## 八、目录结构

```
校招星图-Netlify版/
├─ netlify.toml            Netlify 配置（发布目录 / 函数 / 重定向 / 安全头）
├─ package.json            依赖与脚本
├─ netlify/functions/
│  └─ api.js               无服务器函数入口（Netlify Blobs 存储）
├─ shared/
│  ├─ core.js              核心业务逻辑（审批 / 授权 / 岗位 / 鉴权）
│  ├─ map.json             省级地图（只读）
│  └─ seed.json            企业岗位种子（只读）
├─ public/
│  ├─ index.html           页面
│  ├─ style.css            样式
│  └─ app.js               前端逻辑
└─ test/
   ├─ emulator.js          本地模拟器（文件存储复现函数行为）
   ├─ e2e.js               接口端到端测试（47 项）
   └─ dom.js               真实页面 UI 测试（28 项）
```

## 九、自测

```bash
node test/e2e.js     # 接口与安全边界（无需 Netlify 环境）
node test/dom.js     # 真实页面 UI（需 jsdom：npm install --no-save jsdom）
```

## 免责声明

信息来自微信公众号、企业官网 / 上市公司公告、高校就业网等公开渠道聚合与人工维护，部分岗位为示例数据，不构成真实招聘承诺。地图边界为公开 GeoJSON 简化示意，不作为标准地图使用。请通过企业官方渠道投递，谨防「付费内推、保录取」等招聘诈骗。
