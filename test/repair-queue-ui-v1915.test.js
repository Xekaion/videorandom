const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const fixtureFile = path.join(__dirname, 'completed-actions-ui-v1914.test.js');
const source = fs.readFileSync(fixtureFile, 'utf8');
const fixtureModule = { exports: {} };
vm.runInNewContext(source.slice(0, source.indexOf('\ntest(')) + '\nmodule.exports = { boot, result, rowFor, nodes, textOf, openDetail, settings };', {
  module: fixtureModule, require: createRequire(fixtureFile), __dirname, setImmediate, TextEncoder, URL, Blob, console
}, { filename: fixtureFile });
const { boot, result, rowFor, nodes, textOf, openDetail, settings } = fixtureModule.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(setImmediate);
const action = (ui, id, translation = true) => nodes(rowFor(ui,id)).find(node => node.tag === 'button'
  && (translation ? node.dataset.translationRepairId === id : node.dataset.repairRecordId === id));
const activeRecord = result('owned-current');
const active = { id:'owned-active-job', source:'manual', status:'running', total:1, completed:0,
  currentFile:activeRecord.name, currentFilePath:activeRecord.path, stage:'합성 작업 진행 중', stageKey:'summary', percent:40, results:[] };

async function fixture({ paused=false, pending=[], activeJob=active, fail=false, hold=false }={}) {
  const records = [activeRecord, result('owned-translate-b',{completed:1}), result('owned-full-c',{summary:false}), result('owned-translate-d',{completed:2})];
  let queue = {enabled:true,paused,configured:true,options:settings,pending:plain(pending),pendingCount:pending.length,
    activeAutoPath:'',activeJob:plain(activeJob),waitingReason:paused?'합성 오류로 일시 중지됨':'',currentBatch:activeJob?[{name:activeRecord.name,path:activeRecord.path,status:'running'}]:[]};
  const ui = await boot({records,savedSettings:settings,initialQueue:queue,initialActiveJob:activeJob});
  const fetch = ui.sandbox.fetch, requests=[];
  let release;
  const gate = hold ? new Promise(resolve => {release=resolve;}) : Promise.resolve();
  ui.sandbox.fetch = async (url, options={}) => {
    if (url === '/api/analysis/queue/repair') {
      const body=JSON.parse(options.body); requests.push({url,method:options.method,body});
      await gate;
      if (fail) return {ok:false,status:400,json:async()=>({error:'합성 대기 저장 실패'})};
      const record=records.find(item=>item.id===body.recordId); assert(record);
      const exists=queue.pending.some(item=>item.path===record.path);
      if (!exists) queue.pending.push({name:record.name,path:record.path,source:'repair',operation:body.operation,
        repairOf:record.id,position:queue.pending.length+1,status:'waiting'});
      queue={...queue,pendingCount:queue.pending.length}; ui.setQueue(queue);
      return {ok:true,status:exists?200:202,json:async()=>plain({status:exists?'already-queued':'queued',addedCount:exists?0:1,queue})};
    }
    if (url.startsWith('/api/analysis/queue?')) return {ok:true,json:async()=>plain(queue)};
    return fetch(url,options);
  };
  return {ui,records,requests,release,getQueue:()=>queue};
}

test('other catalog rows can queue multiple different repair operations while the active job stays visible', async()=>{
  const f=await fixture(), {ui}=f;
  assert.equal(action(ui,'owned-current').disabled,true,'the same current source cannot be queued twice');
  const translating=action(ui,'owned-translate-b');
  assert.equal(translating.disabled,false); assert.match(translating.textContent,/대기 추가/);
  await translating.dispatch('click');
  assert.equal(f.requests.length,1); assert.equal(f.requests[0].body.operation,'translation-only');
  assert.equal(f.requests[0].body.options.transcribeAudio,false);
  assert.equal(action(ui,'owned-translate-b').disabled,true);
  assert.match(action(ui,'owned-translate-b').textContent,/복구 대기 중/);
  await action(ui,'owned-full-c',false).dispatch('click');
  await action(ui,'owned-translate-d').dispatch('click');
  assert.deepEqual(f.requests.map(call=>[call.body.recordId,call.body.operation]),[
    ['owned-translate-b','translation-only'],['owned-full-c','analysis'],['owned-translate-d','translation-only']]);
  assert.equal(ui.calls.filter(call=>/\/results\/.*\/repair$/.test(call.url)&&call.method==='POST').length,0);
  assert.match(ui.elements.get('catalogJobFile').textContent,/owned-current/);
  const queueText=textOf(ui.elements.get('catalogQueueItems'));
  assert.match(queueText,/owned-translate-b/);assert.match(queueText,/한국어 자막 번역 복구/);
  assert.match(queueText,/owned-full-c/);assert.match(queueText,/영상 전체 복구/);
});

test('detail primary and optional repair controls queue a different video without replacing current work', async()=>{
  const {ui,requests}=await fixture();
  await openDetail(ui,'owned-translate-b');
  const button=ui.elements.get('catalogDetailPrimaryRepair');
  assert.equal(button.disabled,false);assert.match(button.textContent,/대기 추가/);
  await button.dispatch('click');
  assert.equal(requests.length,1);assert.equal(requests[0].body.recordId,'owned-translate-b');
  assert.equal(requests[0].body.operation,'translation-only');
  assert.equal(ui.elements.get('catalogSubtitleRepair').disabled,true);
  await openDetail(ui,'owned-full-c');
  assert.equal(ui.elements.get('catalogDetailRepair').disabled,false);
  await ui.elements.get('catalogDetailRepair').dispatch('click');
  assert.equal(requests[1].body.operation,'analysis');
  assert.match(ui.elements.get('catalogJobFile').textContent,/owned-current/);
});

test('queued repair clicks retain a prior pause and explain that explicit resume is required', async()=>{
  const {ui,requests,getQueue}=await fixture({paused:true});
  await action(ui,'owned-translate-b').dispatch('click');
  assert.equal(requests.length,1);assert.equal(getQueue().paused,true);
  assert.match(ui.elements.get('catalogQueueNotice').textContent,/일시 중지.*재개/);
  assert.equal(ui.calls.some(call=>call.body?.resume===true),false);
});

test('an existing pending task keeps later repair clicks FIFO even with no currently running job', async()=>{
  const pending=[{name:'earlier.mp4',path:'Z:\\OWNED_ACTION_UI_ONLY\\earlier.mp4',position:1,source:'manual',status:'waiting'}];
  const f=await fixture({pending,activeJob:null,paused:true});
  await action(f.ui,'owned-translate-b').dispatch('click');
  assert.equal(f.requests.length,1);assert.equal(f.getQueue().pending[0].name,'earlier.mp4');
  assert.equal(f.getQueue().pending[1].repairOf,'owned-translate-b');
});

test('a held queue request ignores double clicks and re-enables other targets after durable enqueue', async()=>{
  const f=await fixture({hold:true});
  const button=action(f.ui,'owned-translate-b');
  const saving=button.dispatch('click');await flush();
  await button.dispatch('click');
  assert.equal(f.requests.length,1);
  assert.equal(action(f.ui,'owned-full-c',false).disabled,true);
  f.release();await saving;
  assert.equal(action(f.ui,'owned-full-c',false).disabled,false);
  assert.equal(action(f.ui,'owned-translate-b').disabled,true);
});

test('failed queue persistence reports the filename and keeps the current job and old results', async()=>{
  const {ui,requests}=await fixture({fail:true});
  await action(ui,'owned-translate-b').dispatch('click');
  assert.equal(requests.length,1);
  assert.match(ui.elements.get('catalogNotice').textContent,/합성 대기 저장 실패/);
  assert.match(ui.elements.get('catalogJobFile').textContent,/owned-current/);
  assert.equal(action(ui,'owned-translate-b').disabled,false);
});
