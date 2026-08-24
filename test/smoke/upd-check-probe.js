// 临时探针：验证当前运行实例的更新检查开发模式短路
const http = require('http');
const fs = require('fs');
const path = require('path');
const SPEC = '127.0.0.1:9333';
const OUTFILE = path.join(__dirname, 'upd-check-result.txt');
let WS;
try { WS = globalThis.WebSocket; } catch (e) { }
if (!WS) { try { WS = require('ws'); } catch (e) { } }
function json(p) { return new Promise((res, rej) => { http.get(`http://${SPEC}${p}`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const result = [];
  const write = () => fs.writeFileSync(OUTFILE, result.join('\n') + '\n');
  if (!WS) { result.push('FATAL no WebSocket'); write(); process.exit(2); }
  let pages = null;
  for (let i = 0; i < 60 && !pages; i++) { try { const p = await json('/json'); if (Array.isArray(p) && p.length) pages = p; } catch (e) {} if (!pages) await sleep(400); }
  const page = pages.find((p) => p.type === 'page' && /index/.test(p.url)) || pages.find((p) => p.type === 'page');
  const ws = new WS(page.webSocketDebuggerUrl);
  let id = 0; const pend = {}; const logs = [];
  const send = (method, params) => new Promise((res) => { const mid = ++id; pend[mid] = res; ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.method === 'Runtime.exceptionThrown') { const ed = m.params.exceptionDetails; logs.push('EXC: ' + (ed ? (ed.exception ? ed.exception.description : ed.text) : '?')); } if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; } };
  await new Promise((r) => (ws.onopen = r));
  await send('Runtime.enable');
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) logs.push('EVAL: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text)); return r.result && r.result.value; };
  const apiInfo = await ev(`(function(){try{return {hasApi:!!(window.api&&window.api.update),keys:window.api&&window.api.update?Object.keys(window.api.update):[]};}catch(e){return {err:String(e)};}})()`);
  result.push('API ' + JSON.stringify(apiInfo));
  const st = await ev(`(function(){return window.api.update.getState();})()`);
  result.push('STATE ' + JSON.stringify(st));
  const ck = await ev(`(function(){return window.api.update.check();})()`);
  result.push('CHECK ' + JSON.stringify(ck));
  const st2 = await ev(`(function(){return window.api.update.getState();})()`);
  result.push('STATE2 ' + JSON.stringify(st2));
  result.push('LOGS  ' + (logs.length ? '\n' + logs.join('\n') : '(none)'));
  write();
  process.exit(0);
})();
