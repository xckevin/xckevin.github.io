---
title: MySQL 的 mysql_native_password 错误怎么解决
excerpt: 最近开发一个 Node 项目，需要使用数据库，自然地选择了 MySQL 和 mysql.js npm 包，于是在本机安装了 MySQL 的最新版本。结果项目启动时出现错误：
publishDate: 2025-08-25
tags:
  - MySQL
  - 数据库
  - 运维
seo:
  title: MySQL 的 mysql_native_password 错误怎么解决
  description: 最近开发一个 Node 项目，需要使用数据库，自然地选择了 MySQL 和 mysql.js npm 包，于是在本机安装了 MySQL 的最新版本。结果项目启动时出现错误：
---
## 背景

最近开发一个 Node 项目，需要使用数据库，自然地选择了 MySQL 和 `mysql.js` npm 包，于是在本机安装了 MySQL 的最新版本。结果项目启动时出现错误：

```plain
mysql 9.0 macos Plugin 'mysql_native_password' is not loaded
```

## 什么是 mysql_native_password

**mysql_native_password** 是 MySQL 数据库中的一种认证插件，用于在客户端和服务器之间建立连接时验证用户身份。它使用基于双重 SHA-1 的挑战-响应机制：服务器发送一个随机挑战值，客户端将密码的 SHA-1 哈希与挑战值组合后再次哈希，将结果发送给服务器进行验证，密码本身不会在网络中传输。该插件是 MySQL 5.7 及之前版本中的默认认证方式。

从 MySQL 8.0 开始，**caching_sha2_password** 作为新的默认认证插件被引入。它使用更强的 SHA-256 哈希算法和随机数来增强安全性，提供更高的抗碰撞能力。此外，该插件支持密码缓存，可减少密码验证过程中的计算开销。

## 如何继续使用 mysql_native_password

显然，`mysql.js` npm 包仍在使用旧的 **mysql_native_password** 插件，目前尚不支持 **caching_sha2_password**，详见该 [issue](https://github.com/mysqljs/mysql/pull/2233)。

若仅在本机运行 MySQL 服务，可将用户认证方式改为 **mysql_native_password**：

```plain
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'your_password';
```

执行后发现，**mysql_native_password** 在 MySQL 9.0 版本后已被默认移除。若要继续使用，只能将 MySQL 降级到 8.x 版本。

需要注意的是，MySQL 8.4 已默认不再加载 `mysql_native_password` 插件，需手动启用。可先修改配置文件如下，然后重启服务：

```plain
# Enable mysql_native_password plugin
[mysqld]
mysql_native_password=ON
```

## 更好的办法

**mysql_native_password** 使用的 SHA-1 哈希算法已被证明存在碰撞漏洞，安全性较低。**caching_sha2_password** 采用更强的 SHA-256 算法且支持缓存机制，安全性和性能更优，建议优先使用。若 Node 客户端要使用该认证插件，可采用以下方案。

### 使用 MySQL Connector X DevAPI

MySQL X DevAPI for Node 是官方团队提供的 `mysql.js` 包替代品，支持新的 **caching_sha2_password** 认证插件，并提供许多旧包所不具备的新功能。

但需注意以下几点：

1. 使用 33060 端口进行 X 协议通信；
2. API 与 `mysql.js` 差异较大；
3. MySQL X DevAPI 包目前尚无 TypeScript 类型定义，若使用 TypeScript 可能会遇到问题。

若是新项目，可直接采用此方案；若是老项目升级，改造工作量较大。若希望采用更简单的方案，可继续阅读下文。

### 使用 mysql2.js

`mysql2.js` 是 `mysql.js` 的一个 fork 分支，支持 **caching_sha2_password**，且 API 与 `mysql.js` 完全兼容，可直接替换：

```plain
npm un mysql && npm i mysql2
```

经实测，项目可正常启动。

## 后记

经过一番研究，对 MySQL 的认证机制有了更清晰的认识。最终我选择了降级 MySQL 版本的方案，因为线上环境使用的也是 8.4 版本，尽量保持本地与线上环境一致。
