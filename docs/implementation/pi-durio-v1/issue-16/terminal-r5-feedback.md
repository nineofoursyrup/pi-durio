# r5 真实 Terminal 部分观察

固定候选：`e4571452a1ebf712cd60282ded0161640670d70e`；本地 integration merge：`7a067340dda2e4fb84a4472ff91cfec1100c626f`。65/65 组合检查、8/8 最终影响检查、独立安装和 12,704 文件核验通过；合成 PTY 不代表本节真人观察。

用户明确反馈“PPP，但emoji还是会占多个字符”。对应本次 runner 的 [C1–C3 原始记录](terminal-r5-cursor-observation.json) 均为 PASS：原样光标、首见 Unicode、约 40×12 缩放恢复。机器记录表明 raw/stty 均恢复，当前会话实测 `👩‍💻` 占 5 格，校准没有报告错误。[直接反馈及原记录哈希](terminal-r5-short-feedback.json) 保留了关联证据。

这只确认三项短测。Terminal 的原生 emoji 占格和字形间隙继续存在；限定补丁匹配实际坐标，不承诺改变原生字形。

完整 normal（输出期间 IME、多行、字符簇删除、复制、滚动、焦点、最小窗口）、stop、esc、exit、fault 的真人观察仍待完成。未报告项保持 UNKNOWN/NOT RUN；中途退出的零请求场景不算完成。#16 尚未 integrated-accepted，#17/#18 仍不解锁。r3/r4 FAIL、各次人工现场、首败、原规格均保留。付费调用、#32 日用接受、main 产品合并及发布未执行。
