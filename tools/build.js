// GAS の include を展開して、貼り付け用の3ファイル（dist/）とデモ画面を作る
//   node tools/build.js                 → dist/Code.gs, dist/Index.html, dist/appsscript.json
//   node tools/build.js preview.html    → ブラウザで直接開けるデモ画面
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), dir = path.join(root, 'gas');
let html = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
html = html.replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => fs.readFileSync(path.join(dir, n + '.html'), 'utf8'));
if (/<\?/.test(html)) throw new Error('展開後の HTML に GAS のテンプレート記号が残っています');
if (process.argv[2]) {
  fs.writeFileSync(process.argv[2], html);
  console.log('wrote', process.argv[2]);
} else {
  const out = path.join(root, 'dist');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'Index.html'), '<!-- このファイルは tools/build.js で gas/ から自動生成しています。直接編集しないでください -->\n' + html);
  fs.copyFileSync(path.join(dir, 'Code.gs'), path.join(out, 'Code.gs'));
  fs.copyFileSync(path.join(dir, 'appsscript.json'), path.join(out, 'appsscript.json'));
  console.log('wrote dist/Code.gs, dist/Index.html, dist/appsscript.json');
}
