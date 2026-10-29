const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGroupPage, parseTopicPage, renderDoubanPost, topicUrl, DoubanService, DoubanAccessError } = require("../out/douban.js");

const groupPage = `
<table class="olt"><tr><th>讨论</th></tr>
<tr><td class="title"><a href="https://www.douban.com/group/topic/123/?_spm_id=YWJj" title="帖子标题">帖子</a></td><td><a>作者</a></td><td class="r-count">42</td><td class="time">今天</td></tr>
<tr><td class="title"><a href="https://www.douban.com/group/topic/123/">重复</a></td><td>作者</td><td class="r-count">1</td><td class="time"></td></tr>
<tr><td class="title"><a href="https://example.com/group/topic/456/">恶意链接</a></td></tr></table>
<div class="paginator"><span class="next"><a href="/group/748338/discussion?start=25&amp;type=new">后页</a></span></div>`;
const topicPage = `
<h1>主题标题</h1><div class="topic-doc"><h3><span class="from"><a>楼主</a></span><span class="create-time">今天</span></h3>
<div id="link-report"><div class="topic-richtext"><p>正文</p><img src="https://img9.doubanio.com/a.jpg"></div></div></div>
<ul class="topic-reply"><li class="reply-item" id="c1"><div class="reply-doc"><h4><a>读者</a><span class="pubtime">刚刚</span></h4>
<div class="reply-content"><div class="markdown"><p>回复内容</p></div></div></div></li></ul>`;

test("解析小组帖子和安全的分页链接", () => {
  const parsed = parseGroupPage(groupPage, 0);
  assert.equal(parsed.posts.length, 1);
  assert.equal(parsed.posts[0].id, "123");
  assert.equal(parsed.posts[0].author, "作者");
  assert.match(parsed.posts[0].url, /_spm_id=YWJj/);
  assert.equal(parsed.nextStart, 25);
  assert.equal(topicUrl("https://example.com/group/topic/123/"), undefined);
  assert.equal(topicUrl("https://www.douban.com/group/topic/456/", "123"), undefined);
  assert.throws(() => parseGroupPage("<html>需要登录</html>", 0), /没有返回公开/);
});

test("解析帖子及评论，图片仅以链接显示", () => {
  const post = parseTopicPage(topicPage, "123");
  assert.equal(post.author, "楼主");
  assert.equal(post.comments.length, 1);
  assert.equal(post.comments[0].author, "读者");
  assert.match(post.content, /查看图片 1/);
  assert.doesNotMatch(post.content, /!\[/);
  assert.match(renderDoubanPost(post, "https://www.douban.com/group/topic/123/"), /## 评论/);
  assert.throws(() => parseTopicPage("<h1>提示</h1>", "123"), /没有返回可阅读/);
});

test("保留帖子链接参数，缓存结果并提示访问受限", async () => {
  const calls = [];
  const service = new DoubanService(() => 5, async url => { calls.push(String(url)); return new Response(topicPage, { status: 200 }); });
  const url = "https://www.douban.com/group/topic/123/?_spm_id=YWJj";
  await service.getPost("123", url);
  await service.getPost("123", url);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /_spm_id=YWJj/);
  await assert.rejects(service.getPost("123", "https://example.com/group/topic/123/"), /无效/);
  const blocked = new DoubanService(() => 0, async () => new Response("", { status: 403 }));
  await assert.rejects(blocked.getGroupPage(), /HTTP 403/);
});

test("识别豆瓣安全验证，禁止把会话发送到跨站跳转", async () => {
  const calls = [];
  const service = new DoubanService(() => 0, async (url, options) => {
    calls.push({ url: String(url), cookie: options.headers.Cookie, redirect: options.redirect });
    return new Response(null, { status: 302, headers: { location: "https://sec.douban.com/c?challenge=1" } });
  }, async () => "bid=local-test; dbcl2=local-test");
  await assert.rejects(service.getGroupPage(), error => error instanceof DoubanAccessError && error.reason === "verification");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/www\.douban\.com\//);
  assert.equal(calls[0].cookie, "bid=local-test; dbcl2=local-test");
  assert.equal(calls[0].redirect, "manual");
  const htmlChallenge = new DoubanService(() => 0, async () => new Response("<title>豆瓣</title><p>请点击下方按钮继续浏览或登录使用豆瓣</p>"));
  await assert.rejects(htmlChallenge.getGroupPage(), error => error instanceof DoubanAccessError && error.reason === "verification");
});
