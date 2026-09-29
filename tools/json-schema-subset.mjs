/**
 * Knit · 一个**只覆盖本项目用到的 JSON Schema 子集**的校验器。
 *
 * 为什么需要它：`knit_docs` 的 `OUTPUT_SCHEMA` 是**封闭**的
 * （`additionalProperties: false` + 一串 `required`），而 DSH 的工具层会在
 * 真正执行后拿它校验一次返回值。返回值只要多一个没声明的字段、少一个必填字段、
 * 或者该是整数的地方给了浮点，整次调用就会失败 —— **agent 一个 Context Pack 都拿不到**。
 *
 * v0.14 就是这么坏掉的：`kind` / `reason.term` / `totals` 三个字段没声明、
 * `mtimeMs` 是浮点（`fs.Stats.mtimeMs` 本来就是浮点）。当时 335 条测试全绿，
 * 因为所有 tool 测试都是拿手写的假 payload 测渲染函数，
 * **从来没有把 `execute()` 的真实返回值交给它自己的 schema 校验过**。
 *
 * 为什么不用 `ajv`：这个包没有任何运行时依赖（`package.json` 没有 `dependencies`），
 * 而 DSH 自带的那份在 checkout 的 `node_modules` 里、不在本包的解析路径上 ——
 * 引它会让 `npm test` 依赖一个工作区之外的绝对路径。手写这四十行换来的是
 * 「任何机器上 clone 下来就能跑」。
 *
 * 覆盖的子集：`type` / `enum` / `required` / `additionalProperties: false` /
 * `properties` / `items`。那个子集**就是** `ITEM_SCHEMA` 与 `OUTPUT_SCHEMA` 用到的全集
 * —— 它们存在的意义是精确描述形状，不是通用校验。
 *
 * 零依赖。
 */

/**
 * 拿一份 schema 校验一个值。
 *
 * @param {object} schema - 工具自己的 schema
 * @param {unknown} value - 要校验的值
 * @param {string} [path] - 出错定位的前缀（递归时自动加长）
 * @returns {string[]} 错误列表；空数组 = 通过
 */
export function validateAgainst(schema, value, path = 'value') {
  const errors = []
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`"${path}" must be one of: ${schema.enum.join(', ')}`)
  }

  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [...errors, `"${path}" must be an object`]
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`"${path}.${key}" is required`)
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = (schema.properties || {})[key]
      if (!sub) {
        // 只有显式 `additionalProperties: false` 才算错 —— 没写这个键的 schema
        // 允许额外字段（`PARAMETERS` 就是这种）。
        if (schema.additionalProperties === false) {
          errors.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
        }
        continue
      }
      errors.push(...validateAgainst(sub, child, `${path}.${key}`))
    }
    return errors
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [...errors, `"${path}" must be an array`]
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainst(schema.items, item, `${path}[${index}]`))
      })
    }
    return errors
  }

  if (schema.type === 'integer' && !Number.isInteger(value)) {
    errors.push(`"${path}" must be an integer`)
  }
  if (schema.type === 'string' && typeof value !== 'string') {
    errors.push(`"${path}" must be a string`)
  }
  return errors
}

/**
 * 断言用：把错误列表压成一行可读文本。
 *
 * @param {string[]} errors - `validateAgainst()` 的结果
 * @returns {string} 文本
 */
export function describeErrors(errors) {
  return errors.length === 0 ? '' : errors.join('; ')
}
