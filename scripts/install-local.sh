#!/usr/bin/env bash
#
# 本地开发安装：把插件 link 进 dsh profile 的 node_modules，并在该 profile 的
# cordis.patch.yml 里追加一条挂载行（profile 补丁逐层生效，不需要改 package.json
# 的 bundles 列表）。
#
# 用法：
#   ./scripts/install-local.sh                    # 装进 desktop profile（DSH 桌面端）
#   ./scripts/install-local.sh web                # 装进 web profile
#   ./scripts/install-local.sh --remove           # 从 desktop profile 卸载
#   ./scripts/install-local.sh --remove web
#
# 环境变量：
#   DSH_HOME   默认 ~/.dsh（跟 dsh 自己的约定一致，方便隔离测试）
#
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="$(node -p "require('${PLUGIN_DIR}/package.json').name")"
ENTRY_ID="image-pin-comment"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"

MODE="install"
if [[ "${1:-}" == "--remove" ]]; then
  MODE="remove"
  shift
fi
PROFILE="${1:-desktop}"
PROFILE_DIR="${DSH_HOME}/profiles/${PROFILE}"
PATCH="${PROFILE_DIR}/cordis.patch.yml"

if [[ ! -d "${PROFILE_DIR}" ]]; then
  echo "找不到 profile：${PROFILE_DIR}" >&2
  echo "可用 profile：" >&2
  ls -1 "${DSH_HOME}/profiles" 2>/dev/null | grep -v node_modules >&2 || true
  exit 1
fi

if [[ "${MODE}" == "remove" ]]; then
  rm -f "${PROFILE_DIR}/node_modules/${PKG_NAME}"
  if [[ -f "${PATCH}" ]]; then
    cp "${PATCH}" "${PATCH}.bak.$(date +%Y%m%d-%H%M%S)"
    node -e '
      const fs = require("node:fs");
      const [file, pkg, id] = process.argv.slice(1);
      const text = fs.readFileSync(file, "utf8");
      const block = new RegExp("\\n- insert:\\n {4}- id: " + id + "\\n {6}name: ." + pkg + ".\\n", "g");
      fs.writeFileSync(file, text.replace(block, "\n"));
    ' "${PATCH}" "${PKG_NAME}" "${ENTRY_ID}"
  fi
  echo "已卸载 ${PKG_NAME}（profile: ${PROFILE}）。刷新或重启 DSH 后生效。"
  exit 0
fi

mkdir -p "${PROFILE_DIR}/node_modules"
ln -sfn "${PLUGIN_DIR}" "${PROFILE_DIR}/node_modules/${PKG_NAME}"

if [[ ! -f "${PATCH}" ]]; then
  printf '# dsh profile patch layer\n[]\n' > "${PATCH}"
fi

if grep -q "name: '${PKG_NAME}'" "${PATCH}" || grep -q "name: \"${PKG_NAME}\"" "${PATCH}"; then
  echo "挂载行已存在，跳过写入：${PATCH}"
else
  cp "${PATCH}" "${PATCH}.bak.$(date +%Y%m%d-%H%M%S)"
  # 注意：cordis.patch.yml 必须是一个 YAML 文档。空列表写作 `[]`，此时不能
  # 直接往后追加 `- insert:`（流式空节点会把文档收尾），要先把 `[]` 换成块序列。
  node -e '
    const fs = require("node:fs");
    const [file, id, pkg] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const block = [
      "",
      "# 本地开发：图片图钉标注插件",
      "- insert:",
      "    - id: " + id,
      "      name: \x27" + pkg + "\x27",
      ""
    ].join("\n");
    const lines = text.split("\n");
    const emptyIndex = lines.findIndex((line) => line.trim() === "[]");
    const content = lines.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    const isEmptyList = emptyIndex >= 0 && content.length === 1 && content[0].trim() === "[]";
    const next = isEmptyList
      ? lines.map((line, index) => (index === emptyIndex ? block.trim() : line)).join("\n") + "\n"
      : text.replace(/\s*$/, "\n") + block;
    fs.writeFileSync(file, next);
  ' "${PATCH}" "${ENTRY_ID}" "${PKG_NAME}"
  echo "已写入挂载行：${PATCH}"
fi

echo
echo "装好了："
echo "  插件目录：${PLUGIN_DIR}"
echo "  profile ：${PROFILE_DIR}"
echo
echo "接下来：在 DSH 里刷新界面（⌘R / Ctrl+R）；若工具条没出现，重启一次 DSH。"
echo "卸载：$0 --remove ${PROFILE}"
