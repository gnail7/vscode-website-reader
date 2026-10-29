import { load } from "cheerio";
import { Comment, Post, PostSummary, ZonePage } from "./types";

const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36";
const ZONE_URL = "https://m.hupu.com/zone/85";
const DETAIL_URL = (id: string) => "https://m.hupu.com/bbs/" + id + ".html";

function pageProps(html: string): Record<string, any> {
  const $ = load(html);
  const data = $("#__NEXT_DATA__").html();
  if (!data) throw new Error("虎扑页面没有返回帖子数据，可能需要验证或页面结构已变化。");
  try {
    const result = JSON.parse(data)?.props?.pageProps;
    if (!result || typeof result !== "object") throw new Error("missing pageProps");
    return result;
  } catch {
    throw new Error("无法读取虎扑页面数据，页面结构可能已变化。");
  }
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() || fallback : fallback;
}

function safeImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch { return undefined; }
}

/** Convert public HTML to readable text; images remain links, never embedded images. */
export function htmlToMarkdown(html: string): string {
  if (!html) return "";
  if (html.trim().startsWith("{")) {
    try {
      const card = JSON.parse(html);
      if (card.type || card.url) return "［嵌入内容暂无法显示，请打开原帖查看］";
    } catch { /* It is ordinary text, not a structured card. */ }
  }
  const $ = load(html, {}, false);
  const images: string[] = [];
  $("script,style,iframe,video,audio").remove();
  $("img,center.hupu-img").each((_index, element) => {
    const item = $(element);
    const src = item.attr("data-gif") || item.attr("data-origin") || item.attr("data-src") || item.attr("data_url") || item.attr("src") || "";
    const url = safeImageUrl(src);
    if (url) {
      images.push(url);
      item.replaceWith(" ［图片 " + images.length + "］ ");
    } else {
      item.replaceWith(" ［图片］ ");
    }
  });
  $("br").replaceWith("\n");
  $("p,div,li,blockquote,section,article").append("\n\n");
  const content = $.root().text().replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().replace(/!\[/g, "\\![");
  return content + (images.length ? "\n\n" + images.map((url, i) => "[查看图片 " + (i + 1) + "](" + url + ")").join(" · ") : "");
}

function parseZoneList(raw: unknown): PostSummary[] {
  if (!Array.isArray(raw)) throw new Error("专区帖子列表格式已变化，无法解析。");
  const seen = new Set<string>();
  const posts: PostSummary[] = [];
  for (const item of raw) {
    const id = text(item?.tid);
    const title = text(item?.title);
    if (!/^\d+$/.test(id) || !title || seen.has(id)) continue;
    seen.add(id);
    posts.push({ id, title, author: text(item?.username, "未知作者"), replyCount: Number(item?.replies) || 0, time: text(item?.time) });
  }
  return posts;
}
export function parseZoneFirst(html: string): ZonePage {
  const props = pageProps(html);
  if (Number(props.zoneData?.topicId) !== 85) throw new Error("虎扑返回的不是英雄联盟专区。");
  const posts = parseZoneList(props.postList?.topicThreads);
  if (!posts.length) throw new Error("英雄联盟专区没有返回可用的帖子，请稍后刷新。");
  return { posts, nextCursor: text(props.postList?.nextCursor) };
}
export function parseZonePage(html: string): PostSummary[] { return parseZoneFirst(html).posts; }
export function parseZoneNext(json: string): ZonePage {
  let result: any;
  try { result = JSON.parse(json); } catch { throw new Error("专区分页数据无法读取，请稍后重试。"); }
  if (result?.code !== undefined && Number(result.code) !== 200) throw new Error("虎扑分页请求失败：" + text(result.msg, "请稍后重试"));
  if (!result?.data || typeof result.data !== "object") throw new Error("专区分页数据格式已变化，请稍后重试。");
  return { posts: parseZoneList(result.data.topicThreads), nextCursor: text(result.data.nextCursor) };
}

export function parsePostPage(html: string, id: string): Post {
  const props = pageProps(html);
  const thread = props.threadData?.data;
  const modules = thread?.moduleConfigList;
  if (!thread || !modules?.title?.moduleContent) throw new Error("帖子不存在、不可公开访问，或虎扑页面结构已变化。");
  const replies = props.initialRepliesData || {};
  const rawComments = [...(Array.isArray(replies.lightReplies) ? replies.lightReplies : []), ...(Array.isArray(replies.initialReplies) ? replies.initialReplies : [])];
  const seen = new Set<string>();
  const comments: Comment[] = [];
  for (const entry of rawComments) {
    const commentId = text(entry?.pid);
    if (entry?.isDelete || entry?.isSelfDelete || entry?.isHidden || (commentId && seen.has(commentId))) continue;
    if (commentId) seen.add(commentId);
    const body = htmlToMarkdown(text(entry?.content));
    if (!body) continue;
    comments.push({
      id: commentId,
      author: text(entry?.user?.username, "匿名用户"),
      time: text(entry?.createDt),
      content: body,
      likes: Number(entry?.light) || 0
    });
  }
  return {
    id,
    title: text(modules.title.moduleContent.title, "虎扑帖子"),
    author: text(modules.user?.moduleContent?.name ?? thread.basicInfo?.author?.name, "未知作者"),
    time: text(modules.user?.moduleContent?.time),
    content: htmlToMarkdown(text(modules.content?.moduleContent?.content)) || "［该帖子没有可显示的文本内容］",
    comments,
    hasMore: Boolean(replies.initialHasMore)
  };
}

export function renderPost(post: Post): string {
  const heading = post.title.replace(/[\r\n]+/g, " ").replace(/([\\\x60*_{}\[\]<>])/g, "\\$1");
  const comments = post.comments.map((comment, index) =>
    "### " + (index + 1) + " · " + comment.author.replace(/[\r\n]+/g, " ") + "\n\n" +
    "> " + [comment.time, comment.likes ? "亮 " + comment.likes : ""].filter(Boolean).join(" · ") +
    "\n\n" + comment.content
  ).join("\n\n---\n\n");
  return [
    "# " + heading,
    "> " + post.author.replace(/[\r\n]+/g, " ") + (post.time ? " · " + post.time : ""),
    post.content,
    "---",
    "## 评论",
    comments || "［暂无可显示的公开评论］",
    post.hasMore ? "［仅显示页面返回的首批公开评论；更多评论请查看原帖。］" : "［显示页面返回的公开评论。］",
    "原帖：https://m.hupu.com/bbs/" + post.id + ".html",
    "图片默认不加载；按住 Ctrl 并点击图片链接查看。"
  ].join("\n\n") + "\n";
}

type CacheEntry<T> = { value: T; expires: number };
export class HupuService {
  private zone?: CacheEntry<ZonePage>;
  private readonly posts = new Map<string, CacheEntry<Post>>();
  constructor(private readonly cacheMinutes: () => number, private readonly fetcher: typeof fetch = fetch) {}

  private async fetchHtml(url: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { "User-Agent": MOBILE_USER_AGENT, "Accept-Language": "zh-CN,zh;q=0.9", "Accept": "text/html" },
        signal: AbortSignal.timeout(15000),
        redirect: "follow"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error("连接虎扑失败：" + message + "。请检查网络或代理设置。");
    }
    if (!response.ok) throw new Error("虎扑返回 HTTP " + response.status + "，请稍后重试。");
    return response.text();
  }
  private expiry(): number { return Date.now() + Math.max(0, Math.min(60, this.cacheMinutes())) * 60_000; }
  async getZoneFirst(force = false): Promise<ZonePage> {
    if (!force && this.zone && this.zone.expires > Date.now()) return this.zone.value;
    const page = parseZoneFirst(await this.fetchHtml(ZONE_URL));
    this.zone = { value: page, expires: this.expiry() };
    return page;
  }
  async getZonePosts(force = false): Promise<PostSummary[]> {
    return (await this.getZoneFirst(force)).posts;
  }
  async getZoneNext(cursor: string, page: number): Promise<ZonePage> {
    if (!cursor || !Number.isInteger(page) || page < 2) throw new Error("分页参数无效，请刷新专区列表。");
    const url = "https://m.hupu.com/api/v2/bbs/topicThreads?topicId=85&page=" + page + "&cursor=" + encodeURIComponent(cursor);
    const result = parseZoneNext(await this.fetchHtml(url));
    if (result.nextCursor === cursor) result.nextCursor = "";
    return result;
  }
  async getPost(id: string, force = false): Promise<Post> {
    if (!/^\d+$/.test(id)) throw new Error("无效的虎扑帖子编号。");
    const cached = this.posts.get(id);
    if (!force && cached && cached.expires > Date.now()) return cached.value;
    const post = parsePostPage(await this.fetchHtml(DETAIL_URL(id)), id);
    this.posts.set(id, { value: post, expires: this.expiry() });
    return post;
  }
  clearPost(id: string): void { this.posts.delete(id); }
}
