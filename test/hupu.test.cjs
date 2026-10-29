const test = require("node:test");
const assert = require("node:assert/strict");
const { parseZonePage, parseZoneNext, parsePostPage, htmlToMarkdown, renderPost, HupuService } = require("../out/hupu.js");

const page = props => '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: props } }) + "</script>";
const hotHtml = page({ zoneData: { topicId: 85 }, postList: { topicThreads: [
  { tid: 123, title: "真实标题", username: "作者", replies: 12, time: "今天" },
  { tid: 123, title: "重复" }, { tid: "bad", title: "无效" }
] } });
const postHtml = page({ threadData: { data: { moduleConfigList: {
  title: { moduleContent: { title: "测试帖子" } },
  user: { moduleContent: { name: "楼主", time: "今天" } },
  content: { moduleContent: { content: '<p>正文 &amp; 内容</p><center class="hupu-img" data-origin="https://i.hoopchina.com.cn/a.png"></center>' } }
} } }, initialRepliesData: {
  lightReplies: [{ pid: "1", user: { username: "用户甲" }, content: "<p>评论内容</p>", light: "3", createDt: "刚刚" }],
  initialReplies: [{ pid: "1", user: { username: "用户甲" }, content: "<p>评论内容</p>" }, { pid: "2", isDelete: true, content: "deleted" }],
  initialHasMore: true
} });

test("解析英雄联盟专区并去重，拒绝无效编号", () => {
  const posts = parseZonePage(hotHtml);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { id: "123", title: "真实标题", author: "作者", replyCount: 12, time: "今天" });
  assert.throws(() => parseZonePage("<html>验证页面</html>"), /没有返回帖子数据/);
  assert.throws(() => parseZonePage(page({ zoneData: { topicId: 1 }, postList: { topicThreads: [] } })), /不是英雄联盟专区/);
});

test("正文、图片链接、评论去重和只显示首批的说明", () => {
  const post = parsePostPage(postHtml, "123");
  assert.match(post.content, /正文 & 内容/);
  assert.match(post.content, /\[查看图片 1\]\(https:\/\/i\.hoopchina\.com\.cn\/a\.png\)/);
  assert.doesNotMatch(post.content, /!\[/);
  assert.equal(post.comments.length, 1);
  assert.equal(post.comments[0].author, "用户甲");
  assert.match(renderPost(post), /仅显示页面返回的首批公开评论/);
  assert.match(htmlToMarkdown('{"type":"iframe-match","url":"https://example.com"}'), /嵌入内容/);
  assert.doesNotMatch(htmlToMarkdown('<img src="javascript:alert(1)">'), /javascript/);
});

test("读取分页结果并阻止游标重复", async () => {
  const calls = [];
  const response = JSON.stringify({ code: 200, data: { topicThreads: [{ tid: 9, title: "下一页" }], nextCursor: "same" } });
  assert.equal(parseZoneNext(response).posts[0].id, "9");
  const service = new HupuService(() => 5, async url => { calls.push(String(url)); return new Response(response, { status: 200 }); });
  const result = await service.getZoneNext("same", 2);
  assert.equal(result.nextCursor, "");
  assert.match(calls[0], /topicId=85&page=2&cursor=same/);
  await assert.rejects(service.getZoneNext("", 2), /分页参数无效/);
  assert.throws(() => parseZoneNext('{"code":403,"msg":"blocked"}'), /分页请求失败/);
});

test("按配置缓存，刷新时重新获取，并提示 HTTP 错误", async () => {
  let calls = 0;
  const service = new HupuService(() => 5, async () => {
    calls++;
    return new Response(hotHtml, { status: 200 });
  });
  await service.getZonePosts();
  await service.getZonePosts();
  assert.equal(calls, 1);
  await service.getZonePosts(true);
  assert.equal(calls, 2);
  await assert.rejects(service.getPost("../bad"), /无效/);
  const failing = new HupuService(() => 0, async () => new Response("", { status: 403 }));
  await assert.rejects(failing.getZonePosts(), /HTTP 403/);
});
