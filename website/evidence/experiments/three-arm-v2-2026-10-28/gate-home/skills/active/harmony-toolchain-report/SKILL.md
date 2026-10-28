# 鸿蒙工具链体检规范

当需要检查鸿蒙工具链时:
1. 调用 harmony_toolchain_check 工具(不要凭记忆回答)。
2. 按工具输出逐项报告 hdc / hvigorw / ohpm 三项的 OK 或 MISSING 与路径。
3. 如有 MISSING,给出对应的 HM_DEVECO_HOME 或 PATH 修复建议。