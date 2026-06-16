# AirPlan V2 设计文档

> **版本**: Draft 0.1
> **日期**: 2026-06-09
> **基线**: AirPlan V1 (air-suite-20260518, air_runtime ~4,500 行, 8 插件)
> **状态**: 待评审

---

## 0. 文档目的

本文档记录 AirPlan V1 在真实工程项目（DecodePlayer 系列, AirCoding V1.0.0 Alpha）中暴露的系统性缺陷，并定义 V2 的架构改进方向、新增组件设计和分阶段实施计划。

V2 的核心命题：**V1 证明了制品驱动 + 上下文隔离 + 波次并行的架构方向成立；V2 要解决可靠性、可观测性和规模化问题。**

---

## 1. V1 问题诊断

### 1.1 缺陷分级

#### P0 — 已造成实际损失

| ID | 缺陷 | 位置 | 影响 | 根因 |
|----|------|------|------|------|
| P0-1 | AirXDB 假阳性阻塞 | `airxdb_runtime.py` `ensure_xdb_sessions_for_result()` | 11+ 任务触发虚假修复循环，每次需人工覆盖 | 证据门控无任务类型感知 |
| P0-2 | 部署验证缺口 | `contracts.py` `validate_for_finalize()` | T-028b 发现 4 个 "done" 任务未实际部署，延迟发布一整天 | 验证只检查结构完整性，不检查部署一致性 |
| P0-3 | 非原子写入 | 全部 `_json_dump` (5 份) | 进程崩溃时 state.json 截断，下次加载 JSONDecodeError | `path.write_text()` 直接覆盖，无 tempfile + rename |
| P0-4 | 零并发控制 | 整个 `air_runtime/` | 两个 Worker 同时完成时 todo.md 读-改-写竞态 | 无任何锁、互斥量或原子操作 |
| P0-5 | AirArc 被 plan 模式劫持 | AirArc SKILL.md / 命令文件 | 架构器频繁被 Agent 内置 plan mode 接管，偏离架构规划职责 | 缺乏 plan mode 阻断机制，SKILL.md 指令不够强硬 |
| P0-6 | AirEng 停下来问而不自主决策 | AirEng SKILL.md / 命令文件 | 调度器用英文反复询问用户确认，而非中文自主推进开发进度 | SKILL.md 未强制"以推进为目标自行决策"，语言未锁定中文 |
| P0-7 | AirEng 无子线程状态轮询 | `engine.py` `monitor_engine()` | 子线程卡死后调度器无限等待，必须用户手动发现并告知 | 轮询逻辑依赖 Agent 自觉执行，无硬编码的定时轮询循环 |
| P0-8 | AirDo 不调用专家插件（Dbg/XDB/NDB/SDB/Rvr） | AirDo SKILL.md / `worker.py` `finish_worker()` | 执行器遇到问题或验收时几乎不触发任何专家插件：不调 AirDbg 调试、不调 AirXDB 截图、不调 AirNDB 抓包、不调 AirSDB 静态分析、不调 AirRvr 审查，直接报 blocked 或 false-done | 自动路由为建议性而非强制，Worker 倾向于跳过所有专家插件直接返回 |
| P0-9 | 安装器脚本路径错误 | 安装脚本 / 插件注册逻辑 | 安装后插件无法识别，AI 修复后可识别但脚本执行失败，路径不正确 | 安装器未正确解析插件脚本的绝对路径，注册的命令路径与实际文件位置不匹配 |
| P0-10 | AirEng 偏离调度亲自写代码 | AirEng SKILL.md / 命令文件 | 调度引擎频繁偏离调度职责自己编写代码，破坏隔离架构。极端情况（子代理循环阻塞需接手合并）允许少量修改，但日常调度中不应发生 | SKILL.md 未明确区分"仅调度"与"极端接管"的边界，无工具限制约束 |

#### P1 — 限制可靠性与可维护性

| ID | 缺陷 | 位置 | 影响 |
|----|------|------|------|
| P1-1 | 硬编码开发者路径 | `debug_runtime.py:130`, `airxdb_runtime.py:156` | `C:\Users\20392\...` 在其他机器静默失败 |
| P1-2 | `_json_dump`/`_json_load` 5 份重复 | engine, worker, airxdb, debug, repair | 修一处漏四处 |
| P1-3 | `_ordered_unique` 4 份重复 | airxdb, debug, repair, contracts | 同上 |
| P1-4 | policy normalization 3 份重复 | airxdb, debug, repair | 同上 |
| P1-5 | merge-into-state 3 份重复 | airxdb, debug, repair | 同上 |
| P1-6 | marker block upsert 2 份（接口不同） | doc_sync, project_bootstrap | 同上 |
| P1-7 | `_session_stamp` 格式不一致 | airxdb, debug vs engine | 时间戳格式在不同模块产生不同文件名 |
| P1-8 | todo.md 列索引硬编码 | `doc_sync.py:154-156` | `cells[1]`=status, `cells[6]`=validation, `cells[7]`=adr — 表头变化时全部失效 |
| P1-9 | 并发度上限硬编码为 3 | `engine.py:527` | 无法根据项目规模调整 |
| P1-10 | 子进程无超时 | airxdb, debug runtime | 挂死时阻塞整个引擎 |
| P1-11 | task_id 路径注入 | `worker.py:59` | 无 `../` 遍历校验 |
| P1-12 | 标记注入风险 | `doc_sync.py` `_replace_marker_block()` | marker 字段含 `-->` 时可注入内容 |
| P1-13 | 静默吞异常 | session 文件损坏时 `except` 后 `continue` | 损坏文件不可见，无日志 |
| P1-14 | Arc 重规划后 Eng 无法衔接 | `engine.py` 计划解析 + `todo.md` 同步 | 中途变更需求后 Arc 重新生成规划，Eng 需多轮 AI 迭代才能恢复调度 | 调度引擎基于静态 todo.md 表格，无法增量吸收 Arc 的动态重规划结果 |
| P1-15 | 同文件无冲突任务被迫串行 | `review.py` 写集冲突检测 | 同文件不同区域（如 Qt 样式 vs 状态机）被判为冲突，被迫串行执行 | 冲突检测粒度为文件级而非区域级，无 worktree 隔离并行能力 |
| P1-16 | AirArc 跳过需求探讨直接生成规划 | AirArc SKILL.md / 命令文件 | 用户刚说一两句就自顾自生成计划并要求执行，未与用户充分探讨需求和分析架构 | SKILL.md 未强制"先探讨后规划"流程，缺少用户确认架构的门控 |
| P1-17 | AirDbg 未取证就盲改代码 | AirDbg SKILL.md / `debug_runtime.py` | 调试器不进行任何取证（抓包/截图/代码分析）就猜测原因并修改代码，引入新问题且污染代码库 | 7 步工作流为建议性不强制，无"先读后写"硬性门控——未执行任何取证行为就不允许修改代码 |
| P1-18 | 项目缺乏标准化日志体系 | 项目引导 / AirArc 规划 | 生成的代码无统一日志输出，debug/release 无法切换，问题排查困难 | 无项目级日志标准要求，AirArc 规划时未强制 spdlog 集成，AirRvr 审查时未检查日志完备性 |
| P1-19 | 边界无测试 + 终审缺高风险检查 | AirDo / AirRvr | 代码边界无接口测试和单元测试，最终审查未着重检查生命周期、空指针、悬垂指针、异常风险，产品交付后短时间内崩溃 | AirArc 规划时未强制测试任务，AirRvr 终审无专项高风险审计环节 |
| P1-20 | 界面设计缺乏专业 Skill 支撑 | AirDo / 安装器 | UI/前端任务由通用 Agent 直接编写，界面质量差，布局、配色、交互不符合设计规范 | 未集成 frontend-design Skill，AirDo 遇到 UI 任务时无专业工具可用，安装器未自动检测并配置 |
| P1-21 | ADR 变更无级联失效机制 | AirArc / AirEng / TaskGraph | 架构方案变更（如 ffmpeg → gstreamer）后，基于旧 ADR 已完成的任务不会自动失效，旧代码残留与新方案冲突，下游任务基于过期产出继续执行 | TaskGraph 无 ADR→任务的溯源链，无已完成任务的失效判定，无回滚清理流程 |
| P1-22 | Dispatch → Worker 启动无桥接 | `eng_mode.py:dispatch_worker_group()` | dispatch 只写 JSON 派发清单，不启动 Worker。Worker 启动依赖 Agent 自觉读 payload 并手动调用 Skill 工具——Agent 不读则 Worker 永不启动，Agent 最终「回退自己执行」 | `dispatch_worker_group()` 与 Worker 启动之间仅有 JSON 文件，无代码层桥接。L1 保障未覆盖 Agent 调度层 |
| P1-23 | Dispatch 指令歧义 | `commands/eng.md` | Eng 的 dispatch 步骤（spawn Worker）是意图描述而非可执行伪代码，Agent 每步都在猜：用什么工具？参数格式？task-text 从哪取？——猜错多一轮，猜不出来 Worker 不启动 | 指令未降到操作级。Arc 和 Eng 的约束非对称性是刻意的（Arc 永不写→硬阻断，Eng 保留极端接管→不硬阻断），P1-23 是纯指令层问题 |
| P1-24 | AirArc 任务描述歧义导致弱模型破坏性执行 | AirArc `review.py` / SKILL.md | 任务粒度太粗、用词有歧义（如"清理"被弱模型理解为"删除全部"），Worker 严格按字面执行导致误删现有代码。真实案例：screenPlayer CMake 重构中 Worker 删除了整个 src/ | Arc 未针对弱模型优化任务描述，无"保留约束"机制，任务粒度未按操作类型拆分 |
| P1-25 | Merge 后 TaskGraph 状态不同步 | `eng_mode.py:merge_worker_result()` | merge 更新 todo.md 和 state.json 但不动 task-graph.json。已完成任务的节点状态仍是 TODO/DISPATCHED，再次 dispatch 重复派发 | `merge_worker_result()` Phase 5/6 未同步 `task-graph.json` 节点 status 字段 |

#### P2 — 限制规模化

| ID | 缺陷 | 位置 | 影响 |
|----|------|------|------|
| P2-1 | 冲突检测 O(n²) | `review.py` `combinations(active_tasks, 2)` | 100 任务时 ~495,000 次路径比较 |
| P2-2 | state.json 无界增长 | `engine.py` | `mergedResults` 等列表永不截断 |
| P2-3 | todo.md 每次操作全量重解析 | engine 多处调用 `parse_tasks()` | 大 todo 表时性能退化 |
| P2-4 | 零测试覆盖 | 整个 `air_runtime/` | 任何重构都有回归风险 |

#### P3 — 限制用户体验

| ID | 缺陷 | 位置 | 影响 |
|----|------|------|------|
| P3-1 | AGENTS.md 膨胀 | AirEng sync 追加无去重 | 同一任务记录重复 2-3 次 |
| P3-2 | 写集刚性导致级联任务链 | 写集边界设计 | T-028 衍生 fix-001~005 + T-028b + T-028c |
| P3-3 | 并行 Worker 抢占共享硬件 | 无硬件资源感知 | kmsgrab 锁死、负载 7.59 自发重启 |
| P3-4 | 环境特定修复不可持久化 | 部署自动化不完整 | MonitorServiceD、cgroup v1 每次重启需手动修复 |
| P3-5 | 跨项目知识不迁移 | 无模板继承机制 | 每个项目从零积累运维经验 |

### 1.2 插件级差距

| 插件 | V1 差距 | 影响 |
|------|---------|------|
| **AirContext** | 压缩质量无监控；Token 估算 `char_div_3.5` 粗糙；续传 prompt 硬编码中文；锁文件无陈旧检测 | 坏摘要静默损坏上下文 |
| **AirDbg** | 7 步工作流纯建议性不强制；无不可复现 bug 分支；无回滚能力 | 调试质量依赖模型自觉 |
| **AirXDB** | 无 headless CI；无 DRM/KMS 原生截图；无截图 diff；远程探测不含 ffmpeg | 生产渲染路径无法自动验证 |
| **AirNDB** | 无 TLS 解密；大 pcap `tail(8000)` 截断；无 pcapng 支持 | 大规模抓包分析能力不足 |
| **AirSDB** | 仅 C/C++；无 diff 模式；无 compile_commands.json 生成 | 多语言项目零覆盖 |
| **AirArc** | 无规划质量验证；无增量重规划；无执行→规划反馈 | scope 变更必须全量重新生成 |
| **AirEng** | 无级联故障保护；无资源耗尽监控；5 分钟固定轮询；无 Worker 总时间上限 | 大规模调度时稳定性不足 |

### 1.3 真实项目痛点汇总

| 痛点 | 频次 | 根因缺陷 |
|------|------|---------|
| AirXDB 假阳性阻塞 | 11+ 任务 | P0-1 |
| 完成但未部署 | 1 次关键事故 | P0-2 |
| 写集级联任务链 | 5+ 条链 | P3-2 |
| 并行 Worker 抢占硬件 | 3+ 次 | P3-3 |
| 空壳修复循环 | 11+ 次 | P0-1 + P3-4 |
| AGENTS.md 膨胀 | 持续累积 | P3-1 |
| 环境修复不可持久 | 每次重启 | P3-4 |
| AirArc 被 plan 模式劫持 | 频繁 | P0-5 |
| AirEng 反复询问不自主推进 | 每次调度 | P0-6 |
| AirEng 遗忘轮询导致无限等待 | 频繁 | P0-7 |
| AirDo 跳过 AirDbg 直接返回 | 频繁 | P0-8 |
| 安装后插件无法识别或脚本路径错误 | 用户普遍反馈 | P0-9 |
| 需求变更后调度需多轮迭代恢复 | 每次变更 | P1-14 |
| 同文件无冲突任务被迫串行 | 频繁 | P1-15 |
| 实现偏离设计无对照机制 | 持续累积 | AirRvr 设计缺口 |
| AirArc 跳过需求探讨直接生成规划 | 每次启动 | P1-16 |
| AirDbg 不取证就猜测修复污染代码 | 频繁 | P1-17 |
| AirEng 偏离调度亲自写代码 | 频繁 | P0-10 |
| 项目代码缺乏标准化日志体系 | 所有项目 | P1-18 |
| 边界无测试 + 终审缺高风险检查 | 所有项目 | P1-19 |
| 界面设计缺乏专业 Skill 支撑 | UI 任务 | P1-20 |
| ADR 变更后已完成任务不失效 | 架构变更时 | P1-21 |
| AirArc 任务描述歧义导致弱模型破坏性执行 | 已造成实际损失 | P1-24 |

---

## 2. V2 设计目标

### 2.1 核心目标

1. **可靠性**：状态写入不丢失，并发操作不竞态，崩溃后可自愈
2. **可观测性**：所有引擎操作可追溯，指标可导出，异常主动通知
3. **智能化**：证据门控感知任务类型，轮询频率自适应，修复模式可学习
4. **规模化**：支持 100+ 任务、5+ 并行 Worker、多项目知识迁移

### 2.2 不变量

V2 必须保持 V1 的核心不变量：

| 不变量 | V1 定义 | V2 保持方式 |
|--------|---------|------------|
| INV-1 制品驱动通信 | 插件间通过 AirPlan/ 文件通信 | 保持，增加事件索引层 |
| INV-2 上下文隔离 | Worker `fork_context=false` | 保持，增加选择性上下文继承 |
| INV-3 架构同步强制 | 不更新架构文档不能 DONE | 保持，增加增量同步 |
| INV-4 证据先于修复 | 截图/抓包/静态分析前置 | 保持，增加任务类型感知 |
| INV-5 闭环自动修复 | 执行→失败→调试→修复→重执行 | 保持，增加修复模式学习 |

---

## 3. V2 架构改进

### 3.1 基础设施层重构

#### 3.1.1 `air_runtime.io` — 统一 I/O 模块

消除 5 份 `_json_dump`/`_json_load` 重复，统一为原子写入：

```python
# air_runtime/io.py

def atomic_json_write(path: Path, data: dict) -> None:
    """POSIX 原子写入：tempfile + os.replace()"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        os.write(fd, json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8"))
        os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise

def safe_json_load(path: Path) -> dict | None:
    """安全加载：处理损坏文件，自动从 .bak 恢复"""
    try:
        return json.loads(path.read_text("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        bak = path.with_suffix(path.suffix + ".bak")
        if bak.exists():
            logging.warning("corrupt %s, restoring from %s", path, bak)
            return json.loads(bak.read_text("utf-8"))
        logging.error("corrupt %s with no backup", path)
        return None
```

每次写入前自动备份旧文件为 `.bak`（单级轮转），保证至少有一次完整的历史版本。

#### 3.1.2 `air_runtime.lock` — 文件级并发控制

```python
# air_runtime/lock.py

class FileLock:
    """基于 fcntl.flock 的进程级文件锁"""

    def __init__(self, path: Path, timeout: float = 10.0):
        self._path = path.with_suffix(path.suffix + ".lock")
        self._timeout = timeout
        self._fd = None

    def __enter__(self):
        self._fd = os.open(self._path, os.O_CREAT | os.O_RDWR)
        deadline = time.monotonic() + self._timeout
        while True:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"lock timeout: {self._path}")
                time.sleep(0.1)

    def __exit__(self, *exc):
        fcntl.flock(self._fd, fcntl.LOCK_UN)
        os.close(self._fd)
```

所有 `state.json` 和 `todo.md` 的读-改-写操作必须持有对应锁。

#### 3.1.3 `air_runtime.utils` — 消除代码重复

```python
# air_runtime/utils.py

def ordered_unique(items: list) -> list:
    """保序去重"""
    seen = set()
    result = []
    for item in items:
        key = item if isinstance(item, str) else item.get("id", str(item))
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result

def session_stamp() -> str:
    """统一的文件系统安全时间戳"""
    return datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-").replace("+", "-")

def normalize_policy(defaults: dict, overrides: dict | None) -> dict:
    """通用的策略合并"""
    merged = {**defaults}
    if overrides:
        for k, v in overrides.items():
            if k in merged:
                expected_type = type(defaults[k])
                merged[k] = expected_type(v) if not isinstance(v, expected_type) else v
    return merged

def sanitize_task_id(task_id: str) -> str:
    """防止路径注入"""
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", task_id):
        raise ValueError(f"invalid task_id: {task_id!r}")
    return task_id

def sanitize_marker(marker: str) -> str:
    """防止 HTML 注释注入"""
    if "-->" in marker or "<!--" in marker:
        raise ValueError(f"marker contains comment delimiters: {marker!r}")
    return marker
```

### 3.2 引擎层改进

#### 3.2.1 任务类型感知的证据门控

```python
# 替代 airxdb_runtime.py 中的无差别触发

class EvidenceGatePolicy:
    """基于任务特征的差异化证据要求"""

    GUI_INDICATORS = {"gui", "ui", "render", "layout", "dialog", "osd",
                      "overlay", "visual", "screenshot", "display",
                      "widget", "pane", "toolbar", "settings_dialog"}

    NETWORK_INDICATORS = {"network", "rtsp", "http", "tcp", "udp", "tls",
                          "dns", "proxy", "socket", "stream", "port"}

    def classify(self, task: TaskRecord) -> EvidenceClass:
        text = f"{task.task} {task.files_dirs} {task.done_when}".lower()
        has_gui = any(kw in text for kw in self.GUI_INDICATORS)
        has_net = any(kw in text for kw in self.NETWORK_INDICATORS)

        if has_gui:
            return EvidenceClass.GUI_REQUIRED
        elif has_net:
            return EvidenceClass.NETWORK_REQUIRED
        else:
            return EvidenceClass.CODE_ONLY  # 不需要截图/抓包
```

#### 3.2.2 部署验证强制

```python
# contracts.py 扩展

class WorkerResult:
    def validate_for_finalize(self, brief: dict) -> None:
        # ... 现有验证 ...

        # V2 新增: 部署一致性
        if brief.get("deploy_required"):
            deploy_validations = [
                v for v in self.validations
                if v.kind in ("remote-deploy-verify", "remote-binary-md5")
            ]
            if not deploy_validations:
                raise ValidationError(
                    "deploy_required but no deploy verification in validations"
                )
            if any(v.status != "passed" for v in deploy_validations):
                raise ValidationError(
                    "deploy verification did not pass"
                )
```

#### 3.2.3 自适应轮询

```python
# engine.py 监控循环改进

class AdaptivePoller:
    """根据 Worker 状态动态调整轮询间隔"""

    def __init__(self, min_interval=30, max_interval=300):
        self.min_interval = min_interval
        self.max_interval = max_interval
        self._worker_phases: dict[str, str] = {}

    def interval_for(self, worker: dict) -> int:
        age_seconds = (now() - worker["spawnedAt"]).total_seconds()

        # 刚派发: 快速检测早期失败
        if age_seconds < 120:
            return self.min_interval

        # Worker 报告接近完成
        state = self._read_worker_state(worker)
        if state and state.get("phase") in ("finalizing", "running-validations"):
            return self.min_interval

        # 稳定执行中
        return self.max_interval
```

#### 3.2.4 Worker 超时与级联保护

```python
# engine.py 新增

WORKER_MAX_WALL_TIME = 7200  # 2 小时硬上限, 可配置

def _check_worker_timeout(self, worker: dict) -> bool:
    age = (now() - worker["spawnedAt"]).total_seconds()
    if age > WORKER_MAX_WALL_TIME:
        self._record_intervention(
            taskId=worker["taskId"],
            reason="wall-time-exceeded",
            action="terminate-and-block",
        )
        return True
    return False

def _check_resource_pressure(self) -> bool:
    """系统资源压力检测"""
    load = os.getloadavg()[0]
    cpu_count = os.cpu_count() or 4
    if load > cpu_count * 2:
        logging.warning("system load %.1f > 2x cpu_count (%d), pausing dispatch", load, cpu_count)
        return True
    return False
```

#### 3.2.5 合并事务化

V1 的 `merge_worker_result()` 执行 8+ 次文件写入，中间崩溃导致不一致。V2 引入事务语义：

```python
def merge_worker_result(self, project_root, result_path):
    lock = FileLock(project_root / "AirPlan" / "state" / "aireng" / "state.json")
    with lock:
        # Phase 1: 验证
        result = safe_json_load(result_path)
        enforce_doc_sync_requirements(project_root, result)

        # Phase 2: 归档（可重试）
        archive_path = _archive_result(project_root, result)

        # Phase 3: 应用文档更新（原子写入）
        applied = apply_document_updates(project_root, result)

        # Phase 4: 同步标记块（原子写入）
        sync_paths = sync_engine_managed_docs(project_root, result, applied)

        # Phase 5: 更新 todo（带锁）
        todo_lock = FileLock(project_root / "AirPlan" / "todo.md")
        with todo_lock:
            update_todo_after_merge(project_root, result, applied, sync_paths)

        # Phase 6: 更新引擎状态（原子写入）
        _update_engine_state(project_root, result, archive_path)
```

#### 3.2.6 AirArc plan 模式阻断

V1 中 AirArc 频繁被 Agent 内置 plan mode 劫持，导致架构器偏离规划职责去执行代码修改。V2 在 SKILL.md 和命令文件中增加硬性阻断：

```markdown
# AirArc SKILL.md V2 关键指令

## 角色边界（不可违反）
你是**纯规划器**。你的职责是分析任务依赖、写集冲突、产出调度计划。
**禁止**：编写代码、修改源代码文件、执行构建命令、进入 plan mode。
如果你发现自己正在写代码或修改文件，**立即停止**并返回规划职责。

## plan mode 阻断
当 Agent 框架尝试进入 plan mode 时，你必须拒绝：
"我是 AirArc 架构规划器，不进入 plan mode。我的产出是 execution-plan.json，不是代码变更。"
```

技术层面，AirArc 命令文件中 `allowed_tools` 仅包含读取类工具（Read, Glob, Grep），不包含 Write/Edit/Bash：

```json
{
  "allowed_tools": ["Read", "Glob", "Grep"],
  "denied_tools": ["Write", "Edit", "Bash", "NotebookEdit"],
  "deny_plan_mode": true
}
```

#### 3.2.7 AirEng 自主决策与中文锁定

V1 中 AirEng 反复用英文询问用户确认，中断调度流程。V2 在 SKILL.md 中强制自主决策和中文输出：

```markdown
# AirEng SKILL.md V2 关键指令

## 语言锁定
你**必须始终使用中文**与用户交流。所有状态报告、进度通知、问题描述均使用中文。

## 自主决策原则
你以**推进开发进度**为第一目标。遇到以下情况时自行决策，不要停下来问用户：
- Worker 返回 blocked 但修复预算未耗尽 → 自行派发修复
- Worker 停滞 → 自行执行停滞干预（重派发/标记 blocked）
- 验证失败但非关键 → 记录问题并继续下一任务
- 波次间衔接 → 自行启动下一波次

## 仅在以下情况才询问用户：
- 修复预算耗尽且任务仍 blocked
- 发现需求歧义无法继续
- 系统资源耗尽无法派发新 Worker
- 用户显式暂停了调度
```

#### 3.2.8 AirEng 硬编码轮询循环

V1 中轮询逻辑依赖 Agent "自觉"执行，实际经常遗忘导致无限等待。V2 将轮询指令硬编码到 SKILL.md 的强制循环中：

```markdown
# AirEng SKILL.md V2 轮询指令

## 强制轮询循环（不可跳过）
进入调度状态后，你必须执行以下循环，**每 5 分钟**检查一次所有活跃 Worker：

```
while 存在活跃 Worker:
  1. 遍历所有 dispatched Worker
  2. 检查每个 Worker 的 state 文件 mtime
  3. mtime > 5分钟未更新 → 标记 stalled → 执行停滞干预
  4. state = done → 执行合并流程
  5. state = blocked → 检查修复预算 → 派发修复或升级
  6. 所有 Worker 处理完毕 → 派发下一波次
  7. 等待 5 分钟后重复
```

**绝对不允许**：
- 派发 Worker 后不做轮询就等待
- 仅检查一次就声称"等待 Worker 完成"
- 轮询间隔超过 10 分钟
```

技术补充：引擎 `monitor_engine()` 增加 wall-clock 超时检测，Worker 超过 `WORKER_MAX_WALL_TIME` 自动 terminate。

#### 3.2.8b AirEng 调度职责边界

V1 中 AirEng 频繁偏离调度职责自己编写代码，破坏上下文隔离架构。V2 明确区分"仅调度"与"极端接管"的边界：

```markdown
# AirEng SKILL.md V2 职责边界指令

## 核心职责：调度，不是编码
你是**调度引擎**，不是执行器。你的职责是：
- 解析执行计划，派发 AirDo Worker
- 轮询 Worker 状态，处理停滞和合并
- 管理波次衔接和修复预算

**默认禁止**：编写源代码、修改项目文件。这些是 AirDo Worker 的职责。

## 极端接管（唯一例外）
仅在以下条件**全部满足**时，你才可以少量修改代码：
1. 子代理陷入循环阻塞，修复预算已耗尽
2. 问题已通过 AirDbg 定位到明确的根因
3. 修复范围极小（≤5 行改动，如配置修正、路径修复）
4. 继续等待 Worker 重派发已无意义（至少尝试过 2 次）

进入极端接管前，必须在引擎日志中记录：
"EXTREME_TAKEOVER: taskId=X, reason=Y, changes=Z"

## 极端接管时的专家插件调用（强制）
即使进入极端接管，你也必须像 AirDo 一样调用相关专家插件：
- 修改代码前：**必须**调用 AirDbg 定位根因
- GUI 相关变更：**必须**调用 AirXDB 采集修改前后截图
- 网络相关变更：**必须**调用 AirNDB 采集抓包证据
- C/C++ 代码变更：**必须**调用 AirSDB 执行静态分析
- 修改完成后：**必须**调用 AirRvr 进行需求一致性审查
- **禁止**跳过专家插件直接修改代码

## 违规判定
如果你在以下场景编写代码，视为违规：
- 正常调度流程中（Worker 可用且未阻塞）
- 修复预算未耗尽时
- 改动超过 5 行
- 未调用相关专家插件就猜测修复
```

#### 3.2.9 AirDo 强制专家插件路由

V1 中 AirDo 不调用任何专家插件（Dbg/XDB/NDB/SDB/Rvr），遇到问题直接报 blocked 或 false-done。V2 将所有专家插件调用从"建议"升级为"强制"：

```python
# worker.py finish_worker() V2 改进 — 全专家插件强制路由

def finish_worker(result: WorkerResult, brief: dict) -> list[RoutingDecision]:
    decisions = []

    # 1. GUI 任务 → 强制 AirXDB 截图
    if brief.get("taskType") == "gui" or _has_gui_indicators(brief):
        if not result.xdb_sessions:
            decisions.append(RoutingDecision(
                target="airxdb", forced=True,
                reason="GUI task requires screenshot evidence"
            ))

    # 2. 网络任务 → 强制 AirNDB 抓包
    if brief.get("taskType") == "network" or _has_network_indicators(brief):
        if not result.ndb_sessions:
            decisions.append(RoutingDecision(
                target="airndb", forced=True,
                reason="network task requires packet capture evidence"
            ))

    # 3. C/C++ 任务 → 强制 AirSDB 静态分析
    if _has_cpp_files(result.filesChanged):
        if not result.sdb_reports:
            decisions.append(RoutingDecision(
                target="airsdb", forced=True,
                reason="C/C++ task requires static analysis"
            ))

    # 4. blocked/failed → 强制 AirDbg 调试
    if result.status in ("blocked", "failed"):
        decisions.append(RoutingDecision(
            target="airdbg", forced=True,
            reason=f"status={result.status} — AirDbg mandatory before return"
        ))

    # 5. done 无实质验证 → 强制 AirDbg 审查
    if result.status == "done" and not result.validations and not result.filesChanged:
        decisions.append(RoutingDecision(
            target="airdbg", forced=True,
            reason="done without evidence — mandatory debug review"
        ))

    # 6. 所有 done 任务 → 强制 AirRvr 审查
    if result.status == "done":
        decisions.append(RoutingDecision(
            target="airrvr", forced=True,
            reason="completed task requires requirements review"
        ))

    # 无强制路由时才允许合并
    if not decisions:
        return [RoutingDecision(target="merge")]
    return decisions
```

SKILL.md 配合强制指令：

```markdown
## 专家插件调用强制规则（不可跳过）

### AirDbg（调试）
- blocked 或 failed 时，**必须**先调用 AirDbg
- done 但无验证证据时，**必须**调用 AirDbg

### AirXDB（GUI 截图）
- GUI 任务完成时，**必须**调用 AirXDB 采集截图证据
- **禁止**在没有截图的情况下声称 GUI 任务完成

### AirNDB（网络抓包）
- 网络任务完成时，**必须**调用 AirNDB 采集抓包证据
- **禁止**在没有抓包的情况下声称网络任务完成

### AirSDB（静态分析）
- C/C++ 任务完成时，**必须**调用 AirSDB 执行静态分析
- **禁止**跳过 cppcheck 直接报完成

### AirRvr（需求审查）
- 所有 done 任务，**必须**调用 AirRvr 进行需求一致性审查
- **禁止**跳过审查直接合并
```

#### 3.2.10 安装器路径修正

V1 安装器存在两个问题：(1) 安装后插件命令不被识别；(2) AI 修复注册后脚本执行路径不正确。

根因：安装器使用相对路径或硬编码路径注册插件命令，未根据实际安装位置动态生成绝对路径。

V2 修正：

```python
# installer.py V2 改进

def resolve_plugin_paths(install_dir: Path) -> dict[str, str]:
    """根据实际安装目录动态生成所有插件脚本的绝对路径"""
    scripts_dir = install_dir / "scripts"
    return {
        plugin_name: str(scripts_dir / f"{plugin_name}.py")
        for plugin_name in PLUGIN_NAMES
    }

def register_plugin_commands(paths: dict[str, str]) -> None:
    """注册时使用已解析的绝对路径，并验证文件存在"""
    for name, path in paths.items():
        if not Path(path).exists():
            raise InstallError(f"plugin script not found: {path}")
        register_command(name, command=path)

def post_install_verify() -> VerifyResult:
    """安装后自动验证：命令可识别 + 脚本可执行"""
    errors = []
    for name in PLUGIN_NAMES:
        if not is_command_registered(name):
            errors.append(f"{name}: command not registered")
        elif not can_execute(name):
            errors.append(f"{name}: script not executable")
    return VerifyResult(ok=not errors, errors=errors)
```

验证标准：安装完成后 `post_install_verify()` 必须全部通过，否则安装器自动报错并输出修复建议，而非让用户自行发现。

#### 3.2.11 动态图调度（替代静态表格）

V1 的 AirArc 产出静态 `todo.md` 表格，AirEng 基于该表格调度。当需求变更时 Arc 重新生成表格，Eng 无法增量吸收差异，需多轮 AI 迭代才能恢复。

V2 将调度结构从表格升级为**动态有向图 (DAG)**：

```python
# air_runtime/task_graph.py

class TaskGraph:
    """动态任务依赖图，支持增量更新"""

    def __init__(self):
        self.nodes: dict[str, TaskNode] = {}
        self.edges: list[Edge] = []

    def apply_delta(self, delta: PlanDelta) -> None:
        """增量吸收 Arc 的重规划结果，无需全量重建"""
        for removed in delta.removed_tasks:
            self._remove_node(removed)
        for added in delta.added_tasks:
            self._add_node(added)
        for modified in delta.modified_tasks:
            self._update_node(modified)
        for edge_change in delta.edge_changes:
            self._update_edge(edge_change)

    def ready_tasks(self) -> list[str]:
        """返回当前入度为 0 且未调度的任务"""
        return [n.id for n in self.nodes.values()
                if n.in_degree == 0 and n.status == "TODO"]

class PlanDelta:
    """Arc 重规划产出的增量差异"""
    removed_tasks: list[str]
    added_tasks: list[TaskNode]
    modified_tasks: list[TaskNode]
    edge_changes: list[EdgeChange]
```

Arc 重规划时不再全量覆盖 `todo.md`，而是产出 `plan-delta.json`，Eng 调用 `apply_delta()` 增量更新图结构，保持已调度任务不受影响。

#### 3.2.11b Dispatch → Worker 启动桥接

V2 初版中，`dispatch_worker_group()` 完成冲突检测、选定 ready 任务后，仅将派发清单写入 `state/aireng/dispatch/wave-*.json`，**不执行任何 Worker 启动操作**。Worker 的实际启动依赖当前运行的 Claude Agent 自觉读取 dispatch payload 并手动调用 `Skill` 工具逐个 spawn `/do` 子代理。

**缺陷**：设计与 L1 代码级保障原则矛盾。`commands/eng.md` 第 59 行写「读取派发清单，为每个任务 spawn 隔离的 /do Worker 子代理」——但这是对 LLM 的**意图描述**而非**操作步骤**。Agent 需要多轮推理才能翻译成具体操作：用什么工具？参数格式是什么？task-text 从哪取？每一步都是 Agent 在猜，猜错就多一轮，猜不出来就「回退自己执行」。

**根因**：dispatch 与 Worker 启动之间只有 JSON 文件，没有代码层桥接。L1 代码级保障覆盖了 Python 层（门控、路由、审计），但**未覆盖 Agent 调度层**——即「Claude Agent 如何把 dispatch payload 变成实际的 Skill 调用」这一环节。

**V2 修正**：从两个层面补齐——

**(a) 指令操作化**：`commands/eng.md` 中 dispatch 段必须给出可执行的伪代码而非意图描述：

```markdown
### dispatch

1. 运行 `python ... --sub dispatch`，得到 `{waveId, taskIds, dispatchPath}`
2. 对 taskIds 中的每个 tid:
   a. 从 task-graph.json 读 `nodes[tid].task` 获取任务描述
   b. 调用 `Skill` 工具:
      - skill: "airplan"
      - args: "do --sub enter --task-id {tid} --task-text '{task}' --project ."
   c. 每个 Skill 调用是独立的子代理（自动 fork_context=false）
3. 所有 Worker spawn 完成后，记录 wave 启动，进入 monitor 状态
```

**(b) 工具白名单对齐**：`commands/eng.md` 的 `allowed-tools` 当前为 `[Read, Glob, Grep, Bash, Write, Edit]`，与 Arc 的 `[Read, Glob, Grep]` 形成鲜明对比。Eng 的「不能写代码」（INV-6）仅有自然语言约束，没有工具白名单硬阻断。

Eng 模式需要**分层工具权限**：
- 调度操作（plan/dispatch/monitor/merge）：允许 Bash + Write（写 AirPlan/ 目录下的状态文件）
- 任务代码修改：禁止 Write/Edit（由 Skill 子代理在 /do 上下文中执行）

但 Claude Code CLI 的 `allowed-tools` 是 per-command 而非 per-context 的，无法在一个 Agent 内动态切换。因此 V2 的折中方案：
1. 保持 `allowed-tools: [Read, Glob, Grep, Bash, Write, Edit]`
2. 在 SKILL.md 中将 INV-6 升级为**硬编码检查**：每次 Write/Edit 调用前校验目标路径是否在 `AirPlan/` 目录下，不在则拒绝并提示「由 /do Worker 执行」
3. `commands/eng.md` 中增加明确的操作步骤伪代码（如上述），消除 Agent 的推理歧义

**(c) Worker spawn 函数**：新增 `air_runtime/modes/eng_mode.py:spawn_workers(project_root, task_ids)` —— 不替代 Agent 决策层，但提供标准化数据准备：

```python
def spawn_workers(project_root: Path, task_ids: list[str]) -> list[dict]:
    """为每个 ready 任务准备 spawn 指令，返回 Agent 可直接消费的 Skill 调用参数列表。
    不实际启动子进程——启动由 Agent 框架的 Skill 工具完成。"""
    tg_json = airplan_root(project_root) / "state" / "airarc" / "reviews" / "task-graph.json"
    graph = TaskGraph.load(tg_json) if tg_json.exists() else TaskGraph()
    instructions = []
    for tid in task_ids:
        node = graph.nodes.get(tid)
        task_text = node.task if node else ""
        instructions.append({
            "skill": "airplan-v2:do",
            "args": f"--sub enter --task-id {tid} --task-text '{task_text}' --project .",
            "taskId": tid,
            "taskText": task_text,
        })
    return instructions
```

调用方（Eng Agent）只需遍历返回的列表，逐个调用 `Skill` 工具即可，无需自行从 task-graph.json 提取 task_text。

#### 3.2.11c Merge → TaskGraph 状态同步

V2 初版的 `merge_worker_result()` 在 Phase 5 更新 `todo.md`、Phase 6 更新 `state.json`，但**不更新 `task-graph.json` 中对应节点的 status**。导致 merge 完成后，task-graph 中已完成任务的 status 仍为 TODO/DISPATCHED，再次 dispatch 时会**重复派发已完成任务**。

**修正**：在 `merge_worker_result()` 的 Phase 6（写回引擎状态）中追加 task-graph 状态同步：

```python
# Phase 6.5: 同步 task-graph.json 节点状态
tg_json = airplan_root(project_root) / "state" / "airarc" / "reviews" / "task-graph.json"
if tg_json.exists():
    graph = TaskGraph.load(tg_json)
    if task_id in graph.nodes:
        graph.nodes[task_id].status = "DONE" if status == "done" else status.upper()
        _export_task_graph_json(graph, tg_json)
```

**不变量**：`task-graph.json` 中的节点 status 是 Eng 调度决策的权威来源（`_select_ready_tasks` 依赖 `ready_tasks()` 筛选 `status == "TODO"`），必须与 merge 结果保持同步。

#### 3.2.12 Worktree 隔离并行（同文件不同区域）

V1 的冲突检测粒度为文件级。实际场景中，同一文件的不同区域可能互不影响（如 Qt 组件样式 vs 状态机逻辑），可以安全并行。

V2 引入**区域级冲突检测 + git worktree 隔离**：

```python
# review.py V2 改进

class RegionConflictDetector:
    """区域级写集冲突检测"""

    def detect(self, task_a: TaskNode, task_b: TaskNode) -> ConflictLevel:
        file_overlap = set(task_a.write_set) & set(task_b.write_set)
        if not file_overlap:
            return ConflictLevel.NONE

        region_overlap = self._check_region_overlap(task_a, task_b, file_overlap)
        if region_overlap:
            return ConflictLevel.HARD  # 同区域，必须串行
        else:
            return ConflictLevel.SOFT  # 同文件不同区域，可 worktree 隔离

class WorktreeIsolation:
    """为 SOFT 冲突任务创建 worktree 隔离，完成后合并"""

    def create_worker_worktree(self, task_id: str, base_branch: str) -> Path:
        wt_path = Path(f".git/worktrees/air-{task_id}")
        subprocess.run(["git", "worktree", "add", str(wt_path), base_branch],
                       check=True, capture_output=True)
        return wt_path

    def merge_back(self, task_id: str, wt_path: Path) -> MergeResult:
        """worktree 完成后合并回主分支"""
        subprocess.run(["git", "merge", f"air-{task_id}"], check=True)
        subprocess.run(["git", "worktree", "remove", str(wt_path)],
                       check=True, capture_output=True)
```

调度策略：`NONE` 直接并行，`SOFT` 使用 worktree 隔离并行，`HARD` 强制串行。合并冲突时自动升级到 AirDbg。

#### 3.2.13 AirArc 需求探讨门控

V1 中 AirArc 在用户仅说一两句时就立即生成执行计划，未与用户充分探讨需求和分析架构。V2 强制"先探讨、后确认、再规划"的三阶段流程：

```markdown
# AirArc SKILL.md V2 流程指令

## 三阶段流程（不可跳过）

### 阶段一：需求探讨
- 与用户反复讨论需求细节、边界条件、隐含约束
- 主动提问澄清模糊点，不要假设用户意图
- 分析现有代码库的结构、技术栈、约束条件
- 提出多种架构方案及其优劣势对比
- **此阶段禁止生成 execution-plan.json**

### 阶段二：架构确认
- 向用户呈现推荐的架构方案（模块划分、依赖关系、技术选型）
- 明确等待用户确认："请确认此架构方案是否符合预期，确认后我将生成执行规划"
- 用户有异议时回到阶段一修订
- **此阶段禁止生成 execution-plan.json**

### 阶段三：生成规划
- 仅在用户明确确认架构无误后，才生成 execution-plan.json
- 规划产出必须严格对应用户确认的架构方案
```

技术门控：AirArc 运行时增加 `phase` 状态追踪，`execution-plan.json` 仅在 `phase == "confirmed"` 时允许写入：

```python
class ArcPhaseGate:
    PHASES = ["discussing", "proposing", "confirmed"]

    def can_write_plan(self) -> bool:
        return self.current_phase == "confirmed"

    def confirm_architecture(self, user_confirmation: str) -> None:
        if "确认" in user_confirmation or "可以" in user_confirmation:
            self.current_phase = "confirmed"
```

#### 3.2.14 项目级 spdlog 日志标准

V1 生成的代码缺乏统一日志体系，debug/release 无法切换，问题排查困难。V2 强制所有项目集成 spdlog 日志库，支持 debug/release 级别切换。

**AirArc 规划阶段强制要求**：

```markdown
# AirArc SKILL.md V2 日志标准指令

## 项目日志标准（所有 C++ 项目强制）
- 必须使用 spdlog 作为日志库
- 如果项目未集成 spdlog，首个任务必须为"集成 spdlog 到项目"
- 所有生成的代码必须使用 spdlog 输出日志，禁止 std::cout/qDebug 等
- 必须支持 debug/release 编译开关切换日志级别
- 关键路径（初始化、网络、文件 I/O、错误）必须有日志输出
```

**AirRvr 审查阶段检查项**：

```python
# AirRvr 审查清单扩展

LOGGING_CHECKS = [
    "spdlog 是否已集成到项目依赖",
    "代码中是否存在 std::cout / qDebug / printf 等非标准日志",
    "是否有 CMAKE_BUILD_TYPE 或等效的 debug/release 编译开关",
    "关键路径（初始化、网络、文件 I/O、错误处理）是否有日志输出",
    "日志格式是否统一（时间戳 + 级别 + 模块 + 消息）",
]
```

**CMake 集成模板**：

```cmake
# 自动检测并集成 spdlog
find_package(spdlog QUIET)
if(NOT spdlog_FOUND)
    include(FetchContent)
    FetchContent_Declare(spdlog
        GIT_REPOSITORY https://github.com/gabime/spdlog.git
        GIT_TAG v1.14.1)
    FetchContent_MakeAvailable(spdlog)
endif()

# debug/release 日志级别切换
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_definitions(${PROJECT_NAME} PRIVATE SPDLOG_ACTIVE_LEVEL=SPDLOG_LEVEL_TRACE)
else()
    target_compile_definitions(${PROJECT_NAME} PRIVATE SPDLOG_ACTIVE_LEVEL=SPDLOG_LEVEL_INFO)
endif()
```

#### 3.2.15 边界测试强制 + 终审高风险审计

V1 生成的代码在模块边界缺乏接口测试和单元测试，最终审查未着重检查高风险问题，产品交付后短时间内崩溃。V2 从规划和审查两端强制保障。

**AirArc 规划阶段——测试任务强制**：

```markdown
# AirArc SKILL.md V2 测试要求指令

## 边界测试（每个模块边界强制）
- 每个模块的公共接口必须有对应的接口测试任务
- 每个模块的核心逻辑必须有对应的单元测试任务
- 规划时自动生成测试任务，标记为 test-required
- Done When 条件必须包含"测试通过"
```

**AirRvr 终审阶段——高风险专项审计**：

```
终审检查清单（里程碑审查时强制执行）:

生命周期风险:
  - 资源申请与释放是否配对（new/delete, malloc/free, open/close）
  - RAII 是否覆盖所有资源持有
  - 异步操作的回调/完成是否保证执行

空指针/悬垂指针:
  - 指针使用前是否判空
  - 智能指针生命周期是否覆盖使用范围
  - 回调闭包中捕获的指针是否仍然有效
  - 容器元素删除后迭代器是否失效

异常安全:
  - 异常路径中资源是否正确释放
  - 是否存在异常吞没（catch 后无处理）
  - 跨模块边界是否有异常传播保护

并发风险:
  - 共享状态是否有锁保护
  - 锁顺序是否一致（防死锁）
  - 条件变量是否有虚假唤醒保护

报告结构扩展:
{
  "highRiskAudit": {
    "lifecycle": [
      {"file": "src/network/connection.cpp", "line": 145,
       "severity": "critical", "issue": "socket fd 在异常路径未关闭"}
    ],
    "nullPointer": [
      {"file": "src/auth/handler.cpp", "line": 78,
       "severity": "high", "issue": "getUser() 返回 nullptr 后直接调用 ->name()"}
    ],
    "danglingPointer": [],
    "exceptionSafety": [],
    "concurrency": [],
    "overallRisk": "critical | high | medium | low",
    "deliveryVerdict": "safe-to-ship | needs-fix | block-release"
  }
}
```

**与 AirEng 集成**：`deliveryVerdict = block-release` 时阻止任何后续派发，要求立即修复。

#### 3.2.16 界面设计 frontend-design Skill 集成

V1 中 UI/前端任务由通用 Agent 直接编写，界面质量差。V2 强制 UI 任务使用 frontend-design Skill，未安装时自动配置。

**AirDo SKILL.md 指令**：

```markdown
## 界面设计任务处理
- 当任务涉及 UI/前端/界面设计时，必须使用 frontend-design Skill
- 如果 frontend-design Skill 不存在，先执行自动安装再继续
- 禁止在无 frontend-design Skill 的情况下直接编写 UI 代码
```

**自动安装检测**：

```python
# worker.py 新增

def ensure_frontend_design_skill() -> bool:
    """检测 frontend-design Skill 是否存在，不存在则自动安装"""
    skill_path = get_skill_path("frontend-design")
    if skill_path and skill_path.exists():
        return True

    logging.info("frontend-design skill not found, auto-installing...")
    result = subprocess.run(
        ["qoderclicn", "skill", "install", "frontend-design"],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode == 0:
        logging.info("frontend-design skill installed successfully")
        return True

    logging.error("frontend-design skill install failed: %s", result.stderr)
    return False

def route_ui_task(task: TaskRecord) -> RoutingDecision:
    if is_ui_task(task) and not ensure_frontend_design_skill():
        return RoutingDecision(
            target="blocked",
            reason="UI task requires frontend-design skill but installation failed"
        )
    return RoutingDecision(target="execute", skill="frontend-design")
```

#### 3.2.17 ADR 变更级联失效

V1/V2 初版中，当架构方案变更（如 ffmpeg → gstreamer）时，基于旧 ADR 已完成的任务不会自动失效，旧代码残留与新方案冲突。V2 增加完整的级联失效机制。

**ADR→任务溯源链**：

```python
# air_runtime/task_graph.py 扩展

class TaskNode:
    adr_refs: list[str]  # 该任务依赖的 ADR 列表，如 ["ADR-0005", "ADR-0012"]

class TaskGraph:
    def tasks_by_adr(self, adr_id: str) -> list[TaskNode]:
        """查找所有依赖指定 ADR 的任务（含已完成）"""
        return [n for n in self.nodes.values() if adr_id in n.adr_refs]

    def invalidate_by_adr(self, adr_id: str, delta: PlanDelta) -> CascadeReport:
        """ADR 变更时级联失效所有相关任务"""
        affected = self.tasks_by_adr(adr_id)
        completed = [t for t in affected if t.status == "DONE"]
        in_progress = [t for t in affected if t.status == "DOING"]
        pending = [t for t in affected if t.status == "TODO"]

        # 1. 暂停调度：阻止新任务派发直到重规划完成
        self.dispatch_frozen = True

        # 2. 中止进行中的 Worker
        for t in in_progress:
            self._terminate_worker(t.id)

        # 3. 标记已完成任务为 invalidated
        for t in completed:
            t.status = "INVALIDATED"
            delta.removed_tasks.append(t.id)

        # 4. 级联失效下游任务
        downstream = self._find_downstream(completed + in_progress)
        for t in downstream:
            if t.status in ("TODO", "DOING"):
                t.status = "INVALIDATED"
                delta.removed_tasks.append(t.id)

        # 5. 记录回滚点
        delta.rollback_ref = self._create_rollback_snapshot(completed)

        return CascadeReport(
            invalidated_completed=len(completed),
            terminated_in_progress=len(in_progress),
            cascaded_downstream=len(downstream),
            rollback_ref=delta.rollback_ref,
        )
```

**回滚清理流程**：

```
ADR 变更处理流程:
  1. AirArc 检测到 ADR 变更（ADR-0005 从 ffmpeg 改为 gstreamer）
  2. AirArc 产出 PlanDelta，标记旧 ADR 为 superseded
  3. AirEng 调用 invalidate_by_adr("ADR-0005")
  4. 冻结调度（dispatch_frozen = true）
  5. 中止进行中的相关 Worker
  6. git revert 已合并的旧代码（基于 rollback_ref）
  7. AirArc 基于新 ADR 重新生成受影响部分的任务
  8. AirEng 调用 apply_delta() 吸收新任务
  9. 解冻调度（dispatch_frozen = false）
  10. 继续正常调度流程
```

**ADR 变更自动检测**：

```python
# air_runtime/adr_watcher.py

class ADRWatcher:
    """监控 ADR 文件变更，自动触发级联失效"""

    def __init__(self, adr_dir: Path):
        self._adr_dir = adr_dir
        self._known_hashes: dict[str, str] = {}  # adr_id -> content_hash

    def snapshot(self) -> None:
        """启动时记录所有 ADR 的内容 hash"""
        for adr_file in self._adr_dir.glob("ADR-*.md"):
            adr_id = adr_file.stem  # e.g. "ADR-0005-ffmpeg-decode"
            self._known_hashes[adr_id] = hashlib.sha256(
                adr_file.read_bytes()
            ).hexdigest()

    def detect_changes(self) -> list[ADRChange]:
        """对比当前 ADR hash 与已知 hash，返回变更列表"""
        changes = []
        for adr_file in self._adr_dir.glob("ADR-*.md"):
            adr_id = adr_file.stem
            current_hash = hashlib.sha256(adr_file.read_bytes()).hexdigest()
            old_hash = self._known_hashes.get(adr_id)

            if old_hash is None:
                changes.append(ADRChange(adr_id=adr_id, kind="new"))
            elif current_hash != old_hash:
                status = self._parse_status(adr_file)
                if status == "superseded":
                    changes.append(ADRChange(adr_id=adr_id, kind="superseded"))
                else:
                    changes.append(ADRChange(adr_id=adr_id, kind="modified"))
            self._known_hashes[adr_id] = current_hash
        return changes
```

AirEng 在每轮轮询时调用 `adr_watcher.detect_changes()`，发现 `superseded` 或 `modified` 变更时自动触发 `invalidate_by_adr()`。

**局部重规划（替代全量重规划）**：

```python
# air_runtime/review.py 扩展

class PartialReplanner:
    """仅重新生成受 ADR 变更影响的任务子集"""

    def replan(self, graph: TaskGraph, invalidated_ids: list[str],
               new_adr: ADRDocument) -> PlanDelta:
        delta = PlanDelta()

        # 1. 收集受影响任务的上下文（原始需求、依赖关系、写集）
        affected_context = []
        for tid in invalidated_ids:
            node = graph.nodes.get(tid)
            if node:
                affected_context.append(node.to_replan_context())

        # 2. 仅对受影响部分调用 Arc 重新规划
        #    传入新 ADR + 受影响任务的上下文 + 未受影响任务的接口约束
        new_tasks = self._call_arc_partial_replan(
            new_adr=new_adr,
            affected_context=affected_context,
            stable_interfaces=self._extract_stable_interfaces(graph, invalidated_ids),
        )

        # 3. 生成增量 delta（仅包含变更部分）
        delta.added_tasks = new_tasks
        # removed_tasks 已在 invalidate_by_adr 中填充

        return delta

    def _extract_stable_interfaces(self, graph: TaskGraph,
                                    invalidated_ids: set) -> list[Interface]:
        """提取未受影响任务暴露的接口，确保重规划不破坏依赖"""
        stable = [n for nid, n in graph.nodes.items()
                  if nid not in invalidated_ids and n.status == "DONE"]
        return [n.public_interface for n in stable]
```

AirArc SKILL.md 配合指令：收到局部重规划请求时，**仅重新生成指定任务列表**，不触碰其他任务的规划。

**与 AirRvr 集成**：终审时检查所有 `INVALIDATED` 任务的代码是否已清理，防止旧方案代码残留。

#### 3.2.18 AirArc 任务描述弱模型优化

V1 中 Arc 生成的任务描述粒度太粗、用词有歧义，弱模型严格按字面执行导致破坏性后果。真实案例：

```
任务描述: "清理旧产品实现并重建新 CMake 骨架"
完成标准: "screenPlayer 目标只链接 Qt5 + RanderWidget/media_streaming；不链接 sipclient"
文件范围: CMakeLists.txt, cmake/, main.cpp, src/, tests/

→ Worker 理解: "清理" = 删除旧代码, "src/" 在文件范围内 → 删除整个 src/ 目录
→ 正确理解: 只重构 CMakeLists.txt 去掉 sipclient 依赖, src/ 现有模块保留不动
```

V2 从三个层面修复：

**1. 操作类型拆分（按动词分类）**：

```python
# review.py 任务生成改进

AMBIGUOUS_VERBS = {
    "清理": "歧义——可能是删除、重构、或移除依赖",
    "优化": "歧义——可能是性能优化、代码重构、或简化逻辑",
    "整理": "歧义——可能是格式化、重命名、或删除",
    "更新": "歧义——可能是修改现有代码、或替换为新实现",
}

SAFE_VERBS = {
    "重构": "修改实现但保持外部接口不变",
    "新增": "添加新功能，不修改现有代码",
    "删除": "移除指定文件或函数（必须列出具体目标）",
    "修改": "修改指定文件的具体部分（必须指明改什么）",
    "保留": "明确标记为不可修改的文件/目录",
}

def validate_task_description(task: TaskRecord) -> list[str]:
    """检测任务描述中的歧义词并建议替换"""
    warnings = []
    for verb, explanation in AMBIGUOUS_VERBS.items():
        if verb in task.task:
            warnings.append(
                f"任务描述包含歧义词「{verb}」({explanation})，"
                f"请拆分为具体操作（重构/新增/删除/修改/保留）"
            )
    return warnings
```

**2. 保留约束机制（显式声明不可修改的内容）**：

```markdown
# AirArc SKILL.md V2 任务描述指令

## 任务描述规范（面向弱模型优化）

### 每个任务必须包含：
1. **操作指令**: 用具体动词描述要做什么（重构/新增/删除/修改）
2. **保留约束**: 明确列出不可修改的文件、目录或函数
3. **变更边界**: 精确到文件级别，每个文件标注"新建|修改|删除|保留"
4. **完成标准**: 可验证的条件，避免主观判断

### 禁止的写法:
- "清理旧实现" → 改为 "重构 CMakeLists.txt 去掉 sipclient 依赖，保留 src/ 下所有现有模块"
- "优化模块结构" → 改为 "将 auth/login.py 中的 validate() 函数提取到 auth/validator.py"

### 示例（正确写法）:
任务: "重构 screenPlayer CMake 构建配置"
完成标准: "screenPlayer 目标只链接 Qt5 + RanderWidget/media_streaming；不链接 sipclient"
文件范围:
  - CMakeLists.txt: 修改（去掉 sipclient 相关 find_package 和 target_link_libraries）
  - cmake/: 修改（清理 sipclient 相关的 .cmake 文件）
  - main.cpp: 保留（不修改）
  - src/: 保留（不修改，现有模块保持不动）
  - tests/: 保留（不修改）
保留约束: src/ 目录下所有现有源文件不得删除或修改
```

**3. Arc 自检环节**：

Arc 生成任务后，对所有任务执行 `validate_task_description()` 自检。发现歧义词时自动拆分任务或补充保留约束，不将歧义任务传递给 Eng。

### 3.3 AirContext V2 改进

#### 3.3.1 压缩质量校验

```python
# compactor.py 新增

class CompressionValidator:
    """验证压缩摘要保留了关键信息"""

    MUST_PRESERVE_PATTERNS = [
        r"[A-Za-z0-9_\-/]+\.(py|ts|js|cpp|h|md|json|yaml)",  # 文件路径
        r"ADR-\d{4}",                                          # ADR 引用
        r"TODO|FIXME|HACK",                                    # 未完成项
        r"INV-\d+",                                            # 不变量引用
    ]

    def validate(self, original_text: str, summary: str) -> ValidationResult:
        missing = []
        for pattern in self.MUST_PRESERVE_PATTERNS:
            original_matches = set(re.findall(pattern, original_text))
            summary_matches = set(re.findall(pattern, summary))
            lost = original_matches - summary_matches
            if len(lost) > len(original_matches) * 0.3:  # 丢失 >30%
                missing.append({"pattern": pattern, "lost": list(lost)})

        if missing:
            return ValidationResult(ok=False, missing=missing)
        return ValidationResult(ok=True, missing=[])
```

如果校验失败，重试一次压缩（换 prompt 或换模型），仍失败则放弃压缩（保留原始上下文）并通知用户。

#### 3.3.2 Token 估算改进

```python
# token_estimator.py 改进

class AdaptiveTokenEstimator:
    """按内容类型分比率"""

    RATIOS = {
        "chinese": 1.5,    # 中文字符 → token
        "english": 4.0,    # 英文单词字符 → token
        "code": 3.0,       # 代码字符 → token
        "markup": 5.0,     # Markdown/HTML 标记 → token
    }

    def estimate(self, text: str) -> int:
        chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
        code = len(re.findall(r"[{}()\[\];=<>]", text))
        markup = len(re.findall(r"[#*\-`|]", text))
        english = len(text) - chinese - code - markup

        tokens = (
            chinese / self.RATIOS["chinese"]
            + code / self.RATIOS["code"]
            + markup / self.RATIOS["markup"]
            + english / self.RATIOS["english"]
        )
        return int(tokens)
```

#### 3.3.3 陈旧锁检测

```python
def acquire_compactor_lock(lock_path: Path) -> bool:
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        # 检查持有锁的进程是否存活
        try:
            pid = int(lock_path.read_text().strip())
            os.kill(pid, 0)  # 不发信号，只检查进程存在
            return False  # 进程存活，锁有效
        except (ValueError, ProcessLookupError, PermissionError):
            # 进程不存在或无法访问 → 陈旧锁，清理
            logging.warning("stale lock detected (pid=%s), removing", pid)
            lock_path.unlink(missing_ok=True)
            return acquire_compactor_lock(lock_path)  # 重试
```

### 3.4 AirSDB V2：多语言静态分析

```python
# airsdb 架构扩展

class StaticAnalyzerBackend(Protocol):
    """静态分析后端协议（类似 AirContext 的 CompressionBackend）"""

    name: str

    def detect(self) -> bool:
        """检测分析器是否可用"""

    def analyze(self, source_paths: list[str], compile_db: Path | None) -> AnalysisResult:
        """执行分析"""

    def parse_report(self, report_path: Path) -> list[Finding]:
        """解析报告为统一格式"""


class CppcheckBackend(StaticAnalyzerBackend):
    """现有 cppcheck 实现"""

class ClangTidyBackend(StaticAnalyzerBackend):
    """clang-tidy 集成"""

class RustClippyBackend(StaticAnalyzerBackend):
    """cargo clippy 集成"""

class GoVetBackend(StaticAnalyzerBackend):
    """go vet + staticcheck 集成"""

class TypeScriptBackend(StaticAnalyzerBackend):
    """tsc --noEmit 集成"""

class PythonBackend(StaticAnalyzerBackend):
    """mypy + ruff 集成"""
```

新增 **diff 模式**：比较两次扫描结果，高亮新增/消除的 finding。

```python
class AnalysisDiff:
    def compute(self, baseline: list[Finding], current: list[Finding]) -> DiffReport:
        baseline_keys = {(f.file, f.line, f.rule_id) for f in baseline}
        current_keys = {(f.file, f.line, f.rule_id) for f in current}

        return DiffReport(
            new_findings=[f for f in current if (f.file, f.line, f.rule_id) not in baseline_keys],
            resolved_findings=[f for f in baseline if (f.file, f.line, f.rule_id) not in current_keys],
            unchanged_count=len(baseline_keys & current_keys),
        )
```

### 3.5 AirDbg V2：工作流强制与模式学习

#### 3.5.1 步骤追踪

```python
# airdbg_mode.py 新增

class DebugWorkflowTracker:
    """追踪调试工作流的当前步骤，阻止跳步"""

    STEPS = [
        "confirm_symptoms",
        "load_context",
        "reproduce",         # 可跳过（标记为 non-reproducible）
        "locate_root_cause",
        "fix",
        "verify",
        "close_out",
    ]

    def current_step(self, session_id: str) -> str:
        state = self._load_session_state(session_id)
        return state.get("currentStep", "confirm_symptoms")

    def advance(self, session_id: str, evidence: dict) -> None:
        """只有提供了当前步骤要求的证据才能推进"""
        step = self.current_step(session_id)
        if not self._validate_step_evidence(step, evidence):
            raise WorkflowViolation(
                f"step '{step}' requires {self._required_evidence(step)}"
            )
        self._set_step(session_id, self._next_step(step))

    def skip_reproduce(self, session_id: str, reason: str) -> None:
        """显式标记为不可复现，进入分析路径"""
        self._set_step(session_id, "locate_root_cause")
        self._record(session_id, "reproduce_skipped", reason)
```

#### 3.5.2 修复回滚

```python
def pre_fix_snapshot(project_root: Path, task_id: str) -> SnapshotRef:
    """修复前自动创建 git commit 作为回滚点"""
    ref = f"airdbg/prefix-{task_id}-{session_stamp()}"
    subprocess.run(["git", "commit", "-am", f"AirDbg pre-fix snapshot: {task_id}",
                     "--allow-empty"], check=True, capture_output=True)
    subprocess.run(["git", "tag", ref], check=True, capture_output=True)
    return SnapshotRef(ref=ref, timestamp=now_iso())
```

#### 3.5.3 先读后写门控

V1 中 AirDbg 不进行任何取证就猜测原因并修改代码，引入新问题且污染代码库。V2 强制"先读后写"原则：必须至少执行一种取证行为后，才允许修改代码。

```python
# debug_runtime.py 新增

class EvidenceFirstGate:
    """取证门控：未执行任何取证行为前，禁止代码修改"""

    EVIDENCE_TYPES = [
        "screenshot",        # AirXDB 截图
        "packet_capture",    # AirNDB 抓包
        "static_analysis",   # AirSDB 静态分析
        "log_analysis",      # 日志分析
        "code_trace",        # 代码追踪（读取相关文件、调用链分析）
        "reproduction",      # 复现步骤执行
    ]

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._collected_evidence: list[str] = []

    def record_evidence(self, evidence_type: str, detail: str) -> None:
        self._collected_evidence.append(evidence_type)
        self._log(f"evidence collected: {evidence_type} — {detail}")

    def can_modify_code(self) -> bool:
        return len(self._collected_evidence) > 0

    def gate_check(self) -> None:
        if not self.can_modify_code():
            raise WorkflowViolation(
                "未执行任何取证行为，禁止修改代码。"
                "请先至少完成以下一项：截图、抓包、静态分析、日志分析、代码追踪、复现步骤。"
            )
```

SKILL.md 配合指令：

```markdown
## 先读后写原则（不可违反）
- 修改任何代码之前，必须至少完成一项取证行为
- 取证行为包括但不限于：截图、抓包、静态分析、日志分析、代码追踪、复现步骤
- 不要求取证覆盖完整（部分问题确实无法完全取证），但必须有至少一项取证作为依据
- 取证结果必须记录到 debug-log.md 后方可开始修复
- **禁止**：未做任何调查就直接修改代码
```

### 3.6 AirXDB V2：扩展截图能力

#### 3.6.1 DRM/KMS 原生截图

```python
# airxdb_runtime.py 新增

class KmsGrabCapture(CaptureBackend):
    """Linux DRM/KMS scanout 截图（ffmpeg -f kmsgrab）"""

    def detect(self) -> bool:
        result = subprocess.run(["ffmpeg", "-devices"], capture_output=True, text=True, timeout=5)
        return "kmsgrab" in result.stdout

    def capture(self, output_path: Path, card: str = "/dev/dri/card0") -> CaptureResult:
        cmd = [
            "sudo", "ffmpeg", "-y", "-f", "kmsgrab", "-framerate", "1",
            "-i", card, "-vframes", "1",
            "-vf", "hwdownload,format=bgr0",
            "-f", "image2", str(output_path),
        ]
        return self._run_with_timeout(cmd, timeout=15)
```

#### 3.6.2 Headless CI 支持

```python
class XvfbCapture(CaptureBackend):
    """Xvfb 虚拟帧缓冲截图"""

    def setup(self) -> None:
        if not self._display_exists():
            subprocess.run(["Xvfb", ":99", "-screen", "0", "1920x1080x24"],
                           check=True, start_new_session=True)
            os.environ["DISPLAY"] = ":99"

    def capture(self, output_path: Path) -> CaptureResult:
        return subprocess.run(
            ["xwd", "-root", "-out", str(output_path.with_suffix(".xwd"))],
            check=True, capture_output=True, timeout=10,
        )
```

### 3.7 新增组件

#### 3.7.1 AirDep — 部署插件

```
职责: SSH 远程构建 + 部署 + systemd 生命周期管理 + 部署验证

工作流:
  1. 远程构建 (cmake --build / cargo build / npm build)
  2. 二进制传输 (scp + MD5 校验)
  3. systemd 操作 (daemon-reload + restart + is-active 验证)
  4. 部署产物记录 (binary md5, service status, journal excerpt)
  5. 冒烟验证 (可选: 运行预定义的 smoke test)

制品:
  AirPlan/state/airdep/
    sessions/{session_id}.json    # 部署会话完整记录
    deploy-log.md                 # 人类可读的部署日志
```

#### 3.7.2 AirTst — 测试运行器插件

```
职责: 统一测试执行 + 结构化结果报告

支持:
  - CTest / GoogleTest (C++)
  - pytest (Python)
  - jest / vitest (TypeScript)
  - go test (Go)
  - cargo test (Rust)

制品:
  AirPlan/state/airtst/
    reports/{task_id}-{ts}.json   # 结构化测试结果
    test-summary.md               # 人类可读摘要

结果格式:
  {
    "framework": "googletest",
    "totalTests": 128,
    "passed": 127,
    "failed": 0,
    "disabled": 1,
    "duration": "4.2s",
    "failures": []
  }
```

#### 3.7.3 AirSec — 安全扫描插件

```
职责: 制品敏感数据扫描 + 自动脱敏

扫描目标:
  - ADR/debug-log 中的 API 密钥、令牌、密码
  - pcap 文件中的明文凭据
  - 截图中的敏感 UI 内容（标注但不自动处理）

集成点:
  - Worker finalize 前自动扫描 result.json
  - 引擎 merge 前扫描 documentUpdates
  - 发现敏感数据时阻止合并并通知用户
```

#### 3.7.4 AirRvr — 需求审查器插件

```
职责: 基于原始需求文档对已完成任务进行独立审查，验证交付物与需求的一致性

核心问题:
  V1 中任务"完成"的判定仅依赖 Worker 自报 + AirEng 结构验证。
  没有任何组件将交付物与原始需求 (requirements.md / plan.md / 用户指令) 进行
  独立比对。Worker 可能:
  - 实现了代码但偏离了需求意图
  - 满足了 Done When 字面条件但遗漏了隐含需求
  - 验证通过但解决的是错误的问题

工作流:
  1. 加载原始需求上下文:
     - AirPlan/docs/analysis/requirements.md
     - AirPlan/plan.md
     - AirPlan/todo.md (含当前任务的 Task/Files/Done When/Validation)
     - 用户的原始指令 (如果有记录)

  2. 加载交付物:
     - Worker result.json (summary, filesChanged, validations)
     - 变更文件的 diff (git diff 或文件内容)
     - 验证证据 (测试输出、截图、静态分析报告)

  3. 多维度审查:
     - 需求覆盖度: 原始需求中的每个要求点是否被交付物覆盖
     - 意图一致性: 交付物是否解决了需求想解决的真正问题
     - 边界完整性: 是否遗漏了需求的隐含边界条件
     - 回归风险: 变更是否破坏了需求的已有功能
     - 代码质量: 复杂度、可读性、重复率、异常处理完备性
     - 生命周期健壮性: 资源释放、连接管理、超时/重试/降级策略
     - 运行时稳定性: 内存泄漏风险、竞态条件、崩溃路径、错误传播
     - 用户影响评估: 变更是否引入用户可感知的崩溃或卡顿风险
     - **Code-to-Design 一致性（强制）**: 代码实现是否严格遵循设计文档，逐行对照

  4. 产出审查报告:
     AirPlan/state/airrvr/reviews/{task_id}-{ts}.json
     AirPlan/docs/reviews/{task_id}-review.md

     报告结构:
     {
       "taskId": "T-001",
       "verdict": "pass | conditional-pass | fail",
       "coverage": [
         {"requirement": "...", "status": "covered | partial | missing",
          "evidence": "具体文件或代码位置"}
       ],
       "intentAlignment": "aligned | divergent",
       "divergenceNotes": "...",
       "regressionRisk": "none | low | medium | high",
       "regressionDetails": "...",
       "codeQuality": {
         "complexity": "low | medium | high",
         "readability": "good | acceptable | poor",
         "duplication": "none | low | high",
         "errorHandling": "complete | partial | missing"
       },
       "lifecycleHealth": {
         "resourceLeak": "none | suspected | confirmed",
         "connectionManagement": "proper | improper | missing",
         "timeoutStrategy": "present | absent",
         "retryStrategy": "present | absent"
       },
       "runtimeStability": {
         "crashRisk": "none | low | medium | high",
         "raceCondition": "none | suspected | confirmed",
         "memoryLeak": "none | suspected | confirmed",
         "userImpact": "none | minor | major"
       },
       "codeToDesignTable": [
         {"designRef": "ADR-0023: JWT认证", "codeLocation": "auth/jwt.py:L45-78", "status": "aligned | divergent | missing", "notes": "实现了ADR规定的RS256算法"},
         {"designRef": "C4: 模块边界", "codeLocation": "services/auth_service.py:L12", "status": "aligned", "notes": "依赖方向符合架构约束"},
         {"designRef": "需求: 登录失败锁定", "codeLocation": "auth/login.py:L89-102", "status": "divergent", "notes": "实现了5次失败锁定，需求要求3次"}
       ],
       "recommendations": ["..."]
     }

  5. 与 AirEng 集成:
     - AirEng merge 前可选调用 AirRvr 审查
     - verdict=fail 时阻止合并，要求 Worker 修订
     - verdict=conditional-pass 时允许合并但记录遗留项
     - verdict=pass 时正常合并

审查模式:
  - 逐任务审查: 单个任务完成后立即审查
  - 波次审查: 一个波次所有任务完成后批量审查
  - 里程碑审查: 项目阶段结束时全量审查 (比对 requirements.md 全文)

  **Code-to-Design 逐行对照审查**（每次审查必含）:
    对每个任务的交付代码，与对应的设计文档进行逐行级别的对照：
    - 实现 ↔ 需求: 代码是否覆盖了需求中的每个功能点
    - 实现 ↔ ADR: 代码是否遵循了架构决策记录中的约束
    - 实现 ↔ C4: 代码是否符合模块边界和职责划分
    - 实现 ↔ Done When: 代码是否满足了完成条件的字面要求
    - 偏离标记: 发现实现偏离设计时，标记具体行号和偏离类型

    报告结构扩展:
    {
      "codeToDesign": [
        {"designItem": "ADR-0003: 使用 JWT 认证",
         "implementationStatus": "aligned | divergent | missing",
         "codeLocation": "src/auth/token.py:45-78",
         "designLocation": "docs/architecture/adr/ADR-0003-jwt.md",
         "divergenceDetail": "实现使用了 HS256 而非 ADR 规定的 RS256"}
      ]
    }

制品:
  AirPlan/state/airrvr/
    reviews/{task_id}-{ts}.json    # 结构化审查报告
    review-summary.md              # 累积审查摘要
  AirPlan/docs/reviews/
    {task_id}-review.md            # 人类可读审查报告
```

#### 3.7.4 事件索引层

```python
# air_runtime/events.py

class EventLog:
    """结构化事件日志 (JSONL)"""

    def __init__(self, path: Path):
        self._path = path

    def emit(self, event_type: str, payload: dict) -> None:
        entry = {
            "ts": now_iso(),
            "type": event_type,
            **payload,
        }
        with open(self._path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

# 事件类型:
# task.dispatched    — 任务派发
# task.completed     — 任务完成
# task.blocked       — 任务阻塞
# merge.started      — 合并开始
# merge.completed    — 合并完成
# repair.created     — 修复创建
# repair.resolved    — 修复解决
# intervention.stall — 停滞干预
# xdb.captured       — 截图采集
# debug.session      — 调试会话
# context.compacted  — 上下文压缩
# deploy.completed   — 部署完成
```

事件日志与 `state.json` 互补：`state.json` 是当前快照，事件日志是完整时间线。

### 3.8 `air_runtime` 模块重组

```
air_runtime/
  __init__.py
  contracts.py       # 数据契约（保持，增加 DeploymentRecord）
  io.py              # NEW: 原子 I/O (替代 5 份 _json_dump)
  lock.py            # NEW: 文件锁
  utils.py           # NEW: 公共工具 (替代重复代码)
  events.py          # NEW: 事件日志
  task_graph.py      # NEW: 动态任务依赖图 (替代静态 todo 表格)
  adr_watcher.py     # NEW: ADR 文件变更监控 + 自动触发级联失效
  worktree.py        # NEW: git worktree 隔离并行
  paths.py           # 路径约定（保持）
  todo_parser.py     # TODO 解析（保持，修复列索引硬编码）
  review.py          # 并行审查（保持，优化算法）
  engine.py          # 调度引擎（重构：事务化合并、自适应轮询、资源检测）
  worker.py          # Worker 生命周期（保持，增加 task_id 校验）
  doc_sync.py        # 文档同步（保持，增加去重）
  project_bootstrap.py  # 项目引导（保持）
  evidence_gate.py   # NEW: 任务类型感知证据门控 (替代无差别 AirXDB 触发)
  deploy_runtime.py  # NEW: AirDep 运行时
  test_runtime.py    # NEW: AirTst 运行时
  airxdb_runtime.py  # 扩展: kmsgrab, xvfb, 截图 diff
  debug_runtime.py   # 扩展: 步骤追踪, 回滚
  repair_runtime.py  # 扩展: 修复模式学习
  review_runtime.py  # NEW: AirRvr 需求审查运行时
```

---

## 4. 分阶段实施计划

### Phase 1 — 可靠性基础 (P0 修复)

**目标**：消除已造成实际损失的缺陷

| 任务 | 内容 | 对应缺陷 | 预估工作量 |
|------|------|---------|-----------|
| T-1.1 | 实现 `air_runtime.io` (原子写入 + 安全加载) | P0-3 | 0.5d |
| T-1.2 | 实现 `air_runtime.lock` (文件锁) | P0-4 | 0.5d |
| T-1.3 | 实现 `air_runtime.utils` (消除重复) | P1-2~P1-7 | 1d |
| T-1.4 | 实现 `EvidenceGatePolicy` (任务类型感知) | P0-1 | 0.5d |
| T-1.5 | 实现部署验证强制 | P0-2 | 0.5d |
| T-1.6 | 消除硬编码路径 | P1-1 | 0.5d |
| T-1.7 | 子进程超时 | P1-10 | 0.5d |
| T-1.8 | task_id / marker 注入防护 | P1-11, P1-12 | 0.5d |
| T-1.9 | 异常处理改进 (不静默吞) | P1-13 | 0.5d |
| T-1.10 | AirArc plan 模式阻断 + 工具白名单 | P0-5 | 0.5d |
| T-1.11 | AirEng 中文锁定 + 自主决策指令 | P0-6 | 0.5d |
| T-1.12 | AirEng 强制轮询循环 (5分钟周期) | P0-7 | 0.5d |
| T-1.13 | AirDo 强制 AirDbg 路由 | P0-8 | 0.5d |
| T-1.14 | 安装器路径修正 + 安装后验证 | P0-9 | 1d |
| T-1.15 | AirArc 需求探讨门控（三阶段流程） | P1-16 | 0.5d |
| T-1.16 | AirDbg 先读后写门控（取证前置） | P1-17 | 0.5d |
| T-1.17 | 项目级 spdlog 日志标准（AirArc 强制 + AirRvr 检查） | P1-18 | 0.5d |
| T-1.18 | AirEng 调度职责边界（仅调度 + 极端接管例外） | P0-10 | 0.5d |
| T-1.19 | 边界测试强制（AirArc 规划） + 终审高风险审计（AirRvr 审查） | P1-19 | 1d |
| T-1.20 | frontend-design Skill 集成 + 自动安装检测 | P1-20 | 0.5d |
| T-1.21 | AirArc 任务描述弱模型优化（歧义词检测 + 保留约束 + 自检） | P1-24 | 1d |
| T-1.22 | Dispatch → Worker 桥接（spawn_workers + 指令操作化 + 工具白名单对齐） | P1-22, P1-23 | 1d |
| T-1.23 | Merge → TaskGraph 状态同步（merge 后更新 task-graph.json 节点 status） | P1-25 | 0.5d |

**验证标准**：所有现有项目（DecodePlayer 系列）的 state.json 在 V2 引擎下不损坏；AirXDB 假阳性率降至 0。

### Phase 2 — 引擎增强

**目标**：提升调度质量和可观测性

| 任务 | 内容 | 对应缺陷 |
|------|------|---------|
| T-2.1 | 自适应轮询 (`AdaptivePoller`) | P3-3 部分 |
| T-2.2 | Worker 超时与资源压力检测 | P3-3 |
| T-2.3 | 合并事务化 | P0-4 深化 |
| T-2.4 | AGENTS.md 去重与压缩 | P3-1 |
| T-2.5 | 事件日志 (`EventLog`) | 可观测性 |
| T-2.6 | todo.md 列索引从表头推导 | P1-8 |
| T-2.7 | 并发度可配置 | P1-9 |
| T-2.8 | state.json 历史列表上限 | P2-2 |
| T-2.9 | 动态图调度 (TaskGraph + PlanDelta) | P1-14 |
| T-2.10 | 区域级冲突检测 + worktree 隔离并行 | P1-15 |
| T-2.11 | ADR 变更级联失效（溯源链 + 回滚清理 + 调度冻结） | P1-21 |

### Phase 3 — 新插件

**目标**：填补最大的功能空白

| 任务 | 内容 | 对应差距 |
|------|------|---------|
| T-3.1 | AirDep 部署插件 | 部署缺口 |
| T-3.2 | AirTst 测试运行器 | 测试标准化 |
| T-3.3 | AirSDB 多语言后端 | AirSDB 差距 |
| T-3.4 | AirXDB kmsgrab + xvfb | AirXDB 差距 |
| T-3.5 | AirDbg 步骤追踪 + 回滚 | AirDbg 差距 |
| T-3.6 | AirRvr 需求审查器 | 交付物与需求一致性验证缺失 |
| T-3.7 | AirSec 安全扫描 | 制品敏感数据泄露风险 |

### Phase 4 — 规模化

**目标**：支持大规模项目和多项目知识迁移

| 任务 | 内容 | 对应缺陷 |
|------|------|---------|
| T-4.1 | 冲突检测算法优化 (O(n²) → O(n log n)) | P2-1 |
| T-4.2 | todo.md 缓存 (避免全量重解析) | P2-3 |
| T-4.3 | AirContext 压缩质量校验 | AirContext 差距 |
| T-4.4 | AirContext Token 估算改进 | AirContext 差距 |
| T-4.5 | AirContext 陈旧锁检测 | AirContext 差距 |
| T-4.6 | AirArc 增量重规划 | AirArc 差距 |
| T-4.7 | 跨项目运维模式库 | P3-5 |

### Phase 5 — 测试覆盖

**贯穿所有阶段**，每新增/重构模块必须附带测试：

| 模块 | 测试重点 |
|------|---------|
| `todo_parser.py` | Markdown 表格格式变化、缺失列、转义字符 |
| `review.py` | 依赖环检测、写集冲突正确性、大规模任务性能 |
| `doc_sync.py` | 标记块嵌套/缺失/重叠、路径遍历防护 |
| `contracts.py` | from_dict/to_dict 往返、验证边界 |
| `engine.py` | 状态机转换、派发选择、停滞检测 |
| `io.py` | 原子写入、损坏恢复、备份轮转 |
| `lock.py` | 锁超时、陈旧锁清理 |
| `evidence_gate.py` | 任务分类正确率 |
| `task_graph.py` | 增量 delta 应用、依赖环检测、ready 任务计算 |
| `worktree.py` | worktree 创建/合并/清理、冲突升级 |

---

## 5. 迁移策略

### 5.1 向后兼容

V2 必须能读取 V1 的 `state.json`、`todo.md`、`result.json`。迁移方式：

```python
def migrate_state_v1_to_v2(state: dict) -> dict:
    """V1 → V2 状态迁移"""
    v2 = {**state}

    # 新增字段使用默认值
    v2.setdefault("evidenceGatePolicy", {"guiIndicators": [], "networkIndicators": []})
    v2.setdefault("deployVerificationRequired", False)
    v2.setdefault("adaptivePolling", True)
    v2.setdefault("workerMaxWallTimeSeconds", 7200)

    # 历史列表截断
    for key in ("mergedResults", "xdbSessions", "debugSessions", "repairAttempts"):
        if key in v2 and len(v2[key]) > 100:
            v2[key] = v2[key][-100:]

    return v2
```

### 5.2 渐进式迁移

不需要一次性迁移所有项目。V2 引擎可以混合运行 V1 插件：

- V2 引擎 + V1 Worker：Worker 不感知证据门控变化，引擎侧过滤
- V2 AirContext + V1 其他：AirContext 独立运行
- V1 引擎 + V2 AirDep：AirDep 作为独立插件，不依赖引擎版本

### 5.3 回滚方案

V2 的 `state.json` 保持 V1 的 JSON 结构，新增字段使用 `setdefault` 填充。回滚到 V1 引擎时，V1 忽略不认识的新字段。

---

## 6. 关键设计决策

### 6.1 为什么选择文件锁而非数据库

V1 的核心优势是**所有状态都是人类可读文件**。引入 SQLite 会破坏这一属性——`state.json` 可以直接 `cat` 查看，SQLite 不行。文件锁在保持可检查性的同时提供足够的并发安全。

如果项目规模超过 500+ 任务或 20+ 并行 Worker，再考虑引入嵌入式数据库。

### 6.2 为什么证据门控用关键词匹配而非 LLM 分类

关键词匹配的优势：
- **确定性**：相同输入总是产生相同输出，可测试
- **零成本**：不需要额外 API 调用
- **可解释**：用户可以理解为什么某个任务被分类为 GUI 任务
- **可覆盖**：用户可以在 todo.md 中用 `[no-xdb]` 标记显式跳过

LLM 分类的优势是更准确，但引入了不确定性和额外成本。在 V2 初期使用关键词匹配，积累足够标注数据后可考虑 LLM 分类作为增强。

### 6.3 为什么新插件不合并到 air_runtime

AirDep/AirTst/AirSec 作为独立插件而非 `air_runtime` 模块：
- 独立版本和发布节奏
- 用户可按需安装
- 保持 `air_runtime` 作为核心库的精简性
- 遵循 V1 的插件边界不变量

---

## 7. 度量指标

V2 应追踪以下 KPI 以验证改进效果：

| 指标 | V1 基线 | V2 目标 |
|------|---------|---------|
| AirXDB 假阳性率 | ~60%（11/18 任务） | < 5% |
| 状态文件损坏率 | 未量化（已知发生） | 0% |
| 部署一致性事故 | 1 次关键事故 | 0 次 |
| 空壳修复循环 | 11+ 次 | 0 次 |
| 代码重复度 | `_json_dump` 5 份等 | 每函数 1 份 |
| 测试覆盖率 | 0% | 核心模块 > 80% |
| AGENTS.md 大小 | 持续膨胀 | 自动去重/压缩 |
| 平均任务合并耗时 | 未量化 | 量化基线 + 优化 |
| AirArc plan 模式劫持 | 频繁发生 | 0 次 |
| AirArc 跳过需求探讨直接生成规划 | 每次启动 | 0 次（三阶段门控强制） |
| AirEng 非中文输出 | 频繁发生 | 0 次 |
| AirEng 轮询遗忘 | 频繁发生 | 0 次 |
| AirEng 偏离调度亲自写代码 | 频繁发生 | 0 次（仅极端接管例外，需日志记录） |
| AirDo 跳过专家插件（Dbg/XDB/NDB/SDB/Rvr） | 频繁发生 | 0 次（全专家插件强制路由） |
| AirDbg 未取证就修改代码 | 频繁发生 | 0 次（先读后写门控强制） |
| 项目无标准化日志 | 所有项目 | spdlog 覆盖率 100%（AirArc 强制 + AirRvr 检查） |
| 边界无测试覆盖 | 所有项目 | 模块边界接口测试覆盖率 100% |
| 终审未检查高风险问题 | 无专项审计 | 高风险审计通过率 100%（deliveryVerdict != block-release） |
| UI 任务无专业 Skill | 所有 UI 任务 | frontend-design Skill 覆盖率 100%（自动安装 + 强制路由） |
| 需求偏离未检出 | 无审查机制 | AirRvr 覆盖率 > 80% |
| 实现偏离设计未检出 | 无对照机制 | Code-to-Design 对照覆盖率 100% |
| 安装后插件不可用 | 用户普遍反馈 | 0 次（安装后自动验证通过） |
| 需求变更后调度恢复时间 | 多轮 AI 迭代 | < 1 次（增量吸收 delta） |
| 同文件无冲突任务串行率 | 100% 串行 | < 20%（worktree 并行） |
| ADR 变更后旧代码残留 | 无自动清理 | 0 次（级联失效 + git revert 自动清理） |
| 任务描述歧义导致破坏性执行 | 已发生 1 次 | 0 次（歧义词检测 + 保留约束 + Arc 自检） |
| Dispatch → Worker 断链 | Agent 停止调度，回退自己写代码 | 0 次（spawn_workers 标准化 + 指令操作化消除歧义） |
| Merge 后重复派发 | 已完成任务再次被 dispatch | 0 次（task-graph.json 节点 status 实时同步） |
| Eng 编码越界（非接管场景） | 调度器在正常调度中越界写任务代码 | 0 次（指令伪代码消除 spawn 歧义，Agent 不再因「Worker 不启动」而回退自己执行） |
