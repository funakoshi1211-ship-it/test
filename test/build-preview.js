// GAS の include を展開して、ブラウザで直接開ける1枚の HTML を作る（デモ表示用）
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'gas');
let html = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
html = html.replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => fs.readFileSync(path.join(dir, n + '.html'), 'utf8'));
const out = process.argv[2] || path.join(__dirname, '..', 'preview.html');
fs.writeFileSync(out, html);
console.log('wrote', out);
