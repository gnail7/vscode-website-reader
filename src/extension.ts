import * as vscode from "vscode";
import { HupuService, renderPost } from "./hupu";
import { PostSummary } from "./types";
import { registerDouban } from "./doubanExtension";
import { registerWeibo } from "./weibo";

const SCHEME = "hupu-reader";
function idFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== SCHEME) return undefined;
  const id = uri.path.split("/").filter(Boolean)[0];
  return id && /^\d+$/.test(id) ? id : undefined;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HotTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private forceNext = false;
  private posts?: PostSummary[];
  private nextCursor = "";
  private page = 1;
  private generation = 0;
  private loadingMore = false;
  constructor(private readonly service: HupuService) {}
  refresh(): void { this.generation++; this.forceNext = true; this.changed.fire(undefined); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      if (!this.posts || this.forceNext) {
        const generation = this.generation, force = this.forceNext;
        const first = await this.service.getZoneFirst(force);
        if (generation !== this.generation) return [];
        this.posts = first.posts;
        this.nextCursor = first.nextCursor;
        this.page = 1;
        this.forceNext = false;
      }
      const items = this.posts.map(post => {
        const item = new vscode.TreeItem(post.title, vscode.TreeItemCollapsibleState.None);
        item.id = post.id;
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.description = post.replyCount ? String(post.replyCount) + " 回复" : undefined;
        item.tooltip = post.title + "\n" + post.author + (post.time ? " · " + post.time : "") + "\n" + post.replyCount + " 条回复";
        item.command = { command: "hupuReader.openPost", title: "打开帖子", arguments: [post] };
        return item;
      });
      if (this.nextCursor) {
        const more = new vscode.TreeItem(this.loadingMore ? "正在加载更多…" : "加载更多帖子", vscode.TreeItemCollapsibleState.None);
        more.id = "hupu-reader-load-more";
        more.iconPath = new vscode.ThemeIcon(this.loadingMore ? "loading~spin" : "add");
        more.description = "已加载 " + this.posts.length + " 条";
        if (!this.loadingMore) more.command = { command: "hupuReader.loadMore", title: "加载更多帖子" };
        items.push(more);
      }
      return items;
    } catch (error) {
      const item = new vscode.TreeItem("加载失败，点击重试", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("warning");
      item.tooltip = message(error);
      item.command = { command: "hupuReader.refresh", title: "刷新专区帖子" };
      return [item];
    }
  }
  async loadMore(): Promise<void> {
    if (this.loadingMore) return;
    if (!this.posts) await this.getChildren();
    if (!this.posts || !this.nextCursor) {
      void vscode.window.showInformationMessage("暂时没有更多帖子。");
      return;
    }
    const generation = this.generation, cursor = this.nextCursor, page = this.page + 1;
    this.loadingMore = true;
    this.changed.fire(undefined);
    try {
      const result = await this.service.getZoneNext(cursor, page);
      if (generation !== this.generation) return;
      const seen = new Set(this.posts.map(post => post.id));
      const next = result.posts.filter(post => !seen.has(post.id));
      this.posts = [...this.posts, ...next];
      this.nextCursor = result.nextCursor;
      this.page = page;
      if (!next.length) void vscode.window.showInformationMessage(this.nextCursor ? "这一页没有新帖子，可以继续加载下一页。" : "暂时没有更多帖子。");
    } catch (error) {
      if (generation === this.generation) void vscode.window.showErrorMessage("加载更多帖子失败：" + message(error));
    } finally {
      this.loadingMore = false;
      this.changed.fire(undefined);
    }
  }
  dispose(): void { this.changed.dispose(); }
}

class PostDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly service: HupuService) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = idFromUri(uri);
    if (!id) return "# 无效的帖子地址\n";
    try {
      return renderPost(await this.service.getPost(id));
    } catch (error) {
      return "# 帖子加载失败\n\n" + message(error) + "\n\n请使用编辑器右上角的刷新按钮重试，或在浏览器中打开：\n\nhttps://m.hupu.com/bbs/" + id + ".html\n";
    }
  }
  refresh(uri: vscode.Uri): void {
    const id = idFromUri(uri);
    if (!id) return;
    this.service.clearPost(id);
    this.changed.fire(uri);
  }
  dispose(): void { this.changed.dispose(); }
}

function activePostUri(arg?: unknown): vscode.Uri | undefined {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  return uri && idFromUri(uri) ? uri : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const service = new HupuService(() => vscode.workspace.getConfiguration("hupuReader").get<number>("cacheMinutes", 5));
  const tree = new HotTree(service);
  const documents = new PostDocuments(service);
  registerWeibo(context);
  registerDouban(context, () => vscode.workspace.getConfiguration("hupuReader").get<number>("cacheMinutes", 5));
  context.subscriptions.push(
    tree,
    documents,
    vscode.window.registerTreeDataProvider("hupuReader.hot", tree),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.commands.registerCommand("hupuReader.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("hupuReader.loadMore", () => tree.loadMore()),
    vscode.commands.registerCommand("hupuReader.openPost", async (post: PostSummary) => {
      if (!post || !/^\d+$/.test(post.id)) {
        void vscode.window.showWarningMessage("请从虎扑英雄联盟专区列表中选择帖子。");
        return;
      }
      const name = (post.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim() || "虎扑帖子").slice(0, 80);
      const uri = vscode.Uri.from({ scheme: SCHEME, path: "/" + post.id + "/" + name + ".md" });
      try {
        let document = await vscode.workspace.openTextDocument(uri);
        if (document.languageId !== "markdown") document = await vscode.languages.setTextDocumentLanguage(document, "markdown");
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        void vscode.window.showErrorMessage("打开帖子失败：" + message(error));
      }
    }),
    vscode.commands.registerCommand("hupuReader.refreshPost", (arg?: unknown) => {
      const uri = activePostUri(arg);
      if (uri) documents.refresh(uri);
      else void vscode.window.showInformationMessage("请先打开一篇虎扑帖子。");
    }),
    vscode.commands.registerCommand("hupuReader.openInBrowser", async (arg?: unknown) => {
      const uri = activePostUri(arg);
      const id = uri && idFromUri(uri);
      if (!id) { void vscode.window.showInformationMessage("请先打开一篇虎扑帖子。"); return; }
      await vscode.env.openExternal(vscode.Uri.parse("https://m.hupu.com/bbs/" + id + ".html"));
    })
  );
}

export function deactivate(): void {}
