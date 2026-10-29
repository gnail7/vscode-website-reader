import * as vscode from "vscode";
import { DoubanAccessError, DoubanPage, DoubanService, DoubanSummary, renderDoubanPost, topicUrl } from "./douban";

const SCHEME = "douban-reader";
const COOKIE_SECRET = "doubanReader.sessionCookie";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function postAddress(uri: vscode.Uri): { id: string; url: string } | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const id = uri.path.split("/").filter(Boolean)[0];
  if (!id || !/^\d+$/.test(id)) return undefined;
  const link = new URL("https://www.douban.com/group/topic/" + id + "/");
  const spm = new URLSearchParams(uri.query).get("_spm_id");
  if (spm && /^[A-Za-z0-9_-]{1,200}$/.test(spm)) link.searchParams.set("_spm_id", spm);
  const url = topicUrl(link.href, id);
  return url ? { id, url } : undefined;
}

class GroupTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private posts?: DoubanSummary[];
  private nextStart?: number;
  private loading = false;
  private force = false;
  private generation = 0;
  constructor(private readonly service: DoubanService) {}
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  refresh(): void { this.generation++; this.force = true; this.changed.fire(undefined); }
  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      if (!this.posts || this.force) {
        const generation = this.generation;
        const first = await this.service.getGroupPage(0, this.force);
        if (generation !== this.generation) return [];
        this.posts = first.posts;
        this.nextStart = first.nextStart;
        this.force = false;
      }
      const items = this.posts.map(post => {
        const item = new vscode.TreeItem(post.title, vscode.TreeItemCollapsibleState.None);
        item.id = "douban-" + post.id;
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.description = post.replyCount ? post.replyCount + " 回复" : undefined;
        item.tooltip = post.title + "\n" + post.author + (post.time ? " · " + post.time : "") + "\n" + post.replyCount + " 条回复";
        item.command = { command: "doubanReader.openPost", title: "打开帖子", arguments: [post] };
        return item;
      });
      if (!this.posts.length) {
        const empty = new vscode.TreeItem("没有可见帖子", vscode.TreeItemCollapsibleState.None);
        empty.tooltip = "该小组可能暂无帖子，或者需要登录后才能查看。";
        items.push(empty);
      }
      if (this.nextStart !== undefined) {
        const more = new vscode.TreeItem(this.loading ? "正在加载更多…" : "加载更多帖子", vscode.TreeItemCollapsibleState.None);
        more.id = "douban-reader-load-more";
        more.iconPath = new vscode.ThemeIcon(this.loading ? "loading~spin" : "add");
        more.description = "已加载 " + this.posts.length + " 条";
        if (!this.loading) more.command = { command: "doubanReader.loadMore", title: "加载更多帖子" };
        items.push(more);
      }
      return items;
    } catch (error) {
      if (error instanceof DoubanAccessError && error.reason !== "rate-limit") {
        const verify = new vscode.TreeItem("豆瓣需要验证或登录 · 点击打开小组", vscode.TreeItemCollapsibleState.None);
        verify.iconPath = new vscode.ThemeIcon("link-external");
        verify.tooltip = error.message;
        verify.command = { command: "doubanReader.openGroup", title: "打开豆瓣小组" };
        const session = new vscode.TreeItem("验证后设置豆瓣浏览器会话", vscode.TreeItemCollapsibleState.None);
        session.iconPath = new vscode.ThemeIcon("key");
        session.tooltip = "手动输入浏览器 Cookie；只存储在 VS Code 安全存储中，并仅发送给 www.douban.com。";
        session.command = { command: "doubanReader.setCookie", title: "设置豆瓣浏览器会话" };
        const retry = new vscode.TreeItem("刷新小组列表", vscode.TreeItemCollapsibleState.None);
        retry.iconPath = new vscode.ThemeIcon("refresh");
        retry.command = { command: "doubanReader.refresh", title: "刷新豆瓣小组" };
        return [verify, session, retry];
      }
      const item = new vscode.TreeItem("加载失败：" + errorMessage(error), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("warning");
      item.tooltip = errorMessage(error);
      item.command = { command: "doubanReader.refresh", title: "刷新豆瓣小组" };
      return [item];
    }
  }
  async loadMore(): Promise<void> {
    if (this.loading) return;
    if (!this.posts) await this.getChildren();
    if (!this.posts || this.nextStart === undefined) { void vscode.window.showInformationMessage("暂时没有更多豆瓣帖子。"); return; }
    const generation = this.generation, start = this.nextStart;
    this.loading = true; this.changed.fire(undefined);
    try {
      const page: DoubanPage = await this.service.getGroupPage(start);
      if (generation !== this.generation) return;
      const seen = new Set(this.posts.map(post => post.id));
      const next = page.posts.filter(post => !seen.has(post.id));
      this.posts = [...this.posts, ...next];
      this.nextStart = page.nextStart;
      if (!next.length) void vscode.window.showInformationMessage(this.nextStart !== undefined ? "这一页没有新帖子，可以继续加载下一页。" : "暂时没有更多豆瓣帖子。");
    } catch (error) {
      if (generation === this.generation) void vscode.window.showErrorMessage("加载豆瓣帖子失败：" + errorMessage(error));
    } finally { this.loading = false; this.changed.fire(undefined); }
  }
  dispose(): void { this.changed.dispose(); }
}

class TopicDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly service: DoubanService) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const address = postAddress(uri);
    if (!address) return "# 无效的豆瓣帖子地址\n";
    try { return renderDoubanPost(await this.service.getPost(address.id, address.url), address.url); }
    catch (error) { return "# 帖子加载失败\n\n" + errorMessage(error) + "\n\n请使用编辑器右上角的刷新按钮重试，或在浏览器中打开：\n\n" + address.url + "\n"; }
  }
  refresh(uri: vscode.Uri): void { const address = postAddress(uri); if (address) { this.service.clearPost(address.id, address.url); this.changed.fire(uri); } }
  dispose(): void { this.changed.dispose(); }
}

function activeUri(arg?: unknown): vscode.Uri | undefined {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  return uri && postAddress(uri) ? uri : undefined;
}

export function registerDouban(context: vscode.ExtensionContext, cacheMinutes: () => number): void {
  const service = new DoubanService(cacheMinutes, fetch, () => context.secrets.get(COOKIE_SECRET)), tree = new GroupTree(service), documents = new TopicDocuments(service);
  context.subscriptions.push(
    tree, documents,
    vscode.window.registerTreeDataProvider("doubanReader.group", tree),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.commands.registerCommand("doubanReader.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("doubanReader.loadMore", () => tree.loadMore()),
    vscode.commands.registerCommand("doubanReader.openGroup", async () => {
      await vscode.env.openExternal(vscode.Uri.parse("https://www.douban.com/group/748338/"));
    }),
    vscode.commands.registerCommand("doubanReader.setCookie", async () => {
      const input = await vscode.window.showInputBox({
        title: "设置已验证的豆瓣浏览器会话",
        prompt: "先在浏览器访问小组并完成验证，再从该页面的网络请求复制 Cookie 请求头。仅存入 VS Code 安全存储，且仅发送给 www.douban.com；不要发送到聊天中。",
        placeHolder: "粘贴 Cookie 请求头的值",
        password: true,
        ignoreFocusOut: true,
        validateInput: value => {
          const cookie = value.replace(/^Cookie:\s*/i, "").trim();
          return !cookie || !cookie.includes("=") || /[\r\n]/.test(cookie) || cookie.length > 8192 ? "请输入单行 Cookie 值（不超过 8192 字符）。" : undefined;
        }
      });
      if (input === undefined) return;
      const cookie = input.replace(/^Cookie:\s*/i, "").trim();
      if (!cookie || !cookie.includes("=") || /[\r\n]/.test(cookie) || cookie.length > 8192) { void vscode.window.showWarningMessage("Cookie 格式无效，未保存。"); return; }
      await context.secrets.store(COOKIE_SECRET, cookie);
      tree.refresh();
      void vscode.window.showInformationMessage("豆瓣会话已保存在 VS Code 安全存储中，正在刷新小组。");
    }),
    vscode.commands.registerCommand("doubanReader.clearCookie", async () => {
      await context.secrets.delete(COOKIE_SECRET);
      tree.refresh();
      void vscode.window.showInformationMessage("已清除保存的豆瓣会话。");
    }),
    vscode.commands.registerCommand("doubanReader.openPost", async (post: DoubanSummary) => {
      const url = post && topicUrl(post.url, post.id);
      if (!url) { void vscode.window.showWarningMessage("请从豆瓣小组列表中选择帖子。"); return; }
      const name = (post.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "豆瓣帖子").slice(0, 80);
      const uri = vscode.Uri.from({ scheme: SCHEME, path: "/" + post.id + "/" + name + ".md", query: new URL(url).search.slice(1) });
      try {
        let document = await vscode.workspace.openTextDocument(uri);
        if (document.languageId !== "markdown") document = await vscode.languages.setTextDocumentLanguage(document, "markdown");
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) { void vscode.window.showErrorMessage("打开豆瓣帖子失败：" + errorMessage(error)); }
    }),
    vscode.commands.registerCommand("doubanReader.refreshPost", (arg?: unknown) => {
      const uri = activeUri(arg);
      if (uri) documents.refresh(uri); else void vscode.window.showInformationMessage("请先打开一篇豆瓣帖子。");
    }),
    vscode.commands.registerCommand("doubanReader.openInBrowser", async (arg?: unknown) => {
      const uri = activeUri(arg), address = uri && postAddress(uri);
      if (!address) { void vscode.window.showInformationMessage("请先打开一篇豆瓣帖子。"); return; }
      await vscode.env.openExternal(vscode.Uri.parse(address.url));
    })
  );
}
