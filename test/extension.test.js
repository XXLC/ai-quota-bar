'use strict';
require('../src/i18n').setLocale('vi');
process.env.TZ='Asia/Ho_Chi_Minh';
const {test}=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
test('Bộ nối VS Code đăng ký lệnh, áp dụng cấu hình, tooltip an toàn và dừng',async()=>{
 const originalLoad=Module._load,originalInterval=global.setInterval,originalClear=global.clearInterval;
 const registered=new Map(),messages=[],logs=[],items=[];let tick,changed,disposed=false,configPath='',runCount=0;
 const state={buckets:[],lastAttemptAt:null,lastSuccessAt:null,runningSince:null};
 const bar={show(){},dispose(){}};
 const fakeVscode={
  StatusBarAlignment:{Right:2},QuickPickItemKind:{Separator:-1},
  ThemeColor:class {constructor(id){this.id=id;}},
  MarkdownString:class {constructor(value){this.value=value;}},
  workspace:{getConfiguration:()=>({get:key=>key==='agyPath'?configPath:key==='providers.claude.enabled'||key==='providers.codex.enabled'?false:undefined}),onDidChangeConfiguration:cb=>{changed=cb;return {dispose(){}};}},
  commands:{registerCommand:(name,cb)=>{registered.set(name,cb);return {dispose(){}};},executeCommand:async()=>{}},
  window:{createOutputChannel:()=>({info:s=>logs.push(s),warn:s=>logs.push(s),error:s=>logs.push(s),show(){},dispose(){}}),createStatusBarItem:()=>bar,showErrorMessage:async s=>messages.push(s),showWarningMessage:async()=>{},showInformationMessage:async()=>{},showQuickPick:async choices=>{items.push(...choices);}}
 };
 const runner={run:async()=>{runCount++;return {error:{type:'not-found',message:'Không tìm thấy agy.'}};},invalidate(){},dispose(){disposed=true;}};
 const store={
  claim:async(c,manual)=>({claimed:true,state:{...state,runningSince:1}}),
  complete:async result=>({state:{...state,error:result.error}})
 };
 Module._load=function(request,parent,...rest){
  if(parent?.filename.endsWith('extension.js')){
   if(request==='vscode')return fakeVscode;
   if(request==='./providers/agy')return {id:'agy',createProvider:()=>({id:'agy',fetch:runner.run,dispose:runner.dispose})};
   if(request==='./state')return {emptyState:()=>({...state}),createStore:()=>store};
  }
  return originalLoad.call(this,request,parent,...rest);
 };
 global.setInterval=(cb,ms)=>{assert.equal(ms,60000);tick=cb;return 1;};global.clearInterval=()=>{};
 try {
  const extension=require('../src/extension');const context={globalStorageUri:{fsPath:'/kho'},subscriptions:[]};extension.activate(context);
  await new Promise(setImmediate);assert.equal(registered.size,4);assert.equal(runCount,1);assert.equal(bar.tooltip.isTrusted,false);assert.equal(bar.command,'aiQuota.showDetails');assert.equal(messages.length,1);
  await registered.get('aiQuota.refresh')();assert.equal(messages.length,1);
  await registered.get('aiQuota.showDetails')();assert.deepEqual(items.filter(item=>item.action).map(item=>item.action),['refresh','log','selectProviders','settings']);
  configPath='C:\\agy.exe';changed({affectsConfiguration:()=>true});await new Promise(setImmediate);assert.equal(runCount,3);
  tick();await new Promise(setImmediate);assert.equal(runCount,4);
  extension.deactivate();assert.equal(disposed,true);
 }finally{Module._load=originalLoad;global.setInterval=originalInterval;global.clearInterval=originalClear;}
});
