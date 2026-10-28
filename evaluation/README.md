测试包下载：同目录 aircoding-analysis-test.zip，下载并解压后执行下面的步骤。

# AirCoding 项目理解引擎测试包

不包含 Understand、授权、Joern 安装文件或任何破解程序。C++ 夹具、辅助脚本和云端参考结果均在包内。优先从下面 A 或 B 中选择你要验证的工具，无须安装 VS Code。

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

## B. Understand 本机正版验证

只在你已安装、已授权的 Understand 环境运行，无需转交授权。

1. 可以直接用 CLion 分别打开 sample 和 sample-explicit。使用 C++20 工具链与 Ninja，将 `CMAKE_EXPORT_COMPILE_COMMANDS` 设为 ON，配置、编译、运行；两个程序均应返回 0。
2. 或从有可用 C++ 编译器的终端生成：

```sh
cmake -S sample -B build-original -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build-original
cmake -S sample-explicit -B build-explicit -G Ninja -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build build-explicit
```

3. 按你 Understand 版本支持的方式分别建立两个独立 C++ 分析项目，导入各自编译数据库或等价编译配置，完成分析。不要把两种源码混进同一个项目。
4. 用 Understand 自带的 upython，或已正确配置官方绑定的 Python，执行以下命令；`.und` 路径替换为实际项目，输出目录必须尚不存在：

```sh
upython export_understand.py /path/original.und --output understand-original
upython export_understand.py /path/explicit.und --output understand-explicit
```

Windows 如果 upython 不在 PATH，用其完整路径运行。不要 `pip install understand`：PyPI 上同名包并非这里需要的 SciTools 绑定。

5. 检查两个 summary.json：errors 应为空，cross_layer_reference_evidence 应包含 decoder.cpp 对 allow_frame 的引用。再核对引用的 kind、line、scope，确认不是仅匹配了方法源码字符串。

输出包括 entities.jsonl、references.jsonl、summary.json。脚本不调用修改 Understand 数据库的 API，也不采集授权值。发生 API 错误时记录为 partial，不冒充成功。此脚本依据公开 API 示例编写，云端没有 Understand，尚未执行该路径；若版本不兼容，请保留错误以便适配。

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
