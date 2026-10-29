const assert = require("node:assert/strict");
const vscode = require("vscode");
const { HupuService } = require("../out/hupu.js");
const { DoubanService } = require("../out/douban.js");

exports.run = async function () {
  const extension = vscode.extensions.getExtension("local.hupu-reader");
  assert.ok(extension, "extension is discoverable");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("hupuReader.openPost"), "open command registered");
  assert.ok(commands.includes("hupuReader.refresh"), "refresh command registered");
  const posts = await new HupuService(() => 0).getZonePosts();
  await vscode.commands.executeCommand("hupuReader.openPost", posts[0]);
  const editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.uri.scheme, "hupu-reader");
  assert.equal(editor.document.languageId, "markdown");
  assert.match(editor.document.getText(), /## 评论/);
  assert.match(editor.document.getText(), /原帖：https:\/\/m\.hupu\.com\/bbs\/\d+\.html/);
  await vscode.commands.executeCommand("hupuReader.refreshPost");
  const doubanPosts = (await new DoubanService(() => 0).getGroupPage()).posts;
  await vscode.commands.executeCommand("doubanReader.openPost", doubanPosts[0]);
  const doubanEditor = vscode.window.activeTextEditor;
  assert.equal(doubanEditor.document.uri.scheme, "douban-reader");
  assert.equal(doubanEditor.document.languageId, "markdown");
  assert.match(doubanEditor.document.getText(), /## 评论/);
  require("node:fs").writeFileSync(require("node:path").join(__dirname, "../.vscode-test/host-success.json"), JSON.stringify({ id: posts[0].id, language: editor.document.languageId }));
  console.log("Extension host: activation, live post, virtual Markdown, and refresh command passed.");
};
