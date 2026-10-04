import axios, { type AxiosRequestConfig } from "axios";

const PAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.8,en;q=0.5",
};

/** Direct CrowdWorks request. No proxy. */
export function cwRequestConfig(extra?: AxiosRequestConfig): AxiosRequestConfig {
  const extraHeaders = (extra?.headers || {}) as Record<string, string>;
  const { headers: _headers, proxy: _proxy, ...rest } = extra || {};
  return {
    timeout: 30_000,
    validateStatus: (status) => status < 500,
    ...rest,
    proxy: false,
    headers: { ...PAGE_HEADERS, ...extraHeaders },
  };
}

export function cwGet(url: string, extra?: AxiosRequestConfig) {
  return axios.get(url, cwRequestConfig(extra));
}
