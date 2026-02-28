---
title: SQL基础功能全面指南：从入门到精通
excerpt: SQL（结构化查询语言）是与数据库交互的标准语言。无论是数据分析师、后端开发人员还是 Android 开发者，掌握 SQL 都是必备技能。本文将系统介绍 SQL 的核心功能，从基础查询到高级操作，帮助您构建完整的 SQL 知识体系。
publishDate: 2025-02-24
tags:
  - SQL
  - 数据库
  - 后端
seo:
  title: SQL基础功能全面指南：从入门到精通
  description: SQL（结构化查询语言）是与数据库交互的标准语言。无论是数据分析师、后端开发人员还是 Android 开发者，掌握 SQL 都是必备技能。本文将系统介绍 SQL 的核心功能，从基础查询到高级操作，帮助您构建完整的 SQL 知识体系。
---
# SQL基础功能全面指南：从入门到精通

![](../../assets/sql基础功能全面指南从入门到精通-1.png)

SQL（结构化查询语言）是与数据库交互的标准语言。无论是数据分析师、后端开发人员还是 Android 开发者，掌握 SQL 都是必备技能。本文将系统介绍 SQL 的核心功能，从基础查询到高级操作，帮助您构建完整的 SQL 知识体系。

## 一、SQL 基础查询

### 1.1 基本查询结构

SQL 的基础是 SELECT 语句，它由以下几个关键部分组成：

```sql
SELECT 列名1, 列名2, ...  -- 选择要查询的列
FROM 表名                -- 指定数据来源
WHERE 条件               -- 过滤条件
GROUP BY 分组字段        -- 分组依据
HAVING 分组后条件        -- 对分组结果过滤
ORDER BY 排序字段        -- 结果排序
LIMIT 数量;             -- 限制返回行数
```

### 1.2 常用查询示例

**查询所有列：**

```sql
SELECT * FROM employees;
```

**查询特定列并设置别名：**

```sql
SELECT 
    first_name AS "名", 
    last_name AS "姓" 
FROM employees;
```

**去重查询：**

```sql
SELECT DISTINCT department_id FROM employees;
```

**限制返回行数：**

```sql
-- MySQL/PostgreSQL
SELECT * FROM products LIMIT 10;

-- SQL Server
SELECT TOP 10 * FROM products;

-- Oracle
SELECT * FROM employees WHERE ROWNUM <= 10;
```

## 二、数据过滤与排序

### 2.1 条件过滤

WHERE 子句支持多种条件运算符：

**比较运算符：**

```sql
SELECT * FROM employees WHERE salary > 50000;
```

**逻辑运算符：**

```sql
SELECT * FROM employees 
WHERE salary > 50000 AND department_id = 10;
```

**范围查询：**

```sql
SELECT * FROM employees 
WHERE salary BETWEEN 40000 AND 60000;
```

**模糊查询：**

```sql
-- 以 S 开头
SELECT * FROM employees WHERE last_name LIKE 'S%';

-- 包含 son
SELECT * FROM employees WHERE last_name LIKE '%son%';
```

**空值判断：**

```sql
SELECT * FROM employees WHERE manager_id IS NULL;
```

### 2.2 结果排序

**单列排序：**

```sql
SELECT * FROM employees ORDER BY last_name;
```

**多列排序：**

```sql
SELECT * FROM employees 
ORDER BY department_id ASC, salary DESC;
```

**自定义排序：**

```sql
SELECT * FROM employees 
ORDER BY 
    CASE WHEN department_id = 10 THEN 0 ELSE 1 END,
    last_name;
```

### 2.3 分页查询

**MySQL/PostgreSQL：**

```sql
SELECT * FROM employees 
ORDER BY employee_id 
LIMIT 5 OFFSET 10;  -- 跳过 10 条，取 5 条
```

**SQL Server：**

```sql
SELECT * FROM employees 
ORDER BY employee_id 
OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;
```

**Oracle：**

```sql
SELECT * FROM (
    SELECT e.*, ROWNUM rn 
    FROM employees e 
    WHERE ROWNUM <= 15
) WHERE rn > 10;
```

## 三、聚合与分组统计

### 3.1 聚合函数

**常用聚合函数：**

```sql
SELECT 
    COUNT(*) AS 员工总数,
    AVG(salary) AS 平均薪资,
    MAX(salary) AS 最高薪资,
    MIN(salary) AS 最低薪资,
    SUM(salary) AS 薪资总额
FROM employees;
```

**非空计数：**

```sql
SELECT COUNT(manager_id) FROM employees;
```

**去重计数：**

```sql
SELECT COUNT(DISTINCT department_id) FROM employees;
```

### 3.2 数据分组

**基本分组：**

```sql
SELECT 
    department_id, 
    COUNT(*) AS 员工数,
    AVG(salary) AS 平均薪资
FROM employees
GROUP BY department_id;
```

**分组后过滤：**

```sql
SELECT 
    department_id, 
    AVG(salary) AS 平均薪资
FROM employees
GROUP BY department_id
HAVING AVG(salary) > 50000;
```

**多级分组统计：**

```sql
SELECT 
    department_id, 
    job_id,
    COUNT(*) AS 员工数
FROM employees
GROUP BY department_id, job_id;
```

### 3.3 高级分组

**ROLLUP 小计：**

```sql
SELECT 
    department_id, 
    job_id, 
    COUNT(*) 
FROM employees 
GROUP BY ROLLUP(department_id, job_id);
```

**CUBE 多维分析：**

```sql
SELECT 
    department_id, 
    job_id, 
    COUNT(*) 
FROM employees 
GROUP BY CUBE(department_id, job_id);
```

**计算百分比：**

```sql
SELECT 
    department_id, 
    COUNT(*) as count,
    COUNT(*) * 100.0 / (SELECT COUNT(*) FROM employees) AS percentage
FROM employees 
GROUP BY department_id;
```

## 四、多表连接查询

### 4.1 连接类型

**内连接（INNER JOIN）：**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
INNER JOIN departments d ON e.department_id = d.department_id;
```

**左连接（LEFT JOIN）：**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
LEFT JOIN departments d ON e.department_id = d.department_id;
```

**右连接（RIGHT JOIN）：**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
RIGHT JOIN departments d ON e.department_id = d.department_id;
```

**全连接（FULL OUTER JOIN）：**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
FULL OUTER JOIN departments d ON e.department_id = d.department_id;
```

### 4.2 特殊连接

**自连接（查询员工及其经理）：**

```sql
SELECT 
    e1.last_name AS employee, 
    e2.last_name AS manager
FROM employees e1 
LEFT JOIN employees e2 ON e1.manager_id = e2.employee_id;
```

**多表连接：**

```sql
SELECT e.last_name, d.department_name, l.city
FROM employees e 
JOIN departments d ON e.department_id = d.department_id
JOIN locations l ON d.location_id = l.location_id;
```

**非等值连接：**

```sql
SELECT e.last_name, g.grade_level
FROM employees e 
JOIN grade_levels g ON e.salary BETWEEN g.low_salary AND g.high_salary;
```

## 五、子查询应用

### 5.1 WHERE 子查询

**单值子查询：**

```sql
SELECT * FROM employees 
WHERE salary > (SELECT AVG(salary) FROM employees);
```

**IN 子查询：**

```sql
SELECT * FROM employees 
WHERE department_id IN (SELECT department_id FROM departments WHERE location_id = 1700);
```

**EXISTS 子查询：**

```sql
SELECT * FROM departments d 
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.department_id);
```

### 5.2 FROM 子查询

```sql
SELECT dept_avg.department_id, dept_avg.avg_salary
FROM (
    SELECT department_id, AVG(salary) AS avg_salary 
    FROM employees 
    GROUP BY department_id
) dept_avg
WHERE dept_avg.avg_salary > 50000;
```

### 5.3 关联子查询

```sql
SELECT e.last_name, e.salary, e.department_id
FROM employees e
WHERE e.salary > (
    SELECT AVG(salary) 
    FROM employees 
    WHERE department_id = e.department_id
);
```

## 六、数据操作语言（DML）

### 6.1 插入数据

**单行插入：**

```sql
INSERT INTO employees (
    employee_id, first_name, last_name, 
    email, hire_date, job_id
) VALUES (
    1001, 'John', 'Doe', 
    'jdoe@example.com', '2023-01-15', 'IT_PROG'
);
```

**批量插入：**

```sql
INSERT INTO employees VALUES
(1001, 'John', 'Doe', 'jdoe@example.com', '2023-01-15', 'IT_PROG'),
(1002, 'Jane', 'Smith', 'jsmith@example.com', '2023-02-20', 'SA_REP');
```

**插入查询结果：**

```sql
INSERT INTO employee_archive
SELECT * FROM employees WHERE hire_date < '2020-01-01';
```

### 6.2 更新数据

**简单更新：**

```sql
UPDATE employees 
SET salary = salary * 1.05 
WHERE department_id = 10;
```

**关联更新：**

```sql
UPDATE employees e
SET e.salary = e.salary * 1.10
WHERE EXISTS (
    SELECT 1 
    FROM departments d 
    WHERE d.department_id = e.department_id 
    AND d.location_id = 1700
);
```

### 6.3 删除数据

```sql
DELETE FROM employees WHERE employee_id = 100;
```

### 6.4 合并数据（MERGE/UPSERT）

**SQL Server/Oracle：**

```sql
MERGE INTO employees_target t
USING employees_source s ON (t.employee_id = s.employee_id)
WHEN MATCHED THEN 
    UPDATE SET t.salary = s.salary, t.department_id = s.department_id
WHEN NOT MATCHED THEN 
    INSERT (employee_id, first_name, last_name, salary, department_id)
    VALUES (s.employee_id, s.first_name, s.last_name, s.salary, s.department_id);
```

**PostgreSQL：**

```sql
INSERT INTO employees (employee_id, first_name, last_name, email)
VALUES (100, 'John', 'Doe', 'jdoe@example.com')
ON CONFLICT (employee_id) 
DO UPDATE SET 
    first_name = EXCLUDED.first_name, 
    last_name = EXCLUDED.last_name;
```

## 七、表结构与索引

### 7.1 表操作

**创建表：**

```sql
CREATE TABLE employees (
    employee_id INT PRIMARY KEY,
    first_name VARCHAR(50),
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE,
    hire_date DATE DEFAULT CURRENT_DATE,
    salary DECIMAL(10,2) CHECK (salary > 0),
    department_id INT REFERENCES departments(department_id)
);
```

**修改表结构：**

```sql
ALTER TABLE employees ADD COLUMN phone_number VARCHAR(20);
ALTER TABLE employees ALTER COLUMN phone_number TYPE VARCHAR(30);
ALTER TABLE employees DROP COLUMN phone_number;
```

### 7.2 索引管理

**创建索引：**

```sql
CREATE INDEX idx_emp_last_name ON employees(last_name);
CREATE UNIQUE INDEX idx_emp_email ON employees(email);
CREATE INDEX idx_emp_name_dept ON employees(last_name, department_id);
```

**函数索引：**

```sql
CREATE INDEX idx_emp_upper_name ON employees(UPPER(last_name));
```

**删除索引：**

```sql
DROP INDEX idx_emp_last_name;
```

## 八、高级功能

### 8.1 视图

**创建视图：**

```sql
CREATE VIEW emp_dept_view AS
SELECT e.employee_id, e.last_name, d.department_name
FROM employees e JOIN departments d ON e.department_id = d.department_id;
```

**物化视图：**

```sql
CREATE MATERIALIZED VIEW emp_salary_mv AS
SELECT department_id, AVG(salary) AS avg_salary
FROM employees GROUP BY department_id;
```

### 8.2 执行计划分析

```sql
EXPLAIN SELECT * FROM employees WHERE last_name = 'Smith';
```

## 九、SQL 最佳实践

1. **编写可读的 SQL**：合理使用缩进、换行和注释；
2. **避免 SELECT \***：只查询需要的列；
3. **合理使用索引**：为常用查询条件创建索引；
4. **注意 NULL 值处理**：NULL 与任何值的比较结果都是 NULL；
5. **批量操作优于循环**：尽量使用批量 INSERT/UPDATE；
6. **事务控制**：对多个相关操作使用事务保证一致性；
7. **定期优化**：分析慢查询并优化执行计划。

## 结语

SQL 是一门功能强大且灵活的语言，本文涵盖了从基础查询到高级操作的绝大多数常用功能。掌握这些基础后，您可以进一步学习窗口函数、CTE（公用表表达式）、存储过程等高级特性。记住，优秀的 SQL 不仅要求语法正确，更需要考虑性能和可维护性。实践是最好的老师，建议在实际项目中不断尝试和应用这些技术。
