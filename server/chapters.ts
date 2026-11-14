import { db, tx } from './db.ts';
import { emit, type Job } from './jobs.ts';
import { withRoom } from './ask.ts';
import { addUsage, callModel, zeroUsage, type Usage } from './llm.ts';
import * as R from './records.ts';
import { arcSystem, defaultTemplate, summarySystem } from './modes.ts';
import { on } from './rules.ts';
import { ledgerText } from './tools.ts';
import { flushPendingRecords } from './turn.ts';
import { clip, estTokens, now } from './util.ts';

function summaryConn(story: R.Story) {
  const c = R.storyConns(story);
  const conn = c.records ?? c.writer;
  if (!conn) throw new Error('No connection set up yet.');
  return conn;
}

export async function summarizeChapter(job: Job, story: R.Story, ch: R.Chapter, o: { title?: string; note?: string }): Promise<Usage> {
  const conn = summaryConn(story);
  const pname = R.personaName(story);
  const passages = R.chapterPassages(ch.id).filter(p => p.kind === 'prose' || p.kind === 'direction');
  if (!passages.some(p => p.kind === 'prose')) throw new Error('This chapter has no passages yet.');
  let text = passages.map(p => p.kind === 'prose' ? p.text : `<round>\n${p.text}\n</round>`).join('\n\n');
  if (estTokens(text) > 150000) text = text.slice(-540000);
  const prev = db.prepare(`select summary from chapters where story_id = ? and number = ?`).get(story.id, ch.number - 1) as any;
  const changes = (db.prepare(`select summary from record_changes where story_id = ? and undone = 0 and passage_id in (select id from passages where chapter_id = ?) order by id`).all(story.id, ch.id) as any[]).map(r => `- ${r.summary}`);
  const ledger = on(story.settings, 'knowledge_ledger') ? R.listLedger(story.id, 'open').map(ledgerText) : null;
  const facts = R.listFacts(story.id).slice(-60).map(f => `#${f.id} ${f.text}`);
  const title = (o.title ?? ch.title ?? '').trim();
  const template = (story.summary_template.trim() || defaultTemplate(story.settings)).replace(/\{n\}/g, String(ch.number)).replace(/\{title\}/g, title || '{title}');
  const unit = 'chapter';
  const user = [
    prev?.summary ? `<previous_${unit}_summary>\n${prev.summary}\n</previous_${unit}_summary>` : '',
    `<${unit} number="${ch.number}">\n${text}\n</${unit}>`,
    changes.length ? `<record_changes_this_${unit}>\n${clip(changes.join('\n'), 12000)}\n</record_changes_this_${unit}>` : '',
    `<story_facts>\n${facts.join('\n') || '(none)'}\n</story_facts>${ledger ? `\n<knowledge_ledger>\n${ledger.join('\n') || '(none)'}\n</knowledge_ledger>` : ''}`,
    `<template>\n${template}\n</template>`,
    `Write the summary of ${unit} ${ch.number} in the template's format.${title ? '' : ` The ${unit} has no title yet: start your reply with a line "TITLE: <a short ${unit} title>", then the summary, and use that title in it.`} If anything in the ${unit} contradicts the story facts${ledger ? ' or the ledger' : ''}, end with one line per issue starting "⚠ Possible conflict:". Output only the summary.${o.note ? `\nNote from ${pname}: ${o.note}` : ''}`,
  ].filter(Boolean).join('\n\n');
  emit(job, 'phase', { phase: 'summary', label: `summarizing ${unit} ${ch.number}` });
  emit(job, 'summary_start', { chapterId: ch.id });
  const r = await callModel({ conn, system: [{ text: summarySystem(story.settings, pname) }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: withRoom(conn, 12000), signal: job.abort.signal, onText: d => emit(job, 'text', { delta: d }) });
  let out = r.text.trim();
  let newTitle = title;
  const m = out.match(/^TITLE:\s*(.+)\n+/i);
  if (m) { newTitle = newTitle || m[1].trim().replace(/^["']|["']$/g, ''); out = out.slice(m[0].length).trim(); }
  out = out.replace(/\{title\}/g, newTitle);
  db.prepare(`update chapters set summary = ?, summary_status = 'draft', title = ? where id = ?`).run(out, newTitle, ch.id);
  emit(job, 'summary', { chapterId: ch.id, title: newTitle, text: out });
  return r.usage;
}

export async function closeChapter(job: Job, storyId: number, title?: string) {
  let story = R.getStory(storyId)!;
  await flushPendingRecords(job, story);
  story = R.getStory(storyId)!;
  const ch = R.openChapter(storyId);
  let usage = await summarizeChapter(job, story, ch, { title });
  tx(() => {
    db.prepare(`update chapters set status = 'closed', closed_at = ? where id = ?`).run(now(), ch.id);
    db.prepare(`insert into chapters(story_id, number, title, status, created_at) values (?, ?, '', 'open', ?)`).run(storyId, ch.number + 1, now());
  });
  emit(job, 'chapter_closed', { chapterId: ch.id, number: ch.number });
  const unrolled = db.prepare(`select count(*) n from chapters where story_id = ? and status = 'closed' and arc_id is null`).get(storyId) as { n: number };
  if (unrolled.n >= 10) usage = addUsage(usage, await rollupArc(job, storyId, 10));
  emit(job, 'usage', { usage });
}

// Compress closed chapters not yet in an arc (the oldest `limit` of them, or all) into one arc summary.
export async function rollupArc(job: Job, storyId: number, limit?: number): Promise<Usage> {
  const story = R.getStory(storyId)!;
  const chs = db.prepare(`select * from chapters where story_id = ? and status = 'closed' and arc_id is null order by number ${limit ? `limit ${Number(limit)}` : ''}`).all(storyId) as R.Chapter[];
  if (chs.length < 2) { emit(job, 'notice', { message: 'An arc needs at least two closed chapters that are not already in an arc.' }); return zeroUsage(); }
  const conn = summaryConn(story);
  emit(job, 'phase', { phase: 'summary', label: `rolling chapters ${chs[0].number}-${chs[chs.length - 1].number} into an arc` });
  const prevArc = db.prepare('select summary from arcs where story_id = ? order by last_chapter desc limit 1').get(storyId) as any;
  const user = `${prevArc ? `<previous_arc>\n${prevArc.summary}\n</previous_arc>\n\n` : ''}${chs.map(c => `<chapter_summary number="${c.number}" title="${c.title}">\n${c.summary}\n</chapter_summary>`).join('\n\n')}\n\nWrite the arc summary. Start with a line "TITLE: <short arc title>".`;
  const r = await callModel({ conn, system: [{ text: arcSystem(story.settings, R.personaName(story)) }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: withRoom(conn, 8000), signal: job.abort.signal, onText: d => emit(job, 'text', { delta: d }) });
  let out = r.text.trim(), title = '';
  const m = out.match(/^TITLE:\s*(.+)\n+/i);
  if (m) { title = m[1].trim(); out = out.slice(m[0].length).trim(); }
  tx(() => {
    const id = db.prepare('insert into arcs(story_id, first_chapter, last_chapter, title, summary, created_at) values (?, ?, ?, ?, ?, ?)').run(storyId, chs[0].number, chs[chs.length - 1].number, title, out, now()).lastInsertRowid;
    for (const c of chs) db.prepare('update chapters set arc_id = ? where id = ?').run(id, c.id);
  });
  emit(job, 'arc', { title, first: chs[0].number, last: chs[chs.length - 1].number });
  return r.usage;
}
