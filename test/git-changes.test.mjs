/**
 * Knit v0.25 · **Git 变更关联检索**（`src/host/git.js` + `src/host/changes.js` + 装配层的接线）。
 *
 * 三件事各测各的，**不混着测**：
 *
 *   1. **状态读取**（`git.js`）：`--porcelain=v1 -z` 的解析、五种降级、缓存与并发去重、
 *      以及「只跑哪两个子命令」的**安全守卫**。全部用注入的 `exec` 或手写字节串 ⇒ 确定性，
 *      不需要真的建一个仓库、也不依赖这台机器上 git 的版本与配置。
 *   2. **关联投影**（`changes.js`）：四类证据、已删除/重命名前的路径当种子、无证据不硬凑、
 *      截断与确定性排序。用**手写的候选记录**直接喂 `buildRelationFacts()`，零 I/O。
 *   3. **接线**（`index.js` 的 `buildContextFor`）：关闭时**包逐字不变**、打开时只多一个平行区、
 *      三层与固定区一个字节都不动。
 *
 * ⚠️ 一份**真机** fixture（真的 `git init` 一个临时仓库、真的跑一条 `git status`）也在这里 ——
 * `test/fixture.mjs` 的纪律：样本工作区一律自己造、路径用 `os.tmpdir()`，断言里不出现 `knit/` 前缀。
 * 那是唯一会 spawn 进程的用例；它证明「我们解析的是**真 git** 的输出」，而不是我们以为的格式。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseStatusZ, kindsOf, createGitReader, spawnGit, gitEnv,
  GIT_STATUS_ARGS, GIT_PREFIX_ARGS, GIT_ENV_ALLOW, MUTATING_VERBS,
  MAX_CHANGED_FILES, MAX_REPORTED_FILES,
} from '../src/host/git.js'
import {
  splitSeeds, ghostCandidates, projectChangeRelated, MAX_CHANGE_RELATED,
} from '../src/host/changes.js'
import { buildRelationFacts, resetRelationCache, testsOf } from '../src/host/relations.js'
import { changesPayload, corpusForChanges, scanMemo, resetScanMemo, resetGitReaderCache } from '../src/host/index.js'
import { createIndex } from '../src/host/links.js'
import { startKnitServer } from './http-harness.mjs'
import { scan, buildContextFor, publicScanPayload } from '../src/host/index.js'
import { knitDocsDefinition } from '../src/host/tool.js'
// `scan` 已在 import 列表里（独立验收案例要真的扫一遍临时仓库）

/* ── 1. 状态读取 ─────────────────────────────────────── */

test('git: `--porcelain=v1 -z` 的解析 —— 五种状态各就各位（含重命名的新/原路径顺序）', () => {
  // 这一串的形状是**实测**来的（2026-10-13，真 git 2.x 的 od 输出）：
  //   R  <新路径>\0<原路径>\0      重命名：**新在前**，后面紧跟一个原路径字段
  //   MM <路径>\0                  索引与工作区**都**改了
  //    D <路径>\0                   工作区删除（索引里还在）
  //   ?? <路径>\0                  未跟踪
  const raw = 'R  new-name.ts\0old-name.ts\0MM src/foo.ts\0 D tests/foo.test.ts\0?? src/brand-new.ts\0'
  const files = parseStatusZ(raw)
  assert.deepEqual(files.map((f) => f.rel), ['new-name.ts', 'src/brand-new.ts', 'src/foo.ts', 'tests/foo.test.ts'],
    '按路径字典序（确定性），不是按 git 的输出顺序')

  const byRel = new Map(files.map((f) => [f.rel, f]))
  assert.deepEqual(byRel.get('new-name.ts').kinds, ['renamed', 'staged'])
  assert.equal(byRel.get('new-name.ts').origRel, 'old-name.ts', '重命名的**原路径**要留下来（它也是一个种子）')
  assert.deepEqual(byRel.get('src/foo.ts').kinds, ['staged', 'unstaged'], '`MM` = 暂存与未暂存**同时**成立，不许压成一个标签')
  assert.deepEqual(byRel.get('tests/foo.test.ts').kinds, ['deleted', 'unstaged'])
  assert.deepEqual(byRel.get('src/brand-new.ts').kinds, ['untracked'])
  assert.equal(byRel.get('src/foo.ts').origRel, undefined, '没有原路径时**不给这个键**（不是给个空串）')
})

test('git: `kindsOf` 把 XY 两位翻成状态集合（X=索引侧、Y=工作区侧）', () => {
  assert.deepEqual(kindsOf('?', '?'), ['untracked'])
  assert.deepEqual(kindsOf('M', ' '), ['staged'])
  assert.deepEqual(kindsOf(' ', 'M'), ['unstaged'])
  assert.deepEqual(kindsOf('M', 'M'), ['staged', 'unstaged'])
  assert.deepEqual(kindsOf('A', ' '), ['added', 'staged'])
  assert.deepEqual(kindsOf(' ', 'D'), ['deleted', 'unstaged'])
  assert.deepEqual(kindsOf('D', ' '), ['deleted', 'staged'])
  assert.deepEqual(kindsOf('R', ' '), ['renamed', 'staged'])
  assert.deepEqual(kindsOf('U', 'U'), ['unmerged'], '冲突态不许被说成「已暂存 + 未暂存」')
  assert.deepEqual(kindsOf('D', 'D'), ['deleted', 'unmerged'], '`DD` 两种事实都在：既冲突、也确实删了')
  assert.deepEqual(kindsOf('A', 'A'), ['unmerged'])
})

test('git: 工作区是仓库的子目录时，路径按**工作区**基准给出（减掉 --show-prefix）', () => {
  const raw = 'MM src/foo.ts\0?? src/new.ts\0?? outside/other.ts\0'
  const files = parseStatusZ(raw, { prefix: 'src/' })
  assert.deepEqual(files.map((f) => f.rel), ['foo.ts', 'new.ts'],
    '工作区之外的路径（同一个仓库里）**直接丢弃**，不算这个工作区的变更')
})

test('git: 解析对残缺输入不抛（半截条目 / 空串 / 只有状态位）', () => {
  for (const raw of ['', '\0', 'M\0', 'M \0', 'QQ\0', null, undefined, 123]) {
    assert.doesNotThrow(() => parseStatusZ(raw))
  }
  assert.deepEqual(parseStatusZ('M \0'), [], '「状态位 + 空格 + 空路径」不算一条变更')
})

test('git: 五种降级各有各的 reason，且**一条都不抛**', async () => {
  const mk = (impl) => createGitReader({ exec: impl, now: () => 0 })
  const cases = [
    ['not-a-repo', (args) => (args.includes('rev-parse')
      ? { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' }
      : { code: 0, stdout: '', stderr: '' })],
    ['git-missing', () => ({ code: null, stdout: '', stderr: '', spawnError: true })],
    ['timeout', (args) => (args.includes('rev-parse')
      ? { code: 0, stdout: '', stderr: '' }
      : { code: null, stdout: '', stderr: '', killed: 'timeout' })],
    ['output-too-large', (args) => (args.includes('rev-parse')
      ? { code: 0, stdout: '', stderr: '' }
      : { code: null, stdout: '', stderr: '', killed: 'too-large' })],
    ['failed-fatal', (args) => (args.includes('rev-parse')
      ? { code: 0, stdout: '', stderr: '' }
      : { code: 1, stdout: '', stderr: 'boom' })],
  ]
  for (const [reason, impl] of cases) {
    const result = await mk(impl).read('/w')
    assert.equal(result.available, false, `${reason} 必须是 available:false`)
    assert.equal(result.reason, reason)
    assert.deepEqual(result.files, [], '读不到时**不给半份变更清单**')
  }
  // exec 自己抛（比如 spawn 抛 EACCES）也不许冒出去
  const throwing = createGitReader({ exec: async () => { throw new Error('EACCES') }, now: () => 0 })
  const res = await throwing.read('/w')
  assert.equal(res.available, false)
  assert.equal(res.reason, 'failed-fatal')
})

test('git: 非 Git 工作区只问一次 —— 负结论也缓存（不然面板每轮都白跑一条 git）', async () => {
  let calls = 0
  const impl = async (args) => {
    calls += 1
    void args
    return { code: 128, stdout: '', stderr: 'fatal: not a git repository' }
  }
  const reader = createGitReader({ exec: impl, now: () => 0 })
  assert.equal((await reader.read('/w')).reason, 'not-a-repo')
  assert.equal((await reader.read('/w')).reason, 'not-a-repo')
  assert.equal(calls, 1, `` + `负结论必须被缓存（实测调用 ${calls} 次）`)
})

test('git: 结果缓存命中时不再 spawn；并发的两轮共用同一次调用', async () => {
  let calls = 0
  let clock = 0
  const impl = async (args) => {
    calls += 1
    if (args.includes('rev-parse')) return { code: 0, stdout: '', stderr: '' }
    await new Promise((r) => setTimeout(r, 5))
    return { code: 0, stdout: 'M  a.ts\0', stderr: '' }
  }
  const reader = createGitReader({ exec: impl, now: () => clock, ttlMs: 1000 })
  const [a, b] = await Promise.all([reader.read('/w'), reader.read('/w')])
  assert.deepEqual(a.files.map((f) => f.rel), ['a.ts'])
  assert.deepEqual(b.files.map((f) => f.rel), ['a.ts'])
  assert.equal(calls, 2, 'rev-parse 1 次 + status 1 次：并发的两轮**共用**了同一次 git')
  clock = 500
  await reader.read('/w')
  assert.equal(calls, 2, 'TTL 之内命中缓存，不再 spawn')
  clock = 2000
  await reader.read('/w')
  assert.equal(calls, 3, 'TTL 过了才重新问一次')
})

test('git: 条目数超过上限时截断并如实标记（不静默丢）', async () => {
  const many = Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, i) => `M  f${String(i).padStart(4, '0')}.ts`).join('\0') + '\0'
  const impl = async (args) => (args.includes('rev-parse')
    ? { code: 0, stdout: '', stderr: '' }
    : { code: 0, stdout: many, stderr: '' })
  const result = await createGitReader({ exec: impl, now: () => 0 }).read('/w')
  assert.equal(result.truncated, true)
  assert.equal(result.filesTotal, MAX_CHANGED_FILES)
  assert.equal(result.files.length, MAX_CHANGED_FILES)
})

test('安全：只跑 `status` 与 `rev-parse --show-prefix`，两个 argv 里一个写动词都没有', () => {
  assert.equal(GIT_STATUS_ARGS[0], 'status')
  assert.equal(GIT_PREFIX_ARGS[0], 'rev-parse')
  for (const verb of MUTATING_VERBS) {
    assert.ok(!GIT_STATUS_ARGS.includes(verb), `status 的 argv 里出现了写动词 ${verb}`)
    assert.ok(!GIT_PREFIX_ARGS.includes(verb), `rev-parse 的 argv 里出现了写动词 ${verb}`)
  }
  // `--untracked-files=all` 是**有界**的：它不会展开被忽略的目录（`--ignored` 没开）
  assert.ok(GIT_STATUS_ARGS.includes('--untracked-files=all'))
  assert.ok(!GIT_STATUS_ARGS.includes('--ignored'), '不主动去看被忽略的文件（node_modules 那类）')
})

/* ── 2. 与**真 git** 对一次账（唯一会 spawn 的用例）──────── */

test('真机：真的 git init 一个临时仓库，五种状态都解析得出来', async (t) => {
  let repo
  try {
    repo = mkdtempSync(join(tmpdir(), 'knit-git-'))
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    mkdirSync(join(repo, 'src'))
    mkdirSync(join(repo, 'tests'))
    writeFileSync(join(repo, 'src', 'foo.ts'), 'export const a = 1\n')
    writeFileSync(join(repo, 'tests', 'foo.test.ts'), 'import "../src/foo"\n')
    writeFileSync(join(repo, 'old-name.ts'), 'x\n')
    git('add', '-A')
    git('commit', '-qm', 'init')

    writeFileSync(join(repo, 'src', 'foo.ts'), 'export const a = 2\n')
    git('add', 'src/foo.ts')
    writeFileSync(join(repo, 'src', 'foo.ts'), 'export const a = 3\n')      // 暂存 + 未暂存
    writeFileSync(join(repo, 'src', 'brand-new.ts'), 'new\n')              // 未跟踪
    rmSync(join(repo, 'tests', 'foo.test.ts'))                             // 删除
    git('mv', 'old-name.ts', 'new-name.ts')                                // 重命名

    const result = await createGitReader().read(repo)
    assert.equal(result.available, true, `真机读取必须成功（reason=${result.reason}）`)
    const byRel = new Map(result.files.map((f) => [f.rel, f]))
    assert.deepEqual(byRel.get('src/foo.ts').kinds, ['staged', 'unstaged'])
    assert.deepEqual(byRel.get('src/brand-new.ts').kinds, ['untracked'])
    assert.deepEqual(byRel.get('tests/foo.test.ts').kinds, ['deleted', 'unstaged'])
    assert.deepEqual(byRel.get('new-name.ts').kinds, ['renamed', 'staged'])
    assert.equal(byRel.get('new-name.ts').origRel, 'old-name.ts')
  } finally {
    if (repo) rmSync(repo, { recursive: true, force: true })
  }
  void t
})

test('真机：非仓库目录如实回 not-a-repo（用 os.tmpdir()，不碰任何真实项目）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-norepo-'))
  try {
    const result = await createGitReader().read(dir)
    assert.equal(result.available, false)
    assert.equal(result.reason, 'not-a-repo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真机：默认 exec 是 spawnGit，且它把「命令不存在」也收敛成结果而不是抛', async () => {
  const res = await spawnGit(['--version'], { cwd: tmpdir(), timeoutMs: 5000 })
  assert.equal(typeof res.code, 'number')
  assert.match(res.stdout, /git version/)
  // 拿一个不存在的可执行名不行（argv[0] 固定是 git），所以这里只证明「不抛 + 有上限参数」
  assert.equal(res.killed, null)
})

/* ── 3. 关联投影（纯函数）────────────────────────────── */

/** 手写一份最小候选集：代码互相 import、一个测试、一篇文档提到代码。 */
function candidateCorpus() {
  return [
    { rel: 'src/foo.ts', kind: 'code', head: "import { x } from './bar'\nexport const foo = x\n", mtimeMs: 1 },
    { rel: 'src/bar.ts', kind: 'code', head: 'export const x = 1\n', mtimeMs: 1 },
    { rel: 'tests/foo.test.ts', kind: 'code', head: "import { foo } from '../src/foo'\n", mtimeMs: 1 },
    { rel: 'docs/readme.md', kind: 'md', head: '# Doc\n\nsee src/foo.ts for details\n', mtimeMs: 1 },
    { rel: 'docs/other.md', kind: 'md', head: '# Other\n\nnothing to see\n', mtimeMs: 1 },
  ]
}

test('关联：四类证据都能从变更文件找出来，且每条都写明**起点 / 类型 / 行号**', () => {
  resetRelationCache()
  const corpus = candidateCorpus()
  const rels = new Set(corpus.map((d) => d.rel))
  const facts = buildRelationFacts(corpus, { root: '/t1' })
  const out = projectChangeRelated({ seeds: ['src/foo.ts'], incident: facts.incident, itemRels: rels })
  const byRel = new Map(out.related.map((r) => [r.rel, r]))

  assert.ok(byRel.has('src/bar.ts'), 'imports：foo 导入了 bar')
  // 方向的口径：`dir` 说的是**目标**这一侧的视角 —— `in` = 起点（变更文件）指向它
  assert.deepEqual(byRel.get('src/bar.ts').evidence[0], { type: 'imports', dir: 'in', other: 'src/foo.ts', line: 1 })
  assert.ok(byRel.has('tests/foo.test.ts'), 'tests：文件名约定（foo ↔ foo.test）')
  // 同一个目标可以**同时**有两条不同证据：这个测试既是被测关系（tests），又真的 import 了 foo
  const tEv = byRel.get('tests/foo.test.ts').evidence
  assert.ok(tEv.some((e) => e.type === 'tests'), 'tests：文件名约定那条必须在')
  assert.deepEqual(tEv.find((e) => e.type === 'tests'), { type: 'tests', dir: 'out', other: 'src/foo.ts' },
    'tests 这一类**没有行号** —— 证据是文件名约定，不编一个出来；叙述方是测试文件自己（所以是 out）')
  assert.ok(tEv.some((e) => e.type === 'imports' && e.line === 1), '同一个目标上的第二条证据（imports + 行号）也要在')
  assert.ok(byRel.has('docs/readme.md'), 'documents：文档提到了代码路径')
  assert.deepEqual(byRel.get('docs/readme.md').evidence[0], { type: 'documents', dir: 'out', other: 'src/foo.ts', line: 3 })
  assert.ok(!byRel.has('docs/other.md'), '没提到它的文档**不许**被拉进来')
  assert.deepEqual(out.unresolved, [], 'foo.ts 有证据 ⇒ 不算 unresolved')
})

test('关联：变更文件**自己**不当结果（这一区回答的是「还该看什么」）', () => {
  resetRelationCache()
  const corpus = candidateCorpus()
  const rels = new Set(corpus.map((d) => d.rel))
  const facts = buildRelationFacts(corpus, { root: '/t2' })
  // 两个文件都被改了：foo 与 bar 之间有 imports 边，但谁也不该出现在对方的关联结果里
  const out = projectChangeRelated({
    seeds: ['src/foo.ts', 'src/bar.ts'],
    incident: facts.incident,
    itemRels: rels,
    exclude: new Set(['src/foo.ts', 'src/bar.ts']),
  })
  const got = out.related.map((r) => r.rel)
  assert.ok(!got.includes('src/bar.ts'))
  assert.ok(!got.includes('src/foo.ts'))
  assert.ok(got.includes('tests/foo.test.ts'), '别的证据照常工作')
})

test('关联：**已删除**的文件也能当种子 —— 删掉测试，还能找回它的被测文件', () => {
  resetRelationCache()
  // 磁盘上只有 foo.ts（测试已经被删了）⇒ 候选集里没有 tests/foo.test.ts
  const corpus = candidateCorpus().filter((d) => d.rel !== 'tests/foo.test.ts')
  const rels = new Set(corpus.map((d) => d.rel))
  const changeSet = {
    available: true, reason: null, truncated: false, filesTotal: 1,
    files: [{ rel: 'tests/foo.test.ts', kinds: ['deleted', 'unstaged'] }],
  }
  const { seeds, gone, outside, seedRels } = splitSeeds(changeSet, rels)
  assert.deepEqual(seeds, [], '被删掉的文件不在候选集里')
  assert.deepEqual(gone, ['tests/foo.test.ts'])
  assert.deepEqual(outside, ['tests/foo.test.ts'], '它也要被算进「不在本档语料」的计数')
  assert.deepEqual(seedRels, ['tests/foo.test.ts'], '但它**仍然要当种子**')

  // 有合成候选 ⇒ 别人指向它的边解析得出来
  const withGhost = buildRelationFacts([...corpus, ...ghostCandidates(gone)], { root: '/t3' })
  const out = projectChangeRelated({ seeds: seedRels, incident: withGhost.incident, itemRels: rels })
  const byRel = new Map(out.related.map((r) => [r.rel, r]))
  assert.ok(byRel.has('src/foo.ts'), '删掉 tests/foo.test.ts ⇒ 它的被测文件 src/foo.ts 就是该一起看的')
  assert.deepEqual(byRel.get('src/foo.ts').evidence[0].type, 'tests')
  assert.equal(byRel.get('src/foo.ts').evidence[0].other, 'tests/foo.test.ts', '证据的起点是那个被删掉的文件')

  // 没有合成候选 ⇒ 一条都找不到（这正是加 ghost 的理由）
  resetRelationCache()
  const without = buildRelationFacts(corpus, { root: '/t3b' })
  const bare = projectChangeRelated({ seeds: ['tests/foo.test.ts'], incident: without.incident, itemRels: rels })
  assert.equal(bare.relatedTotal, 0, '证伪：不给合成候选时这条链是断的')
  assert.deepEqual(bare.unresolved, ['tests/foo.test.ts'])
})

test('关联：重命名**前后的两个路径**都当种子', () => {
  const rels = new Set(['new-name.ts', 'docs/readme.md'])
  const changeSet = {
    available: true, reason: null, truncated: false, filesTotal: 1,
    files: [{ rel: 'new-name.ts', kinds: ['renamed', 'staged'], origRel: 'old-name.ts' }],
  }
  const { seeds, seedRels, gone } = splitSeeds(changeSet, rels)
  assert.deepEqual(seeds, ['new-name.ts'], '新路径在候选集里 ⇒ 能当结果')
  assert.ok(seedRels.includes('new-name.ts'))
  assert.ok(seedRels.includes('old-name.ts'), '原路径也要去查（别人引用的还是旧名字）')
  assert.ok(!seeds.includes('old-name.ts'), '但原路径**不能当结果**（那个名字已经不存在了）')
  assert.deepEqual(gone, ['old-name.ts'])
})

test('关联：没有任何证据的变更文件如实进 unresolved，**不硬凑**', () => {
  resetRelationCache()
  const corpus = candidateCorpus()
  const rels = new Set(corpus.map((d) => d.rel))
  const facts = buildRelationFacts(corpus, { root: '/t4' })
  const out = projectChangeRelated({
    seeds: ['docs/other.md', 'src/foo.ts'],
    incident: facts.incident,
    itemRels: rels,
  })
  assert.deepEqual(out.unresolved, ['docs/other.md'], '没人提到它 ⇒ 如实说「没有证据」')
  assert.ok(out.related.length > 0)
})

test('关联：结果有条数上限，且排序是确定性的（同样的输入永远同样的顺序）', () => {
  resetRelationCache()
  const corpus = candidateCorpus()
  const rels = new Set(corpus.map((d) => d.rel))
  const facts = buildRelationFacts(corpus, { root: '/t5' })
  const a = projectChangeRelated({ seeds: ['src/foo.ts'], incident: facts.incident, itemRels: rels, limit: 2 })
  const b = projectChangeRelated({ seeds: ['src/foo.ts'], incident: facts.incident, itemRels: rels, limit: 2 })
  assert.deepEqual(a, b)
  assert.ok(a.related.length <= 2)
  assert.equal(a.relatedTotal, 3, 'relatedTotal 说的是**截断前**的总数（面板据此说「还有 N 条」）')
  assert.ok(MAX_CHANGE_RELATED >= 2)
})

/* ── 4. **接口隔离**：变更关联是一条独立接口，普通检索一个字节都不变 ─────────
   v0.25 第二轮：`/api/recent` 的响应与 v0.24 **逐字相同**（`changes` 这个键根本不存在），
   变更关联走 `/knit/api/changes`。下面三条就是那道闸门：
     ① 常规检索（含显式传旧选项）里不许出现任何变更字段；
     ② 新接口的结构是**专用**的（起点 / 目标 / 类型 / 行号），不借 Context Pack 的词汇；
     ③ 关闭时宿主不读 git（一次都不问）。 */

/** 一份最小的 `ranked`（`buildContextFor` 要的形状）。 */
function rankedCorpus() {
  return candidateCorpus().map((d, i) => ({
    ...d,
    raw: i === 0 ? 3 : 0,
    matchedTerms: i === 0 ? [{ term: 'foo', fields: { title: true, summary: false, body: false } }] : [],
  }))
}

test('隔离：常规检索载荷里**一个变更字段都没有**（连显式传旧选项也一样）', async () => {
  const ranked = rankedCorpus()
  const pack = await buildContextFor('/t6', {
    ranked, topic: 't', task: '', total: ranked.length, withRelations: false,
  })
  assert.ok(!('changes' in pack), 'Context Pack 里不许有 `changes`')
  // 把 v0.25 第一版用过的那两个选项**原样再传一遍** —— 现在它们应当是彻底的噪音
  const alsoOff = await buildContextFor('/t6', {
    ranked, topic: 't', task: '', total: ranked.length, withRelations: false,
    changes: true, changeCorpus: rankedCorpus(), gitReader: { read: async () => { throw new Error('不该被调用') } },
  })
  assert.ok(!('changes' in alsoOff), '传了旧选项也不许冒出来（这条路已经整体删掉了）')
  assert.deepEqual(alsoOff, pack, '两条路径的包必须逐字相同')
  // 变更词汇也不许在任何一层里出现
  const text = JSON.stringify(alsoOff)
  assert.ok(!/changeRelated|"provenance":"change"/.test(text), `包里不许出现变更词汇：${text.slice(0, 200)}`)
})

test('隔离：关闭时**一次 git 都不问**（独立接口自己才是唯一的 git 调用方）', async () => {
  const ranked = rankedCorpus()
  let reads = 0
  const counting = { read: async () => { reads += 1; return { available: true, reason: null, filesTotal: 0, files: [], truncated: false } } }
  await buildContextFor('/t11', {
    ranked, topic: 't', task: '', total: ranked.length, withRelations: false, gitReader: counting,
  })
  assert.equal(reads, 0, '默认路径：一个 git 进程都不 spawn')
  const payload = await changesPayload('/t11', { corpus: ranked, gitReader: counting })
  assert.equal(reads, 1, '独立接口：一次调用只问一次 git')
  assert.equal(payload.mode, 'changes')
})

test('隔离：新接口的结构是**专用**的 —— 起点 / 目标 / 类型 / 行号，不借 Context Pack 的词汇', async () => {
  resetRelationCache()
  const corpus = candidateCorpus()
  const payload = await changesPayload('/t7', {
    corpus,
    changeSet: {
      available: true, reason: null, truncated: false, filesTotal: 2,
      files: [
        { rel: 'src/foo.ts', kinds: ['unstaged'] },
        { rel: 'docs/other.md', kinds: ['untracked'] },
      ],
    },
  })
  // 顶层形状：**没有** `root` / `hostRoot`（绝对路径不外发），也**没有** `sort` / `kind`
  assert.deepEqual(Object.keys(payload).sort(),
    ['git', 'links', 'linksTotal', 'mode', 'ok', 'outOfScope', 'unresolved'].sort())
  assert.ok(!JSON.stringify(payload).includes('/t7'), '载荷里不许出现绝对路径（工作区相对路径足够）')
  assert.equal(payload.mode, 'changes')
  assert.equal(payload.git.available, true)
  assert.equal(payload.git.filesTotal, 2)
  // 顺序由 `git.js` 的解析保证（字典序）；这里注入的是手写 changeSet，所以只比集合
  assert.deepEqual(payload.git.files.map((f) => f.rel).sort(), ['docs/other.md', 'src/foo.ts'])
  // 变更文件自己不当结果；两条有证据的目标 + 两条证据行
  const byTarget = new Map(payload.links.map((l) => [l.target, l]))
  assert.ok(!byTarget.has('src/foo.ts'), '变更文件自己不当结果')
  assert.ok(!byTarget.has('docs/other.md'), '没有证据的变更文件不许硬凑成关联结果')
  assert.deepEqual([...byTarget.keys()].sort(), ['docs/readme.md', 'src/bar.ts', 'tests/foo.test.ts'])
  assert.equal(payload.linksTotal, 3)
  assert.deepEqual(payload.unresolved, ['docs/other.md'], '无证据的如实进 unresolved')
  assert.deepEqual(payload.outOfScope, [], '两条变更都在语料里 ⇒ 没有「不在检索范围」的')

  // 每一条：**起点 / 类型 / 方向 / 行号**四件齐全，且没有一个 Context Pack 的字段
  for (const link of payload.links) {
    assert.deepEqual(Object.keys(link).sort(),
      ['evidence', 'evidenceTotal', 'kind', 'mtimeMs', 'source', 'summary', 'target', 'title', 'types'].sort())
    assert.ok(!('provenance' in link) && !('reason' in link) && !('relations' in link),
      '不许借 Context Pack 条目的词汇（provenance / reason / relations）')
    assert.ok(link.evidence.length > 0, '没有证据就不该出现在这里')
    for (const e of link.evidence) {
      assert.deepEqual(Object.keys(e).sort(), ['dir', 'line', 'origin', 'type'])
      assert.equal(e.origin, 'src/foo.ts', '起点必须是那个**被改过的**文件')
      assert.ok(['references', 'imports', 'tests', 'documents'].includes(e.type), `关系类型 ${e.type}`)
      assert.ok(e.line === null || Number.isInteger(e.line), '行号要么是真实整数、要么是 null')
    }
  }
  // `tests` 是文件名约定 ⇒ `line` 必须是 `null`（不是 0、不是省略）
  const testsEv = byTarget.get('tests/foo.test.ts').evidence.find((e) => e.type === 'tests')
  assert.equal(testsEv.line, null, 'tests 这一类没有行号，专用结构里如实给 null')
  // imports / documents 有真行号
  assert.deepEqual(byTarget.get('src/bar.ts').evidence[0], { origin: 'src/foo.ts', type: 'imports', dir: 'in', line: 1 })
  assert.deepEqual(byTarget.get('docs/readme.md').evidence[0], { origin: 'src/foo.ts', type: 'documents', dir: 'out', line: 3 })
})

test('隔离：读不到 git / 非 Git / 没有关联 —— 三种降级都安全且结构齐全', async () => {
  const corpus = candidateCorpus()
  // ① 非 Git：`git.available=false` + 原因，links 空，但仍然是一份**结构齐全**的载荷
  const noRepo = await changesPayload('/t8', {
    corpus,
    changeSet: { available: false, reason: 'not-a-repo', files: [], filesTotal: 0, truncated: false },
  })
  assert.equal(noRepo.ok, true)
  assert.equal(noRepo.git.available, false)
  assert.equal(noRepo.git.reason, 'not-a-repo')
  assert.deepEqual(noRepo.links, [])
  assert.deepEqual(noRepo.unresolved, [])
  assert.equal(noRepo.linksTotal, 0)
  // ② 一条变更都没有
  const clean = await changesPayload('/t9', {
    corpus,
    changeSet: { available: true, reason: null, files: [], filesTotal: 0, truncated: false },
  })
  assert.equal(clean.git.available, true)
  assert.equal(clean.git.filesTotal, 0)
  assert.deepEqual(clean.links, [])
  // ③ 有变更但一条关联都没有（全是语料之外的路径）
  const none = await changesPayload('/t10', {
    corpus,
    changeSet: {
      available: true, reason: null, truncated: false, filesTotal: 1,
      files: [{ rel: 'zz/nowhere.ts', kinds: ['untracked'] }],
    },
  })
  assert.deepEqual(none.links, [], '一条证据都没有 ⇒ 一条结果都不给')
  assert.deepEqual(none.outOfScope, ['zz/nowhere.ts'], '语料之外 ⇒ 只进 outOfScope')
  assert.deepEqual(none.unresolved, [], '语料之外的**不算** unresolved（两个计数不许重复算同一篇）')
})

test('隔离：下发的变更清单有上限，但 `filesTotal` 仍是**全量**（不许因为截断少报）', async () => {
  const many = Array.from({ length: MAX_REPORTED_FILES + 10 }, (_, i) => ({ rel: `f${i}.ts`, kinds: ['unstaged'] }))
  const payload = await changesPayload('/t10', {
    corpus: rankedCorpus(),
    changeSet: { available: true, reason: null, files: many, filesTotal: many.length, truncated: false },
  })
  assert.equal(payload.git.files.length, MAX_REPORTED_FILES, '载荷里只带前 N 个（体积有界）')
  assert.equal(payload.git.filesTotal, many.length, '但计数是全量')
})

test('隔离：**几百个变更文件**也不会放大输出 —— 清单 / 结果 / 证据各有一道上限', async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ rel: `zz/not-in-corpus-${i}.ts`, kinds: ['unstaged'] }))
  const payload = await changesPayload('/t12', {
    corpus: rankedCorpus(),
    changeSet: { available: true, reason: null, truncated: false, files: many, filesTotal: many.length },
  })
  assert.equal(payload.git.files.length, MAX_REPORTED_FILES)
  assert.equal(payload.git.filesTotal, 300)
  assert.ok(payload.links.length <= MAX_CHANGE_RELATED, '关联结果有上限')
  assert.equal(payload.outOfScope.length, 300, '300 条全都不在语料里 —— 如实计数，不硬凑')
  assert.deepEqual(payload.links, [])
})

/* ── 5. 复用：两个接口**共用**一次扫描与一次 git（不重复 walk、不重复 spawn）── */

test('复用：`scan()` 记一份备忘，独立接口**直接复用**它（TTL 内不再走目录树）', async () => {
  const repo = makeAcceptanceRepo()
  try {
    resetScanMemo()
    assert.equal(scanMemo(), null, '清掉之后没有可复用的扫描')
    const session = {
      header: { cwd: repo, id: 'memo' },
      snapshotEvents: () => [],
    }
    const payload = await scan(repo, 40, { session, sessionId: 'memo-1', sort: 'relevance', kind: 'context' })
    const memo = scanMemo()
    assert.equal(memo.root, repo, '扫完就记下这个工作区')

    // **可观测的复用证明**：把一个文件删掉，再问一次语料 —— 复用的那份里**仍然**有它
    // （如果这里重新走了目录树，它就该消失了）。
    rmSync(join(repo, 'docs', 'guide.md'))
    const reused = await corpusForChanges(repo, { limit: 40, options: { session, sessionId: 'memo-2', sort: 'relevance', kind: 'context' } })
    assert.ok(reused.contextCorpus.some((d) => d.rel === 'docs/guide.md'),
      'TTL 内复用的是**同一份**语料（没有重新 walk）')
    assert.equal(reused, payload, '复用的就是同一个对象（连引用都相同）')

    // 清掉备忘之后必须真扫 —— 这时那个文件才该消失（证明上面那条不是「怎么扫都还在」）
    resetScanMemo()
    const fresh = await corpusForChanges(repo, { limit: 40, options: { session, sessionId: 'memo-3', sort: 'relevance', kind: 'context' } })
    assert.ok(!fresh.contextCorpus.some((d) => d.rel === 'docs/guide.md'), '清掉备忘后真的重扫，删掉的文件不再出现')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('接线：`contextCorpus` 是内部字段，`publicScanPayload()` 必须把它剥掉', () => {
  const payload = {
    ok: true, docs: [], contextCorpus: [{ rel: 'a.ts' }], ranked: [], task: '', allDocs: [], stats: {},
  }
  const pub = publicScanPayload(payload)
  assert.ok(!('contextCorpus' in pub), '内部候选集不下发')
  assert.ok(!('ranked' in pub) && !('allDocs' in pub) && !('stats' in pub) && !('task' in pub))
  assert.equal(pub.ok, true)
})

/* ── 6. **契约守卫**：这个功能**不许**渗进 agent 工具 ─────────────
   `knit_docs` 的输入 / 输出 schema 是既有接口契约（`additionalProperties: false`）。
   把「Git 变更关联」做成平行区时，它只走**面板那一侧**（HTTP 的 `context.changes`）；
   工具那一侧的入参、返回值与 `ITEM_SCHEMA` 一个字节都不许动。下面这条就是那道闸门。 */

test('契约：`knit_docs` 的入参与输出 schema **完全没变**（这个功能不进 agent 工具）', () => {
  const definition = knitDocsDefinition(() => {})
  assert.deepEqual(Object.keys(definition.parameters.properties), ['query', 'limit', 'audit', 'retrieval'],
    '参数集合不许变（变更关联没有 `changes` 这个参数）')
  assert.equal(definition.parameters.properties.changes, undefined)
  // 输出 schema：多一个属性就会在**校验层**静默失败（v0.14 的 kind 那次教训）
  assert.equal(definition.output.schema.properties.changes, undefined, '输出里不许有 `changes`')
  assert.deepEqual(definition.output.schema.required,
    ['mode', 'topic', 'total', 'primary', 'supporting', 'related'])
  for (const tier of ['primary', 'supporting', 'related', 'pinned']) {
    const items = definition.output.schema.properties[tier].items
    assert.deepEqual(items.properties.provenance.enum, ['retrieval', 'relation', 'manual', 'semantic'],
      `${tier}：来源枚举不许扩（change 不进契约）`)
    assert.ok(!items.properties.reason.properties.code.enum.includes('changeRelated'),
      `${tier}：理由码枚举不许扩（changeRelated 不进契约）`)
  }
})

/* ── 7. 解析边界：NUL 分隔、空格 / 换行文件名、重命名、前缀过滤与截断顺序 ── */

test('解析：文件名含**空格**与**换行**时按 NUL 切分仍然正确（`-z` 不转义）', () => {
  const raw = 'M  src/a b.ts\0?? weird\nname.ts\0?? tab\tname.ts\0'
  const files = parseStatusZ(raw)
  assert.deepEqual(files.map((f) => f.rel).sort(), ['src/a b.ts', 'tab\tname.ts', 'weird\nname.ts'].sort())
  const byRel = new Map(files.map((f) => [f.rel, f]))
  assert.deepEqual(byRel.get('src/a b.ts').kinds, ['staged'])
  assert.deepEqual(byRel.get('weird\nname.ts').kinds, ['untracked'])
})

test('解析：重命名只吃**紧跟其后的那一个**原路径字段（后面的条目不许被吃掉）', () => {
  const raw = 'R  new name.ts\0old name.ts\0M  after.ts\0R  b.ts\0a.ts\0'
  const files = parseStatusZ(raw)
  assert.deepEqual(files.map((f) => f.rel), ['after.ts', 'b.ts', 'new name.ts'])
  const byRel = new Map(files.map((f) => [f.rel, f]))
  assert.equal(byRel.get('new name.ts').origRel, 'old name.ts')
  assert.equal(byRel.get('b.ts').origRel, 'a.ts')
  assert.equal(byRel.get('after.ts').origRel, undefined, '普通条目不许被前一条的重命名字段串位')
})

test('解析：**先按工作区前缀过滤、再算条目数** —— 工作区外的条目不许占用 200 条上限', () => {
  const outside = Array.from({ length: 250 }, (_, i) => `M  outside/f${String(i).padStart(4, '0')}.ts`).join('\0') + '\0'
  const inside = Array.from({ length: 5 }, (_, i) => `M  src/keep${i}.ts`).join('\0') + '\0'
  const files = parseStatusZ(outside + inside, { prefix: 'src/' })
  assert.equal(files.length, 5, '前缀之外的 250 条都被丢掉，不占上限')
  assert.ok(files.every((f) => f.rel.startsWith('keep')))

  const capped = parseStatusZ(
    Array.from({ length: MAX_CHANGED_FILES + 7 }, (_, i) => `M  src/f${String(i).padStart(4, '0')}.ts`).join('\0') + '\0',
  )
  assert.equal(capped.length, MAX_CHANGED_FILES + 7, '`parseStatusZ` 自己**不截断**（截断是读取器的事）')
})

test('读取器：截断发生在前缀过滤**之后**（截到的是这个工作区的文件）', async () => {
  const outside = Array.from({ length: 260 }, (_, i) => `M  outside/f${String(i).padStart(4, '0')}.ts`).join('\0') + '\0'
  const inside = Array.from({ length: 12 }, (_, i) => `M  src/keep${i}.ts`).join('\0') + '\0'
  const impl = async (args) => (args.includes('rev-parse')
    ? { code: 0, stdout: 'src/\n', stderr: '' }
    : { code: 0, stdout: outside + inside, stderr: '' })
  const result = await createGitReader({ exec: impl, now: () => 0 }).read('/w')
  assert.equal(result.truncated, false, '工作区内只有 12 条 ⇒ 不截断')
  assert.equal(result.filesTotal, 12)
  assert.ok(result.files.every((f) => f.rel.startsWith('keep')))
})

/* ── 8. 安全边界：**真机**证明 fsmonitor 钩子不会被拉起 ─────────
   这一条是「只读」这条承诺的闭合处：固定 argv 只挡住我们主动写，
   挡不住 git 被 `core.fsmonitor` 牵着去执行外部命令 / 起守护进程。 */

test('安全（真机）：`core.fsmonitor` 指向外部钩子时，我们的读取**不会**执行它', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'knit-git-fsmon-'))
  const log = join(repo, 'hook-ran.log')
  const hook = join(repo, 'fsmonitor.sh')
  try {
    writeFileSync(hook, `#!/bin/sh\necho ran >> ${log}\n echo "/"\n`, { mode: 0o755 })
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.ts'), 'x\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    git('config', 'core.fsmonitor', hook)

    const result = await createGitReader({ now: () => 0 }).read(repo)
    assert.equal(result.available, true, `读取必须成功（reason=${result.reason}）`)
    let ran = true
    try { readFileSync(log) } catch { ran = false }
    assert.equal(ran, false, '`core.fsmonitor` 的钩子**一次都不许被执行**（-c core.fsmonitor=false）')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/* ── 9. 独立验收案例：一个**确定性的临时仓库**，只改一个文件 ─────────
   它不是「在脏工作区上跑一遍」，而是一份**受控**夹具：唯一的变更文件 = `src/foo.ts`，
   四类关系里预置三类（imports / tests / documents）+ 一组**干扰项**。
   每个结果的起点、目标、类型、行号都要能回到原文核对；干扰项一个都不许进来。 */

/**
 * 造出这一份夹具 → 返回仓库路径（调用方负责 `rmSync`）。
 *
 * @param {{extraTest?: boolean}} [options] - `extraTest` 会在**初始提交之前**再放一个
 *   `src/foo.test.ts`（用来验「同名测试出现在两个候选位置」时的方向性）。
 *   ⚠️ 必须写在初始提交之前 —— 测试里再 `git add -A && commit` 会把那一处变更一起提交掉，
 *   工作树因此变干净、变更集为空（第一版这么写错过一次）。
 */
function makeAcceptanceRepo(options = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'knit-git-case-'))
  const w = (rel, text) => {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')

  // 变更文件：第 1 行就是 import（行号证据）
  w('src/foo.ts', "import { b } from './bar'\nexport const foo = () => b + 1\n")
  w('src/bar.ts', 'export const b = 1\n')
  // ⚠️ 测试文件的目录必须是 `test/`（`testsOf()` 的候选只有 `<dir>/` 与 `test/`）
  w('test/foo.test.ts', "import { foo } from '../src/foo'\nexport const t = foo()\n")
  w('docs/guide.md', '# Guide\n\nsee src/foo.ts for details\n')
  // 干扰项：谁都不引用、也不 import 谁
  w('src/util.ts', 'export const u = 2\n')
  w('src/other.ts', 'export const o = 3\n')
  w('test/other.test.ts', "import { o } from '../src/other'\n")
  w('docs/notes.md', '# Notes\n\nnothing about code here\n')
  // 同名测试的第二个候选位置（只由 `extraTest` 用例打开）
  if (options.extraTest === true) w('src/foo.test.ts', "import './foo'\n")
  git('add', '-A')
  git('commit', '-qm', 'init')
  // **只**改 src/foo.ts（暂存 + 未暂存都占上）
  w('src/foo.ts', "import { b } from './bar'\nexport const foo = () => b + 2\n")
  git('add', 'src/foo.ts')
  w('src/foo.ts', "import { b } from './bar'\nexport const foo = () => b + 3\n")
  return repo
}

test('独立案例：只改 `src/foo.ts` ⇒ 精确找到它的测试 / 被导入模块 / 提到它的文档，干扰项一个不进', async () => {
  const repo = makeAcceptanceRepo()
  try {
    const session = {
      header: { cwd: repo, id: 'accept' },
      // 任务原话**刻意与这些文件无关**：变更关联不该依赖对话提到什么
      snapshotEvents: () => [{ seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '天气 阴天 出门带伞' }], source: { kind: 'user' } } }],
    }
    const payload = await scan(repo, 40, { session, sessionId: 'accept-1', sort: 'relevance', kind: 'context' })
    const off = await buildContextFor(repo, { ranked: payload.ranked, topic: payload.topic, task: payload.task, total: payload.total })
    // v0.25 第二轮：变更关联走**独立接口**（这里是它的载荷构造函数，等价于 `/api/changes` 的内核）
    const on = await changesPayload(repo, { corpus: payload.contextCorpus })

    // ① git 事实：**只有**一个变更文件，而且是暂存 + 未暂存都占
    assert.equal(on.git.available, true, `git 读取必须成功（reason=${on.git.reason}）`)
    assert.equal(on.git.filesTotal, 1, `只改了一个文件，实测 ${JSON.stringify(on.git.files.map((f) => f.rel))}`)
    assert.deepEqual(on.git.files.map((f) => f.rel), ['src/foo.ts'])
    assert.deepEqual(on.git.files[0].kinds, ['staged', 'unstaged'])

    // ② 关联结果**恰好**是这三条（多一条都算误报）
    const got = on.links.map((i) => i.target).sort()
    assert.deepEqual(got, ['docs/guide.md', 'src/bar.ts', 'test/foo.test.ts'],
      `结果集合必须精确：${JSON.stringify(got)}`)
    // ③ 干扰项一个都不许进来
    for (const noise of ['src/util.ts', 'src/other.ts', 'test/other.test.ts', 'docs/notes.md']) {
      assert.ok(!got.includes(noise), `没有证据的文件不许被标成关联结果：${noise}`)
    }
    assert.deepEqual(on.unresolved, [], 'foo.ts 有证据 ⇒ 不算 unresolved')
    assert.equal(on.linksTotal, 3)

    // ④ 每条证据的**起点 / 类型 / 行号**都要与原文一致
    const readLine = (rel, line) => readFileSync(join(repo, rel), 'utf8').split('\n')[line - 1]
    const byRel = new Map(on.links.map((i) => [i.target, i]))
    const evOf = (rel, type) => byRel.get(rel).evidence.find((e) => e.type === type)

    const imp = evOf('src/bar.ts', 'imports')
    assert.deepEqual({ type: imp.type, dir: imp.dir, origin: imp.origin, line: imp.line },
      { type: 'imports', dir: 'in', origin: 'src/foo.ts', line: 1 })
    assert.match(readLine('src/foo.ts', imp.line), /from '\.\/bar'/, '行号指的必须真是那一行')

    const tst = evOf('test/foo.test.ts', 'tests')
    assert.deepEqual({ type: tst.type, dir: tst.dir, origin: tst.origin }, { type: 'tests', dir: 'out', origin: 'src/foo.ts' })
    assert.equal(tst.line, null, 'tests 是文件名约定 ⇒ 如实给 null，**不许**编一个行号')

    const doc = evOf('docs/guide.md', 'documents')
    assert.deepEqual({ type: doc.type, dir: doc.dir, origin: doc.origin, line: doc.line },
      { type: 'documents', dir: 'out', origin: 'src/foo.ts', line: 3 })
    assert.match(readLine('docs/guide.md', doc.line), /src\/foo\.ts/, '文档那一行必须真的提到它')

    // ⑤ 每一条证据的起点都必须是那个**变更文件**（不许拿别的文件当起点）
    for (const link of on.links) {
      for (const e of link.evidence) assert.equal(e.origin, 'src/foo.ts', `${link.target} 的证据起点错了`)
      assert.ok(!('provenance' in link) && !('reason' in link), '专用结构里没有 Context Pack 的词汇')
    }
    // ⑥ 变更文件**自己**不当结果
    assert.ok(!got.includes('src/foo.ts'))

    // ⑦ 原有行为：独立接口**完全不碰** Context Pack（三层的唯一来源是 `buildContextFor`）
    assert.ok(!('changes' in off), '默认路径连这个键都不该有')
    assert.ok(!('links' in off) && !('git' in off), '包与独立接口的载荷是两套结构')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('独立案例（约定边界）：同名测试有两个候选位置时，边**只从测试那一侧**建立', async () => {
  // 语义（读 `relations.js` 的实现得出，不是猜的）：
  //   · `testsOf(源文件)` 会去 `<dir>/x.test.*` 与 `test/x.test.*` 两处找 —— **两个都在 ⇒ 歧义 ⇒ null**；
  //   · `testsOf(测试文件)` 按 stem 找唯一同名非测试文件 —— 唯一 ⇒ 认。
  //   所以「源 → 测试」那一侧不猜，而每个测试文件各自**唯一地**指向它的被测文件，那条边照常成立。
  //   这是可核验的路径事实（文件名一致），不是推断；本用例把这个方向性钉住。
  const repo = makeAcceptanceRepo({ extraTest: true })
  try {
    const session = {
      header: { cwd: repo, id: 'accept2' },
      snapshotEvents: () => [{ seq: 1, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '天气 阴天 出门带伞' }], source: { kind: 'user' } } }],
    }
    const payload = await scan(repo, 40, { session, sessionId: 'accept-2', sort: 'relevance', kind: 'context' })
    const on = await changesPayload(repo, { corpus: payload.contextCorpus })

    // ① 两个测试文件**各自**都指向 src/foo.ts（这就是要的结果：两个都该看）
    const testsTargets = on.links
      .filter((i) => i.evidence.some((e) => e.type === 'tests'))
      .map((i) => i.target)
      .sort()
    assert.deepEqual(testsTargets, ['src/foo.test.ts', 'test/foo.test.ts'],
      `两个同名测试都该被找出来：${JSON.stringify(testsTargets)}`)
    for (const link of on.links) {
      for (const e of link.evidence.filter((x) => x.type === 'tests')) {
        assert.equal(e.origin, 'src/foo.ts', 'tests 边的起点永远是**测试文件自己**（叙述方）')
        assert.equal(e.line, null, 'tests 不给行号（专用结构里是 null）')
      }
    }
    // ② 反向（源 → 测试）确实是歧义的：这一侧**不猜**，回 null
    assert.equal(
      testsOf('src/foo.ts', createIndex(['src/foo.ts', 'src/foo.test.ts', 'test/foo.test.ts'])),
      null,
      '两个候选位置都在 ⇒ 源→测试这一侧不许猜',
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('真机：工作区是仓库的**子目录**时，路径按工作区基准给出，工作区之外的改动被丢掉', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'knit-git-sub-'))
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    mkdirSync(join(repo, 'app', 'src'), { recursive: true })
    mkdirSync(join(repo, 'outside'), { recursive: true })
    writeFileSync(join(repo, 'app', 'src', 'in.ts'), 'a\n')
    writeFileSync(join(repo, 'outside', 'out.ts'), 'b\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'app', 'src', 'in.ts'), 'a2\n')
    writeFileSync(join(repo, 'outside', 'out.ts'), 'b2\n')
    // 工作区根 = 仓库里的 app/ 子目录
    const result = await createGitReader({ now: () => 0 }).read(join(repo, 'app'))
    assert.equal(result.available, true, `子目录也必须能读（reason=${result.reason}）`)
    assert.deepEqual(result.files.map((f) => f.rel), ['src/in.ts'],
      `只报工作区内的那条，且路径**不含** app/ 前缀：${JSON.stringify(result.files.map((f) => f.rel))}`)
    assert.equal(result.filesTotal, 1, '工作区外那条不许计入')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/* ── 10. **真接口**：在真实回环端口上验 `/api/changes` 与 `/api/recent` 的隔离 ─────
   前面那些用例验的是载荷构造函数（等价于路由内核）；这一条验**接口本身**：
   路由存在、query 解析、响应形状、以及「常规检索请求里没有变更字段」这条隔离纪律。 */

test('独立接口（真端口）：`/api/changes` 返回夹具里那三条关联，且 `/api/recent` 完全不受影响', async () => {
  const repo = makeAcceptanceRepo()
  let server
  try {
    server = await startKnitServer({ root: repo, sessionId: 's' })
    // ① 常规检索：**一个变更字段都没有**
    const recent = await (await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&kind=doc&limit=40`)).json()
    assert.equal(recent.ok, true)
    assert.ok(!('changes' in recent), '`/api/recent` 顶层不许有 changes')
    assert.ok(!('changes' in (recent.context || {})), '`context` 里也不许有')
    assert.ok(!/changeRelated|"provenance":"change"/.test(JSON.stringify(recent.context || {})), '包里不许有变更词汇')

    // ② 独立接口：三条关联，起点 / 类型 / 行号逐条对得上
    const res = await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&kind=doc&limit=40`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, 'changes')
    assert.equal(body.git.available, true)
    assert.equal(body.git.filesTotal, 1)
    assert.deepEqual(body.git.files.map((f) => f.rel), ['src/foo.ts'])
    assert.deepEqual(body.links.map((l) => l.target).sort(), ['docs/guide.md', 'src/bar.ts', 'test/foo.test.ts'])
    assert.equal(body.linksTotal, 3)
    const byTarget = new Map(body.links.map((l) => [l.target, l]))
    assert.deepEqual(byTarget.get('src/bar.ts').evidence[0], { origin: 'src/foo.ts', type: 'imports', dir: 'in', line: 1 })
    assert.deepEqual(byTarget.get('docs/guide.md').evidence[0], { origin: 'src/foo.ts', type: 'documents', dir: 'out', line: 3 })
    const tEv = byTarget.get('test/foo.test.ts').evidence.find((e) => e.type === 'tests')
    assert.equal(tEv.line, null, 'tests 那一类没有行号 ⇒ null')
    // 干扰项一个都不许进来
    for (const noise of ['src/util.ts', 'src/other.ts', 'test/other.test.ts', 'docs/notes.md']) {
      assert.ok(!byTarget.has(noise), `误报：${noise}`)
    }

    // ③ 时间序：如实说「这条口径下没有变更关联」，不是空壳
    const timeBody = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=time`)).json()
    assert.equal(timeBody.ok, true)
    assert.equal(timeBody.git.available, false)
    assert.equal(timeBody.git.reason, 'not-relevance-order')
    assert.deepEqual(timeBody.links, [])
  } finally {
    if (server) await server.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('独立接口（真端口）：**非 Git 工作区**安全降级，`/api/recent` 照旧可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-nogit-'))
  let server
  try {
    writeFileSync(join(dir, 'a.md'), '# a\n\nhello\n')
    server = await startKnitServer({ root: dir, sessionId: 's' })
    const recent = await (await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&limit=10`)).json()
    assert.equal(recent.ok, true, '非 Git 工作区里列表这条路必须照常')
    assert.ok(Array.isArray(recent.docs))
    const body = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&limit=10`)).json()
    assert.equal(body.ok, true)
    assert.equal(body.git.available, false)
    assert.equal(body.git.reason, 'not-a-repo')
    assert.deepEqual(body.links, [])
    assert.deepEqual(body.unresolved, [])
    assert.deepEqual(body.outOfScope, [])
  } finally {
    if (server) await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('独立接口（真端口）：同窗内两个接口**共用**一次扫描与一次 git —— 说清「为什么相同」', async () => {
  /* 这个用例的**前置状态 / 命中结果 / 清掉之后的结果**必须逐段写清，否则「结果相同」
     证明不了复用。三段是：
       ① 前置：`/api/recent` 先扫一次（备忘建立）→ `/api/changes` 再读一次 git（缓存建立）；
       ② 缓存热：**在扫描之后**把 `docs/guide.md` 删掉，两条接口都还按**旧快照**回答 ——
          它仍是被关联目标（语料里还有它），而删除**没有**进变更集（git 也没重读）；
       ③ 缓存冷：把扫描备忘与 git 缓存都清掉之后再问 —— 删除**必须**同时出现在两处：
          它不再是关联目标，而且变成第二条变更（`deleted`）。
     只有 ②③ 都在，才能说 ② 的「看不见」是缓存造成的，而不是接口对文件增删无感。 */
  const repo = makeAcceptanceRepo()
  let server
  try {
    server = await startKnitServer({ root: repo, sessionId: 's' })
    const url = `${server.base}/api/changes?sessionId=s&sort=relevance&limit=40`
    const expected = ['docs/guide.md', 'src/bar.ts', 'test/foo.test.ts']

    // ① 前置：扫描（recent）+ git（changes）
    await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&kind=doc&limit=40`)
    const memoAt = scanMemo().at
    const before = await (await fetch(url)).json()
    assert.deepEqual(before.links.map((l) => l.target).sort(), expected)
    assert.equal(before.git.filesTotal, 1)
    assert.equal(scanMemo().at, memoAt, '这次请求**没有**重新扫（备忘时间戳没变）—— 这就是复用的直接证据')

    // ② 缓存热：删掉那个「提到过 foo.ts 的文档」
    rmSync(join(repo, 'docs', 'guide.md'))
    const after = await (await fetch(url)).json()
    assert.equal(scanMemo().at, memoAt, '仍然没有重扫')
    assert.deepEqual(after.links.map((l) => l.target).sort(), expected,
      '语料还是旧快照 ⇒ guide.md 仍能当被关联目标')
    assert.equal(after.git.filesTotal, 1,
      'git 也是旧快照 ⇒ 这次删除还没有变成第二条变更（它确实是一次已提交文件的删除）')

    // ③ 缓存冷：两个缓存都清掉，同一份请求必须**同时**反映那次删除
    resetScanMemo()
    resetGitReaderCache()
    const fresh = await (await fetch(url)).json()
    assert.ok(scanMemo() && scanMemo().at > memoAt, '清掉备忘后真的重扫了')
    assert.ok(!fresh.links.some((l) => l.target === 'docs/guide.md'),
      '重扫之后语料里没有它了 ⇒ 不再是被关联目标')
    assert.equal(fresh.git.filesTotal, 2, '重读 git 之后这次删除变成第二条变更（deleted）')
    assert.ok(fresh.git.files.some((f) => f.rel === 'docs/guide.md' && f.kinds.includes('deleted')),
      '而且它自己是 `deleted` —— 变更文件自己不当结果，所以它只出现在 git 清单里')
    assert.ok(!fresh.links.some((l) => l.target === 'docs/guide.md'))
  } finally {
    if (server) await server.close()
    resetScanMemo()
    resetGitReaderCache()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('独立接口（真端口）：`kind` 已从契约里删除，传了也**不改变任何结果**', async () => {
  // 删掉它的理由要能被验证：变更关联固定用「文档 + 代码」那一份**不分档**语料，
  // 档位只切列表那一栏。所以带不带 `kind`、带哪个值，答案必须逐字相同。
  const repo = makeAcceptanceRepo()
  let server
  try {
    server = await startKnitServer({ root: repo, sessionId: 's' })
    resetScanMemo()
    const bare = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&limit=40`)).json()
    const withKind = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&limit=40&kind=media`)).json()
    assert.deepEqual(withKind.links, bare.links, '`kind=media` 与不带参数必须给出同样的关联')
    assert.deepEqual(withKind.git, bare.git)
    // 绝对路径一个都不许出现在响应体里
    assert.ok(!JSON.stringify(bare).includes(repo), '响应里不许有绝对路径')
  } finally {
    if (server) await server.close()
    resetScanMemo()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('真机：工作区是仓库的**子目录**时，路径按工作区基准给出，工作区之外的改动被丢掉', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'knit-git-sub-'))
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    mkdirSync(join(repo, 'app', 'src'), { recursive: true })
    mkdirSync(join(repo, 'outside'), { recursive: true })
    writeFileSync(join(repo, 'app', 'src', 'in.ts'), 'a\n')
    writeFileSync(join(repo, 'outside', 'out.ts'), 'b\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'app', 'src', 'in.ts'), 'a2\n')
    writeFileSync(join(repo, 'outside', 'out.ts'), 'b2\n')
    // 工作区根 = 仓库里的 app/ 子目录
    const result = await createGitReader({ now: () => 0 }).read(join(repo, 'app'))
    assert.equal(result.available, true, `子目录也必须能读（reason=${result.reason}）`)
    assert.deepEqual(result.files.map((f) => f.rel), ['src/in.ts'],
      `只报工作区内的那条，且路径**不含** app/ 前缀：${JSON.stringify(result.files.map((f) => f.rel))}`)
    assert.equal(result.filesTotal, 1, '工作区外那条不许计入')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

/* ── 10. **真接口**：在真实回环端口上验 `/api/changes` 与 `/api/recent` 的隔离 ─────
   前面那些用例验的是载荷构造函数（等价于路由内核）；这一条验**接口本身**：
   路由存在、query 解析、响应形状、以及「常规检索请求里没有变更字段」这条隔离纪律。 */

test('独立接口（真端口）：`/api/changes` 返回夹具里那三条关联，且 `/api/recent` 完全不受影响', async () => {
  const repo = makeAcceptanceRepo()
  let server
  try {
    server = await startKnitServer({ root: repo, sessionId: 's' })
    // ① 常规检索：**一个变更字段都没有**
    const recent = await (await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&kind=doc&limit=40`)).json()
    assert.equal(recent.ok, true)
    assert.ok(!('changes' in recent), '`/api/recent` 顶层不许有 changes')
    assert.ok(!('changes' in (recent.context || {})), '`context` 里也不许有')
    assert.ok(!/changeRelated|"provenance":"change"/.test(JSON.stringify(recent.context || {})), '包里不许有变更词汇')

    // ② 独立接口：三条关联，起点 / 类型 / 行号逐条对得上
    const res = await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&kind=doc&limit=40`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.mode, 'changes')
    assert.equal(body.git.available, true)
    assert.equal(body.git.filesTotal, 1)
    assert.deepEqual(body.git.files.map((f) => f.rel), ['src/foo.ts'])
    assert.deepEqual(body.links.map((l) => l.target).sort(), ['docs/guide.md', 'src/bar.ts', 'test/foo.test.ts'])
    assert.equal(body.linksTotal, 3)
    const byTarget = new Map(body.links.map((l) => [l.target, l]))
    assert.deepEqual(byTarget.get('src/bar.ts').evidence[0], { origin: 'src/foo.ts', type: 'imports', dir: 'in', line: 1 })
    assert.deepEqual(byTarget.get('docs/guide.md').evidence[0], { origin: 'src/foo.ts', type: 'documents', dir: 'out', line: 3 })
    const tEv = byTarget.get('test/foo.test.ts').evidence.find((e) => e.type === 'tests')
    assert.equal(tEv.line, null, 'tests 那一类没有行号 ⇒ null')
    // 干扰项一个都不许进来
    for (const noise of ['src/util.ts', 'src/other.ts', 'test/other.test.ts', 'docs/notes.md']) {
      assert.ok(!byTarget.has(noise), `误报：${noise}`)
    }

    // ③ 时间序：如实说「这条口径下没有变更关联」，不是空壳
    const timeBody = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=time`)).json()
    assert.equal(timeBody.ok, true)
    assert.equal(timeBody.git.available, false)
    assert.equal(timeBody.git.reason, 'not-relevance-order')
    assert.deepEqual(timeBody.links, [])
  } finally {
    if (server) await server.close()
    rmSync(repo, { recursive: true, force: true })
  }
})

test('独立接口（真端口）：**非 Git 工作区**安全降级，`/api/recent` 照旧可用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-nogit-'))
  let server
  try {
    writeFileSync(join(dir, 'a.md'), '# a\n\nhello\n')
    server = await startKnitServer({ root: dir, sessionId: 's' })
    const recent = await (await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&limit=10`)).json()
    assert.equal(recent.ok, true, '非 Git 工作区里列表这条路必须照常')
    assert.ok(Array.isArray(recent.docs))
    const body = await (await fetch(`${server.base}/api/changes?sessionId=s&sort=relevance&limit=10`)).json()
    assert.equal(body.ok, true)
    assert.equal(body.git.available, false)
    assert.equal(body.git.reason, 'not-a-repo')
    assert.deepEqual(body.links, [])
    assert.deepEqual(body.unresolved, [])
    assert.deepEqual(body.outOfScope, [])
  } finally {
    if (server) await server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('独立接口（真端口）：同窗内两个接口**共用**一次扫描与一次 git —— 删掉一个文件都看不见', async () => {
  const repo = makeAcceptanceRepo()
  let server
  try {
    server = await startKnitServer({ root: repo, sessionId: 's' })
    const url = `${server.base}/api/changes?sessionId=s&sort=relevance&kind=doc&limit=40`
    const expected = ['docs/guide.md', 'src/bar.ts', 'test/foo.test.ts']

    // 第一次：`/api/recent` 那次扫描 + 这次 git
    await fetch(`${server.base}/api/recent?sessionId=s&sort=relevance&kind=doc&limit=40`)
    const before = await (await fetch(url)).json()
    assert.deepEqual(before.links.map((l) => l.target).sort(), expected)
    assert.equal(before.git.filesTotal, 1)

    // 窗口之内把「那个提到过 foo.ts 的文档」删掉：重新走目录树 / 重新问 git 都会**立刻**反映出来
    rmSync(join(repo, 'docs', 'guide.md'))
    const after = await (await fetch(url)).json()
    assert.deepEqual(after.links.map((l) => l.target).sort(), expected,
      '同窗内复用了那次扫描（删掉的文档还在语料里 ⇒ 仍能当关联目标）')
    assert.equal(after.git.filesTotal, 1, 'git 状态也复用了（这次删除没有变成第二条变更）')

    // 证伪：把扫描备忘清掉之后再问，**必须**反映那次删除 —— 否则上面那条是「怎么问都这样」
    resetScanMemo()
    const fresh = await (await fetch(url)).json()
    assert.ok(!fresh.links.some((l) => l.target === 'docs/guide.md'),
      '清掉备忘后真的重扫：删掉的文档不再是被关联目标')
  } finally {
    if (server) await server.close()
    resetScanMemo()
    rmSync(repo, { recursive: true, force: true })
  }
})

/* ── 11. 安全边界：**子进程环境**（第二轮边界检查，第四轮收尾）─────────────
   固定 argv + 关 fsmonitor + 禁可选锁，挡的都是「我们主动让它做的事」；
   挡不住「父进程的环境替我们做了决定」。这一节的规则是**白名单 + 前缀**：
   只继承与 Git 配置无关的运行时必需品，**任何 `GIT_*` 一律不继承**。 */

test('安全：子进程环境是**筛选过**的 —— 任何 GIT_* 都不从父进程继承', () => {
  const env = gitEnv({
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'zh_CN.UTF-8',
    GIT_DIR: '/evil/.git', GIT_WORK_TREE: '/evil', GIT_INDEX_FILE: '/evil/index',
    GIT_TRACE: '/evil/trace.log', GIT_EXEC_PATH: '/evil/bin',
    GIT_CONFIG_GLOBAL: '/evil/config', GIT_SSH_COMMAND: '/evil/ssh',
    PAGER: 'less', SSH_ASKPASS: '/evil/askpass', EDITOR: 'vim',
  })
  // ① 危险的那一族一个都不许在
  for (const bad of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_TRACE', 'GIT_EXEC_PATH',
    'GIT_CONFIG_GLOBAL', 'GIT_SSH_COMMAND', 'PAGER', 'SSH_ASKPASS', 'EDITOR']) {
    assert.equal(env[bad], undefined, `${bad} 不许继承`)
  }
  // ② 我们自己设的只读参数**恰好**是那三个（多一个都算边界被放宽）
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('GIT_')).sort(),
    ['GIT_OPTIONAL_LOCKS', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT'])
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  // ③ 与 Git 配置无关的必需品照旧（`HOME` 决定全局配置与 ignore 规则从哪来，**不能抹**）
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/u')
  assert.equal(env.LANG, 'zh_CN.UTF-8')
  // ④ 白名单自己不许含 `GIT_*`（前缀规则是冗余防线，不是主要防线）
  assert.ok(GIT_ENV_ALLOW.every((k) => !k.startsWith('GIT_')), `白名单里混进了 GIT_*：${GIT_ENV_ALLOW.filter((k) => k.startsWith('GIT_'))}`)
})

test('安全（真机）：父进程注入 GIT_DIR / GIT_INDEX_FILE / GIT_TRACE —— 读取仍属于指定工作区，且不产生额外写入', async () => {
  /* 这条是**注入**测试：把三个变量塞进 `process.env`（`spawnGit` 只在真机上才会继承环境，
     注入的 `exec` 替身看不到这条路），然后走真实的读取器。
     判据三条：① 结果属于**我们指定的工作区**；② 不读别的仓库；③ 不写日志、不碰外部索引。 */
  const ws = mkdtempSync(join(tmpdir(), 'knit-git-env-ws-'))
  const decoy = mkdtempSync(join(tmpdir(), 'knit-git-env-decoy-'))
  const trace = join(ws, 'trace.log')
  const evilIndex = join(ws, 'evil-index')
  const saved = {}
  const injected = {
    GIT_DIR: join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: evilIndex,
    GIT_TRACE: trace,
  }
  try {
    const mk = (repo, files) => {
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
      git('config', 'user.email', 't@t')
      git('config', 'user.name', 't')
      for (const [rel, text] of Object.entries(files)) writeFileSync(join(repo, rel), text)
      git('add', '-A')
      git('commit', '-qm', 'init')
    }
    mk(ws, { 'a.ts': 'export const a = 1\n' })
    mk(decoy, { 'only-in-decoy.ts': 'nope\n' })
    // 让 ws 有一个**真实**的未提交改动当判据；decoy 保持干净
    writeFileSync(join(ws, 'a.ts'), 'export const a = 2\n')

    for (const [key, value] of Object.entries(injected)) {
      saved[key] = process.env[key]
      process.env[key] = value
    }

    const result = await createGitReader({ now: () => 0 }).read(ws)
    assert.equal(result.available, true, `读取必须成功（reason=${result.reason}）`)
    // ① 结果属于我们指定的工作区
    assert.deepEqual(result.files.map((f) => f.rel), ['a.ts'],
      `必须读到 ws 的真实改动，实测 ${JSON.stringify(result.files.map((f) => f.rel))}`)
    assert.deepEqual(result.files[0].kinds, ['unstaged'])
    // ② 没有读另一个仓库
    assert.ok(!result.files.some((f) => f.rel.includes('only-in-decoy')), '不许读到 decoy 仓库的文件')
    // ③ 没有额外写入
    assert.equal(existsSync(trace), false, '`GIT_TRACE` 指向的日志**一次都不许被创建**')
    assert.equal(existsSync(evilIndex), false, '`GIT_INDEX_FILE` 指向的外部索引**不许被创建/改写**')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(ws, { recursive: true, force: true })
    rmSync(decoy, { recursive: true, force: true })
  }
})

test('安全（证伪）：**不净化**环境时，上面那三个注入确实会改变行为 —— 说明那条守卫不是空转的', () => {
  /* 「守卫必须证伪一次」：这一条不用我们的代码，直接用 `spawnSync` 把**原始继承环境**交给 git，
     证明 GIT_TRACE 真的会写文件、GIT_DIR 真的会读别的仓库。没有它，上面那条测试
     可能只是「怎么跑都过」。 */
  const ws = mkdtempSync(join(tmpdir(), 'knit-git-raw-ws-'))
  const decoy = mkdtempSync(join(tmpdir(), 'knit-git-raw-decoy-'))
  const trace = join(ws, 'raw-trace.log')
  const evilIndex = join(ws, 'raw-evil-index')
  try {
    const mk = (repo, files) => {
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
      git('config', 'user.email', 't@t')
      git('config', 'user.name', 't')
      for (const [rel, text] of Object.entries(files)) writeFileSync(join(repo, rel), text)
      git('add', '-A')
      git('commit', '-qm', 'init')
    }
    mk(ws, { 'a.ts': 'export const a = 1\n' })
    mk(decoy, { 'only-in-decoy.ts': 'nope\n' })
    writeFileSync(join(ws, 'a.ts'), 'export const a = 2\n')

    const raw = (env) => spawnSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: ws, encoding: 'utf8', env: { ...process.env, ...env },
    }).stdout || ''

    // ① 原始继承 + GIT_TRACE ⇒ 真的写了日志（这就是我们要挡掉的写入）
    raw({ GIT_TRACE: trace })
    assert.equal(existsSync(trace), true, '原始环境下 `GIT_TRACE` 确实会写文件（所以净化是必要的）')
    // ② 原始继承 + GIT_INDEX_FILE ⇒ 索引被换掉，已提交的文件被报成 D/??
    const swapped = raw({ GIT_INDEX_FILE: evilIndex })
    assert.match(swapped, /a\.ts/, '换成空索引后，连已提交的 a.ts 都会被重新报出来')
    // ③ 原始继承 + GIT_DIR/GIT_WORK_TREE ⇒ 读的是**另一个仓库**
    const elsewhere = raw({ GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy })
    assert.ok(!/a\.ts/.test(elsewhere), `GIT_DIR 让我们读到了别的仓库（ws 的改动看不见）：${JSON.stringify(elsewhere)}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(decoy, { recursive: true, force: true })
  }
})
