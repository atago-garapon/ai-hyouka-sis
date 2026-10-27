// index.html の評価エンジン（最初の <script> の ENG）を Node で読み込む。
// 評価・指導AIのコードを二重に持たないため、常に index.html から直接読む。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function loadEngine(htmlPath = path.join(__dirname, "..", "index.html")) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("index.html にエンジンの <script> が見つかりません");
  return vm.runInNewContext(m[1] + "\n;ENG", { console });
}

module.exports = { loadEngine };
