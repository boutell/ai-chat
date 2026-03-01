// Thin wrappers around fetch that parse JSON in one step

export async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export async function post(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export async function patch(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

export async function del(url) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// Returns the raw Response for streaming reads
export async function postStream(url, body, options = {}) {
  const fetchOptions = {
    method: 'POST',
    ...options
  };
  if (body !== undefined) {
    fetchOptions.headers = { 'Content-Type': 'application/json', ...options.headers };
    fetchOptions.body = JSON.stringify(body);
  }
  return fetch(url, fetchOptions);
}
