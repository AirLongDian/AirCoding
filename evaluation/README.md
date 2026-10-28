下载并解压同目录 aircoding-analysis-test.zip 后执行。

# AirCoding 项目理解引擎测试包

不包含 Understand、授权、Joern 安装文件或任何破解程序。C++ 夹具、辅助脚本和云端参考结果均在包内。优先从下面 A 或 B 中选择你要验证的工具，无须安装 VS Code。

新增无人值守评估与部署限制见 [UNATTENDED-EVALUATION.md](UNATTENDED-EVALUATION.md)。Understand 自动验证入口为 run_understand.py，尚待真实安装环境执行。

## 测什么

两个 C++ 项目功能等价：采集类返回 21，解码类调用业务策略后乘 2，发送类返回结果，main 检查是否为 42。程序退出码应为 0。它们不是实际编解码或 UDP 传输实现。

- sample/decoder.cpp：业务函数调用在 `return {...}` 初始化列表中。
- sample-explicit/decoder.cpp：业务函数调用先存入变量，再赋值、返回。
- 两者都应能识别 `Decoder::decode -> business::allow_frame`，否则存在关系覆盖缺口。
- Joern 4.0.666 云端实测：前一种写法未生成对应 CALL，后一种有。不要为了得到通过结果而修改原始夹具。

## A. Joern 一条命令复现

前置：Python 3.9+（脚本仅用标准库）、JDK 21、CMake、Ninja，以及工作中的 C++20 编译器。首次测试应固定 Joern 4.0.666，与参考结果保持一致。

官方下载：https://github.com/joernio/joern/releases/tag/v4.0.666
选择与你系统匹配的 `joern-cli-*.zip`，对照同页 `.sha512` 校验后解压。`--joern-home` 指向包含 joern-parse 或 joern-parse.bat 的 joern-cli 目录。脚本不会下载安装任何引擎。

Windows PowerShell 示例（先确保编译器、Java、CMake、Ninja 在 PATH；使用 MSVC 时从对应开发者终端执行）：

```powershell
python .\run_joern.py --joern-home "D:\tools\joern-cli"
```

Linux/macOS 示例：

```sh
python3 run_joern.py --joern-home /path/to/joern-cli
```

若用 Unix Makefiles 代替 Ninja：

```sh
python3 run_joern.py --joern-home /path/to/joern-cli --generator "Unix Makefiles"
```

若 CMake 不在 PATH，追加 `--cmake` 及完整可执行文件路径。不要用不生成 compile_commands.json 的 generator。

脚本会依次完成两个项目的配置、编译、实际运行、Joern 解析、完整 GraphSON 导出及 CPGQL 查询。产物位于 `results/<时间戳>/`，不会覆盖先前测试；应用源码不被修改。返回码：

- 0：执行完成，两种写法均找到预期调用。
- 2：执行完成，但至少一种写法缺少预期调用（在 4.0.666 上预期复现此状态）。
- 1：配置、编译、运行或工具执行失败，先看对应日志；不能当作语义检测结果。

`summary.json` 是结论，`commands.json` 记录命令、退出码和耗时，每阶段有独立日志。单次小样例耗时不能当作大项目性能数据。

## B. Understand 无人值守验证（无需打开 GUI）

前置条件一次性完成：合法安装与激活 Understand，准备对应的 und、upython、CMake、Ninja 和 C++ 编译器。无需配置模型，也不修改管理员 AI 策略。脚本没有在真实 Understand 8.0 环境执行，以下用于确认该安装/授权组合是否能无人值守运行，不能预先称为已验证。

启动一次脚本后，将自动完成 API 预检、两套夹具的配置/编译/实际运行、从编译数据库创建 Understand 项目、分析、导出和引用证据检查。每个子进程关闭标准输入，并设置超时；不要求逐步点击确认。

```powershell
python run_understand.py --und "D:\实际安装目录\und.exe" --upython "D:\实际安装目录\upython.exe"
```

工具已在 PATH 时：

```sh
python3 run_understand.py
```

可用 `--cmake` 指定 CMake 完整路径，`--generator "Unix Makefiles"` 改用 Make，`--timeout 300` 设置每阶段超时。Windows 使用 MSVC 时需由配置好编译器环境的终端/任务执行器启动。

自动建库命令形态来自 stinb/understand-jenkins-plugin 的 UndBuilder.java：

```text
und -db PROJECT.und create -languages all add compile_commands.json analyze
```

本版本若不接受命令、授权需要交互、Python 绑定不可用或策略阻止执行，将保留失败日志，不跳过检查。脚本不会配置/读取授权值，不使用破解软件，也不会启用被禁用的 AI 功能。

查看 `results/understand-时间戳/summary.json`：

- `reference_check_passed`（返回 0）：自动链路跑通，两种写法都有预期跨层引用；仍需核对分析日志是否存在未解析内容。
- `semantic_gap_detected`（返回 2）：链路完成，但至少一种写法缺少证据。
- `execution_failed`（返回 1）：环境、授权、命令、绑定、编译或导出阶段失败；根据对应日志定位，不视为代码审查不通过。

所有输出为新目录。当前脚本只验证自动建库和批量导出，不验证常驻 MCP、并发数据库读取、运行中更新或大型工程性能。常驻服务部署完成后可由任务执行器启动它；如果分析节点在个人电脑上，关机/休眠会中断可用性，脚本无法消除此部署约束。

也可单独用已建好的项目执行原始导出：

```sh
upython export_understand.py /path/original.und --output result-original
upython export_understand.py /path/explicit.und --output result-explicit
```

输出目录须尚不存在。不要 `pip install understand`：PyPI 同名包不是这里需要的 SciTools 绑定。查看两个 summary.json 的 errors 和 cross_layer_reference_evidence。

## C. 看已有结果与测 token

reference-results/ 保存云端参考产物，先阅读 CLOUD-REPORT.md。文件用途：

- clang-uml-structure.json：类结构。
- clang-uml-includes.json：文件包含关系。
- scip-reference-evidence.json：SCIP 汇总的跨文件引用及证据（非完整程序图）。
- joern-original-raw.json / normalized.json：全图原始输出和去包装输出。
- joern-*-query.json：两种写法的实际查询结果。

可选安装本目录 package.json 指定的 js-tiktoken 1.0.21，再离线计数；无需模型 API：

```sh
npm install --ignore-scripts --no-audit --no-fund
node measure_tokens.mjs reference-results/joern-original-raw.json reference-results/joern-original-normalized.json
```

口径为 o200k_base，不等于当前助手或所有模型的实际 tokenizer，也不包含工具描述、提示词和回答。这些输出的语义范围不同，不能仅凭 token 总量判定引擎优劣。

## 返回哪些结果

Joern：结果目录中的 summary.json、commands.json；失败则附相关阶段日志。
Understand：两个 summary.json；必要时再提供相关引用记录。
原始全图可以留本地，不必先上传大型结果文件。

## 验证边界

云端已验证 Linux 路径。Windows/macOS 的脚本路径尚未实机验证；工具版本和平台差异请记录。该包只验证小样例可行性，不代表 Qt、复杂模板、宏、虚调用、线程分析、大型项目或真实媒体管线已通过。MCP 及 LLM 任务效果不在本包自动测试范围内。
