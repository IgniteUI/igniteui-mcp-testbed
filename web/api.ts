// Thin fetch wrappers for the JSON endpoints. Streaming endpoints (/api/run NDJSON
// and the SSE streams) are handled inline by their views.

export async function getJSON(url: string): Promise<any> {
  const r = await fetch(url);
  return r.json();
}

export async function postJSON(url: string, body: any): Promise<any> {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

export async function del(url: string): Promise<any> {
  const r = await fetch(url, { method: 'DELETE' });
  return r.json();
}
