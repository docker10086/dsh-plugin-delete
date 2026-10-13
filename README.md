# DSH Plugin Delete

为 DeepSeek Harness 的会话菜单增加“永久删除”。

## 功能

- 在会话 `...` 菜单中加入“永久删除”。
- 点击后必须确认，确认文本会显示会话标题。
- 删除前停止会话活动并归档，从而避免正在运行的会话再次写回文件。
- 删除会话正文、投影缓存，以及 `workspace.json` 中的会话登记。
- 删除成功后刷新页面；删除不可恢复。

## 安装

把此目录作为本地 DSH 插件包安装到当前 profile。插件目录中已经包含 DSH 所需的 `package.json`、`cordis.patch.yml`、Host 入口和 Web Client 入口。

如果使用 profile 的 `package.json` 管理 bundle，可加入：

```json
{
  "dependencies": {
    "dsh-plugin-delete": "link:C:/path/to/dsh-plugin-delete"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-plugin-delete"]
    }
  }
}
```

安装或启用后重启 DSH；如果 profile 开启了客户端 HMR，客户端改动会随 watcher 更新。

## 运行时约束

插件只接受本地 Web UI 发来的 `POST` 请求，要求会话 ID 和 `confirm: true`，并限制会话 ID 格式，避免把任意路径传给删除逻辑。Host 使用 `DSH_HOME` 定位会话存储；未设置时回退到用户目录下的 `.dsh`。
