---
title: "How to Fix MySQL mysql_native_password Errors"
lang: en
translationKey: mysql-native-password-error-fix
slug: mysql-native-password-error-fix
excerpt: "A practical fix for MySQL mysql_native_password errors in Node.js projects, with options for MySQL 8.x, MySQL X DevAPI, and mysql2."
publishDate: 2025-08-25
tags:
  - MySQL
  - Database
  - Operations
seo:
  title: "How to Fix MySQL mysql_native_password Errors in Node.js"
  description: "Understand why mysql_native_password fails in newer MySQL versions and how to fix Node.js clients with MySQL 8.x, X DevAPI, or mysql2."
  pageType: article
---
## Background

I recently started a Node project that needed a database, so I naturally chose MySQL and the `mysql.js` npm package. I installed the latest version of MySQL locally, but the project failed during startup with this error:

```plain
mysql 9.0 macos Plugin 'mysql_native_password' is not loaded
```

## What Is mysql_native_password?

**mysql_native_password** is an authentication plugin in MySQL. It verifies user identity when a client connects to the server. It uses a challenge-response mechanism based on double SHA-1 hashing: the server sends a random challenge, the client combines it with the SHA-1 hash of the password and hashes the result again, then sends that result back to the server for verification. The password itself is not transmitted over the network. This plugin was the default authentication method in MySQL 5.7 and earlier.

Starting with MySQL 8.0, **caching_sha2_password** was introduced as the new default authentication plugin. It uses the stronger SHA-256 hash algorithm and random values to improve security and collision resistance. It also supports password caching, which reduces the computational overhead of password verification.

## How to Keep Using mysql_native_password

Apparently, the `mysql.js` npm package still uses the older **mysql_native_password** plugin and does not currently support **caching_sha2_password**. See this [issue](https://github.com/mysqljs/mysql/pull/2233) for details.

If you are only running MySQL locally, you can change the user's authentication method to **mysql_native_password**:

```plain
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'your_password';
```

After running it, I found that **mysql_native_password** has been removed by default since MySQL 9.0. If you want to keep using it, the only option is to downgrade MySQL to an 8.x version.

Note that MySQL 8.4 also no longer loads the `mysql_native_password` plugin by default, so you need to enable it manually. First update the configuration file as follows, then restart the service:

```plain
# Enable mysql_native_password plugin
[mysqld]
mysql_native_password=ON
```

## A Better Approach

The SHA-1 hash algorithm used by **mysql_native_password** is known to have collision vulnerabilities and provides weaker security. **caching_sha2_password** uses the stronger SHA-256 algorithm and supports caching, so it is better for both security and performance. If your Node client needs to use this authentication plugin, consider the following options.

### Use MySQL Connector X DevAPI

MySQL X DevAPI for Node is the official team's replacement for the `mysql.js` package. It supports the newer **caching_sha2_password** authentication plugin and provides many features that the older package does not have.

There are a few things to watch out for:

1. It communicates over the X Protocol on port 33060.
2. Its API differs significantly from `mysql.js`.
3. The MySQL X DevAPI package currently has no TypeScript type definitions, which may cause problems if you use TypeScript.

For a new project, you can adopt this option directly. For an existing project upgrade, the migration effort may be large. If you want a simpler approach, keep reading.

### Use mysql2.js

`mysql2.js` is a fork of `mysql.js`. It supports **caching_sha2_password**, and its API is fully compatible with `mysql.js`, so it can be used as a direct replacement:

```plain
npm un mysql && npm i mysql2
```

After testing it, the project started normally.

## Afterword

After digging into this, I now have a clearer understanding of MySQL's authentication mechanisms. In the end, I chose to downgrade the MySQL version because the production environment also uses version 8.4, and I wanted to keep the local and production environments consistent.
