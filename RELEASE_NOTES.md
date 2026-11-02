Jellyfin VR Player 首个服务端插件版本。

- 在 Jellyfin Web 播放器菜单栏显示 VR 入口。
- 支持 180°、360°、鱼眼、影院、单眼、SBS 和 OU。
- 保留手柄交互、进度跳转、缩放及 H.264 兼容源功能。
- 自动注入前端脚本，无需安装 JS Injector 或 File Transformation。
- 内置 Three.js 0.160.1，所有播放器脚本均由 Jellyfin 本地提供。
- 分别提供 Jellyfin 10.11（.NET 9）与 Jellyfin 12（.NET 10）安装包。

在 Jellyfin 控制台 → 插件 → 仓库中添加：

https://raw.githubusercontent.com/biliksir95-blip/jellyfin-vr-player/main/manifest.json

从插件目录安装 Jellyfin VR Player，重启服务器，再刷新 Jellyfin 网页。
升级自手工脚本或 JS Injector 时，先删除原来的 VR 脚本条目。
WebXR 需要 HTTPS（或 localhost）及支持 WebXR 的浏览器。
