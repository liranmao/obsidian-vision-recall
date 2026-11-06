import type VisionRecallPlugin from '../main';
import { TFile, normalizePath } from 'obsidian';
import { KnowledgeEntry, localDay, matches, mergeDigest, parseTopics, renderDigest } from './topic-core';

export class TopicDigestService {
  private running: Promise<number> | null = null;
  constructor(private plugin: VisionRecallPlugin) {}
  generate(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }
  private async run(): Promise<number> {
    const { app, settings, dataManager } = this.plugin;
    const folder = normalizePath(settings.topicDigestFolder.trim());
    if (!folder || folder === '.' || folder.startsWith('/') || folder.split('/').some(p => p === '..')) throw new Error('请设置 vault 内的汇总文件夹。');
    const entries: KnowledgeEntry[] = [];
    for (const entry of dataManager.getAllEntries()) {
      let summary = entry.generatedNotes;
      // Older upstream records deliberately omit summaries; reuse their JSON sidecars.
      if (!summary && entry.metadataPath) {
        const file = app.vault.getAbstractFileByPath(entry.metadataPath);
        if (file instanceof TFile) {
          try { const data = JSON.parse(await app.vault.read(file)); if (typeof data.generatedNotes === 'string') summary = data.generatedNotes; }
          catch { this.plugin.logger.warn(`无法读取历史摘要：${entry.metadataPath}`); }
        }
      }
      entries.push({...entry, generatedNotes: summary});
    }
    if (!entries.length) return 0;
    const topics = parseTopics(settings.knowledgeTopics);
    const related: Record<string,string[]> = Object.create(null);
    const sourceNotes = new Set(entries.map(e=>e.notePath));
    for (const t of topics) related[t.name] = app.vault.getMarkdownFiles()
      .filter(f => !f.path.startsWith(folder+'/') && !sourceNotes.has(f.path) && [t.name,...t.keywords].some(k=>matches(f.basename,k)))
      .map(f=>f.path).sort().slice(0,5);
    const parts = folder.split('/');
    for (let i=1;i<=parts.length;i++) {
      const path=parts.slice(0,i).join('/');
      if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
    }
    const days = [...new Set(entries.map(e=>e.timestamp && localDay(e.timestamp)).filter(Boolean))].sort();
    let changed = 0;
    for (const day of days) {
      const path = `${folder}/${day}.md`;
      const block = renderDigest(day, entries, topics, related);
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) { await app.vault.create(path,block+'\n\n## 我的思考\n\n'); changed++; }
      else if (file instanceof TFile) {
        const existing = await app.vault.read(file);
        if (mergeDigest(existing, block) === existing) continue;
        // Atomic vault.process preserves edits made while generation was running.
        await app.vault.process(file, current => {
          const next = mergeDigest(current,block);
          if (next !== current) changed++;
          return next;
        });
      } else throw new Error(`汇总路径被文件夹占用：${path}`);
    }
    return changed;
  }
}
