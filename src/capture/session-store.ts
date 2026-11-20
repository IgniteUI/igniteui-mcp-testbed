'use strict';

import { openStore } from './opencode-store.ts';

// Which opencode session a scenario step ran in, read from the entry's own store, or
// null (never a guess) when the store can't be read.
//
// A step continues a session by explicit id rather than `opencode run --continue`:
// "the last session" is ambiguous once the agent has spawned subagent (child) sessions,
// so only top-level sessions (parent_id null) are considered.

export interface SessionInfo {
  id: string;
  messages: number;
  /** Context compactions in the session so far. Best effort and an opencode-version
   * dependency (1.x `compaction` parts, 2.x `compaction` messages): 0 may mean "not detectable". */
  compactions: number;
}

const QUERIES = {
  part: {
    session: 'select id from session where parent_id is null and time_updated >= ? order by time_updated desc limit 1',
    messages: 'select count(*) n from message where session_id = ?',
    compactions: "select count(*) n from part where session_id = ? and json_extract(data, '$.type') = 'compaction'",
  },
  session_message: {
    session: 'select id from session_v2 where parent_id is null and time_updated >= ? order by time_updated desc limit 1',
    messages: "select count(*) n from session_message where session_id = ? and type in ('user', 'assistant')",
    compactions: "select count(*) n from session_message where session_id = ? and type = 'compaction'",
  },
};

export async function latestSession(dataDir: string, since: number): Promise<SessionInfo | null> {
  let store;
  try { store = await openStore(dataDir); } catch (_) { return null; }
  if (!store) return null;
  try {
    const q = QUERIES[store.schema];
    const row = store.db.prepare(q.session).get(since);
    if (!row) return null;
    const id = String(row.id);
    const count = (sql: string) => Number(store.db.prepare(sql).get(id)?.n || 0);
    return { id, messages: count(q.messages), compactions: count(q.compactions) };
  } catch (_) {
    return null;
  } finally {
    store.close();
  }
}
