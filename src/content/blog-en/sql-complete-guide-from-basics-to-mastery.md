---
title: "A Complete SQL Guide: From Basics to Mastery"
lang: en
translationKey: sql-complete-guide-from-basics-to-mastery
slug: sql-complete-guide-from-basics-to-mastery
excerpt: "SQL, or Structured Query Language, is the standard language for interacting with databases. This guide walks through core SQL features from basic queries to advanced operations."
publishDate: '2024-07-02'
tags:
  - "SQL"
  - "Database"
  - "Backend"
seo:
  title: "Complete SQL Guide: Queries, Joins, DML, Indexes, and Best Practices"
  description: "Learn SQL from SELECT queries, filtering, grouping, joins, and subqueries to DML, indexes, views, execution plans, and practical best practices."
  pageType: article
---

![](../../assets/sql基础功能全面指南从入门到精通-1.png)

SQL, or Structured Query Language, is the standard language for interacting with databases. Whether you are a data analyst, a backend developer, or an Android engineer, SQL is a core skill. This article introduces the essential capabilities of SQL, from basic queries to advanced operations, and helps you build a complete SQL knowledge system.

## 1. Basic SQL Queries

### 1.1 Basic Query Structure

The foundation of SQL is the `SELECT` statement. It consists of several key parts:

```sql
SELECT column1, column2, ...  -- Choose the columns to query
FROM table_name               -- Specify the data source
WHERE condition               -- Filter rows
GROUP BY grouping_column      -- Define grouping keys
HAVING grouped_condition      -- Filter grouped results
ORDER BY sort_column          -- Sort the result set
LIMIT count;                  -- Limit the number of returned rows
```

### 1.2 Common Query Examples

**Query all columns:**

```sql
SELECT * FROM employees;
```

**Query specific columns and set aliases:**

```sql
SELECT 
    first_name AS "First Name", 
    last_name AS "Last Name" 
FROM employees;
```

**Query distinct values:**

```sql
SELECT DISTINCT department_id FROM employees;
```

**Limit the number of returned rows:**

```sql
-- MySQL/PostgreSQL
SELECT * FROM products LIMIT 10;

-- SQL Server
SELECT TOP 10 * FROM products;

-- Oracle
SELECT * FROM employees WHERE ROWNUM <= 10;
```

## 2. Filtering and Sorting Data

### 2.1 Conditional Filtering

The `WHERE` clause supports many conditional operators:

**Comparison operators:**

```sql
SELECT * FROM employees WHERE salary > 50000;
```

**Logical operators:**

```sql
SELECT * FROM employees 
WHERE salary > 50000 AND department_id = 10;
```

**Range queries:**

```sql
SELECT * FROM employees 
WHERE salary BETWEEN 40000 AND 60000;
```

**Pattern matching:**

```sql
-- Starts with S
SELECT * FROM employees WHERE last_name LIKE 'S%';

-- Contains son
SELECT * FROM employees WHERE last_name LIKE '%son%';
```

**NULL checks:**

```sql
SELECT * FROM employees WHERE manager_id IS NULL;
```

### 2.2 Sorting Results

**Sort by one column:**

```sql
SELECT * FROM employees ORDER BY last_name;
```

**Sort by multiple columns:**

```sql
SELECT * FROM employees 
ORDER BY department_id ASC, salary DESC;
```

**Custom sorting:**

```sql
SELECT * FROM employees 
ORDER BY 
    CASE WHEN department_id = 10 THEN 0 ELSE 1 END,
    last_name;
```

### 2.3 Pagination Queries

**MySQL/PostgreSQL:**

```sql
SELECT * FROM employees 
ORDER BY employee_id 
LIMIT 5 OFFSET 10;  -- Skip 10 rows and fetch 5 rows
```

**SQL Server:**

```sql
SELECT * FROM employees 
ORDER BY employee_id 
OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;
```

**Oracle:**

```sql
SELECT * FROM (
    SELECT e.*, ROWNUM rn 
    FROM employees e 
    WHERE ROWNUM <= 15
) WHERE rn > 10;
```

## 3. Aggregation and Grouped Statistics

### 3.1 Aggregate Functions

**Common aggregate functions:**

```sql
SELECT 
    COUNT(*) AS total_employees,
    AVG(salary) AS average_salary,
    MAX(salary) AS highest_salary,
    MIN(salary) AS lowest_salary,
    SUM(salary) AS total_salary
FROM employees;
```

**Count non-NULL values:**

```sql
SELECT COUNT(manager_id) FROM employees;
```

**Count distinct values:**

```sql
SELECT COUNT(DISTINCT department_id) FROM employees;
```

### 3.2 Grouping Data

**Basic grouping:**

```sql
SELECT 
    department_id, 
    COUNT(*) AS employee_count,
    AVG(salary) AS average_salary
FROM employees
GROUP BY department_id;
```

**Filter after grouping:**

```sql
SELECT 
    department_id, 
    AVG(salary) AS average_salary
FROM employees
GROUP BY department_id
HAVING AVG(salary) > 50000;
```

**Multi-level grouped statistics:**

```sql
SELECT 
    department_id, 
    job_id,
    COUNT(*) AS employee_count
FROM employees
GROUP BY department_id, job_id;
```

### 3.3 Advanced Grouping

**ROLLUP subtotals:**

```sql
SELECT 
    department_id, 
    job_id, 
    COUNT(*) 
FROM employees 
GROUP BY ROLLUP(department_id, job_id);
```

**CUBE multidimensional analysis:**

```sql
SELECT 
    department_id, 
    job_id, 
    COUNT(*) 
FROM employees 
GROUP BY CUBE(department_id, job_id);
```

**Calculate percentages:**

```sql
SELECT 
    department_id, 
    COUNT(*) as count,
    COUNT(*) * 100.0 / (SELECT COUNT(*) FROM employees) AS percentage
FROM employees 
GROUP BY department_id;
```

## 4. Multi-Table Join Queries

### 4.1 Join Types

**Inner join:**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
INNER JOIN departments d ON e.department_id = d.department_id;
```

**Left join:**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
LEFT JOIN departments d ON e.department_id = d.department_id;
```

**Right join:**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
RIGHT JOIN departments d ON e.department_id = d.department_id;
```

**Full outer join:**

```sql
SELECT e.last_name, d.department_name 
FROM employees e 
FULL OUTER JOIN departments d ON e.department_id = d.department_id;
```

### 4.2 Special Joins

**Self join to query employees and their managers:**

```sql
SELECT 
    e1.last_name AS employee, 
    e2.last_name AS manager
FROM employees e1 
LEFT JOIN employees e2 ON e1.manager_id = e2.employee_id;
```

**Multi-table join:**

```sql
SELECT e.last_name, d.department_name, l.city
FROM employees e 
JOIN departments d ON e.department_id = d.department_id
JOIN locations l ON d.location_id = l.location_id;
```

**Non-equi join:**

```sql
SELECT e.last_name, g.grade_level
FROM employees e 
JOIN grade_levels g ON e.salary BETWEEN g.low_salary AND g.high_salary;
```

## 5. Using Subqueries

### 5.1 `WHERE` Subqueries

**Single-value subquery:**

```sql
SELECT * FROM employees 
WHERE salary > (SELECT AVG(salary) FROM employees);
```

**`IN` subquery:**

```sql
SELECT * FROM employees 
WHERE department_id IN (SELECT department_id FROM departments WHERE location_id = 1700);
```

**`EXISTS` subquery:**

```sql
SELECT * FROM departments d 
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.department_id);
```

### 5.2 `FROM` Subqueries

```sql
SELECT dept_avg.department_id, dept_avg.avg_salary
FROM (
    SELECT department_id, AVG(salary) AS avg_salary 
    FROM employees 
    GROUP BY department_id
) dept_avg
WHERE dept_avg.avg_salary > 50000;
```

### 5.3 Correlated Subqueries

```sql
SELECT e.last_name, e.salary, e.department_id
FROM employees e
WHERE e.salary > (
    SELECT AVG(salary) 
    FROM employees 
    WHERE department_id = e.department_id
);
```

## 6. Data Manipulation Language (DML)

### 6.1 Insert Data

**Insert one row:**

```sql
INSERT INTO employees (
    employee_id, first_name, last_name, 
    email, hire_date, job_id
) VALUES (
    1001, 'John', 'Doe', 
    'jdoe@example.com', '2023-01-15', 'IT_PROG'
);
```

**Batch insert:**

```sql
INSERT INTO employees VALUES
(1001, 'John', 'Doe', 'jdoe@example.com', '2023-01-15', 'IT_PROG'),
(1002, 'Jane', 'Smith', 'jsmith@example.com', '2023-02-20', 'SA_REP');
```

**Insert query results:**

```sql
INSERT INTO employee_archive
SELECT * FROM employees WHERE hire_date < '2020-01-01';
```

### 6.2 Update Data

**Simple update:**

```sql
UPDATE employees 
SET salary = salary * 1.05 
WHERE department_id = 10;
```

**Correlated update:**

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

### 6.3 Delete Data

```sql
DELETE FROM employees WHERE employee_id = 100;
```

### 6.4 Merge Data (MERGE/UPSERT)

**SQL Server/Oracle:**

```sql
MERGE INTO employees_target t
USING employees_source s ON (t.employee_id = s.employee_id)
WHEN MATCHED THEN 
    UPDATE SET t.salary = s.salary, t.department_id = s.department_id
WHEN NOT MATCHED THEN 
    INSERT (employee_id, first_name, last_name, salary, department_id)
    VALUES (s.employee_id, s.first_name, s.last_name, s.salary, s.department_id);
```

**PostgreSQL:**

```sql
INSERT INTO employees (employee_id, first_name, last_name, email)
VALUES (100, 'John', 'Doe', 'jdoe@example.com')
ON CONFLICT (employee_id) 
DO UPDATE SET 
    first_name = EXCLUDED.first_name, 
    last_name = EXCLUDED.last_name;
```

## 7. Table Structure and Indexes

### 7.1 Table Operations

**Create a table:**

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

**Modify table structure:**

```sql
ALTER TABLE employees ADD COLUMN phone_number VARCHAR(20);
ALTER TABLE employees ALTER COLUMN phone_number TYPE VARCHAR(30);
ALTER TABLE employees DROP COLUMN phone_number;
```

### 7.2 Index Management

**Create indexes:**

```sql
CREATE INDEX idx_emp_last_name ON employees(last_name);
CREATE UNIQUE INDEX idx_emp_email ON employees(email);
CREATE INDEX idx_emp_name_dept ON employees(last_name, department_id);
```

**Function-based index:**

```sql
CREATE INDEX idx_emp_upper_name ON employees(UPPER(last_name));
```

**Drop an index:**

```sql
DROP INDEX idx_emp_last_name;
```

## 8. Advanced Features

### 8.1 Views

**Create a view:**

```sql
CREATE VIEW emp_dept_view AS
SELECT e.employee_id, e.last_name, d.department_name
FROM employees e JOIN departments d ON e.department_id = d.department_id;
```

**Materialized view:**

```sql
CREATE MATERIALIZED VIEW emp_salary_mv AS
SELECT department_id, AVG(salary) AS avg_salary
FROM employees GROUP BY department_id;
```

### 8.2 Execution Plan Analysis

```sql
EXPLAIN SELECT * FROM employees WHERE last_name = 'Smith';
```

## 9. SQL Best Practices

1. **Write readable SQL**: use indentation, line breaks, and comments sensibly.
2. **Avoid `SELECT *`**: query only the columns you need.
3. **Use indexes thoughtfully**: create indexes for common query predicates.
4. **Handle `NULL` carefully**: comparisons between `NULL` and any value evaluate to `NULL`.
5. **Prefer batch operations over loops**: use batch `INSERT` and `UPDATE` whenever possible.
6. **Use transactions**: wrap related operations in transactions to preserve consistency.
7. **Optimize regularly**: analyze slow queries and improve execution plans.

## Conclusion

SQL is a powerful and flexible language. This article covered most common features, from basic queries to advanced operations. Once you master these foundations, you can continue into advanced topics such as window functions, CTEs, and stored procedures. Good SQL is not only syntactically correct; it also accounts for performance and maintainability. Practice is the best teacher, so keep applying these techniques in real projects.
