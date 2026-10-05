import axios, { type AxiosRequestConfig } from "axios";
import { SocksProxyAgent } from "socks-proxy-agent";
import config from "@Server/config";

const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.8,en;q=0.5",
};

let logged = false;

function proxyRaw(): string {
  return (config.PROXY || "").trim();
}

function withScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function useUrbanBrowser(): boolean {
  return process.env.CW_BROWSER === "true" && !proxyRaw();
}

/** Host only, never credentials. */
export function cwProxyLabel(): string {
  if (useUrbanBrowser()) return "Urban VPN Chrome window";
  const raw = proxyRaw();
  if (!raw) return "direct, no proxy";
  try {
    const parsed = new URL(withScheme(raw));
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || (parsed.protocol.startsWith("socks") ? "1080" : "80")}`;
  } catch {
    return "proxy configured";
  }
}

/** Direct when PROXY is empty. HTTP or SOCKS when PROXY is set. */
export function cwRequestConfig(extra?: AxiosRequestConfig): AxiosRequestConfig {
  const extraHeaders = (extra?.headers || {}) as Record<string, string>;
  const { headers: _headers, proxy: _proxy, httpAgent: _http, httpsAgent: _https, ...rest } = extra || {};
  const base: AxiosRequestConfig = {
    timeout: 30_000,
    validateStatus: (status) => status < 500,
    ...rest,
    proxy: false,
    headers: { ...PAGE_HEADERS, ...extraHeaders },
  };

  const raw = proxyRaw();
  if (!raw) {
    if (!logged) {
      logged = true;
      console.log("[cw] CrowdWorks requests are direct (PROXY is not set)");
    }
    return base;
  }

  const parsed = new URL(withScheme(raw));
  const username = config.PROXY_AUTH?.username || decodeURIComponent(parsed.username || "");
  const password = config.PROXY_AUTH?.password || decodeURIComponent(parsed.password || "");
  const protocol = (parsed.protocol || "http:").replace(":", "");

  if (!logged) {
    logged = true;
    console.log("[cw] CrowdWorks requests via", cwProxyLabel());
  }

  if (protocol.startsWith("socks")) {
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
    const port = parsed.port || "1080";
    const agent = new SocksProxyAgent(`${protocol}://${auth}${parsed.hostname}:${port}`);
    base.httpAgent = agent;
    base.httpsAgent = agent;
    return base;
  }

  base.proxy = {
    protocol,
    host: parsed.hostname,
    port: Number(parsed.port || (protocol === "https" ? 443 : 80)),
    ...(username ? { auth: { username, password } } : {}),
  };
  return base;
}

export async function cwGet(url: string, extra?: AxiosRequestConfig) {
  if (useUrbanBrowser()) {
    const { browseCrowdWorks } = await import("@Server/utils/cwBrowser");
    return browseCrowdWorks(url, extra);
  }
  return axios.get(url, cwRequestConfig(extra));
}
