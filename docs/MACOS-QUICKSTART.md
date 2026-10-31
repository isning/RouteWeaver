# RouteWeaver for Mac / Mac 版

This package contains a macOS control-plane executable and its browser-based UI.
It is not a native `.app`, VPN client, or system proxy. It does not change your
Mac's network settings. Node agents and managed Xray are not included: managed
runtime supervision is tested on Linux, not supported by this Mac package.

本包包含 Mac 控制台程序和浏览器界面，不是原生 `.app`，也不是 VPN 客户端。
不会修改 Mac 网络设置；不包含节点代理或 Linux 托管 Xray。

## Choose a package / 选择版本

- Apple Silicon (M-series): `routeweaver-darwin-arm64.tar.gz`.
- Intel Mac: `routeweaver-darwin-amd64.tar.gz`.

Both executables declare macOS 13.0 as their minimum deployment target.
This is build metadata, not validation on every macOS 13+ release.
两个版本的最低构建目标均为 macOS 13.0，尚未在真实 Mac 上运行验证。

Apple menu → About This Mac shows the chip/processor. These are cross-compiled
binaries, not executed on a Mac during this delivery. There is no Developer ID
signature or notarization. If macOS blocks launch, stop and retain the exact
warning for support; this guide does not disable or bypass Gatekeeper.

## Start / 启动

1. Extract the matching archive. Keep the complete extracted folder together.
2. Open Terminal, type `cd ` (including the space), drag the extracted folder
   into Terminal, and press Return.
3. Run:

       ./routeweaver-control-plane --demo

4. Open http://127.0.0.1:8080 in your browser. The terminal prints the demo login:
   username `routeweaver`, password `local-demo-password`.
5. Leave Terminal open while using the UI. Stop with Ctrl+C.

解压对应版本，在终端输入 `cd ` 后把解压文件夹拖入终端并回车。
执行上面的启动命令，再用浏览器打开 http://127.0.0.1:8080 。
演示账户和密码见上文。使用时保持终端开启，Ctrl+C 停止。

Demo data is synthetic, isolated and deleted on exit. Do not import real private
subscriptions or enroll real nodes in demo mode. If port 8080 is busy, run
`./routeweaver-control-plane --demo --listen 127.0.0.1:8081` and open port 8081.
No Go, Node.js or npm installation is needed to run the extracted application.

## Persistent use

For real data, supply your own 32-byte encryption key as 64 hexadecimal characters
in `ROUTEWEAVER_MASTER_KEY`, plus `ROUTEWEAVER_ADMIN_USERNAME` and
`ROUTEWEAVER_ADMIN_PASSWORD` on first bootstrap. Keep these secrets private and
outside the application folder. Then run:

    ./routeweaver-control-plane --db /your/private/path/routeweaver.db

Keep the key securely: it is needed to reopen encrypted state. On later starts,
retain the master key but remove the bootstrap password from the environment.
The default listener is loopback. Remote binding requires explicit TLS flags;
real node enrollment and deployment remain separate operator actions. This
package does not establish Mac managed-runtime support or production acceptance.

## Provenance

`BUILD-INFO.txt` identifies the exact source commit and Go build settings.
`licenses/` retains linked Go dependency and installed production-web dependency
notices; its inventory states collection limitations. Architecture/content checks
are not a substitute for runtime testing on the intended macOS version.
