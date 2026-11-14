// Long-running work (a turn, a chapter close, a correction) runs as a server-side job. The browser follows it over SSE
// and can reconnect at any time (phone sleeping, tab in the background, tab reloaded) without losing the passage: the job
// never waits on anyone listening.

export type JobEvent = { id: number; type: string; data: any };
export type Job = {
  id: string; storyId: number; kind: string; label: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  events: JobEvent[]; listeners: Set<(e: JobEvent) => void>;
  abort: AbortController; startedAt: number; endedAt?: number;
  textBuf: string; thinkBuf: string; flushTimer?: NodeJS.Timeout;
};

const jobs = new Map<string, Job>();
let seq = 0;

export function runningJob(storyId: number): Job | undefined {
  for (const j of jobs.values()) if (j.storyId === storyId && j.status === 'running') return j;
  return undefined;
}
export const getJob = (id: string) => jobs.get(id);

function push(job: Job, type: string, data: any) {
  const e = { id: job.events.length, type, data };
  job.events.push(e);
  for (const l of job.listeners) { try { l(e); } catch { /* listener gone */ } }
}

function flush(job: Job) {
  if (job.flushTimer) { clearTimeout(job.flushTimer); job.flushTimer = undefined; }
  if (job.thinkBuf) { const d = job.thinkBuf; job.thinkBuf = ''; push(job, 'thinking', { delta: d }); }
  if (job.textBuf) { const d = job.textBuf; job.textBuf = ''; push(job, 'text', { delta: d }); }
}

// Streaming deltas are coalesced (~80 ms) so a long passage is a few hundred events, not thousands.
export function emit(job: Job, type: string, data: any = {}) {
  if (type === 'text' || type === 'thinking') {
    if (type === 'text') job.textBuf += data.delta; else job.thinkBuf += data.delta;
    if (!job.flushTimer) job.flushTimer = setTimeout(() => flush(job), 80);
    return;
  }
  flush(job);
  push(job, type, data);
}

export class JobBusy extends Error {}
const KEEP_MS = 2 * 60 * 60 * 1000;

export function startJob(storyId: number, kind: string, label: string, fn: (job: Job) => Promise<void>): Job {
  if (runningJob(storyId)) throw new JobBusy('Something is already running for this story.');
  const job: Job = {
    id: `${Date.now().toString(36)}${(++seq).toString(36)}`, storyId, kind, label, status: 'running',
    events: [], listeners: new Set(), abort: new AbortController(), startedAt: Date.now(), textBuf: '', thinkBuf: '',
  };
  jobs.set(job.id, job);
  emit(job, 'start', { kind, label });
  (async () => {
    try {
      await fn(job);
      job.status = job.abort.signal.aborted ? 'stopped' : 'done';
    } catch (e: any) {
      if (job.abort.signal.aborted) job.status = 'stopped';
      else { job.status = 'error'; emit(job, 'error', { message: e?.message || String(e) }); console.error(`[job ${job.kind}]`, e); }
    } finally {
      job.endedAt = Date.now();
      emit(job, 'end', { status: job.status });
      job.listeners.clear();
      // Kept a good while after it ends, so a tab that comes back late still gets what it missed.
      setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.();
    }
  })();
  return job;
}

export function stopJob(id: string) {
  const j = jobs.get(id);
  if (j && j.status === 'running') j.abort.abort();
}

// SSE response that replays from `from` and then follows live.
// What one viewer may see of each event: an event can be passed, changed or held back (null).
export type EventView = (e: JobEvent) => JobEvent | null;
export function sseResponse(job: Job, from: number, view: EventView = e => e): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (raw: JobEvent) => {
        // A held-back event still moves the id on, so a reconnect starts after it.
        const e = view(raw) ?? { id: raw.id, type: 'ping', data: 1 };
        try { ctrl.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)); } catch { cleanup(); }
      };
      ctrl.enqueue(enc.encode(`retry: 2000\n: connected\n\n`));
      for (const e of job.events.slice(from)) send(e);
      if (job.status !== 'running') { try { ctrl.close(); } catch {} return; }
      const listener = (e: JobEvent) => { send(e); if (e.type === 'end') { cleanup(); try { ctrl.close(); } catch {} } };
      job.listeners.add(listener);
      // A ping the page can hear (a comment line is invisible to it): silence then means the connection has died.
      const ping = setInterval(() => { try { ctrl.enqueue(enc.encode(`event: ping\ndata: 1\n\n`)); } catch { cleanup(); } }, 10000);
      cleanup = () => { clearInterval(ping); job.listeners.delete(listener); };
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' },
  });
}
