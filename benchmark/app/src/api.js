// Flags such as ?slow=1 and ?fail=list on the page URL are passed through to the API.
const flags = () => new URLSearchParams(window.location.search);

export function url(path, extra = {}) {
  const p = new URLSearchParams();
  for (const k of ['slow', 'fail']) if (flags().get(k)) p.set(k, flags().get(k));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return `${path}?${p}`;
}
