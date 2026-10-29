import { load } from "cheerio";
import { htmlToMarkdown } from "./hupu";
import { Comment, Post, PostSummary } from "./types";

const GROUP = "748338";
const BASE = "https://www.douban.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
export interface DoubanSummary extends PostSummary { url: string }
export interface DoubanPage { posts: DoubanSummary[]; nextStart?: number }

/** Keep only topic URLs from the selected group list, never arbitrary URLs. */
export function topicUrl(value: string, expectedId?: string): string | undefined {
  try {
    const url = new URL(value, BASE);
    const match = /^\/group\/topic\/(\d+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "www.douban.com" || !match || (expectedId && match[1] !== expectedId)) return undefined;
    const result = new URL("/group/topic/" + match[1] + "/", BASE);
    const spm = url.searchParams.get("_spm_id");
    if (spm && /^[A-Za-z0-9_-]{1,200}$/.test(spm)) result.searchParams.set("_spm_id", spm);
    return result.href;
  } catch { return undefined; }
}

export function parseGroupPage(html: string, currentStart: number): DoubanPage {
  const $ = load(html);
  if (!$("table.olt").length) throw new Error("豆瓣没有返回公开的小组帖子列表，可能需要登录、入组或页面结构已变化。");
  const posts: DoubanSummary[] = [], seen = new Set<string>();
  $("table.olt tr").each((_i, row) => {
    const cells = $(row).find("td");
    const link = $(row).find("td.title a[href*='/group/topic/']").first();
    const url = topicUrl(link.attr("href") || "");
    const id = url && /\/group\/topic\/(\d+)\//.exec(url)?.[1];
    const title = (link.attr("title") || link.text()).trim();
    if (!url || !id || !title || seen.has(id)) return;
    seen.add(id);
    posts.push({
      id, url, title,
      author: cells.eq(1).text().trim() || "未知作者",
      replyCount: Number($(row).find(".r-count").text().trim()) || 0,
      time: $(row).find(".time").text().trim()
    });
  });
  let nextStart: number | undefined;
  const href = $(".paginator .next a").first().attr("href");
  if (href) {
    try {
      const next = new URL(href, BASE), value = next.searchParams.get("start");
      const num = value && /^\d+$/.test(value) ? Number(value) : NaN;
      if (next.protocol === "https:" && next.hostname === "www.douban.com" && next.pathname.replace(/\/$/, "") === "/group/" + GROUP + "/discussion" && Number.isSafeInteger(num) && num > currentStart) nextStart = num;
    } catch { /* No valid next page. */ }
  }
  return { posts, nextStart };
}

export function parseTopicPage(html: string, id: string): Post {
  const $ = load(html);
  const title = $("h1").first().text().trim();
  const main = $(".topic-doc #link-report .topic-richtext").first();
  if (!title || !main.length) throw new Error("豆瓣没有返回可阅读的帖子正文，可能需要登录、入组或帖子已不可用。");
  const comments: Comment[] = [];
  $(".topic-reply .reply-item").each((index, element) => {
    const item = $(element), body = item.find(".reply-content .markdown").first();
    if (!body.length) return;
    const content = htmlToMarkdown(body.html() || "");
    if (!content) return;
    comments.push({
      id: item.attr("id") || String(index),
      author: item.find(".reply-doc h4 a").first().text().trim() || "豆瓣用户",
      time: item.find(".pubtime").first().text().trim(),
      content, likes: 0
    });
  });
  return {
    id, title,
    author: $(".topic-doc h3 .from a").first().text().trim() || "豆瓣用户",
    time: $(".topic-doc .create-time").first().text().trim(),
    content: htmlToMarkdown(main.html() || "") || "［该帖子没有可显示的文字］",
    comments,
    hasMore: Boolean($(".paginator .next a").length)
  };
}
export function renderDoubanPost(post: Post, url: string): string {
  const heading = post.title.replace(/[\r\n]+/g, " ").replace(/([\\\x60*_{}\[\]<>])/g, "\\$1");
  const comments = post.comments.map((c, i) => "### " + (i + 1) + " · " + c.author.replace(/[\r\n]+/g, " ") + "\n\n> " + c.time + "\n\n" + c.content).join("\n\n---\n\n");
  return ["# " + heading, "> " + post.author.replace(/[\r\n]+/g, " ") + (post.time ? " · " + post.time : ""), post.content, "---", "## 评论", comments || "［暂无可显示的公开评论］", post.hasMore ? "［仅显示当前页评论，更多评论请查看原帖。］" : "［显示页面返回的公开评论。］", "原帖：" + url, "图片默认不加载；按住 Ctrl 并点击图片链接查看。"].join("\n\n") + "\n";
}

type Entry<T> = { value: T; expires: number };
export class DoubanAccessError extends Error {
  constructor(message: string, readonly reason: "verification" | "login" | "permission" | "rate-limit") { super(message); this.name = "DoubanAccessError"; }
}
export class DoubanService {
  private readonly pages = new Map<number, Entry<DoubanPage>>();
  private readonly posts = new Map<string, Entry<Post>>();
  constructor(
    private readonly cacheMinutes: () => number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly getCookie: () => PromiseLike<string | undefined> = async () => undefined
  ) {}
  private async get(url: string): Promise<string> {
    const cookie = await this.getCookie();
    let current = new URL(url);
    for (let redirects = 0; redirects < 4; redirects++) {
      if (current.protocol !== "https:" || current.hostname !== "www.douban.com" || current.port) throw new DoubanAccessError("豆瓣要求在浏览器中完成验证或登录。请先打开小组完成验证，再在扩展中设置浏览器会话。", "verification");
      const headers: Record<string, string> = { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", "Accept": "text/html" };
      if (cookie) headers.Cookie = cookie;
      let response: Response;
      try {
        response = await this.fetcher(current.href, { headers, signal: AbortSignal.timeout(15000), redirect: "manual" });
      } catch (error) { throw new Error("连接豆瓣失败：" + (error instanceof Error ? error.message : String(error)) + "。请检查网络或代理设置。"); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("豆瓣返回了无效的跳转，请稍后重试。");
        const next = new URL(location, current);
        if (next.hostname === "sec.douban.com") throw new DoubanAccessError("豆瓣要求在浏览器中完成安全验证。请先打开小组完成验证，再在扩展中设置浏览器会话。", "verification");
        if (next.hostname === "accounts.douban.com" || /\/accounts\/(login|passport)/.test(next.pathname)) throw new DoubanAccessError("豆瓣要求登录。请在浏览器登录并确认有权访问小组，再在扩展中设置浏览器会话。", "login");
        if (next.protocol !== "https:" || next.hostname !== "www.douban.com" || next.port) throw new Error("豆瓣返回了不支持的跳转地址，已停止请求。");
        current = next;
        continue;
      }
      if (response.status === 403 || response.status === 401) throw new DoubanAccessError("豆瓣返回 HTTP " + response.status + "；该内容可能需要登录、验证或加入小组。", "permission");
      if (response.status === 429) throw new DoubanAccessError("豆瓣请求过于频繁，请稍后再试。", "rate-limit");
      if (!response.ok) throw new Error("豆瓣返回 HTTP " + response.status + "，请稍后重试。");
      const html = await response.text();
      if (/请点击下方按钮继续浏览|点我继续浏览/.test(html)) throw new DoubanAccessError("豆瓣要求在浏览器中完成安全验证。请先打开小组完成验证，再在扩展中设置浏览器会话。", "verification");
      return html;
    }
    throw new Error("豆瓣页面跳转次数过多，请稍后重试。");
  }
  private expiry(): number { return Date.now() + Math.max(0, Math.min(60, this.cacheMinutes())) * 60_000; }
  async getGroupPage(start = 0, force = false): Promise<DoubanPage> {
    if (!Number.isSafeInteger(start) || start < 0 || start > 1_000_000) throw new Error("无效的豆瓣分页参数。");
    const cached = this.pages.get(start);
    if (!force && cached && cached.expires > Date.now()) return cached.value;
    const url = BASE + "/group/" + GROUP + "/discussion?start=" + start + "&type=new";
    const result = parseGroupPage(await this.get(url), start);
    this.pages.set(start, { value: result, expires: this.expiry() });
    return result;
  }
  async getPost(id: string, url: string, force = false): Promise<Post> {
    const safe = topicUrl(url, id);
    if (!safe) throw new Error("无效的豆瓣帖子地址。");
    const cached = this.posts.get(safe);
    if (!force && cached && cached.expires > Date.now()) return cached.value;
    const result = parseTopicPage(await this.get(safe), id);
    this.posts.set(safe, { value: result, expires: this.expiry() });
    return result;
  }
  clearPost(id: string, url: string): void { const safe = topicUrl(url, id); if (safe) this.posts.delete(safe); }
}
