'use strict';
require('../src/i18n').setLocale('vi');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {resolveAgy,createRunner}=require('../src/runner');
const {emptyState,validState,createStore}=require('../src/state');
const {EventEmitter}=require('node:events');
const response=JSON.stringify({command:{name:'usage'},num_turns:0,conversation_id:'',response:'Nhóm\tFive Hour Limit Remaining\t10%'});
const fakeChild=()=>({pid:123,stdin:Object.assign(new EventEmitter(),{end(){this.ended=true;}}),kill(){this.killed=true;}});
function harness(options={}) {
 const calls=[],logs=[];let callback,timer;const child=fakeChild();
 const execFile=(file,args,opts,cb)=>{calls.push({file,args,opts});if(file==='taskkill.exe'){cb(null);return fakeChild();}callback=cb;return child;};
 const runner=createRunner({execFile,exists:()=>true,homedir:()=>'/nhà',platform:'win32',env:{PATH:'C:\\agy'},now:()=>42,setTimer:cb=>{timer=cb;return 1;},clearTimer:()=>{},log:s=>logs.push(s),...options});
 return {runner,calls,logs,child,finish:(...args)=>callback(...args),timeout:()=>timer()};
}
for(const [name,args,expected] of [
 ['cấu hình tồn tại',{configPath:'C:\\agy.exe',exists:()=>true},'C:\\agy.exe'],
 ['PATH thứ hai',{env:{PATH:';\"C:\\một\";C:\\hai'},exists:p=>p==='C:\\hai\\agy.exe'},'C:\\hai\\agy.exe'],
 ['mặc định Windows',{env:{LOCALAPPDATA:'C:\\Local'},exists:()=>true},'C:\\Local\\agy\\bin\\agy.exe'],
 ['Linux',{platform:'linux',env:{PATH:':/bin',LOCALAPPDATA:'C:\\Local'},exists:()=>true},'/bin/agy']
])test('Tìm agy '+name,()=>assert.equal(resolveAgy({platform:'win32',env:{},...args}).path,expected));
test('Không tìm thấy và từ chối cmd hoặc bat',()=>{
 for(const configPath of ['x.cmd','x.BAT'])assert.match(resolveAgy({platform:'win32',configPath,exists:()=>true}).error.message,/chỉ hỗ trợ tệp .exe/);
 assert.equal(resolveAgy({platform:'win32',configPath:'x.exe',exists:()=>false}).error.type,'not-found');
 assert.equal(resolveAgy({platform:'linux',env:{LOCALAPPDATA:'x'},exists:()=>false}).error.type,'not-found');
});
test('D8, đóng stdin, thành công, không ghi đầu ra thô',async()=>{
 const h=harness();const result=h.runner.run({});const call=h.calls[0];assert.deepEqual(call.args,['--output-format','json','-p','/usage']);assert.equal(call.opts.windowsHide,true);assert.equal(call.opts.cwd,'/nhà');assert.equal(call.opts.maxBuffer,262144);assert.equal(call.opts.encoding,'utf8');assert.equal(call.opts.env.NO_COLOR,'1');assert.equal(h.child.stdin.ended,true);
 h.finish(null,response,'');assert.equal((await result).buckets.length,1);assert.ok(h.logs.every(s=>!s.includes(response)));
});
test('Chia sẻ Promise và chạy lại sau khi xong',async()=>{
 const h=harness();const first=h.runner.run();assert.equal(first,h.runner.run());assert.equal(h.calls.length,1);h.finish(null,response);await first;
 const second=h.runner.run();assert.equal(h.calls.length,2);h.finish(null,response);await second;
});
test('Mã thoát khác không vẫn nhận dữ liệu hợp lệ',async()=>{const h=harness();const p=h.runner.run();h.finish({code:7},response);assert.equal((await p).exitCode,7);});
test('Không có dữ liệu hợp lệ là lỗi exit và làm sạch stderr',async()=>{const h=harness();const p=h.runner.run();h.finish(null,'','Bearer SECRET');const result=await p;assert.equal(result.error.type,'exit');assert.match(result.error.message,/đã che/);assert.ok(h.logs.every(s=>!s.includes('SECRET')));});
for(const exists of [true,false])test('ENOENT khi tệp '+(exists?'vẫn còn':'đã mất'),async()=>{
 let present=true;const h=harness({exists:()=>present});const p=h.runner.run();present=exists;h.finish({code:'ENOENT'});
 assert.equal((await p).error.type,exists?'spawn':'not-found');
});
test('Timeout giết cây Windows và kết thúc Promise',async()=>{const h=harness();const p=h.runner.run();h.timeout();assert.equal((await p).error.type,'timeout');assert.deepEqual(h.calls[1].args,['/PID','123','/T','/F']);assert.equal(h.calls[1].opts.windowsHide,true);});
test('Dừng bộ chạy và lỗi tràn bộ đệm',async()=>{
 const h=harness();const p=h.runner.run();h.runner.dispose();assert.equal((await p).cancelled,true);assert.equal((await h.runner.run()).cancelled,true);
 const other=harness();const q=other.runner.run();other.finish({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',message:'Quá bộ đệm'});assert.equal((await q).error.type,'spawn');
});
test('Lỗi spawn đồng bộ',async()=>{const h=harness({execFile:()=>{throw Object.assign(new Error('Không chạy được'),{code:'EACCES'});}});assert.equal((await h.runner.run()).error.type,'spawn');});
test('Không chạy tiến trình nếu không tìm thấy',async()=>{const h=harness({exists:()=>false});assert.equal((await h.runner.run()).error.type,'not-found');assert.equal(h.calls.length,0);});
function memoryFs() {
 const files=new Map(),locks=new Set(),operations=[];
 return {files,locks,operations,async mkdir(){},async readFile(p){if(!files.has(p))throw Object.assign(new Error('Không có tệp'),{code:'ENOENT'});return files.get(p);},async writeFile(p,data){operations.push('ghi');files.set(p,data);},async rename(a,b){operations.push('đổi tên');if(locks.has(a)){locks.delete(a);locks.add(b);}else{files.set(b,files.get(a));files.delete(a);}},async unlink(p){files.delete(p);locks.delete(p);},async open(p){if(locks.has(p))throw Object.assign(new Error('Đang khóa'),{code:'EEXIST'});locks.add(p);return {async close(){}};},async stat(){return {mtimeMs:1000};}};
}
const bucket={groupName:'Nhóm',groupLabel:'Nhóm',windowKey:'5h',windowLabel:'5 giờ',fraction:.1,percent:10,resetAt:null};
test('Trạng thái hỏng hoặc thiếu khôi phục an toàn',async()=>{
 const fs=memoryFs(),store=createStore({directory:'/kho',fs});assert.deepEqual(await store.read(),emptyState());
 fs.files.set(require('node:path').join('/kho','state-agy.json'),'{');assert.deepEqual(await store.read(),emptyState());assert.equal(validState({buckets:[{}]}),false);
});
test('Ghi nguyên tử, cửa sổ khác dùng kết quả mới và ghi mức trước thông báo',async()=>{
 const fs=memoryFs();let time=1000;const one=createStore({directory:'/kho',fs,now:()=>time,id:'một'}),two=createStore({directory:'/kho',fs,now:()=>time,id:'hai'});
 assert.equal((await one.claim({})).claimed,true);assert.equal((await two.claim({})).claimed,false);
 time=2000;const completed=await one.complete({buckets:[bucket]},{});assert.equal(completed.notification.events.length,1);
 assert.equal((await two.read()).levels['agy|Nhóm|5h'],'critical');assert.equal(typeof two.observe,'undefined');
 assert.equal((await two.claim({})).claimed,false);assert.deepEqual(fs.operations.slice(0,2),['ghi','đổi tên']);
 assert.equal((await two.claim({},true)).claimed,true);
});
test('Hai yêu cầu claim đồng thời chỉ có một người chạy',async()=>{
 const fs=memoryFs(),a=createStore({directory:'/kho',fs,now:()=>1000,id:'a'}),b=createStore({directory:'/kho',fs,now:()=>1000,id:'b'});
 const results=await Promise.all([a.claim({}),b.claim({})]);assert.equal(results.filter(r=>r.claimed).length,1);
});
test('Lỗi giữ dữ liệu; thủ công xóa backoff; thành công xóa lỗi',async()=>{
 const fs=memoryFs();let time=1000;const s=createStore({directory:'/kho',fs,now:()=>time});
 await s.claim({});await s.complete({buckets:[bucket]},{});
 for(let i=0;i<3;i++)await s.complete({error:{type:'exit',message:'Lỗi'}},{});
 assert.equal((await s.read()).buckets.length,1);assert.equal((await s.read()).consecutiveErrors,3);
 time++;await s.claim({},true);assert.equal((await s.read()).consecutiveErrors,0);
 await s.complete({buckets:[bucket]},{});assert.equal((await s.read()).error,null);
});
test('Thông báo tắt vẫn lưu mức qua lần đọc sau',async()=>{const fs=memoryFs(),s=createStore({directory:'/kho',fs,now:()=>1000});await s.claim({});const r=await s.complete({buckets:[bucket]},{notificationEnabled:false});assert.equal(r.notification.events.length,0);assert.equal((await s.read()).levels['agy|Nhóm|5h'],'critical');});
test('Manifest hợp lệ, đủ khóa và giới hạn',()=>{
 const fs=require('node:fs');const manifest=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../package.json'),'utf8').replace(/^\uFEFF/,''));
 const props=manifest.contributes.configuration.properties;assert.equal(Object.keys(props).length,13);assert.equal(props['aiQuota.agyPath'].scope,'machine');
 for(const key of ['refreshInterval','timeout','warningThreshold','criticalThreshold','deepseekWarningThreshold']){assert.equal(typeof props['aiQuota.'+key].minimum,'number');assert.equal(typeof props['aiQuota.'+key].maximum,'number');}
 assert.deepEqual(manifest.extensionKind,['ui']);assert.equal(manifest.capabilities.untrustedWorkspaces.supported,true);assert.equal(manifest.capabilities.virtualWorkspaces,true);
});
test('Không chạy lượt mới trong lúc đang giết cây',async()=>{
 let killed;const calls=[];const h=harness({execFile:(file,args,options,callback)=>{calls.push(file);if(file==='taskkill.exe')killed=callback;return fakeChild();}});
 const first=h.runner.run();h.timeout();assert.equal(h.runner.run(),first);assert.equal(calls.length,2);killed(null);assert.equal((await first).error.type,'timeout');
});
test('Giết nhóm tiến trình trên hệ điều hành khác',async()=>{
 const calls=[];const signals=[];const h=harness({kill:(...args)=>signals.push(args),platform:'linux',env:{PATH:'/bin'},execFile:(file,args,options,callback)=>{calls.push({file,args,options});if(file==='kill')callback(null);return fakeChild();}});
 const p=h.runner.run();h.timeout();assert.equal((await p).error.type,'timeout');assert.equal(calls[0].options.detached,true);assert.deepEqual(signals,[[-123,'SIGKILL']]);assert.equal(calls.length,1);
});
test('Tìm lại agy sau ENOENT và khi đổi đường dẫn',async()=>{
 const h=harness();let p=h.runner.run({agyPath:'C:\\một.exe'});h.finish({code:'ENOENT'});await p;
 p=h.runner.run({agyPath:'C:\\hai.exe'});assert.equal(h.calls[1].file,'C:\\hai.exe');h.finish(null,response);await p;
});
test('Ghi mức thất bại không trả thông báo chưa lưu',async()=>{
 const fs=memoryFs();const s=createStore({directory:'/kho',fs,now:()=>1000});await s.claim({});
 fs.rename=async()=>{throw new Error('Không đổi tên được');};
 await assert.rejects(s.complete({buckets:[bucket]},{}),/Không đổi tên được/);assert.equal((await s.read()).lastSuccessAt,null);assert.equal(fs.locks.size,0);
});
test('Khóa cũ được thu hồi mà không xóa tệp trạng thái',async()=>{
 const fs=memoryFs(),p=require('node:path');fs.locks.add(p.join('/kho','state-agy.lock'));
 const s=createStore({directory:'/kho',fs,now:()=>400000});assert.equal((await s.claim({})).claimed,true);
});
test('Lệnh giết cây không trả callback vẫn kết thúc sau thời gian bảo vệ',async()=>{
 const h=harness({execFile:()=>fakeChild()});const p=h.runner.run();h.timeout();h.timeout();assert.equal((await p).error.type,'timeout');
});
test('Trạng thái sai mức hoặc số lỗi không được tin cậy',()=>{
 assert.equal(validState({...emptyState(),levels:'sai'}),false);
 assert.equal(validState({...emptyState(),consecutiveErrors:'ba'}),false);
 assert.equal(validState({...emptyState(),error:{type:'sai',message:'Lỗi'}}),false);
});
