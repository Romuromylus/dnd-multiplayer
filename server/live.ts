// The table's live line: everyone at a campaign holds one SSE stream, and hears who is here, who is ready, the table
// talk, and when the Game Master starts writing (each turn's words then come over that job's own stream, jobs.ts).
export type LiveEvent = { type: string; data: any };
type Listener = { userId: number; send: (e: LiveEvent) => void };

const rooms = new Map<number, Set<Listener>>();

export function broadcast(storyId: number, type: string, data: any = {}) {
  for (const l of rooms.get(storyId) ?? []) { try { l.send({ type, data }); } catch { /* gone */ } }
}

export const online = (storyId: number) => [...new Set([...(rooms.get(storyId) ?? [])].map(l => l.userId))];

export function liveResponse(storyId: number, userId: number, hello: () => LiveEvent[]): Response {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(ctrl) {
      const write = (e: LiveEvent) => ctrl.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
      const l: Listener = { userId, send: e => { try { write(e); } catch { cleanup(); } } };
      ctrl.enqueue(enc.encode(`retry: 2000\n: connected\n\n`));
      let set = rooms.get(storyId);
      if (!set) rooms.set(storyId, set = new Set());
      const first = !online(storyId).includes(userId);
      set.add(l);
      for (const e of hello()) write(e);
      if (first) broadcast(storyId, 'presence', { online: online(storyId) });
      const ping = setInterval(() => { try { ctrl.enqueue(enc.encode(`event: ping\ndata: 1\n\n`)); } catch { cleanup(); } }, 15000);
      cleanup = () => {
        clearInterval(ping);
        const s = rooms.get(storyId);
        if (!s || !s.delete(l)) return;
        if (!s.size) rooms.delete(storyId);
        if (!online(storyId).includes(userId)) broadcast(storyId, 'presence', { online: online(storyId) });
      };
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' },
  });
}
