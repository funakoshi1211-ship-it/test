// 印刷用シートの作成（exportPrint）が最後まで動くかを、何でも受け付ける簡易な代役で確かめる
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const { S } = require('./run.js');
const written = [];
function chain(extra) {
  return new Proxy(Object.assign(function () {}, extra || {}), {
    get(t, k) { if (k in t) return t[k]; return () => chain(); },
    apply() { return chain(); }
  });
}
const sheet = chain({
  getRange: (r, c) => {
    // どのメソッドを呼んでも同じ範囲を返し、書き込んだ値だけ記録する
    const range = new Proxy({}, { get(t, k) {
      if (k === 'setValues') return (v) => { written.push({ r, c, v }); return range; };
      if (k === 'setValue') return (v) => { written.push({ r, c, v: [[v]] }); return range; };
      return () => range;
    } });
    return range;
  },
  getSheetId: () => 123, getMaxRows: () => 100, getMaxColumns: () => 40
});
const ctx = {
  console, Utilities: { formatDate: (d, tz, f) => { const p = n => String(n).padStart(2, '0'); return f === 'yyyy-MM' ? d.getFullYear() + '-' + p(d.getMonth() + 1) : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); } },
  SpreadsheetApp: { getActive: () => chain({ getSheetByName: () => null, insertSheet: () => sheet, getUrl: () => 'https://sheet', getId: () => 'ID' }), flush() {}, BorderStyle: {} },
  PropertiesService: { getDocumentProperties: () => ({ getProperty: () => null }) }
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), ctx);
ctx.getData = () => ({ master: S.master, note: '' });
const cells = { S1: { '2026-08-03': { AM: '一', PM: '入', N: '' }, '2026-08-04': { AM: '明', PM: '明', N: '深夜' } },
  S2: { '2026-08-01': { AM: '夜', PM: '夜', N: '準夜' } }, S3: { '2026-08-05': { AM: '中 8:30-14:30', PM: '', N: '' } } };
const r = vm.runInContext('exportPrint', ctx)('2026-08', cells, '事務 川又 8/12-14 有給');
assert.ok(/format=pdf/.test(r.pdf) && /size=A3/.test(r.pdf) && /portrait=false/.test(r.pdf), 'A3横のPDF');
const grid = written.find(w => w.r === 1 && w.c === 1 && w.v.length > 2).v;
const row = name => grid.findIndex(x => x[0] === name);
const col = d => 3 + d - 1;
const a = row('管薬A'), b = row('管薬B'), c = row('管薬C');
assert.strictEqual(grid[a][col(3)], '一'); assert.strictEqual(grid[a + 1][col(3)], '', '入は印刷しない');
assert.strictEqual(grid[a][col(4)], '0-9'); assert.strictEqual(grid[a + 1][col(4)], '', '明は印刷しない');
assert.strictEqual(grid[b][col(1)], ''); assert.strictEqual(grid[b + 1][col(1)], '16-24');
assert.strictEqual(grid[c][col(5)], '中 8:30-14:30', '手入力の文字はそのまま');
assert.ok(written.some(w => String(w.v[0][0]).includes('川又')), '備考が入る');
console.log('print tests passed');
