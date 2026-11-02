# Jellyfin VR Player

为 Jellyfin Web 添加 WebXR VR 播放器。支持 180°、360°、鱼眼、影院、SBS / OU 立体格式，以及手柄控制、进度跳转和缩放。

支持 Jellyfin 10.11.x 与 12.x，分别提供对应 .NET 运行时的安装包。进入头盔 VR 需要 HTTPS（或 localhost）及支持 WebXR 的浏览器。本项目扩展 Jellyfin Web；原生电视等不使用 Jellyfin Web 的客户端不会增加 VR 入口。

## 从插件仓库安装

1. 以管理员登录 Jellyfin，打开 **控制台 → 插件 → 仓库**。
2. 添加名为 **Jellyfin VR Player** 的仓库，地址为：

   ```text
   https://raw.githubusercontent.com/biliksir95-blip/jellyfin-vr-player/main/manifest.json
   ```

3. 回到插件目录，安装 **Jellyfin VR Player**。Jellyfin 会选择与服务器 ABI 相符的安装包。
4. 重启 Jellyfin 服务器，并刷新浏览器页面。
5. 开始播放视频，点击菜单栏中全屏按钮旁的 **VR**。

无需另外安装 JS Injector 或 File Transformation。插件使用请求时注入，不修改磁盘上的 Jellyfin Web 文件。Three.js 也由服务器本地提供。

若此前通过 JS Injector、用户脚本或手工修改网页安装过本项目，请先移除旧的 VR 脚本条目，再刷新网页，避免旧代码先运行。

## 使用

- 选择视频的投影及立体格式，默认是 180° / SBS。
- 支持 WebXR 的浏览器中点击 **进入 VR**。
- 普通屏幕可通过鼠标或触摸拖动视角；底部控制条提供进度和缩放。
- VR 中短按扳机或握柄打开控制面板；按住扳机拖动画面，长按握柄复位。
- 原始源无法作为 WebGL 视频纹理使用时，可以尝试 **H264 兼容源**；此功能需要服务器能够执行对应转码。
- 在 **控制台 → 插件 → Jellyfin VR Player** 中可以关闭 VR 功能；保存后刷新网页生效。

单独托管的 Jellyfin Web、反向代理直接从磁盘提供的网页，以及原生客户端，不会经过服务器注入中间件。此类部署可使用 [原始脚本](Jellyfin_VR_Player.js) 或 [JS Injector 导入文件](Jellyfin_VR_Player.import.json)。

## 本地构建与验证

需要 .NET SDK 10、PowerShell 7；检查前端语法还需要 Node.js。

```powershell
node --check Jellyfin_VR_Player.js
./scripts/build.ps1
```

脚本会依次运行两组 HTTP 验证、构建并输出以下文件：

| 文件 | 用途 |
| --- | --- |
| `dist/Jellyfin.Plugin.VrPlayer_1.0.0.0_jellyfin10.11.zip` | Jellyfin 10.11.x 安装包 |
| `dist/Jellyfin.Plugin.VrPlayer_1.0.0.0_jellyfin12.zip` | Jellyfin 12.x 安装包 |
| `dist/manifest.json` | 插件仓库清单及 ZIP 的 MD5 校验 |
| `dist/Jellyfin_VR_Player.import.json` | 从当前脚本生成的 JS Injector 导入文件 |

使用本项目目录内的 SDK 时：

```powershell
./scripts/build.ps1 -DotnetExe ./.tools/dotnet/dotnet.exe
```

单独验证某个服务端版本：

```powershell
dotnet run --project tests/Jellyfin.Plugin.VrPlayer.SmokeTests -c Release -p:JellyfinTarget=jf10
dotnet run --project tests/Jellyfin.Plugin.VrPlayer.SmokeTests -c Release -p:JellyfinTarget=jf12
```

验证使用本机 Kestrel HTTP 服务器，覆盖静态网页注入、UTF-8、压缩、缓存、HEAD、子路径部署、资源字节一致性、配置关闭和异常恢复。头盔交互仍需要实际设备验证。

## 发布更新

修改根目录 `Jellyfin_VR_Player.js`，增加 `plugin.json` 中的四段版本号，并更新其中的 `changelog` 和 `RELEASE_NOTES.md`，然后推送到 `main`。

**Publish plugin repository** 工作流会运行两组验证、生成对应 ZIP、创建带版本标签的 GitHub Release，最后更新根目录 `manifest.json`。同一版本的 Release 不会被覆盖。用户的仓库地址保持不变。

工作流使用 GitHub 自带的 `GITHUB_TOKEN`，无需配置个人访问令牌。仓库需要允许 Actions 写入内容。也可在 Actions 中手动运行该工作流，发布尚未发布的版本。

## 实现与参考

`PluginServiceRegistrator` 注册 ASP.NET Core `IStartupFilter`。中间件仅为 Jellyfin Web 的入口 HTML 增加加载器，并提供两个嵌入式 JavaScript 资源，不拦截视频流或修改服务端 API。

网页响应通过独立的 `IHttpResponseBodyFeature` 缓冲，兼容静态文件、`BodyWriter` 与显式响应启动。HTML 的旧缓存校验和 Range 请求会被归一化；脚本使用内容哈希更新缓存地址。注入不需要写入网页目录。

- [Jellyfin 官方插件模板](https://github.com/jellyfin/jellyfin-plugin-template)
- [Jellyfin 插件仓库清单说明](https://jellyfin.org/posts/plugin-updates/)
- [ASP.NET Core 启动筛选器](https://learn.microsoft.com/aspnet/core/fundamentals/startup)

## 许可证

GPL-3.0-or-later。Three.js 的 MIT 许可证一并保留，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
