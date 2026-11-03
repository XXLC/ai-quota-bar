'use strict';
require('../src/i18n').setLocale('vi');
process.env.TZ='Asia/Ho_Chi_Minh';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse,parseTsv,groupLabel,sanitize}=require('../src/parse');
const {configuration,level,transitions,isRefreshDue,intervalMs,isStale}=require('../src/thresholds');
const {display,countdown,resetTime,ago,escapeMarkdown,notification}=require('../src/format');
const at=Date.parse('2026-11-03T00:00:00Z');
const tsv='Gemini Models\tWeekly Limit Remaining\t60%\t2026-11-06T23:24:21Z\nGemini Models\tFive Hour Limit Remaining\t90%\t2026-11-03T19:48:29Z\nClaude and GPT models\tWeekly Limit Remaining\t50%\t2026-11-09T10:05:03Z\nClaude and GPT models\tFive Hour Limit Remaining\t84%\t2026-11-03T22:16:04Z\n';
const envelope=(response=tsv)=>({conversation_id:'',num_turns:0,command:{name:'usage'},response});
const sample=(percent=50,resetAt=at+3600000)=>({groupName:'Gemini Models',groupLabel:'Gemini',windowKey:'5h',windowLabel:'5 giờ',percent,fraction:percent/100,resetAt});
test('TSV chuẩn, thứ tự và nhãn',()=>{const b=parseTsv(tsv);assert.equal(b.length,4);assert.deepEqual(b.map(x=>x.percent),[90,60,84,50]);assert.equal(b[0].windowKey,'5h');assert.equal(b[2].groupLabel,'Claude/GPT');assert.equal(b[0].resetAt,Date.parse('2026-11-03T19:48:29Z'));});
test('JSON chính sử dụng số thực và giữ thứ tự nhóm',()=>{
 const e=envelope();e.command.data={groups:[{name:'Gemini Models',buckets:[{name:'Weekly Limit Remaining',window:'weekly',remaining_fraction:.104,reset_time:'sai'},{name:'Five Hour Limit Remaining',window:'5h',remaining_fraction:.099}]}]};
 const b=parse(JSON.stringify(e)).buckets;assert.deepEqual(b.map(x=>x.percent),[9,10]);assert.equal(b[0].resetAt,null);
});
for(const [name,input] of [['CRLF',tsv.replaceAll('\n','\r\n')],['dòng trống','\n \n'+tsv+'\n'],['BOM','\uFEFF'+tsv],['ANSI','\x1b[31m'+tsv+'\x1b[0m'],['cập nhật','Có bản cập nhật\n'+tsv+'Hết dữ liệu'],['khoảng trắng',tsv.split('\n').filter(Boolean).map(x=>x.split('\t').map(c=>' '+c+' ').join('\t')+'\t').join('\n')]]) test('TSV xử lý '+name,()=>assert.equal(parse(JSON.stringify(envelope(input))).buckets.length,4));
for(const [input,expected] of [['61.5%',61],['0%',0],['100%',100],['61 %',61],['101%',null],['-1%',null],['61',null],['N/A',null],['61,5%',null],['',null]])test('Phần trăm TSV '+input,()=>{const b=parseTsv('Nhóm models\tDaily Limit Remaining\t'+input);assert.equal(b[0]?.percent??null,expected);});
for(const reset of ['',undefined,'tomorrow','2026-13-45T99:00:00Z'])test('Reset sai vẫn giữ mốc '+reset,()=>assert.equal(parseTsv('Nhóm\tDaily Limit Remaining\t1%'+(reset===undefined?'':'\t'+reset))[0].resetAt,null));
test('Reset có độ lệch',()=>assert.equal(parseTsv('Nhóm\tDaily\t1%\t2026-11-03T07:00:00+07:00')[0].resetAt,at));
test('Dòng không hợp lệ và trùng giữ cuối',()=>{assert.equal(parseTsv('Group\tLimit\tRemaining\tReset\nVăn xuôi\nNhóm\tDaily').length,0);const b=parseTsv('Nhóm Việt models\tDaily Limit Remaining\t9%\nNhóm Việt models\tDaily Limit Remaining\t7%');assert.equal(b.length,1);assert.equal(b[0].percent,7);assert.equal(b[0].groupLabel,'Nhóm Việt');assert.equal(b[0].windowKey,'other:Daily');});
test('Dự phòng yêu cầu hội thoại rỗng',()=>{const e=envelope();delete e.conversation_id;assert.equal(parse(JSON.stringify(e)).error.type,'exit');});
for(const change of [{num_turns:1},{command:{}},{command:{name:'khác'}},{conversation_id:'hội thoại'}])test('Chặn gửi usage vào model '+JSON.stringify(change),()=>assert.equal(parse(JSON.stringify({...envelope(),...change})).error.type,'unexpected'));
test('Đầu ra rỗng, sai JSON và không có dòng hợp lệ',()=>{for(const s of ['', 'Văn xuôi',JSON.stringify(envelope('Lỗi đăng nhập'))])assert.equal(parse(s).error.type,'exit');});
for(const fraction of [-.01,1.01,null,'0.5'])test('JSON loại fraction sai '+fraction,()=>{const e=envelope();e.command.data={groups:[{name:'Nhóm',buckets:[{window:'5h',remaining_fraction:fraction}]}]};assert.ok(parse(JSON.stringify(e)).error);});
test('Rút gọn nhóm',()=>{for(const [input,output] of [['Gemini Models','Gemini'],['Claude and GPT models','Claude/GPT'],['Foo Models','Foo'],['Bar','Bar']])assert.equal(groupLabel(input),output);});
for(const [delta,expected] of [[0,'đã đến giờ reset'],[-1,'đã đến giờ reset'],[30000,'dưới 1 phút'],[59000,'dưới 1 phút'],[60000,'1 phút'],[3599000,'59 phút'],[3600000,'1 giờ 0 phút'],[86340000,'23 giờ 59 phút'],[86400000,'1 ngày 0 giờ'],[576000000,'6 ngày 16 giờ']])test('Đếm ngược '+delta,()=>assert.equal(countdown(at+delta,at),expected));
test('Giờ địa phương từ múi giờ của tiến trình',()=>{assert.equal(resetTime(at),'07:00 T3 03/11');assert.equal(resetTime(Date.parse('2026-11-07T18:00:00Z')),'01:00 CN 08/11');assert.equal(resetTime(null),'không rõ');assert.equal(countdown(null,at),'không rõ');});
test('Thời gian đã qua',()=>{assert.equal(ago(at,at),'vừa xong');assert.equal(ago(at,at+59000),'vừa xong');assert.equal(ago(at,at+180000),'3 phút trước');assert.equal(ago(at,at+7200000),'120 phút trước');});
for(const [percent,expected] of [[0,'critical'],[10,'critical'],[30,'warning'],[31,'ok'],[100,'ok']])test('Ngưỡng '+percent,()=>assert.equal(level(sample(percent),at,{}),expected));
test('Kẹp cấu hình và ngưỡng đảo',()=>{assert.equal(configuration({criticalThreshold:90,warningThreshold:20}).criticalThreshold,20);assert.equal(configuration({timeout:999}).timeout,300);assert.equal(configuration({refreshInterval:0}).refreshInterval,60);assert.equal(level(sample(1),at,{criticalThreshold:0,warningThreshold:0}),'ok');assert.equal(level(sample(0),at,{criticalThreshold:0}),'critical');});
const key='agy|Gemini Models|5h';
for(const [old,next,expected] of [[undefined,50,0],[undefined,20,1],[undefined,5,1],['ok',20,1],['ok',5,1],['warning',5,1],['critical',20,0],['warning',50,1],['critical',50,1],['ok',50,0],['warning',20,0],['critical',5,0]])test('Chuyển mức '+old+' sang '+next,()=>assert.equal(transitions([sample(next)],old?{[key]:old}:{},at).events.length,expected));
test('Thông báo không lặp; biến mất; unknown; tắt',()=>{
 let previous={};let count=0;for(let i=0;i<10;i++){const r=transitions([sample(5)],previous,at);count+=r.events.length;previous=r.levels;}assert.equal(count,1);
 assert.deepEqual(transitions([],previous,at).levels,{});
 assert.equal(transitions([sample(5,at)],previous,at).levels[key],'critical');
 const disabled=transitions([sample(20)],{},at,{notificationEnabled:false});assert.equal(disabled.events.length,0);assert.equal(disabled.levels[key],'warning');
});
test('Gộp thông báo loại nặng nhất',()=>{const r=transitions([sample(5),{...sample(20),groupName:'Nhóm khác'}],{},at);assert.equal(r.events.length,2);assert.equal(r.severity,'critical');assert.match(notification(r),/; /);});
test('Lịch làm mới, đồng hồ lùi, reset và lease',()=>{
 assert.equal(isRefreshDue({},at,{}),true);assert.equal(isRefreshDue({lastAttemptAt:at},at,{}),false);
 assert.equal(isRefreshDue({lastAttemptAt:at},at+300000,{}),true);
 assert.equal(isRefreshDue({lastAttemptAt:at+1},at,{}),true);
 assert.equal(isRefreshDue({lastAttemptAt:at-1,lastSuccessAt:at-10,buckets:[sample(20,at)]},at,{}),true);
 assert.equal(isRefreshDue({runningSince:at},at+49999,{}),false);
 assert.equal(isRefreshDue({runningSince:at},at+50000,{}),true);
});
test('Backoff sau lỗi thứ ba, thứ tư, thứ năm và trần',()=>assert.deepEqual([0,2,3,4,5,20].map(consecutiveErrors=>intervalMs({consecutiveErrors},{})),[300000,300000,600000,1200000,2400000,3600000]));
test('Dữ liệu cũ tại ranh giới',()=>{assert.equal(isStale({lastSuccessAt:at},at+600000,{}),false);assert.equal(isStale({lastSuccessAt:at},at+600001,{}),true);assert.equal(isStale({lastSuccessAt:at,error:{}},at,{}),true);});
test('Thanh, tooltip, QuickPick dùng cùng mô hình',()=>{
 const s={buckets:parseTsv(tsv),lastSuccessAt:at};const m=display(s,at,{});
 assert.equal(m.text,'Gemini 90% | 60% · Claude/GPT 84% | 50%');assert.equal(m.severity,'ok');assert.match(m.tooltip,/\| Gemini \| 5 giờ \| 90% \|/);assert.equal(m.items.filter(i=>i.separator).length,3);assert.deepEqual(m.items.slice(-2).map(i=>i.action),['refresh','log']);
});
test('Thanh unknown, màu, nhóm đơn, cũ, làm mới và lỗi',()=>{
 assert.match(display({buckets:[sample(9,at)]},at).text,/\?%/);
 assert.equal(display({buckets:[sample(9,at)]},at).severity,'ok');
 assert.equal(display({buckets:[sample(9)]},at).severity,'critical');
 assert.equal(display({buckets:[sample(29)]},at).severity,'warning');
 assert.match(display({buckets:[sample()],error:{message:'Lỗi'}},at).text,/history/);
 assert.match(display({buckets:[sample()],runningSince:at,manualRefresh:true},at).text,/sync~spin/);
 assert.match(display({error:require('../src/runner').resolveAgy({exists:()=>false}).error},at).tooltip,/Không tìm thấy agy/);
 assert.match(display({error:{message:'Lỗi thử'}},at).tooltip,/Lỗi thử/);
 assert.match(display({runningSince:at},at).text,/sync~spin/);
});
test('Thoát Markdown và ký tự dòng mới',()=>{const value=escapeMarkdown('A|*_[x]<script>#\\\n');assert.equal(value.includes('\n'),false);assert.match(value,/\\\|/);const m=display({buckets:[{...sample(),groupLabel:'A|*_<script>'}]},at);assert.match(m.tooltip,/A\\\|\\\*\\_\\<script\\>/);});
test('Làm sạch thông tin nhạy cảm và cắt giới hạn',()=>{
 for(const value of ['tên: a@example.com','eyJhbGci.abcdef','ya29.xxx','Bearer abc','a'.repeat(24)])assert.match(sanitize(value),/đã che/);
 assert.equal(sanitize('a'.repeat(23)),'a'.repeat(23));
 for(const max of [120,200]){const result=sanitize('từ '.repeat(200),max);assert.equal(result.length,max);assert.ok(result.endsWith('...'));}
 assert.equal(sanitize('\n\x1b[31mBình thường\x1b[0m\nkhác'),'Bình thường');
});
test('JSON chuẩn bốn mốc, Unicode, nhóm thứ ba và giữ bản ghi cuối',()=>{
 const groups=[
  {name:'Gemini Models',buckets:[{name:'Weekly Limit Remaining',remaining_fraction:.6},{name:'Five Hour Limit Remaining',remaining_fraction:.9}]},
  {name:'Claude and GPT models',buckets:[{window:'weekly',remaining_fraction:.5},{window:'5h',remaining_fraction:.84}]},
  {name:'Nhóm Việt models',buckets:[{name:'Daily Limit Remaining',remaining_fraction:.5},{name:'Daily Limit Remaining',remaining_fraction:.4}]}
 ];
 const e=envelope();e.command.data={groups};
 const b=parse(JSON.stringify(e)).buckets;assert.equal(b.length,5);assert.deepEqual(b.slice(0,4).map(x=>x.percent),[90,60,84,50]);assert.equal(b[4].percent,40);assert.equal(b[4].groupLabel,'Nhóm Việt');assert.equal(b[4].windowLabel,'Daily');
 const model=display({buckets:b,lastSuccessAt:at},at);assert.match(model.text,/Nhóm Việt Daily 40%/);
});
test('JSON sai cấu trúc không làm hỏng bộ phân tích',()=>{
 const e=envelope();e.command.data={groups:[null,{}, {name:'Nhóm',buckets:[null,{}, {window:'5h',remaining_fraction:.5}]}]};
 assert.equal(parse(JSON.stringify(e)).buckets.length,1);
});
test('ANSI OSC được loại bỏ và làm mới nền không nhấp nháy chữ',()=>{
 assert.equal(sanitize('\x1b]0;tiêu đề\x07Nội dung'),'Nội dung');
 assert.equal(display({buckets:[sample()],runningSince:at},at).text,'Gemini 50% | --');
});
test('Mốc biến mất rồi xuất hiện lại được thông báo',()=>{
 const first=transitions([sample(20)],{},at);
 const missing=transitions([],first.levels,at);
 assert.equal(transitions([sample(20)],missing.levels,at).events.length,1);
});
test('JSON thiếu cửa sổ suy từ tên và giữ reset sai hoặc rỗng',()=>{
 const e=envelope();e.command.data={groups:[{name:'Nhóm',buckets:[{name:'Five Hour Limit Remaining',remaining_fraction:0,reset_time:'sai'},{name:'Weekly Limit Remaining',remaining_fraction:1,reset_time:'2026-11-03T07:00:00+07:00'},{name:'Daily Limit Remaining',remaining_fraction:.615,reset_time:''}]}]};
 const b=parse(JSON.stringify(e)).buckets;assert.deepEqual(b.map(x=>x.windowKey),['5h','weekly','other:Daily']);assert.deepEqual(b.map(x=>x.resetAt),[null,at,null]);assert.deepEqual(b.map(x=>x.percent),[0,100,61]);
});
test('Tooltip có ngưỡng, thời gian và dữ liệu cũ không mất bảng',()=>{
 const m=display({buckets:[sample(9)],lastSuccessAt:at,error:{type:'timeout',message:'Hết thời gian chờ.'}},at+60000,{});
 assert.match(m.tooltip,/\*\*Dữ liệu cũ\.\*\*/);assert.match(m.tooltip,/nghiêm trọng/);assert.match(m.tooltip,/cảnh báo <= 30%/);assert.match(m.tooltip,/Cập nhật lúc 07:00 \(1 phút trước\)/);
});
test('Ngày lịch không tồn tại không bị Date.parse tự đổi ngày',()=>{
 for(const reset of ['2026-02-30T00:00:00Z','2026-11-03T24:00:00Z','2026-11-03T00:00:00+25:00'])assert.equal(parseTsv('Nhóm\tDaily\t10%\t'+reset)[0].resetAt,null);
});
