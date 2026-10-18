// gas/ の3ファイルを1つにまとめて、貼り付け用の dist/ を作る
//   node tools/build.js   → dist/Code.gs, dist/appsscript.json
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), dir = path.join(root, 'gas');

function bundle() {
  return '// このファイルは tools/build.js で gas/（Logic.gs・Defaults.gs・Code.gs）から自動生成しています。直接編集しないでください\n\n' +
    ['Logic.gs', 'Defaults.gs', 'Code.gs'].map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
}
module.exports = { bundle };

if (require.main === module) {
  const out = path.join(root, 'dist');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'Code.gs'), bundle());
  fs.copyFileSync(path.join(dir, 'appsscript.json'), path.join(out, 'appsscript.json'));
  console.log('wrote dist/Code.gs, dist/appsscript.json');
}
