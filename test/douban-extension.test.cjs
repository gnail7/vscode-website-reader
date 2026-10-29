const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

test("豆瓣和虎扑视图独立注册，豆瓣帖子保留链接参数并打开虚拟文档", async () => {
  const originalLoad = Module._load, originalFetch = global.fetch;
  const commands = new Map(), views = new Map(), providers = new Map(), requests = [], secrets = new Map();
  let challenged = false, sentCookie;
  let activeEditor;
  class Uri {
    constructor(scheme, path, query = "") { this.scheme = scheme; this.path = path; this.query = query; }
    static from(value) { return new Uri(value.scheme, value.path, value.query); }
    static parse(value) { return new Uri("https", value); }
  }
  class EventEmitter { constructor() { this.event = () => {}; } fire() {} dispose() {} }
  class TreeItem { constructor(label) { this.label = label; } }
  const api = {
    Uri, EventEmitter, TreeItem, TreeItemCollapsibleState: { None: 0 },
    ThemeIcon: class { constructor(name) { this.name = name; } },
    window: {
      registerTreeDataProvider(id, value) { views.set(id, value); return { dispose() {} }; },
      async showTextDocument(document) { activeEditor = { document }; return activeEditor; },
      get activeTextEditor() { return activeEditor; },
      async showInputBox(options) { assert.equal(options.password, true); return "bid=local-test"; },
      showWarningMessage() {}, showInformationMessage() {}, showErrorMessage() {}
    },
    workspace: {
      getConfiguration() { return { get: (_key, fallback) => fallback }; },
      registerTextDocumentContentProvider(scheme, value) { providers.set(scheme, value); return { dispose() {} }; },
      async openTextDocument(uri) { return { uri, languageId: "markdown", content: await providers.get(uri.scheme).provideTextDocumentContent(uri) }; }
    },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
    languages: { async setTextDocumentLanguage(doc, language) { doc.languageId = language; return doc; } },
    env: { async openExternal() {} }
  };
  const group = '<table class="olt"><tr><td class="title"><a href="https://www.douban.com/group/topic/123/?_spm_id=YWJj">豆瓣帖子</a></td><td>作者</td><td class="r-count">1</td><td class="time">今天</td></tr></table><div class="paginator"><span class="next"><a href="/group/748338/discussion?start=25">下一页</a></span></div>';
  const more = '<table class="olt"><tr><td class="title"><a href="https://www.douban.com/group/topic/456/">下一页</a></td><td>作者</td><td class="r-count">0</td><td class="time"></td></tr></table>';
  const topic = '<h1>豆瓣帖子</h1><div class="topic-doc"><h3><span class="from"><a>作者</a></span></h3><div id="link-report"><div class="topic-richtext"><p>豆瓣正文</p></div></div></div><ul class="topic-reply"><li class="reply-item"><div class="reply-doc"><h4><a>读者</a></h4><div class="reply-content"><div class="markdown"><p>豆瓣回复</p></div></div></div></li></ul>';
  global.fetch = async (url, options) => {
    const u = String(url); requests.push(u);
    if (u.includes("/discussion")) sentCookie = options.headers.Cookie;
    if (challenged && !sentCookie) return new Response(null, { status: 302, headers: { location: "https://sec.douban.com/challenge" } });
    return new Response(u.includes("/group/topic/") ? topic : u.includes("start=25") ? more : group, { status: 200 });
  };
  Module._load = function(request, parent, isMain) { return request === "vscode" ? api : originalLoad.call(this, request, parent, isMain); };
  try {
    require("../out/extension.js").activate({ subscriptions: [], secrets: {
      async get(key) { return secrets.get(key); },
      async store(key, value) { secrets.set(key, value); },
      async delete(key) { secrets.delete(key); }
    } });
    assert.ok(views.has("hupuReader.hot"));
    assert.ok(views.has("doubanReader.group"));
    const tree = views.get("doubanReader.group");
    const items = await tree.getChildren();
    assert.equal(items.length, 2);
    await commands.get(items[0].command.command)(...items[0].command.arguments);
    assert.equal(activeEditor.document.uri.scheme, "douban-reader");
    assert.equal(activeEditor.document.languageId, "markdown");
    assert.match(activeEditor.document.content, /豆瓣正文/);
    assert.match(activeEditor.document.content, /豆瓣回复/);
    assert.ok(requests.some(url => url.includes("topic/123/") && url.includes("_spm_id=YWJj")));
    await commands.get("doubanReader.loadMore")();
    assert.deepEqual((await tree.getChildren()).map(item => item.label), ["豆瓣帖子", "下一页"]);
    challenged = true;
    commands.get("doubanReader.refresh")();
    const blocked = await tree.getChildren();
    assert.match(blocked[0].label, /豆瓣需要验证或登录/);
    assert.equal(blocked[1].command.command, "doubanReader.setCookie");
    await commands.get("doubanReader.setCookie")();
    assert.equal(secrets.get("doubanReader.sessionCookie"), "bid=local-test");
    assert.equal((await tree.getChildren())[0].label, "豆瓣帖子");
    assert.equal(sentCookie, "bid=local-test");
    await commands.get("doubanReader.clearCookie")();
    assert.equal(secrets.size, 0);
  } finally { Module._load = originalLoad; global.fetch = originalFetch; }
});
