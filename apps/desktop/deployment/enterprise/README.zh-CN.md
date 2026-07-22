# Hermes Enterprise Desktop 安装与配置

Desktop 只需要 Enterprise Gateway 地址，不保存企业微信 `CorpSecret`、应用 `access_token`、OAuth `code`、`CorpId` 或 `AgentId`。这些参数属于服务器侧认证端。企业分发配置默认启用 Desktop 托管的企业微信个人 Bot 运行时；无需再手工添加内部开关。

当前分发产物仅支持 Windows，企业会话使用 Windows `safeStorage`/DPAPI 加密保存。未来交付 Linux 前必须要求系统 keyring；Electron 退化到 `basic_text` 后企业会话会 fail closed，不会写入或读取 token。

> `https://tencentshow.iwinad.com:8898/wecom` 是企业微信认证端入口，不是 Desktop 的 `GatewayUrl`。请勿把它写入 Desktop 配置；Desktop 应填写用户设备可访问的 Enterprise Gateway HTTPS 根地址。

实际调用拓扑是 `Desktop → 本地/内网 Enterprise Gateway → 公网企业微信认证端 :8898`。Desktop 不直接访问认证端，认证端 URL、`CorpId`、`AgentId` 和 Secret 都由服务器侧组件配置。

## 安装版（推荐）

以管理员 PowerShell 运行：

```powershell
.\Configure-HermesEnterprise.ps1 -GatewayUrl "https://gateway.example.com" -Scope Machine
```

配置写入 `%ProgramData%\Hermes\enterprise-desktop.json`，同一台机器的所有用户生效。没有管理员权限时可使用 `-Scope User`，写入当前用户的 `%APPDATA%\Hermes\enterprise\enterprise-desktop.json`。

局域网内部联调尚未配置 HTTPS 时，可显式开启仅限私网 IP 的 HTTP 开关：

```powershell
.\Configure-HermesEnterprise.ps1 `
  -GatewayUrl "http://172.31.1.49:6500" `
  -Scope User `
  -AllowInsecureLanHttp
```

该开关只接受 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 或 IPv6 unique-local 地址字面量；域名和公网 IP 即使打开开关也会被拒绝。它只用于内部联调，生产发布仍须使用 HTTPS。

推荐安装顺序：

1. 运行 `Hermes-*-win-*.exe` 安装 Desktop。
2. 以管理员 PowerShell 运行上面的配置命令。
3. 启动或完全重启 Hermes；未登录用户会进入统一登录页。

## 便携版

```powershell
.\Configure-HermesEnterprise.ps1 -GatewayUrl "https://gateway.example.com" -Scope Portable -PortableDirectory .\win-unpacked
```

配置会写入 `Hermes.exe` 同目录。重新启动 Desktop 后，未登录用户会进入统一登录页并从 Gateway 获取账号密码、企业微信扫码等可用认证方式。

## 地址要求和优先级

- 生产 Gateway 必须使用 `https://`；localhost 可直接使用 `http://`，私网 IP HTTP 还必须在部署配置中显式设置 `allowInsecureLanHttp: true`。
- `GatewayUrl` 必须是纯 origin，例如 `https://gateway.example.com:8443`；不能带用户名、密码、查询参数、fragment 或 `/wecom` 等路径。
- `%ProgramData%` 机器配置 > 可执行文件同目录配置 > 当前用户配置。只要任意部署配置文件存在，就完全忽略用户环境变量；仅当三处配置都不存在时，才兼容开发环境变量。
- JSON 允许 `schemaVersion`、`enabled`、`gatewayUrl`、`allowInsecureLanHttp` 及当前个人 Bot 运行时兼容字段。出现任何企业微信凭据字段时 Desktop 会拒绝启动企业配置。

## 分发包校验

发布目录中的 `manifest.json` 记录构建版本、Git 状态、配置优先级和可运行产物；`SHA256SUMS.txt` 覆盖安装包、portable ZIP、部署脚本、模板和 manifest。交付或上传服务器前执行：

```powershell
Get-Content .\SHA256SUMS.txt
Get-FileHash .\Hermes-*-win-*.exe -Algorithm SHA256
```

哈希必须与清单一致。未配置代码签名证书时，产物是未签名内部测试构建，Windows 可能显示 SmartScreen 提示。

当前 dirty、未签名构建只允许内部试点。正式生产发布必须先由负责人授权提交，使工作树 clean，再使用企业代码签名证书重新构建和复验；不能直接把本目录的内部试点二进制改名为生产包。

## 企业更新边界

- 企业发行仓库唯一固定为 `https://github.com/Shell-bic/hermes-agent.git`；首次启动按安装包内的精确提交号安装 Runtime。
- 企业托管模式不提供 Desktop、Dashboard 或 `hermes update` 本地升级；客户端不会拉取或合并原版 Hermes 的 `main`。
- 安装/修复现有 Runtime 时会把 `origin` 纠正为企业发行仓库，并移除历史 `upstream` remote。
- 升级方式是部署新的企业安装包。新包再次按其构建提交执行可重复的 Runtime 安装或修复。
