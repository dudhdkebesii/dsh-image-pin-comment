#!/usr/bin/env bash
#
# 把 package.json / README / screenshots 里的 OWNER 占位符换成你的 GitHub 用户（或组织）名。
# 用法： ./scripts/set-repo.sh langhua   或   ./scripts/set-repo.sh my-org my-plugin-repo
#
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-dsh-image-pin-comment}"

if [[ -z "${OWNER}" ]]; then
  echo "用法： $0 <github-owner> [repo-name]" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

node -e '
  const fs = require("node:fs");
  const [owner, repo] = process.argv.slice(1);
  const file = "package.json";
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.repository = { type: "git", url: `git+https://github.com/${owner}/${repo}.git` };
  pkg.homepage = `https://github.com/${owner}/${repo}#readme`;
  pkg.bugs = { url: `https://github.com/${owner}/${repo}/issues` };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "${OWNER}" "${REPO}"

echo "package.json → https://github.com/${OWNER}/${REPO}"
echo
echo "别忘了："
echo "  1) git remote add origin git@github.com:${OWNER}/${REPO}.git && git push -u origin main"
echo "  2) 仓库打上 dsh-plugin topic（网页右上 About ⚙️ → Topics，或 gh repo edit --add-topic dsh-plugin）"
echo "  3) 插件市场收录条目里的 owner/repo 也要用 ${OWNER}/${REPO}"
