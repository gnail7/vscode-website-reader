const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("扩展命令把侧边栏帖子打开为只读虚拟 Markdown", async () => {
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  const commands = new Map();
  let tree, provider, activeEditor;
  class Uri {
    constructor(scheme, path) { this.scheme = scheme; this.path = path; }
    static from(value) { return new Uri(value.scheme, value.path); }
    static parse(value) { return new Uri("https", value); }
  }
  class EventEmitter {
    constructor() { this.event = () => {}; }
    fire() {}
    dispose() {}
  }
  class TreeItem { constructor(label) { this.label = label; } }
  const api = {
    Uri, EventEmitter, TreeItem, TreeItemCollapsibleState: { None: 0 },
    ThemeIcon: class { constructor(name) { this.name = name; } },
    window: {
      registerTreeDataProvider(_id, value) { tree = value; return { dispose() {} }; },
      async showTextDocument(document) { activeEditor = { document }; return activeEditor; },
      get activeTextEditor() { return activeEditor; },
      showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {}
    },
    workspace: {
      getConfiguration() { return { get: (_key, fallback) => fallback }; },
      registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
      async openTextDocument(uri) { return { uri, languageId: "markdown", content: await provider.provideTextDocumentContent(uri) }; }
    },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
    languages: { async setTextDocumentLanguage(doc, language) { doc.languageId = language; return doc; } },
    env: { async openExternal() {} }
  };
  const page = props => '<script id="__NEXT_DATA__">' + JSON.stringify({ props: { pageProps: props } }) + "</script>";
  global.fetch = async url => new Response(String(url).includes("topicThreads?") ?
    JSON.stringify({ code: 200, data: { nextCursor: "", topicThreads: [{ tid: 123, title: "重复" }, { tid: 456, title: "下一页", username: "另一作者" }] } }) :
    String(url).includes("/zone/85") ?
    page({ zoneData: { topicId: 85 }, postList: { nextCursor: "cursor1", topicThreads: [{ tid: 123, title: "侧边栏测试", username: "作者", replies: 1 }] } }) :
    page({ threadData: { data: { moduleConfigList: { title: { moduleContent: { title: "侧边栏测试" } }, content: { moduleContent: { content: "<p>正文</p>" } } } } }, initialRepliesData: { initialReplies: [{ pid: "1", user: { username: "读者" }, content: "<p>回复</p>" }] } }),
    { status: 200 });
  Module._load = function (request, parent, isMain) { return request === "vscode" ? api : originalLoad.call(this, request, parent, isMain); };
  try {
    const extension = require("../out/extension.js");
    extension.activate({ subscriptions: [] });
    const items = await tree.getChildren();
    assert.equal(items.length, 2);
    await commands.get(items[0].command.command)(...items[0].command.arguments);
    assert.equal(activeEditor.document.uri.scheme, "hupu-reader");
    assert.equal(activeEditor.document.languageId, "markdown");
    assert.match(activeEditor.document.content, /正文/);
    assert.match(activeEditor.document.content, /## 评论/);
    assert.match(activeEditor.document.content, /回复/);
    commands.get("hupuReader.refreshPost")();
    await commands.get("hupuReader.loadMore")();
    const extended = await tree.getChildren();
    assert.deepEqual(extended.map(item => item.label), ["侧边栏测试", "下一页"]);
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
});
