// lg-bun-lib / xtream — ported 1:1 from homelessbrian/NuvioTV LiveTvRepository (Kotlin)
// TiviMate-style Xtream Codes login flow: account → categories → live streams → M3U.
// Falls back to get.php if the API isn't available.

export const XTREAM_ACTIONS = {
  account: "",
  liveCategories: "get_live_categories",
  vodCategories: "get_vod_categories",
  seriesCategories: "get_series_categories",
  liveStreams: "get_live_streams",
  vodStreams: "get_vod_streams",
  series: "get_series",
  simpleDataTable: "get_simple_data_table",
};

export const DEFAULT_UA = "Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export function tidyLink(raw) {
  return raw
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-")
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00A0\s]/g, "");
}

export function cleanXtreamServer(raw) {
  const t = raw.trim();
  const m = t.match(/^[a-zA-Z]+:\/\//);
  const schemeLen = m ? m[0].length : 0;
  const hostEnd = t.indexOf("/", schemeLen);
  const end = hostEnd < 0 ? t.length : hostEnd;
  const hostPart = t.substring(schemeLen, end)
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00A0\s]/g, "")
    .replace(/[^\x00-\x7F]/g, "-");
  let fixed = t.substring(0, schemeLen) + hostPart + t.substring(end);
  let s = tidyLink(fixed);
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    const port = u.port ? ":" + u.port : "";
    return `${u.protocol}//${u.hostname}${port}`;
  } catch {
    return s.replace(/\/+$/, "");
  }
}

export function enc(s) { return encodeURIComponent(s.trim()); }

export function credentialsFromLink(raw) {
  const q = raw.split("?")[1] || "";
  if (!q) return null;
  const params = {};
  for (const part of q.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    params[part.substring(0, eq).toLowerCase()] = decodeURIComponent(part.substring(eq + 1));
  }
  if (!params.username || !params.password) return null;
  return [params.username, params.password];
}

export class XtreamLoginError extends Error {
  constructor(m) { super(m); this.name = "XtreamLoginError"; }
}

export class XtreamEngine {
  constructor({ fetchImpl = globalThis.fetch, userAgent = DEFAULT_UA, onStatus } = {}) {
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.onStatus = onStatus;
    this.allowedFormats = new Set();
    this.serverTimezone = "";
  }

  async getText(url, ua = this.userAgent) {
    const res = await this.fetchImpl(url, { headers: { "User-Agent": ua || DEFAULT_UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text) throw new Error("Empty response");
    return text;
  }

  setStatus(msg) { if (this.onStatus) this.onStatus(msg); }

  async downloadXtream(pl, targetPath) {
    if (!pl.xtreamBase) throw new Error("No server set");
    if (!pl.xtreamUsername || !pl.xtreamPassword) throw new Error("Username and password are required");

    const api = pl.xtreamApiUrl ? pl.xtreamApiUrl() : `${pl.xtreamBase()}/player_api.php?username=${enc(pl.xtreamUsername)}&password=${enc(pl.xtreamPassword)}`;
    this.setStatus(`Checking Xtream account "${pl.name}"…`);

    let info;
    try {
      info = JSON.parse(await this.getText(api, pl.userAgent));
    } catch (e) {
      this.setStatus(`Xtream API failed, trying get.php: ${e.message}`);
      return this.downloadGetPhp(pl, targetPath, e);
    }

    const userInfo = info.user_info;
    const serverInfo = info.server_info;

    if (userInfo?.allowed_output_formats) {
      this.allowedFormats = new Set(Array.from(userInfo.allowed_output_formats).map(x => String(x).toLowerCase()));
    }

    if (serverInfo?.timezone && serverInfo.timezone !== pl.serverTimezone) {
      pl.serverTimezone = serverInfo.timezone;
    }

    if (userInfo) {
      const account = this.accountOf(userInfo);
      if (account) this.saveAccount(pl, account);
      if (userInfo.auth === "0") throw new XtreamLoginError("Login failed: check the username and password");
      const status = userInfo.status || "";
      if (status && status.toLowerCase() !== "active") throw new XtreamLoginError(`Account ${status}`);
      const exp = userInfo.exp_date ? parseInt(userInfo.exp_date, 10) : null;
      if (exp > 0 && exp * 1000 < Date.now()) {
        const date = new Date(exp * 1000).toLocaleDateString();
        throw new XtreamLoginError(`Account expired on ${date}`);
      }
    } else if (Object.prototype.hasOwnProperty.call(info, "user_info")) {
      throw new Error("Not an Xtream API response");
    }

    const categories = {};
    try {
      const arr = JSON.parse(await this.getText(`${api}&action=get_live_categories`, pl.userAgent));
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (!c) continue;
        categories[c.category_id] = c.category_name || "";
      }
    } catch { /* categories optional */ }

    this.setStatus(`Loading channels from "${pl.name}"…`);
    return this.writeXtreamPlaylist(pl, `${api}&action=get_live_streams`, categories, targetPath);
  }

  accountOf(ui) {
    if (ui.auth === "0") return null;
    const exp = ui.exp_date ? parseInt(ui.exp_date, 10) : null;
    return {
      expiresAtMs: (exp > 0 ? exp * 1000 : 0),
      status: ui.status || "",
      maxConnections: parseInt(ui.max_connections, 10) || 0,
      activeConnections: parseInt(ui.active_cons, 10) || 0,
      checkedAtMs: Date.now(),
    };
  }

  saveAccount(pl, account) {
    const label = this.expiryLabel(account);
    if (label) this.setStatus(`Account for "${pl.name}": ${label}`);
  }

  expiryLabel(account) {
    if (account.expiresAtMs <= 0) return null;
    const now = Date.now();
    const days = Math.max(0, Math.floor((account.expiresAtMs - now) / 86400000));
    const date = new Date(account.expiresAtMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    const left = account.expiresAtMs <= now ? "expired"
      : days === 0 ? "today"
      : days === 1 ? "1 day"
      : `${days} days`;
    return `${date} (${left})`;
  }

  async writeXtreamPlaylist(pl, url, categories, targetPath) {
    const ext = this.xtreamExtension(pl);
    const base = pl.xtreamBase ? pl.xtreamBase() : cleanXtreamServer(pl.xtreamServer || "");
    const user = encodeURIComponent(pl.xtreamUsername.trim());
    const pass = encodeURIComponent(pl.xtreamPassword.trim());
    let count = 0;

    const res = await this.fetchImpl(url, { headers: { "User-Agent": pl.userAgent || DEFAULT_UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = res.body;
    if (!body) throw new Error("Empty response");

    let text;
    if (typeof body === "string") text = body;
    else if (body.getReader) {
      const reader = body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(typeof value === "string" ? value : new TextDecoder().decode(value));
      }
      text = chunks.join("");
    } else {
      text = await res.text();
    }

    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Xtream stream list was not JSON"); }

    const items = Array.isArray(data) ? data : Object.values(data || {});
    const lines = ["#EXTM3U\n"];
    for (const f of items) {
      const streamId = f.stream_id;
      if (!streamId) continue;
      const title = ((f.name || `Channel ${streamId}`) || "").replace(/\n/g, " ").trim();
      const attrs = [];
      const attr = (k, v) => { if (v) attrs.push(`${k}="${String(v).replace(/"/g, "'")}"`); };
      attr("tvg-id", f.epg_channel_id);
      attr("tvg-name", title);
      attr("tvg-logo", f.stream_icon);
      attr("group-title", categories[f.category_id] || "Uncategorized");
      attr("tvg-chno", f.num);
      if (f.tv_archive === "1") {
        attr("catchup", "xc");
        const dur = f.tv_archive_duration;
        attr("catchup-days", dur && dur !== "0" ? dur : "1");
      }
      lines.push(`#EXTINF:-1${attrs.join(" ")},${title}\n`);
      lines.push(`${base}/live/${user}/${pass}/${streamId}.${ext}\n`);
      count++;
      if (count % 500 === 0) this.setStatus(`Loading channels from ${pl.name}… ${count.toLocaleString()}`);
    }

    if (count === 0) throw new Error("The provider returned no live channels");

    const m3u = lines.join("");
    return { m3u, count, ext };
  }

  xtreamExtension(pl) {
    if (pl.streamFormat === "ts") return "ts";
    if (pl.streamFormat === "m3u8") return "m3u8";
    if (this.allowedFormats.size > 0 && !this.allowedFormats.has("ts") && this.allowedFormats.has("m3u8")) return "m3u8";
    return "ts";
  }

  async downloadGetPhp(pl, targetPath, apiError) {
    const url = pl.resolvedUrl ? pl.resolvedUrl() : `${pl.xtreamBase()}/get.php?username=${enc(pl.xtreamUsername)}&password=${enc(pl.xtreamPassword)}&type=m3u_plus&output=ts`;
    try {
      const text = await this.getText(url, pl.userAgent);
      return { m3u: text, count: 0, ext: "ts", fallback: true, apiError };
    } catch (e) {
      throw new Error(apiError.message || e.message);
    }
  }

  async loadXtreamArchive(pl, streamId) {
    const api = `${pl.xtreamBase()}/player_api.php?username=${enc(pl.xtreamUsername)}&password=${enc(pl.xtreamPassword)}&action=get_simple_data_table&stream_id=${streamId}`;
    const text = await this.getText(api, pl.userAgent || DEFAULT_UA);
    const json = JSON.parse(text);
    const arr = json.epg_listings;
    if (!arr) return [];
    const list = [];
    for (let i = 0; i < arr.length; i++) {
      const o = arr[i];
      if (!o) continue;
      const start = o.start_timestamp ? parseInt(o.start_timestamp, 10) * 1000 : null;
      const stop = (o.stop_timestamp ? parseInt(o.stop_timestamp, 10) * 1000)
        || (o.end_timestamp ? parseInt(o.end_timestamp, 10) * 1000 : null);
      if (!start || !stop || stop <= start) continue;
      const title = (this.b64(o.title) || "").trim();
      if (!title) continue;
      list.push({ startMs: start, stopMs: stop, title, description: (this.b64(o.description) || "").trim() || undefined });
    }
    list.sort((a, b) => a.startMs - b.startMs);
    return list;
  }

  b64(v) {
    if (!v) return v;
    try { return decodeURIComponent(escape(atob(v))); } catch { return v; }
  }
}

if (!String.prototype.substringAfter) {
  String.prototype.substringAfter = function (delim, def = "") {
    const i = this.indexOf(delim);
    return i < 0 ? def : this.substring(i + delim.length);
  };
}
