let searchOverride = null;
let isAvailableOverride = null;

export function _setSearchOverride(fn) {
  searchOverride = fn;
}

export function _setIsAvailableOverride(fn) {
  isAvailableOverride = fn;
}

export function isAvailable() {
  if (isAvailableOverride) {
    return isAvailableOverride();
  }
  return !!process.env.TAVILY_API_KEY;
}

export async function search(query) {
  if (searchOverride) {
    return searchOverride(query);
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set');
  }

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error: ${res.status} ${text}`);
  }

  const data = await res.json();

  const results = (data.results || []).map(r => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content ? r.content.slice(0, 500) : ''
  }));

  return {
    results,
    answer: data.answer || null
  };
}
