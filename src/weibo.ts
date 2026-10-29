import * as vscode from "vscode";
import { load } from "cheerio";
import { htmlToMarkdown } from "./hupu";

interface Topic { title: string; rank: number; heat?: number; label?: string }
const SCHEME = "weibo-reader";
const COOKIE = "weiboReader.sessionCookie";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function parseHotSearch(value: unknown): Topic[] {
  const response = value as { ok?: number; data?: { realtime?: unknown } };
  if (response?.ok !== 1 || !Array.isArray(response.data?.realtime)) throw new Error("微博未返回热搜列表，可能需要验证或接口已变化。");
  const result: Topic[] = [], seen = new Set<string>();
  for (const entry of response.data.realtime) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = typeof item.note === "string" ? item.note.trim() : typeof item.word === "string" ? item.word.trim() : "";
    if (!title || seen.has(title)) continue;
    seen.add(title);
    result.push({ title, rank: typeof item.realpos === "number" && item.realpos > 0 ? item.realpos : result.length + 1,
      heat: typeof item.num === "number" && Number.isFinite(item.num) ? item.num : undefined,
      label: typeof item.label_name === "string" ? item.label_name : undefined });
  }
  if (!result.length) throw new Error("微博没有返回可显示的热搜，请稍后重试。");
  return result;
}

export function parseSearch(html: string): string[] {
  const $ = load(html), posts: string[] = [];
  $(".card-wrap[action-type='feed_list_item'], .card-wrap[mid]").each((_i, el) => {
    const card = $(el), full = card.find("p[node-type='feed_list_content_full']").first();
    const body = full.length ? full : card.find("p[node-type='feed_list_content']").first();
    if (!body.length) return;
    const text = htmlToMarkdown(body.html() || "").trim();
    if (!text) return;
    const author = card.find(".info .name").first().text().trim() || "微博用户";
    const time = card.find(".from a").first().text().trim();
    posts.push("### " + author.replace(/[\r\n]/g, " ") + (time ? " · " + time.replace(/[\r\n]/g, " ") : "") + "\n\n" + text);
  });
  return posts;
}

class WeiboTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private topics?: Topic[];
  private generation = 0;
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  refresh(): void { this.topics = undefined; this.generation++; this.changed.fire(undefined); }
  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      if (!this.topics) {
        const generation = this.generation;
        const response = await fetch("https://weibo.com/ajax/side/hotSearch", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://weibo.com/", "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("微博返回 HTTP " + response.status);
        const topics = parseHotSearch(await response.json());
        if (generation !== this.generation) return [];
        this.topics = topics;
      }
      return this.topics.map(topic => {
        const item = new vscode.TreeItem(topic.rank + ". " + topic.title, vscode.TreeItemCollapsibleState.None);
        item.description = [topic.label, topic.heat !== undefined ? topic.heat.toLocaleString("zh-CN") : undefined].filter(Boolean).join(" · ");
        item.tooltip = topic.title + "\n点击在编辑器中阅读相关微博";
        item.iconPath = new vscode.ThemeIcon("flame");
        item.command = { command: "weiboReader.openTopic", title: "阅读微博话题", arguments: [topic] };
        return item;
      });
    } catch (error) {
      const item = new vscode.TreeItem("加载微博热搜失败，点击重试", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("warning"); item.tooltip = message(error);
      item.command = { command: "weiboReader.refresh", title: "刷新微博热搜" }; return [item];
    }
  }
  dispose(): void { this.changed.dispose(); }
}

class WeiboDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly context: vscode.ExtensionContext) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const title = new URLSearchParams(uri.query).get("q") || "";
    if (!title || title.length > 500) return "# 无效的话题\n";
    const heading = title.replace(/[\r\n]/g, " ").replace(/([\\`*_{}\[\]<>])/g, "\\$1");
    try {
      const cookie = await this.context.secrets.get(COOKIE);
      const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36", "Referer": "https://s.weibo.com/", "Accept": "text/html" };
      if (cookie) headers.Cookie = cookie;
      const url = "https://s.weibo.com/weibo?q=" + encodeURIComponent(title);
      const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400 || response.status === 401 || response.status === 403 || response.status === 432) throw new Error("微博要求登录或安全验证，请在命令面板运行「微博热搜：设置浏览器会话」，然后刷新本文档。");
      if (!response.ok) throw new Error("微博返回 HTTP " + response.status);
      const posts = parseSearch(await response.text());
      if (!posts.length) throw new Error("未获取到可阅读的公开微博，可能需要登录、验证或微博页面结构已变化。");
      return "# " + heading + "\n\n> 微博搜索结果 · 仅显示当前页公开内容\n\n" + posts.join("\n\n---\n\n") + "\n";
    } catch (error) { return "# " + heading + "\n\n**加载失败：** " + message(error) + "\n\n可通过命令面板设置微博浏览器会话，并使用编辑器右上角的刷新按钮重试。\n"; }
  }
  refresh(uri: vscode.Uri): void { this.changed.fire(uri); }
  dispose(): void { this.changed.dispose(); }
}

export function registerWeibo(context: vscode.ExtensionContext): void {
  const tree = new WeiboTree(), documents = new WeiboDocuments(context);
  context.subscriptions.push(tree, documents, vscode.window.registerTreeDataProvider("weiboReader.hot", tree),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.commands.registerCommand("weiboReader.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("weiboReader.openTopic", async (topic: Topic) => {
      if (!topic || typeof topic.title !== "string" || !topic.title.trim() || topic.title.length > 500) return;
      const name = (topic.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").trim() || "微博热搜").slice(0, 80);
      const uri = vscode.Uri.from({ scheme: SCHEME, path: "/" + name + ".md", query: new URLSearchParams({ q: topic.title }).toString() });
      let doc = await vscode.workspace.openTextDocument(uri);
      if (doc.languageId !== "markdown") doc = await vscode.languages.setTextDocumentLanguage(doc, "markdown");
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("weiboReader.refreshTopic", (uri?: vscode.Uri) => {
      const target = uri?.scheme === SCHEME ? uri : vscode.window.activeTextEditor?.document.uri;
      if (target?.scheme === SCHEME) documents.refresh(target);
    }),
    vscode.commands.registerCommand("weiboReader.setCookie", async () => {
      const value = await vscode.window.showInputBox({ title: "设置微博浏览器会话", prompt: "在浏览器登录微博后，从 s.weibo.com 搜索页面的网络请求复制 Cookie 值；仅安全存储并发送至 s.weibo.com。不要发到聊天中。", password: true, ignoreFocusOut: true });
      if (value === undefined) return;
      const cookie = value.replace(/^Cookie:\s*/i, "").trim();
      if (!cookie || !cookie.includes("=") || /[\r\n]/.test(cookie) || cookie.length > 8192) { void vscode.window.showWarningMessage("Cookie 格式无效。"); return; }
      await context.secrets.store(COOKIE, cookie);
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === SCHEME) documents.refresh(active);
      void vscode.window.showInformationMessage("微博会话已保存。请刷新热搜话题文档。");
    }),
    vscode.commands.registerCommand("weiboReader.clearCookie", async () => { await context.secrets.delete(COOKIE); void vscode.window.showInformationMessage("已清除微博会话。"); })
  );
}
