const esbuild = require('esbuild');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const code = esbuild.buildSync({entryPoints:['src/services/topic-core.ts'],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const moduleObject = {exports:{}};
vm.runInNewContext(code,{module:moduleObject,exports:moduleObject.exports,Date,Set,Map});
const c = moduleObject.exports;
const topics = c.parseTopics('论文 | paper,research,论文\nAI 工具 | agent,skills\n论文 | ignored');
const entry = (id, extra={}) => ({id,title:'Research paper',timestamp:'2026-11-03T12:00:00Z',hash:id,generatedNotes:'截图声称某模型表现较好；未展示实验。',extractedTags:['research','agents'],notePath:'Notes/a.md',screenshotStoragePath:'Screenshots/a.png',...extra});
test('user-defined topics, multi-label, unknown and English word boundaries',()=>{
  assert.equal(topics.length,2);
  assert.equal(c.classify(entry('a',{ocrText:'agent skills'}),topics).join(','),'论文,AI 工具');
  assert.equal(c.classify(entry('a',{title:'chair',ocrText:'',generatedNotes:'',extractedTags:[]}),c.parseTopics('AI | AI')).join(','),'待分类');
});
test('hash dedup across dates and stable output',()=>{
 const entries=[entry('b',{hash:'same',timestamp:'2026-11-04T12:00:00Z'}),entry('a',{hash:'same'})];
 assert.equal(c.uniqueEntries(entries).length,1);
 assert.match(c.renderDigest('2026-11-04',entries,topics),/共 0 条/);
 assert.equal(c.renderDigest('2026-11-03',entries,topics),c.renderDigest('2026-11-03',[...entries].reverse(),topics));
});
test('suggestions remain pending, aliases and dismissed tags excluded',()=>{
 const suggestions=c.topicSuggestions([entry('a'),entry('b',{hash:'a'})],topics,[]);
 assert.equal(suggestions.length,1); assert.equal(suggestions[0].name,'agents'); assert.equal(suggestions[0].count,1);
 assert.equal(c.topicSuggestions([entry('a')],topics,['agents']).length,0);
 assert.equal(c.classify(entry('a'),topics).join(','),'论文');
});
test('digest cites sources and preserves user text on repeated runs',()=>{
 const block=c.renderDigest('2026-11-03',[entry('a')],topics);
 assert.match(block,/Screenshots\/a.png/); assert.match(block,/Notes\/a.md/);
 const existing='我的前言\n'+block+'\n## 我的思考\n保留内容';
 assert.equal(c.mergeDigest(existing,block),existing);
 const updated=c.mergeDigest(existing,c.renderDigest('2026-11-03',[entry('a',{title:'New paper'})],topics));
 assert.match(updated,/我的前言/);assert.match(updated,/保留内容/);assert.match(updated,/New paper/);
 assert.throws(()=>c.mergeDigest('用户同名笔记',block));
 assert.throws(()=>c.mergeDigest(block+block,block));
});
test('local date and malformed dates',()=>{
 assert.equal(c.localDay('invalid'),null);
 const d=new Date(2026,10,3,0,5); assert.equal(c.localDay(d.toISOString()),'2026-11-03');
});
test('inbox boundary excludes siblings and root',()=>{
 assert.equal(c.isInInbox('Inbox-private/a.png','Inbox'),false);
 assert.equal(c.isInInbox('Inbox/sub/a.png','Inbox/'),true);
 assert.equal(c.isInInbox('a.png',''),false);
});

class TFile { constructor(path) { this.path=path; this.basename=path.split('/').pop().replace(/\.md$/,''); } }
const serviceCode=esbuild.buildSync({entryPoints:['src/services/topic-digest-service.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian'],write:false}).outputFiles[0].text;
const serviceModule={exports:{}};
vm.runInNewContext(serviceCode,{module:serviceModule,exports:serviceModule.exports,Date,Set,Map,require:()=>({TFile,normalizePath:p=>p.replace(/\\/g,'/').replace(/\/+$/,'')})});
function fixture() {
 const files=new Map(), contents=new Map();let writes=0;
 const add=(path,body)=>{files.set(path,new TFile(path));contents.set(path,body);};
 add('Screenshots/a.json',JSON.stringify({generatedNotes:'历史摘要，等待核实'}));
 add('Old/research overview.md','我的旧笔记');
 const vault={
  getAbstractFileByPath:p=>files.get(p),
  getMarkdownFiles:()=>[...files.values()].filter(f=>f instanceof TFile && f.path.endsWith('.md')),
  read:async f=>contents.get(f.path),
  createFolder:async p=>{files.set(p,{path:p});},
  create:async(p,body)=>{assert.ok(!files.has(p));add(p,body);writes++;},
  process:async(f,fn)=>{contents.set(f.path,fn(contents.get(f.path)));writes++;}
 };
 const entries=[entry('a',{generatedNotes:undefined,metadataPath:'Screenshots/a.json'})];
 const plugin={app:{vault},settings:{topicDigestFolder:'Daily',knowledgeTopics:'论文 | research'},dataManager:{getAllEntries:()=>entries},logger:{warn:()=>{}}};
 return {service:new serviceModule.exports.TopicDigestService(plugin),contents,add,plugin,writes:()=>writes};
}
test('vault integration: old sidecars, related notes, idempotence across restart and manual edits',async()=>{
 const f=fixture();assert.equal(await f.service.generate(),1);
 const path='Daily/2026-11-03.md';assert.match(f.contents.get(path),/历史摘要/);assert.match(f.contents.get(path),/Old\/research%20overview.md/);
 f.contents.set(path,f.contents.get(path)+'用户自己的思考');
 const restarted=new serviceModule.exports.TopicDigestService(f.plugin);
 assert.equal(await restarted.generate(),0);assert.equal(f.writes(),1);assert.match(f.contents.get(path),/用户自己的思考/);
});
test('vault integration: concurrent generation shares work; foreign files are protected',async()=>{
 const f=fixture();const first=f.service.generate();assert.equal(first,f.service.generate());await first;assert.equal(f.writes(),1);
 const other=fixture();other.add('Daily/2026-11-03.md','existing user note');
 await assert.rejects(other.service.generate(),/同名文件/);assert.equal(other.contents.get('Daily/2026-11-03.md'),'existing user note');
});
test('vault integration: rejects unsafe output directory',async()=>{
 const f=fixture();f.plugin.settings.topicDigestFolder='../elsewhere';await assert.rejects(f.service.generate(),/vault/);assert.equal(f.writes(),0);
});
