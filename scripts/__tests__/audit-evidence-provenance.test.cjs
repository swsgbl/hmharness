'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {eventTimeOf,auditEvidenceRoot}=require('../audit-evidence-provenance.cjs');
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hmh-evidence-'));
 return {root,write(dir,file,rows){const p=path.join(root,dir,'raw',file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,rows.join('\n')+'\n');return p;},cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
}
test('recognizes ISO and epoch event times only',()=>{
 assert.equal(eventTimeOf({time:'2026-10-12T11:30:00Z'}),'2026-10-12T11:30:00.000Z');
 assert.equal(eventTimeOf({timestamp:1791804600}),new Date(1791804600*1000).toISOString());
 assert.equal(eventTimeOf({label:'2026-10-12'}),null);
});
test('matching month yields reproducible hash and time range',()=>{
 const f=fixture();try{const file=f.write('evidence-ds-2026-10','log.jsonl',[JSON.stringify({time:'2026-09-29T23:00:00Z'}),JSON.stringify({time:'2026-10-01T00:01:00Z'})]);const r=auditEvidenceRoot(f.root,{now:new Date('2026-10-27T00:00:00Z')}).datasets[0];assert.equal(r.status,'OK');assert.equal(r.eventRange.recordsWithEventTime,2);assert.equal(r.files[0].sha256.length,64);assert.equal(r.files[0].path,path.relative(f.root,file).split(path.sep).join('/'));}finally{f.cleanup();}
});
test('stale month and missing files are explicit',()=>{
 const f=fixture();try{f.write('evidence-ds-2026-11','log.jsonl',[JSON.stringify({time:'2026-09-15T10:00:00Z'})]);fs.mkdirSync(path.join(f.root,'evidence-ds-2026-08'),{recursive:true});const ds=auditEvidenceRoot(f.root).datasets;assert.equal(ds.find(x=>x.labelledPeriod==='2026-11').status,'STALE');assert.equal(ds.find(x=>x.labelledPeriod==='2026-08').status,'NO_RAW_JSONL');}finally{f.cleanup();}
});
test('malformed JSONL and missing timestamps do not become zeroes',()=>{
 const f=fixture();try{f.write('evidence-ds-2026-10','bad.jsonl',['{bad json']);assert.equal(auditEvidenceRoot(f.root).datasets[0].status,'MALFORMED_JSONL');}finally{f.cleanup();}
 const g=fixture();try{g.write('evidence-ds-2026-10','no-time.jsonl',[JSON.stringify({description:'no date'})]);const d=auditEvidenceRoot(g.root).datasets[0];assert.equal(d.status,'NO_EVENT_TIMESTAMPS');assert.equal(d.eventRange.max,null);}finally{g.cleanup();}
});
test('future-dated records mismatch folder period',()=>{
 const f=fixture();try{f.write('evidence-ds-2026-09','log.jsonl',[JSON.stringify({occurredAt:'2026-10-02T10:00:00Z'})]);assert.equal(auditEvidenceRoot(f.root).datasets[0].status,'PERIOD_MISMATCH');}finally{f.cleanup();}
});
