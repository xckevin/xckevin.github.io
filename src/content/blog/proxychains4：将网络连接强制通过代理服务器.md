---
title: proxychains4：将网络连接强制通过代理服务器
excerpt: ProxyChains4 在 Linux 中强制任何应用的网络连接通过代理或代理链，适用于匿名、绕过防火墙与渗透测试，涵盖安装、配置、用法与排错。
publishDate: 2026-03-17
tags:
  - Linux
  - ProxyChains
  - 网络代理
seo:
  title: proxychains4：将网络连接强制通过代理服务器
  description: 完整指南：在 Linux 使用 ProxyChains4 强制经由代理/代理链出网，包含配置、模式选择、示例与故障排查。
---



最近用 ts 开发一些脚本，使用 bun 触发调用。本身还需要增加代理能力，但 bun 目前还不支持 socks5 代理，于是调研了相关工具，最后选择了 ProxyChains4 。

> 总结：ProxyChains4 可以把任意用户态程序（如 curl、nmap、wget）的网络连接强制经由某个代理或由多个代理组成的“代理链”。它常用于保持匿名、绕过防火墙和进行渗透测试。本文按原文结构完整介绍了 ProxyChains4 的工作原理（基于 LD_PRELOAD 劫持 connect/getaddrinfo 等调用）、链类型（dynamic/strict/random）、配置文件关键项（/etc/proxychains4.conf 与 proxy_dns）、基本与高级用法以及常见问题排查步骤。读者可据此快速完成环境配置、验证代理路径并定位连接问题。

## 简介

ProxyChains4 是 Linux 中的一款强大工具，可以强制任何应用程序（例如 `curl`、`nmap`、`wget`）的网络连接通过某个代理，或通过一条由多个代理组成的“代理链”。它可用于保持匿名、绕过防火墙，并通过间接路由开展渗透测试。

## 1. 什么是 ProxyChains4

ProxyChains4 是 ProxyChains 的更新版本，是一个 UNIX 程序，用于把 TCP 连接重定向到以下类型的代理：
- HTTP/HTTPS/SOCKS4/SOCKS5 代理
- TOR 网络
- 自定义的代理列表

它支持：
- 动态链（dynamic chaining）：按需跳过不可用代理，保持连接成功率
- 严格链（strict chaining）：按定义顺序依次经过每个代理
- 随机链（random chaining）：随机选择或排列代理
- 代理认证
- DNS 代理（可防止 DNS 泄露）

## 2. ProxyChains4 的工作方式

ProxyChains4 会劫持应用程序的网络调用，并将其路由到预定义的代理链。它通过 Linux 动态链接器特性 `LD_PRELOAD` 来拦截以下调用：
- `connect()`
- `getaddrinfo()`
- `gethostbyname()`

### 代理链类型

- 动态链（`dynamic_chain`）：从列表中选择可用代理，必要时跳过无效代理，适合在意连通性的场景。
- 严格链（`strict_chain`）：严格按顺序使用代理，链上任意一环不可用就失败，便于调试。
- 随机链（`random_chain`）：随机挑选或打乱代理顺序，增强不可预测性（与动态链类似但更随机）。

## 3. 安装

ProxyChains4 在 Linux 中通常已预装。若缺失，可执行：
```bash
sudo apt update && sudo apt install proxychains4
```

验证安装：
```bash
proxychains4 -h
```

## 4. 配置

主配置文件位于 `/etc/proxychains4.conf`。关键配置示例：
```bash
# Proxy types: http, socks4, socks5
[ProxyList]
socks5  127.0.0.1 9050    # TOR (default)
http    192.168.1.1 8080 user pass   # HTTP with auth

# Chain type (uncomment one)
# dynamic_chain
strict_chain
# random_chain
```

### 启用 DNS 代理（防止泄露）

取消注释：
```bash
proxy_dns
```

## 5. 基本用法

通过 ProxyChains 运行任意命令：
```bash
proxychains4 curl ifconfig.me           # 通过代理查看外网 IP
proxychains4 nmap -sT -Pn target.com    # 经代理扫描
proxychains4 firefox                    # 启动浏览器并走代理
```

### 配合 TOR 使用

- 启动 TOR：
```bash
sudo systemctl start tor
```
- 测试：
```bash
proxychains4 curl ifconfig.me  # 应显示 TOR 出口节点的 IP
```

## 6. 高级用法

### 自定义代理列表

编辑 `/etc/proxychains4.conf` 并添加：
```bash
[ProxyList]
socks5  127.0.0.1 9050          # TOR
http    45.33.12.84 8080        # 公共 HTTP 代理（示例）
socks4  91.121.23.45 4145       # 另一个代理（示例）
```

### 链式多个代理
```bash
proxychains4 -f /path/to/custom_config.conf nmap -sT target.com
```

### 为本地流量旁路

在配置中声明不走代理的网段，例如：
```bash
localnet 127.0.0.0/255.0.0.0
localnet 10.0.0.0/255.0.0.0
```

## 7. 命令行选项

- `-q`：静默模式（减少输出）
- `-f <file>`：使用指定的配置文件
- `-a`：使用列表中的所有代理（即便某些失败也尝试）
- `-d`：开启调试模式

示例：
```bash
proxychains4 -q nmap -sT target.com
```

## 8. 真实场景用例

- 渗透测试：通过 TOR 或公共代理匿名扫描目标
```bash
proxychains4 nmap -sT -Pn -p 80,443 target.com
```

- 绕过防火墙：访问被封锁的网站
```bash
proxychains4 wget https://censored-site.com
```

- 匿名浏览：通过 TOR 启动浏览器
```bash
proxychains4 firefox
```

- 通过代理使用 SSH：
```bash
proxychains4 ssh user@remote-server
```

## 9. 故障排除

**问题：“ProxyChains 不工作”**
- 检查 TOR：
```bash
sudo systemctl status tor
```
- 检查配置：确保 `/etc/proxychains4.conf` 中的代理条目正确
- 用 curl 验证：
```bash
proxychains4 curl ifconfig.me
```
- 开启调试模式：
```bash
proxychains4 -d curl ifconfig.me
```

**问题：“DNS 泄露”**
- 在配置中启用 `proxy_dns`
- 或在特定场景用 curl 的 `--resolve` 测试域名解析路径：
```bash
proxychains4 curl --resolve example.com:80:1.2.3.4 http://example.com
```

**问题：“连接超时”**
- 某些代理已失效，换用其他代理列表
- 为了定位问题，可先用 `strict_chain` 观察在哪一跳失败

---

> 本文翻译自：[proxychains4: A tool for forcing network connections to go through proxy servers | Abdul Wahab Junaid](https://awjunaid.com/kali-linux/proxychains4-a-tool-for-forcing-network-connections-to-go-through-proxy-servers/)
