// The campaign as it reads: each round's actions as the players posted them, then the Dungeon Master's passage with its rolls,
// a scene picture when one is painted, and (for the host) the tools to retry, correct or edit it.
import { useMemo, useState } from 'react';
import { usageLine, type Detail, type InlineCard, type Passage, type Problem } from './api';
import { useReading } from './narrator';
import { parseRound, quoteText, renderProse, stripTags } from './render';
import { Avatar, HpBar } from './Sheet';

export type Live = { jobId: string; kind: string; label: string; phase: string; tools: any[]; thinking: string; text: string; prefix: string; plan: string; summary: boolean };

const unesc = (t: string) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

export function Feed(p: { passages: Passage[]; d: Detail; lastProseId?: number; busy: boolean; readOnly?: boolean; onAction: (a: string, ps: Passage) => void; onUndo: (id: number) => void }) {
  const byName = useMemo(() => new Map(p.d.table.filter(s => s.persona_id).map(s => [s.name.toLowerCase(), s])), [p.d.table]);
  const inline = p.d.story.settings.toggles?.inline_cards !== false;
  return <>{p.passages.map(ps => {
    if (ps.kind === 'direction') return <RoundBlock key={ps.id} text={ps.text} byName={byName} />;
    if (ps.kind === 'note' || ps.kind === 'persona_switch') return <div key={ps.id} className="note-line">· {ps.text} ·</div>;
    if (ps.kind !== 'prose') return null;
    return <PassageView key={ps.id} ps={ps} d={p.d} inline={inline} isLast={ps.id === p.lastProseId} busy={p.busy} readOnly={p.readOnly} onAction={p.onAction} onUndo={p.onUndo} />;
  })}</>;
}

function RoundBlock(p: { text: string; byName: Map<string, any> }) {
  const acts = parseRound(p.text);
  return (
    <div className="round">
      {acts.map((a, i) => {
        const who = unesc(a.who);
        const s = p.byName.get(who.toLowerCase());
        return (
          <div key={i} className="act">
            <Avatar src={s?.avatar} name={who || '?'} size={28} />
            <div className="min0">
              <div className="who">{who || 'The party'}{s && <span className="dim"> · {s.player}</span>}</div>
              <div className="txt" dangerouslySetInnerHTML={{ __html: quoteText(unesc(a.text)) }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PassageView(p: { ps: Passage; d: Detail; inline: boolean; isLast: boolean; busy: boolean; readOnly?: boolean; onAction: (a: string, ps: Passage) => void; onUndo: (id: number) => void }) {
  const ps = p.ps;
  const host = p.d.host;
  const [meta, setMeta] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const reading = useReading(ps.id);
  const html = useMemo(() => renderProse(ps.text, { quotes: true }), [ps.text]);
  const t = ps.turn;
  const lookups = t?.tools?.filter(x => x.who === 'plan').length ?? 0;
  const problems: Problem[] = t?.check ?? [];
  const changes = (ps.changes ?? []).filter(c => !c.undone);
  const art = p.d.art[`scene:${ps.id}`];
  const act = (a: string) => () => p.onAction(a, ps);
  return (
    <div className={`passage ${reading ? 'reading' : ''}`} data-pid={ps.id}>
      {host && t && (t.plan || lookups > 0 || t.usage?.output) ? (
        <div className="meta-line">
          <button className="link" onClick={() => setMeta(!meta)}>{meta ? '▾' : '▸'} {lookups ? `${lookups} lookup${lookups > 1 ? 's' : ''}` : 'no lookups'}{t.plan ? ' · notes' : ''}{t.dice ? ' · dice' : ''}</button>
          {t.usage?.output ? <span>{usageLine(t.usage)}</span> : null}
          {t.model && <span className="hide-mobile">{t.model}</span>}
        </div>
      ) : null}
      {meta && t && (
        <div className="meta-detail">
          {t.plan && <><div className="tl">NOTES</div>{t.plan}{'\n\n'}</>}
          {(t.tools?.length ?? 0) > 0 && <div className="tl">LOOKUPS</div>}
          {t.tools?.map((x, i) => <details key={i}><summary>{x.who === 'plan' ? '› ' : '✎ '}{x.name} {JSON.stringify(x.input).slice(0, 120)}</summary>{x.result}</details>)}
          {t.dice && <details><summary className="tl">THE DICE TRAY</summary>{t.dice}</details>}
          {t.thinking && <details><summary className="tl">THINKING</summary>{t.thinking}</details>}
        </div>
      )}
      <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      {/* The scene's picture comes after its words: read first, then see it. */}
      {art && (art.url ? <a className="scene-art" href={art.full ?? art.url} target="_blank" rel="noreferrer"><img src={art.url} alt="" loading="lazy" /></a>
        : art.status === 'error' ? <div className="scene-art empty small dim">The picture failed{art.error ? `: ${art.error}` : ''}.</div>
          : <div className="scene-art empty small dim"><span className="spinner" /> painting the scene…</div>)}
      {p.inline && ps.cards && ps.cards.length > 0 && <InlineCards cards={ps.cards} d={p.d} />}
      {ps.cut ? <div className="passage-foot"><span className="chip warn">cut off</span>{p.isLast && host && <button className="btn sm primary" disabled={p.busy} onClick={act('continue')}>Continue</button>}</div> : null}
      {host && ps.records_status === 'hold' && (
        <div className="checkbar">
          <h4>CONTINUITY CHECK{problems.length > 0 ? ` · ${problems.length} PROBLEM${problems.length > 1 ? 'S' : ''}` : ''}</h4>
          {problems.length > 0
            ? <ol>{problems.map((x, i) => <li key={i}><span className="mono tiny">[{x.type}]</span> {x.quote && <q>{x.quote}</q>} {x.problem}{x.record && <span className="muted"> ({x.record})</span>}</li>)}</ol>
            : <p className="small muted">The check held this one, but what it found wasn't kept. Keep it as it is, or give a correction.</p>}
          <div className="row wrap">
            {problems.length > 0 && <button className="btn sm primary" disabled={p.busy} onClick={act('autofix')}>Rewrite with fixes</button>}
            <button className="btn sm" disabled={p.busy} onClick={act('fix')}>Correct…</button>
            <button className="btn sm" disabled={p.busy} onClick={act('keep')}>Keep anyway</button>
          </div>
        </div>
      )}
      {!host && ps.records_status === 'hold' && <div className="small dim" style={{ margin: '0 0 12px' }}>The host is looking this one over.</div>}
      <div className="passage-foot">
        {ps.records_status === 'pending' && !ps.cut && <span className="chip">records pending</span>}
        {changes.length > 0 && <button className="btn sm ghost" onClick={() => setShowChanges(!showChanges)}>{showChanges ? '▾' : '▸'} {changes.length} record change{changes.length > 1 ? 's' : ''}</button>}
        <span className="grow" />
        <div className="actions">
          <button className="btn sm ghost" onClick={act('listen')} title="Read it aloud, then carry on">Listen</button>
          {p.d.imageConn && !p.readOnly && <button className="btn sm ghost" onClick={act('paint')} title="Paint a picture of this scene">{art?.url ? 'Repaint' : 'Paint'}</button>}
          <button className="btn sm ghost hide-mobile" onClick={act('copy')}>Copy</button>
          {host && !p.readOnly && <>
            <button className="btn sm ghost" disabled={p.busy} onClick={act('fix')} title="Give a correction; the Dungeon Master rewrites the passage">Correct</button>
            <button className="btn sm ghost" disabled={p.busy} onClick={act('edit')}>Edit</button>
            {p.isLast && <button className="btn sm ghost" disabled={p.busy} onClick={act('retry')}>Retry</button>}
            {(ps.versions ?? 0) > 0 && <button className="btn sm ghost" onClick={act('versions')}>History {ps.versions}</button>}
            <button className="btn sm ghost hide-mobile" disabled={p.busy} onClick={act('redo')} title="Rebuild the records from this passage on">Redo records</button>
            {p.isLast && <button className="btn sm ghost" disabled={p.busy} onClick={act('delete')}>Delete</button>}
          </>}
        </div>
      </div>
      {showChanges && (
        <div className="changes">
          {(ps.changes ?? []).map(c => <div key={c.id} className={`ch ${c.undone ? 'undone' : ''}`}><span className="k">{c.record}</span><span className="grow">{c.summary}</span>{host && !c.undone && <button className="btn sm ghost" onClick={() => p.onUndo(c.id)}>undo</button>}</div>)}
        </div>
      )}
    </div>
  );
}

// What the records keeper wrote for a passage: the scene it ended on, then each new or changed person and sheet.
function InlineCards(p: { cards: InlineCard[]; d: Detail }) {
  return (
    <div className="inline-cards">
      {p.cards.map((c, i) => {
        if (c.type === 'scene') {
          const f = c.fields;
          const present: { name: string; doing?: string; condition?: string }[] = f.present ?? [];
          return (
            <div key={i} className="icard scene">
              <div className="icard-h"><span className="k">SCENE</span><span className="grow ellipsis">{[f.place, f.story_time, f.weather].filter(Boolean).join(' · ')}</span></div>
              {f.initiative && <div className="icard-present"><span className="dim">Initiative:</span> {f.initiative}</div>}
              {present.length > 0 && <div className="icard-present">{present.map((x, j) => (
                <span key={j} className="who"><b>{x.name}</b>{x.doing ? ` ${x.doing}` : ''}{x.condition && !/^(unhurt|alive|fine|healthy)$/i.test(x.condition) ? <span className="cond"> [{x.condition}]</span> : null}</span>
              ))}</div>}
            </div>
          );
        }
        if (c.type === 'user') {
          return (
            <div key={i} className="icard user">
              <div className="icard-h" style={{ cursor: 'default' }}><span className="k">SHEET</span><b className="name">{c.name}</b>{c.what_changed && <span className="what ellipsis">{c.what_changed}</span>}</div>
              {c.fields.hp && <div style={{ marginTop: 6, maxWidth: 220 }}><HpBar hp={c.fields.hp} small /></div>}
            </div>
          );
        }
        const portrait = p.d.art[`portrait:${c.name.trim().toLowerCase().replace(/\s+/g, ' ')}`];
        return (
          <details key={i} className={`icard ${c.type}`} open={c.op === 'create' && p.cards.length <= 3}>
            <summary className="icard-h">
              <span className="k">PERSON</span><b className="name">{c.name}</b>
              <span className={`chip ${c.op === 'create' ? 'ok' : ''}`}>{c.op === 'create' ? 'new' : 'updated'}</span>
              {c.op !== 'create' && c.what_changed && <span className="what ellipsis">{c.what_changed}</span>}
            </summary>
            <div className="icard-body">
              {portrait?.url && <img className="icard-portrait" src={portrait.url} alt="" />}
              {c.fields.role_age && <div className="f"><b>Role</b>{c.fields.role_age}</div>}
              {c.fields.appearance && <div className="f"><b>Looks</b>{c.fields.appearance}</div>}
              {c.fields.relationship && <div className="f"><b>With the party</b>{c.fields.relationship}</div>}
              {c.fields.voice && <div className="f"><b>Voice</b>{c.fields.voice}</div>}
              {c.fields.backstory && <div className="f"><b>Backstory</b>{c.fields.backstory}</div>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function LiveBlock({ live, host }: { live: Live; host: boolean }) {
  const isFix = live.kind === 'fix';
  const text = live.summary ? live.text : isFix ? stripTags(live.text) : live.prefix ? `${live.prefix} ${live.text}` : live.text;
  const html = useMemo(() => renderProse(text, { quotes: true }), [text]);
  const [showThink, setShowThink] = useState(false);
  return (
    <div className="live">
      {host && live.tools.map((t, i) => (
        <div key={i} className="tool-line"><details><summary><span className="who">{t.who === 'plan' ? '›' : '✎'}</span> {t.label ?? t.name}{t.error ? ' (error)' : ''}</summary><pre>{t.result}</pre></details></div>
      ))}
      {host && live.plan && <details className="tool-line"><summary>› notes</summary><pre>{live.plan}</pre></details>}
      {host && live.thinking && <div className="tool-line"><button className="btn sm ghost" onClick={() => setShowThink(!showThink)}>{showThink ? '▾' : '▸'} thinking</button>{showThink && <div className="thinking">{live.thinking}</div>}</div>}
      <div className="phase"><span className="spinner" />{live.phase || live.label}…</div>
      {text && (live.summary ? (host ? <div className="summary-box"><div className="md" dangerouslySetInnerHTML={{ __html: html }} /></div> : null)
        : <div className={`prose streaming ${isFix ? 'dim' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />)}
    </div>
  );
}
