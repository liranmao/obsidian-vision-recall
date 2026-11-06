/** Pure, offline topic and digest logic. AI tags are suggestions, never authority. */
export interface Topic { name: string; keywords: string[] }
export interface KnowledgeEntry {
  id: string; title: string; timestamp?: string; hash?: string;
  generatedNotes?: string | null; ocrText?: string | null;
  extractedTags?: string[]; notePath?: string; screenshotStoragePath?: string;
}
const key = (s: string) => s.normalize('NFKC').trim().toLowerCase();
export function parseTopics(text: string): Topic[] {
  const result: Topic[] = [];
  for (const line of text.split('\n').filter(s => s.trim())) {
    const [name, ...rest] = line.split('|');
    const clean = name.trim().slice(0, 80);
    if (clean && !result.some(t => key(t.name) === key(clean)))
      result.push({ name: clean, keywords: rest.join('|').split(/[,，]/).map(s => s.trim()).filter(Boolean) });
  }
  return result;
}
export function matches(text: string, term: string): boolean {
  const source = key(text), needle = key(term);
  if (!needle) return false;
  if (/^[a-z0-9 _-]+$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'u').test(source);
  }
  return source.includes(needle);
}
export function classify(entry: KnowledgeEntry, topics: Topic[]): string[] {
  const text = [entry.title, entry.ocrText, entry.generatedNotes, ...(entry.extractedTags || [])].join('\n');
  const found = topics.filter(t => [t.name, ...t.keywords].some(k => matches(text, k))).map(t => t.name);
  return found.length ? found : ['待分类'];
}
export function localDay(timestamp: string): string | null {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function uniqueEntries(entries: KnowledgeEntry[]): KnowledgeEntry[] {
  const seen = new Set<string>();
  return [...entries].sort((a,b) => (a.timestamp || '').localeCompare(b.timestamp || '') || a.id.localeCompare(b.id)).filter(e => {
    const identity = e.hash ? `hash:${e.hash}` : `id:${e.id}`;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}
export function topicSuggestions(entries: KnowledgeEntry[], topics: Topic[], dismissed: string[]): { name: string; count: number }[] {
  const known = new Set([...topics.flatMap(t => [t.name, ...t.keywords]), ...dismissed].map(key));
  const counts = new Map<string, {name: string; count: number}>();
  for (const e of uniqueEntries(entries)) {
    for (const tag of new Set((e.extractedTags || []).map(key))) {
      if (!tag || known.has(tag) || tag.length > 60 || /[\n|]/.test(tag)) continue;
      const item = counts.get(tag) || { name: tag, count: 0 };
      item.count++; counts.set(tag, item);
    }
  }
  return [...counts.values()].sort((a,b) => b.count-a.count || a.name.localeCompare(b.name)).slice(0,20);
}
export const BEGIN = '<!-- vision-recall:topic-digest:start -->';
export const END = '<!-- vision-recall:topic-digest:end -->';
const plain = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/[\[\]<>#*`]/g, '');
export const link = (path: string, label: string) => `[${plain(label)}](<${encodeURI(path).replace(/#/g,'%23').replace(/\?/g,'%3F').replace(/>/g,'%3E').replace(/</g,'%3C')}>)`;
export function renderDigest(day: string, entries: KnowledgeEntry[], topics: Topic[], related: Record<string,string[]> = {}): string {
  // Deduplicate globally first: a copied screenshot must not recur on a later day.
  const selected = uniqueEntries(entries).filter(e => e.timestamp && localDay(e.timestamp) === day);
  const groups = new Map<string, KnowledgeEntry[]>();
  for (const e of selected) for (const name of classify(e,topics)) groups.set(name,[...(groups.get(name)||[]),e]);
  const out = [BEGIN, `# ${day} 每日主题汇总`, '', `共 ${selected.length} 条去重知识条目；按处理日期（本机时区）归档，可跨主题出现。`, '', '> 以下为 AI 生成摘要的摘录式聚合，尚未核实。截图中的说法不等于论文已证实的结论；没有读取完整论文或视频。', ''];
  for (const [name, items] of groups) {
    out.push(`## ${plain(name)}（${items.length}）`, '');
    const tags = new Map<string,number>();
    for (const e of items) for (const tag of new Set(e.extractedTags || [])) tags.set(tag,(tags.get(tag)||0)+1);
    const common = [...tags].filter(([,n])=> n>1).map(([tag,n])=>`${plain(tag)}（${n}）`);
    if (common.length) out.push(`共同线索：${common.join('、')}`, '');
    for (const e of items) {
      out.push(`### ${plain(e.title || '未命名')}`, '', ...((e.generatedNotes || '暂无摘要，请打开原笔记核对。').split('\n').map(s=>`> ${s.replace(/<!--/g,'&lt;!--')}`)), '');
      out.push([e.notePath && link(e.notePath,'知识笔记'), e.screenshotStoragePath && link(e.screenshotStoragePath,'原图')].filter(Boolean).join(' · ') || '来源路径缺失，请核对历史元数据。', '');
    }
    if (related[name]?.length) out.push('已有笔记（标题关键词匹配，供复核）：', ...related[name].map(p=>`- ${link(p,p)}`), '');
  }
  out.push(END);
  return out.join('\n');
}
/** Replace only our managed block; never overwrite an unrelated or malformed note. */
export function mergeDigest(existing: string, block: string): string {
  const start = existing.indexOf(BEGIN), end = existing.indexOf(END);
  if (start < 0 || end < start || existing.indexOf(BEGIN,start+BEGIN.length)>=0 || existing.indexOf(END,end+END.length)>=0)
    throw new Error('同名文件不含唯一汇总标记；已保留原文件，请更换汇总文件夹。');
  return existing.slice(0,start)+block+existing.slice(end+END.length);
}
export function isInInbox(path: string, folder: string): boolean {
  const root = folder.replace(/\/+$/,'');
  return !!root && root !== '.' && root !== '/' && path.startsWith(root+'/');
}
