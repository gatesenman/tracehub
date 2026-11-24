'use strict';
const {it}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {defaultIO,safeDiskChild,listSessionFiles}=require('../src/shared/session-files');
const {parseSession}=require('../src/shared/snss');
const b=require('./helpers/snss-build');
const reopen=require('../src/shared/session-reopen');
it('real filesystem rejects symlink profile, Sessions directory and final file; missing canonicalization fails closed',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tracehub-links-'));
 try {
 const inside=path.join(root,'inside'),outside=path.join(root,'outside');fs.mkdirSync(inside);fs.mkdirSync(outside);
 fs.writeFileSync(path.join(outside,'Session_1'),b.sampleTwoWindows());
 fs.symlinkSync(outside,path.join(inside,'Default'),'dir');
 assert.equal(safeDiskChild(inside,path.join(inside,'Default'),defaultIO()),false);
 fs.mkdirSync(path.join(inside,'Profile 1'));fs.symlinkSync(outside,path.join(inside,'Profile 1','Sessions'),'dir');
 assert.deepEqual(listSessionFiles(path.join(inside,'Profile 1')),[]);
 fs.mkdirSync(path.join(inside,'Profile 2','Sessions'),{recursive:true});
 fs.symlinkSync(path.join(outside,'Session_1'),path.join(inside,'Profile 2','Sessions','Session_1'));
 assert.deepEqual(listSessionFiles(path.join(inside,'Profile 2')),[]);
 assert.equal(safeDiskChild(inside,inside,{}),false);
 const io=defaultIO();io.realpath=p=>p===inside?inside:outside;io.lstat=()=>({isSymbolicLink:()=>false});
 assert.equal(safeDiskChild(inside,path.join(inside,'Profile 3'),io),false);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
it('legacy 5 removes back entries and legacy 11 renumbers front with selected navigation',()=>{
 const initial=[b.tabWindow(1,1),b.nav(1,0,'https://a.example/','a'),b.nav(1,1,'https://b.example/','b'),b.nav(1,2,'https://c.example/','c'),b.selectedNav(1,1)];
 let parsed=parseSession(b.snss([...initial,b.cmd(5,b.i32(1,2)),b.cmd(11,b.i32(1,1))]));
 assert.equal(parsed.windows[0].tabs[0].url,'https://b.example/');
 assert.deepEqual(parsed.windows[0].tabs[0].navigations.map(n=>n.index),[0]);
 assert.throws(()=>parseSession(b.snss([...initial,b.cmd(11,b.i32(1,0))])),/裁剪/);
});
it('200 URL clipping and invalid URLs preserve exact row association, partial launch only marks its own rows',async()=>{
 const tabs=Array.from({length:205},(_,i)=>({id:'row'+i,url:'https://bulk.example/'+i}));
 tabs.splice(3,0,{id:'unsafe',url:'https://user:pass@unsafe.example/'});
 const plan=reopen.planWindowReopen({windows:[{tabs}]});
 assert.equal(plan.urlCount,200);assert.equal(plan.skippedLimit,5);assert.equal(plan.skippedNonHttp,1);
 assert.deepEqual(plan.windows[0].tabRowIds,Array.from({length:200},(_,i)=>'row'+i));
 const built=reopen.buildSessionReopenLaunches({browserId:'chrome',exe:'/stub/chrome',profile:'Default',plan});
 const result=await reopen.runSessionReopenLaunches(built,async()=>({ok:true}));
 assert.equal(result.openedTabRowIds.length,200);assert.ok(!result.openedTabRowIds.includes('row200'));
 const partial=await reopen.runSessionReopenLaunches({ok:true,launches:[built.launches[0],{...built.launches[0],tabRowIds:['failed-only']}]},async()=>({ok: !(++calls===2)}));
 assert.deepEqual(partial.failedTabRowIds,['failed-only']);
});
let calls=0;
