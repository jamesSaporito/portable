// How sbx matches a host against its network rules, for the page's Network grid. Shared with the
// tests, so it's plain JavaScript the browser loads as a module.
//
// Checked against sbx 0.51.0 on 2026-11-04 by requesting hosts from a sandbox:
// - A rule without a port (the kit's `*.amazonaws.com`) covers every port; `host:443` only HTTPS.
// - `**.example.com` covers example.com and its subdomains at any depth (https://cursor.sh answered
//   with only `**.cursor.sh:443` allowed).
// - `*.example.com` covers one level of subdomain only, not example.com (with `*.amazonaws.com` and
//   `**.amazonaws.com:443` allowed, http://s3.amazonaws.com answered but http://amazonaws.com and
//   http://s3.us-east-1.amazonaws.com were refused).

// "github.com:443" → { name: 'github.com', port: 443 }; no port → port null (any port for a rule).
export function splitHost(text) {
  const match = /^(.*?)(?::(\d+))?$/.exec(String(text).trim().toLowerCase());
  return { name: match[1], port: match[2] ? Number(match[2]) : null };
}

// Whether a rule like "**.amazonaws.com:443" covers a request to `name` on `port`.
export function covers(rule, name, port) {
  const r = splitHost(rule);
  if (r.port !== null && r.port !== port) return false;
  if (r.name.startsWith('**.')) {
    const domain = r.name.slice(3);
    return name === domain || name.endsWith(`.${domain}`);
  }
  if (r.name.startsWith('*.')) {
    const domain = r.name.slice(2);
    return name.endsWith(`.${domain}`) && !name.slice(0, -domain.length - 1).includes('.');
  }
  return name === r.name;
}

// What someone typed in the grid's search, as a request: a URL or host, with the port from the URL
// or `host:port`, else 443 (https). Undefined when it doesn't look like a host name.
export function parseRequest(text) {
  let value = String(text).trim().toLowerCase();
  let port = null;
  const url = /^(https?):\/\/([^/?#]+)/.exec(value);
  if (url) {
    value = url[2];
    port = url[1] === 'http' ? 80 : 443;
  }
  const { name, port: given } = splitHost(value);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return undefined;
  return { name, port: given ?? port ?? 443 };
}
