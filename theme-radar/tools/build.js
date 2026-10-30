// gas/ の3ファイルを、貼り付け用の1ファイル（dist/Code.gs）にまとめる
//   node theme-radar/tools/build.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), dir = path.join(root, 'gas'), out = path.join(root, 'dist');
const parts = ['Code.gs', 'Engine.gs', 'Themes.gs'].map(f => '// ===== ' + f + ' =====\n' + fs.readFileSync(path.join(dir, f), 'utf8'));
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'Code.gs'), '// このファイルは theme-radar/tools/build.js で gas/ から自動生成しています。直接編集しないでください\n' + parts.join('\n'));
fs.copyFileSync(path.join(dir, 'appsscript.json'), path.join(out, 'appsscript.json'));
console.log('wrote theme-radar/dist/Code.gs, theme-radar/dist/appsscript.json');
