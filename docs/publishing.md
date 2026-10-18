# 发布清单：GitHub → npm → 插件市场

三步走完，插件就能被 `dsh plugin add` / 市场一键装上。**只有第 1、2 步需要你的账号**，其余都是 PR / 配置。

---

## 0. 先把 `OWNER` 换掉

仓库里的 `package.json` 用了占位符；换成你的 GitHub 用户名（或组织）与仓库名：

```sh
cd /path/to/dsh-image-pin-comment
./scripts/set-repo.sh <github-owner> [repo-name]   # 默认 repo 名 dsh-image-pin-comment
```

它会同时改 `repository` / `homepage` / `bugs` —— **npm 包与 GitHub 仓库的关联就靠 `repository` 字段**，
市场据此把下载量显示在条目上。

---

## 1. GitHub

```sh
cd /path/to/dsh-image-pin-comment
git init -b main
git add -A
git commit -m "feat: image pin-comment annotation for DSH lightbox"

# 建仓库（三选一）
gh repo create dsh-image-pin-comment --public --source=. --remote=origin --push   # 有 gh CLI
# 或者先在网页建空仓库，再：
# git remote add origin git@github.com:dudhdkebesii/dsh-image-pin-comment.git
# git push -u origin main
```

然后两件事，市场抓取全靠它们：

1. **打 `dsh-plugin` topic**（网页 About ⚙️ → Topics；或 `gh repo edit --add-topic dsh-plugin`）。
   1024Store 的自动收集只扫带这个 topic 的仓库。
2. **确认 `package.json` 里有 `dsh.bundle`**（本仓库已有）：

   ```jsonc
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
   ```

   ⚠️ 只声明 `dsh.client` 的仓库会被市场判为「不可安装」并拒收。

打 tag 发版（CI 会打 tarball 挂到 Release，文件名固定不带版本号，`latest/download/*.tgz` 永不 404）：

```sh
git tag v0.2.0 && git push --tags
```

---

## 2. npm（市场一键安装只认 npm）

```sh
npm login                      # 或用 NPM_TOKEN
npm publish --access public    # 包名 dsh-image-pin-comment 目前没人占
```

发布前先自查：

```sh
npm run check          # 语法
npm test               # 30/30 夹具冒烟
npm run pack:dry       # 只该有 6~8 个文件，别把 test/ 打进去
```

想省掉每次手动发布，可以在仓库 Secrets 里加 `NPM_TOKEN`，`.github/workflows/release.yml`
会在打 tag 时自动 `npm publish` 并附 tarball。

> 不想发 npm？也可以只发 GitHub Release tarball，用 `github:owner/repo` 安装；
> 但**市场里的「一键安装」按钮只对 npm 包出现**。

---

## 3. 插件市场收录

DSH 生态目前有四条入口，发布到 npm + 打 topic 之后大部分会自动发生：

| 入口 | 怎么进去 | 关键要求 |
| --- | --- | --- |
| **桌面端内置「插件市场」**（DSH Community Market） | 自动：它读取目录来源（默认 dshfind，可选 1024Store），按 npm `latest` 解析 | 条目要有唯一 npm 包名；npm manifest 必须声明 `dsh.bundle.patch` |
| **1024Store**（[awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)） | 自动：定时扫描带 `dsh-plugin` topic 的仓库并静态校验 `dsh.bundle.patch`；也可提 PR 手动收录 | 同上 + topic；手动 PR 见 `CONTRIBUTING.md` |
| **awesome-dsh-plugin**（社区总目录） | 手动 PR：新增 `data/plugins/dudhdkebesii__<repo>.yml` 一个文件 | `dsh.bundle` 必需、仓库**创建满 1 天**、有 `dsh-plugin` topic、描述属实、≤3 条/PR |
| **dshfind.com** | 社区站，抓 GitHub 仓库；收录异常可在 [hikariming/dshfind](https://github.com/hikariming/dshfind) 提 issue | 同上 |

### 3.1 awesome-dsh-plugin 的 PR 长这样

仓库：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`
新增文件：`data/plugins/dudhdkebesii__dsh-image-pin-comment.yml`

```yaml
url: https://github.com/dudhdkebesii/dsh-image-pin-comment
name: dudhdkebesii/dsh-image-pin-comment
category: ui
description:
  en: Pin-numbered anchor points on a DSH image preview and send the original image with a pixel-accurate coordinate list.
  zh: 在 DSH 图片预览上钉编号锚点，随原图一起发出像素级坐标清单，一次可标注多张图。
tarball: https://github.com/dudhdkebesii/dsh-image-pin-comment/releases/latest/download/dsh-image-pin-comment.tgz
```

要点：

- 只有 `description.en` 必填；中文可以让维护者补。
- 描述里带 `: ` 要加引号（本行没有）。
- README 是脚本生成的，**只提交那一个 yml 文件**，别手改 README。
- `tarball` 是可选但推荐的（不发 npm 时几乎必需）；资产名不要带版本号。
- 截图：仓库根已有 `screenshots.json`（指向 `docs/preview.png`），市场详情页会用它，改图只推自己的仓库即可。

### 3.2 1024Store 手动收录（可选，自动收集通常就够了）

仓库有 `CONTRIBUTING.md` 与 `catalog/plugins/<id>.json` 的结构化表单，也提供了 Agent Skill：

```sh
npx skills add imsai-sh/awesome-deepseek-harness-plugins --skill submit-dsh-plugin -g
```

装完对助手说「使用 $submit-dsh-plugin 检查并提交我的 DeepSeek Harness 插件」，它会校验仓库、
生成目录 JSON 并在授权后开 PR。新增条目的 PR 通过静态审查会自动合并。

### 3.3 自建目录来源（Market 的 path A）

内置市场的目录来源是开放的：任何符合公开 Schema 的 HTTPS JSON 都能被用户加进来，不需要改 Market 代码。

1. 发布 `<your-origin>/catalog-source.json`（`schemas/catalog-source.schema.json`）；
2. 发布 `GET /v1/plugins` 返回 `catalog-provider-page`（`schemas/catalog-provider-page.schema.json`）；
3. 用户在你的市场里「来源 → 添加」，填入 manifest URL 即可。

适合自建市场 / 私有分发；公开分发还是走上面三条目录。

---

## 4. 后续发版

```sh
# 改代码 → 改版本号 → 一条命令
npm version patch        # 或 minor / major；会自动打 tag
git push --follow-tags   # CI 出 Release + tarball（+ npm，如果配了 token）
```

fs 版本与桌面端兼容性写在 README 的「已知限制」里；实测环境：DSH Desktop 2.0.17 / dsh 0.2.0-rc.2。

---

## 5. 发布前自查清单

- [ ] `package.json`：`name` / `version` / `description` / `license` / `repository` / `engines`
- [ ] `dsh.bundle.patch` 指向存在的 `cordis.patch.yml`，且行内 `name` 与包名一致
- [ ] `dsh.client.platform` 为 `web`
- [ ] `npm run check` + `npm test` 全绿；`npm run pack:dry` 内容干净
- [ ] 仓库打了 `dsh-plugin` topic；仓库创建已满 1 天（awesome 列表的硬门槛）
- [ ] `screenshots.json` 指向仓库里真实存在的图
- [ ] 已发 npm；`npm view <pkg> version` 能查到
- [ ] README 里没有写死的本机路径、没有夸大描述（市场会对着代码核）
