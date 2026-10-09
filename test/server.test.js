// Code.gs の保存処理（上書き防止）を、GAS の簡易な代役で確かめる
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
function makeSheet(header) {
  let data = [header.slice()];
  return {
    getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => data.slice(r - 1, r - 1 + nr).map(row => { const x = row.slice(c - 1, c - 1 + nc); while (x.length < nc) x.push(''); return x; }),
      setValues: (v) => { v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((val, j) => data[r - 1 + i][c - 1 + j] = val); }); return this; },
      clearContent: () => { data = data.slice(0, r - 1); },
      setNumberFormat() { return this; }
    })
  };
}
const props = {};
const sheets = {};
const ctx = {
  console,
  PropertiesService: { getDocumentProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: { getUuid: (() => { let n = 0; return () => 'v' + (++n); })(), formatDate: () => '10/9 15:00' },
  Session: { getActiveUser: () => ({ getEmail: () => ctx.__user }) },
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] }) },
  __user: 'a@example.com'
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8'), ctx);
sheets['希望'] = makeSheet(ctx.SHEETS ? [] : []);
vm.runInContext("this.__S = SHEETS;", ctx);
sheets['希望'] = makeSheet(ctx.__S.requests.header);
sheets['シフト'] = makeSheet(ctx.__S.shift.header);
const cellsA = { S01: { '2026-11-02': { AM: '一', PM: '一', N: '' } } };
const cellsB = { S01: { '2026-11-02': { AM: '定休', PM: '定休', N: '' } } };

// A と B が同じ版（未保存）を読み込む
const r1 = vm.runInContext("saveMonth('2026-11', {}, " + JSON.stringify(cellsA) + ", '', false)", ctx);
assert.ok(r1.ok, 'A の最初の保存は成功する');
ctx.__user = 'b@example.com';
const r2 = vm.runInContext("saveMonth('2026-11', {}, " + JSON.stringify(cellsB) + ", '', false)", ctx);
assert.ok(r2.conflict && r2.by === 'a@example.com', 'B は A の保存と衝突として止まる');
assert.strictEqual(vm.runInContext("readCells_('shift', '2026-11').S01['2026-11-02'].AM", ctx), '一', 'A の内容が残っている');
const r3 = vm.runInContext("saveMonth('2026-11', {}, " + JSON.stringify(cellsB) + ", '', true)", ctx);
assert.ok(r3.ok, 'B が上書きを選べば保存できる');
assert.strictEqual(vm.runInContext("readCells_('shift', '2026-11').S01['2026-11-02'].AM", ctx), '定休');
const r4 = vm.runInContext("saveMonth('2026-11', {}, " + JSON.stringify(cellsB) + ", '" + r3.version.id + "', false)", ctx);
assert.ok(r4.ok, '最新の版から続けて保存するときは止まらない');
console.log('server tests passed');
