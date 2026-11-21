# 共享内存 Ring 的部署条件

Aevia 的共享 Ring 位于同一个网页的主线程和 Worker 之间。前端与 API 使用不同域名不妨碍它工作，但网页必须处于跨源隔离状态。隔离不可用时，应用自动改用 transferable ArrayBuffer；Ring 写满时单批也会回退，不会因此停止绘制。

以 Nginx 托管前端为例，将仓库的 `deploy/nginx/aevia-isolation.conf` 放到服务器配置目录，然后在前端站点的 `server` 配置中引入：

```nginx
include /etc/nginx/snippets/aevia-isolation.conf;
```

路径应替换为服务器上的实际位置。先通过 `nginx -t` 检查配置，再按服务器现有流程重新加载 Nginx。此配置只随项目提供，不会自动修改线上服务。

这些响应头需要由实际返回网页和 Worker 的服务提供。Nginx 的子 `location` 如果另行配置了 `add_header`，可能不再继承上级响应头，需要一并检查。API 的跨域响应仍需允许前端来源及实际使用的方法、请求头；不能仅通过增加上述网页响应头来替代 API 的 CORS 配置。WebSocket 的来源校验也应保持现有配置。

启用前先在隔离测试环境核对：

1. 页面和 Worker 脚本正常加载，浏览器控制台 `crossOriginIsolated` 为 `true`。
2. API 请求、WebSocket、字体、图片及其他跨源资源正常；相关资源需满足同源、CORS 或 CORP 要求。
3. 登录或第三方窗口等依赖跨窗口通信的流程正常，因为 COOP 会改变窗口隔离行为。
4. 同时验证关闭隔离时可以正常进入房间和绘制，确认 transferable 回退可用。

实际线上页面此前未返回上述隔离响应头；仓库改动不会自动改变现有代理配置。共享区直接编码、解码取决于浏览器能力和环内剩余空间，其他情况会回退到复制或 transferable；JSON 序列化、字符串以及浏览器内部实现仍可能分配或复制，不能保证端到端零拷贝。
