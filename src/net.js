// @ts-check
import net from "node:net";

/** @param {string | undefined} addr */
function normalize(addr) {
  const a = (addr || "").toLowerCase();
  return a.startsWith("::ffff:") && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
}

/** @param {string} ip IPv4 */
function v4ToInt(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/** @param {string} ip @param {string} base @param {number} bits */
function inV4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToInt(ip) & mask) === (v4ToInt(base) & mask);
}

/** @param {string | undefined} addr */
export function isLoopbackAddress(addr) {
  const a = normalize(addr);
  return a === "::1" || (net.isIPv4(a) && inV4Range(a, "127.0.0.0", 8));
}

/**
 * Loopback, private LAN / Docker networks, and Tailscale (100.64.0.0/10 and
 * its IPv6 ULA range, covered by fc00::/7). Public internet addresses are not.
 *
 * @param {string | undefined} addr
 */
export function isLocalNetworkAddress(addr) {
  const a = normalize(addr);
  if (isLoopbackAddress(a)) return true;
  if (net.isIPv4(a)) {
    return (
      inV4Range(a, "10.0.0.0", 8) ||
      inV4Range(a, "172.16.0.0", 12) ||
      inV4Range(a, "192.168.0.0", 16) ||
      inV4Range(a, "100.64.0.0", 10) // Tailscale / CGNAT
    );
  }
  if (net.isIPv6(a)) return /^f[cd]/.test(a); // unique local, incl. Tailscale fd7a:115c:a1e0::/48
  return false;
}

/**
 * Host header check against DNS rebinding: a malicious site can point its own
 * domain at your gateway's IP, but the browser still sends that domain as Host.
 * Allowed: IP literals, localhost, single-label names (MagicDNS short names),
 * *.ts.net (Tailscale MagicDNS), and names listed in ADMIN_HOSTS.
 *
 * @param {string | undefined} hostHeader
 * @param {string[]} extraHosts
 */
export function isAllowedAdminHost(hostHeader, extraHosts = []) {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase().trim();
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]"));
  else host = host.replace(/:\d+$/, "");
  if (!host) return false;
  if (net.isIP(host)) return true;
  if (host === "localhost" || !host.includes(".")) return true;
  if (host.endsWith(".ts.net")) return true;
  return extraHosts.includes(host);
}
